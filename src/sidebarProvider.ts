import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { GraphIntelligenceResult, ProgressEvent } from './graphIntelligence/provider';
import type { ChatStore, ChatMessage } from './graphIntelligence/chatStore';

export interface SavedGraphMeta {
  name: string;
  description: string;
  savedAt: string;
  file: string;
}

// Forward reference — the actual GraphProvider is passed in at construction time
// to avoid a circular module import.
export interface GraphController {
  show(): void;
  isOpen(): boolean;
  reloadLayout(): void;
  loadGraph(data: unknown, filePath?: string): Promise<void>;
  openTimeline(savedGraphFile: string, name: string): void;
  runGraphIntelligence?(prompt: string, onProgress?: (ev: ProgressEvent) => void): Promise<GraphIntelligenceResult>;
  abortIntelligence?(): void;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cograph.savedGraphs';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _graphController: GraphController,
    private readonly _chatStore: ChatStore | null = null,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'src', 'webview')],
    };
    webviewView.webview.html = this._buildHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      this._view = undefined;
      this._graphController.abortIntelligence?.();
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          this._sendGraphList();
          if (this._chatStore) {
            this._view?.webview.postMessage({ type: 'chat-history', messages: this._chatStore.load() });
          }
          const model = vscode.workspace.getConfiguration('cograph').get<string>('graphIntelligence.model', 'sonnet');
          this._view?.webview.postMessage({ type: 'chat-model-set', model });
          break;
        }
        case 'chat-send': {
          const userMsg: ChatMessage = { role: 'user', text: msg.prompt, at: new Date().toISOString() };
          this._chatStore?.append(userMsg);
          this._view?.webview.postMessage({ type: 'chat-append', message: userMsg });
          this._view?.webview.postMessage({ type: 'chat-status', stage: 'thinking' });
          try {
            if (!this._graphController.runGraphIntelligence) {
              throw new Error('Graph Intelligence not available.');
            }
            const onProgress = (ev: ProgressEvent) => {
              this._view?.webview.postMessage({ type: 'chat-progress', event: ev });
            };
            const result = await this._graphController.runGraphIntelligence(msg.prompt, onProgress);
            const aiMsg: ChatMessage = { role: 'assistant', text: result.text, at: new Date().toISOString() };
            this._chatStore?.append(aiMsg);
            this._view?.webview.postMessage({ type: 'chat-append', message: aiMsg });
          } catch (err) {
            const errMsg: ChatMessage = { role: 'error', text: (err as Error).message, at: new Date().toISOString() };
            this._chatStore?.append(errMsg);
            this._view?.webview.postMessage({ type: 'chat-append', message: errMsg });
          } finally {
            this._view?.webview.postMessage({ type: 'chat-status', stage: 'idle' });
          }
          break;
        }
        case 'chat-cancel':
          this._graphController.abortIntelligence?.();
          break;
        case 'chat-clear':
          this._chatStore?.clear();
          break;
        case 'chat-model-change': {
          const target = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;
          try {
            await vscode.workspace.getConfiguration('cograph')
              .update('graphIntelligence.model', msg.model, target);
            this._view?.webview.postMessage({ type: 'chat-model-set', model: msg.model });
          } catch (err) {
            vscode.window.showErrorMessage(`CoGraph: Failed to change model — ${(err as Error).message}`);
          }
          break;
        }
        case 'chat-open-settings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'cograph.graphIntelligence');
          break;
        case 'open-graph': {
          try {
            const raw = fs.readFileSync(msg.file, 'utf8');
            const data = JSON.parse(raw);
            await this._graphController.loadGraph(data, msg.file);
          } catch (err) {
            vscode.window.showErrorMessage(`CoGraph: Failed to load graph — ${(err as Error).message}`);
          }
          break;
        }
        case 'export-graph': {
          try {
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(`${msg.name}.json`),
              filters: { 'CoGraph Layout': ['json'] },
              saveLabel: 'Export',
            });
            if (!uri) { break; }
            fs.copyFileSync(msg.file, uri.fsPath);
            vscode.window.showInformationMessage(`CoGraph: Exported "${msg.name}".`);
          } catch (err) {
            vscode.window.showErrorMessage(`CoGraph: Failed to export — ${(err as Error).message}`);
          }
          break;
        }
        case 'open-timeline': {
          try {
            this._graphController.openTimeline(msg.file, msg.name);
          } catch (err) {
            vscode.window.showErrorMessage(`CoGraph: Failed to open timeline — ${(err as Error).message}`);
          }
          break;
        }
        case 'new-graph':
          if (this._graphController.isOpen()) {
            this._graphController.reloadLayout();
          } else {
            this._graphController.show();
          }
          break;
        case 'delete-graph': {
          const confirm = await vscode.window.showWarningMessage(
            `Delete "${msg.name}"?`,
            { modal: true },
            'Delete',
          );
          if (confirm === 'Delete') {
            try {
              fs.unlinkSync(msg.file);
              this._sendGraphList();
            } catch (err) {
              vscode.window.showErrorMessage(`CoGraph: Failed to delete — ${(err as Error).message}`);
            }
          }
          break;
        }
      }
    });
  }

  /** Re-read the .cograph directory and push an updated list to the webview. */
  refresh(): void {
    if (this._view) {
      this._sendGraphList();
    }
  }

  private _sendGraphList(): void {
    const files = this._listCographFiles();
    this._view?.webview.postMessage({ type: 'graph-list', files });
  }

  private _listCographFiles(): SavedGraphMeta[] {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { return []; }
    const dir = path.join(ws, '.cograph');
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return {
            name: data.name || f.replace('.json', ''),
            description: data.description || '',
            savedAt: data.savedAt || '',
            file: path.join(dir, f),
          };
        } catch {
          return null;
        }
      })
      .filter((x): x is SavedGraphMeta => x !== null);
  }

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const chatScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'sidebar-chat.js'),
    );
    const markdownScriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'markdown.js'),
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      overflow-x: hidden;
    }

    /* ── Section headers (Source Control style) ───────────────────────── */
    .section-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      cursor: pointer;
      user-select: none;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      background: var(--vscode-sideBarSectionHeader-background, transparent);
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
    }
    .section-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .section-header .chevron {
      font-size: 10px;
      transition: transform 0.15s;
      flex-shrink: 0;
    }
    .section-header.collapsed .chevron {
      transform: rotate(-90deg);
    }

    /* ── Section body ──────────────────────────────────────────────────── */
    .section-body {
      padding: 8px 12px;
    }
    .section-body.hidden { display: none; }

    /* ── New Graph button ──────────────────────────────────────────────── */
    #btn-new-graph {
      display: block;
      width: 100%;
      padding: 5px 10px;
      margin-bottom: 8px;
      font-size: 12px;
      font-weight: 600;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      text-align: center;
    }
    #btn-new-graph:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }

    /* ── Search bar ────────────────────────────────────────────────────── */
    #search {
      display: block;
      width: 100%;
      padding: 4px 8px;
      margin-bottom: 10px;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      font-size: 12px;
      outline: none;
    }
    #search:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    /* ── Graph cards ───────────────────────────────────────────────────── */
    #graph-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .graph-card {
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 6px;
      background: var(--vscode-editor-background, #1e1e1e);
      padding: 8px 10px;
      display: grid;
      grid-template-rows: auto auto;
      gap: 4px;
      cursor: pointer;
    }
    .graph-card:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
      border-color: var(--vscode-focusBorder, #007fd4);
    }

    .card-name {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .card-bottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .card-desc {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }

    .btn-timeline {
      flex-shrink: 0;
      padding: 3px 10px;
      font-size: 11px;
      font-weight: 600;
      background: var(--vscode-button-secondaryBackground, #3a3a3a);
      color: var(--vscode-button-secondaryForeground, #ccc);
      border: 1px solid var(--vscode-widget-border, #555);
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-timeline:hover {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border-color: var(--vscode-button-background, #0e639c);
    }

    /* ── Right-click context menu for graph cards ───────────────────────── */
    #ctx-menu {
      position: fixed;
      z-index: 1000;
      min-width: 140px;
      background: var(--vscode-menu-background, #252526);
      color: var(--vscode-menu-foreground, #cccccc);
      border: 1px solid var(--vscode-menu-border, #454545);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      padding: 4px 0;
      font-size: 12px;
      user-select: none;
    }
    #ctx-menu.hidden { display: none; }
    #ctx-menu .ctx-item {
      padding: 5px 14px;
      cursor: pointer;
      white-space: nowrap;
    }
    #ctx-menu .ctx-item:hover {
      background: var(--vscode-menu-selectionBackground, #094771);
      color: var(--vscode-menu-selectionForeground, #ffffff);
    }

    /* ── Empty / placeholder ───────────────────────────────────────────── */
    .placeholder {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #888);
      text-align: center;
      padding: 12px 0;
    }

    .empty-state {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      text-align: center;
      padding: 10px 0;
    }

    /* ── Chat: live-telemetry aesthetic ────────────────────────────────── */
    :root {
      --cg-accent: #f5b041;
      --cg-accent-dim: rgba(245, 176, 65, 0.55);
      --cg-mono: var(--vscode-editor-font-family, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
    }

    /* Chat section header: hold model pill + gear on the right */
    .chat-section-header { position: relative; }
    .chat-header-controls {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .model-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      font-family: var(--cg-mono);
      font-size: 10.5px;
      letter-spacing: 0.02em;
      text-transform: none;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 999px;
      cursor: pointer;
      transition: border-color 180ms ease, color 180ms ease;
    }
    .model-pill:hover {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .model-pill.streaming {
      color: var(--cg-accent);
      border-color: var(--cg-accent-dim);
    }
    .model-pill .diamond { font-size: 8px; opacity: 0.7; }
    .model-gear {
      background: transparent;
      border: none;
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      padding: 0 2px;
      line-height: 1;
    }
    .model-gear:hover { color: var(--vscode-foreground); }

    #body-chat { position: relative; }
    .model-menu {
      position: absolute;
      right: 0;
      top: 0;
      z-index: 20;
      min-width: 240px;
      background: var(--vscode-menu-background, #252526);
      color: var(--vscode-menu-foreground, #cccccc);
      border: 1px solid var(--vscode-menu-border, #454545);
      border-radius: 6px;
      padding: 4px 0;
      box-shadow: 0 4px 14px rgba(0,0,0,0.35);
      font-size: 12px;
      letter-spacing: normal;
      text-transform: none;
      font-weight: normal;
    }
    .model-menu.hidden { display: none; }
    .model-menu .mm-item {
      display: grid;
      grid-template-columns: 14px 1fr;
      gap: 4px 8px;
      padding: 6px 10px;
      cursor: pointer;
    }
    .model-menu .mm-item:hover { background: var(--vscode-menu-selectionBackground, #094771); }
    .model-menu .mm-check { color: var(--cg-accent); font-size: 10px; line-height: 14px; }
    .model-menu .mm-label { color: var(--vscode-foreground); font-family: var(--cg-mono); font-size: 11.5px; }
    .model-menu .mm-desc {
      grid-column: 2 / 3;
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground);
      margin-top: 2px;
      line-height: 1.3;
    }
    .model-menu .mm-footer {
      padding: 6px 10px;
      border-top: 1px solid var(--vscode-menu-border, #454545);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .model-menu .mm-footer:hover { color: var(--vscode-foreground); }

    /* Chat scroll + bubbles */
    #chat-scroll {
      max-height: 400px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 8px;
    }
    .bubble {
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.4;
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    .bubble--user {
      align-self: flex-end;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border-bottom-right-radius: 2px;
      max-width: 90%;
    }
    .bubble--assistant {
      align-self: flex-start;
      background: var(--vscode-editor-background, #1e1e1e);
      border: 1px solid var(--vscode-widget-border, #444);
      border-bottom-left-radius: 2px;
      max-width: 90%;
    }
    .bubble--error {
      align-self: flex-start;
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--vscode-errorForeground, #f48771);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      border-radius: 6px;
      max-width: 90%;
    }

    /* Streaming live bubble */
    .bubble--assistant.bubble--streaming {
      border-left: 2px solid var(--cg-accent);
      position: relative;
    }
    .bubble--assistant.bubble--streaming::after {
      content: '▍';
      color: var(--cg-accent);
      animation: cg-caret 1s steps(2, end) infinite;
      margin-left: 2px;
    }
    @keyframes cg-caret {
      0%, 50% { opacity: 1; }
      51%, 100% { opacity: 0; }
    }
    .bubble-meta {
      font-family: var(--cg-mono);
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      padding: 2px 10px 0;
      opacity: 0.75;
      align-self: flex-start;
    }

    /* Markdown rendering inside assistant bubbles */
    .bubble--assistant > :first-child { margin-top: 0; }
    .bubble--assistant > :last-child  { margin-bottom: 0; }
    .bubble--assistant p { margin: 0 0 8px; line-height: 1.5; }
    .bubble--assistant h1,
    .bubble--assistant h2,
    .bubble--assistant h3,
    .bubble--assistant h4 {
      margin: 12px 0 6px;
      font-weight: 600;
      line-height: 1.25;
      color: var(--vscode-foreground);
    }
    .bubble--assistant h1 { font-size: 14px; }
    .bubble--assistant h2 { font-size: 13px; }
    .bubble--assistant h3,
    .bubble--assistant h4 { font-size: 12px; color: var(--cg-accent-dim); }
    .bubble--assistant ul,
    .bubble--assistant ol { margin: 0 0 8px; padding-left: 20px; }
    .bubble--assistant li { margin: 2px 0; line-height: 1.45; }
    .bubble--assistant strong { color: var(--vscode-foreground); font-weight: 600; }
    .bubble--assistant em { font-style: italic; opacity: 0.9; }
    .bubble--assistant a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      border-bottom: 1px dotted var(--vscode-textLink-foreground);
    }
    .bubble--assistant a:hover { border-bottom-style: solid; }
    .bubble--assistant hr {
      border: 0;
      border-top: 1px solid var(--vscode-widget-border, #444);
      margin: 10px 0;
      opacity: 0.6;
    }
    .bubble--assistant blockquote {
      margin: 0 0 8px;
      padding: 2px 10px;
      border-left: 2px solid var(--cg-accent-dim);
      color: var(--vscode-descriptionForeground);
    }
    .bubble--assistant code {
      font-family: var(--cg-mono);
      font-size: 11.5px;
      background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .bubble--assistant pre {
      position: relative;
      margin: 6px 0 10px;
      padding: 8px 10px;
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.3));
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 6px;
      overflow-x: auto;
      font-size: 11.5px;
      line-height: 1.45;
    }
    .bubble--assistant pre code {
      background: transparent;
      padding: 0;
      font-size: inherit;
      white-space: pre;
    }
    .bubble--assistant .code-copy {
      position: absolute;
      top: 4px; right: 4px;
      background: transparent;
      border: 1px solid transparent;
      color: var(--vscode-descriptionForeground);
      font-family: var(--cg-mono);
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 150ms ease, color 150ms ease, border-color 150ms ease;
    }
    .bubble--assistant pre:hover .code-copy { opacity: 1; }
    .bubble--assistant .code-copy:hover {
      color: var(--cg-accent);
      border-color: var(--cg-accent-dim);
    }
    .bubble--assistant .code-copy.copied { color: var(--cg-accent); opacity: 1; }

    /* Streaming bubble keeps pre-wrap so raw markdown is readable while tokens
       arrive. The markdown pass only runs on finalize. */
    .bubble--assistant.bubble--streaming { white-space: pre-wrap; font-family: inherit; }

    /* Status pane (replaces old #chat-status one-liner) */
    .status-pane {
      position: relative;
      margin: 6px 0 8px;
      padding: 8px 10px 6px;
      background: var(--vscode-editor-background, #1e1e1e);
      border: 1px solid var(--vscode-widget-border, #444);
      border-left: 2px solid var(--cg-accent);
      border-radius: 6px;
      overflow: hidden;
    }
    .status-pane[hidden] { display: none; }
    .status-pane::before {
      content: '';
      position: absolute;
      left: 0; right: 0; top: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--cg-accent-dim), transparent);
      animation: cg-scan 4s linear infinite;
      pointer-events: none;
    }
    @keyframes cg-scan {
      0%   { transform: translateY(0);    opacity: 0; }
      20%  { opacity: 1; }
      80%  { opacity: 1; }
      100% { transform: translateY(120px); opacity: 0; }
    }
    .status-head {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: var(--cg-mono);
      font-size: 11px;
      letter-spacing: 0.04em;
    }
    .status-dot {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: var(--cg-accent);
      animation: cg-pulse 1.2s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes cg-pulse {
      0%, 100% { opacity: 0.35; transform: scale(0.85); }
      50%      { opacity: 1;    transform: scale(1.0); }
    }
    .status-stage { color: var(--vscode-foreground); font-weight: 600; }
    .status-meta  {
      margin-left: auto;
      display: inline-flex;
      gap: 6px;
      color: var(--vscode-descriptionForeground);
    }
    .status-timer { color: var(--cg-accent); font-variant-numeric: tabular-nums; }
    .status-sep   { opacity: 0.5; }
    .status-log {
      list-style: none;
      margin: 6px 0 0;
      padding: 0;
      font-family: var(--cg-mono);
      font-size: 10.5px;
      color: var(--vscode-descriptionForeground);
    }
    .status-log li {
      display: flex;
      gap: 6px;
      padding: 2px 0;
      opacity: 0.55;
    }
    .status-log li:last-child {
      opacity: 1;
      color: var(--vscode-foreground);
    }
    .status-log li::before {
      content: '└';
      color: var(--cg-accent-dim);
      flex-shrink: 0;
    }

    /* Chat form */
    #chat-form {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    #chat-input {
      width: 100%;
      padding: 6px 8px;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 4px;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      resize: vertical;
      outline: none;
    }
    #chat-input:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .chat-form-actions {
      display: flex;
      gap: 4px;
      justify-content: flex-end;
    }
    #chat-send {
      padding: 4px 12px;
      font-size: 12px;
      font-weight: 600;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    #chat-send:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    #chat-send:disabled { opacity: 0.5; cursor: default; }
    #chat-cancel {
      padding: 4px 12px;
      font-size: 12px;
      background: var(--vscode-button-secondaryBackground, #3a3a3a);
      color: var(--vscode-button-secondaryForeground, #ccc);
      border: 1px solid var(--vscode-widget-border, #555);
      border-radius: 4px;
      cursor: pointer;
    }
    #chat-cancel:hover {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
  </style>
</head>
<body>

  <!-- CHAT section -->
  <div class="section-header chat-section-header" id="hdr-chat">
    <span class="chevron">▼</span>
    <span>Chat</span>
    <div class="chat-header-controls">
      <button id="model-pill" class="model-pill" type="button" title="Change model">
        <span class="diamond">◆</span>
        <span id="model-name">sonnet</span>
      </button>
      <button id="model-settings" class="model-gear" type="button" title="Graph Intelligence settings">⚙</button>
    </div>
  </div>
  <div class="section-body" id="body-chat">
    <div id="model-menu" class="model-menu hidden"></div>
    <div id="chat-scroll"></div>
    <div id="chat-status" class="status-pane" hidden>
      <div class="status-head">
        <span class="status-dot"></span>
        <span class="status-stage">Thinking</span>
        <span class="status-meta">
          <span class="status-model">◆ sonnet</span>
          <span class="status-sep">·</span>
          <span class="status-timer">0:00</span>
        </span>
      </div>
      <ol class="status-log" aria-live="polite"></ol>
    </div>
    <form id="chat-form">
      <textarea id="chat-input" rows="2" placeholder="Ask CoGraph…"></textarea>
      <div class="chat-form-actions">
        <button id="chat-cancel" type="button" style="display:none">Cancel</button>
        <button id="chat-send" type="submit">Send</button>
      </div>
    </form>
  </div>

  <!-- SAVED GRAPHS section -->
  <div class="section-header" id="hdr-graphs">
    <span class="chevron">▼</span>
    <span>Saved Graphs</span>
  </div>
  <div class="section-body" id="body-graphs">
    <button id="btn-new-graph">+ New Graph</button>
    <input id="search" type="text" placeholder="Search graphs…" />
    <div id="graph-list">
      <div class="empty-state">No saved graphs yet.</div>
    </div>
  </div>

  <div id="ctx-menu" class="hidden"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ── Section collapsing ─────────────────────────────────────────────
    function wireSection(headerId, bodyId) {
      const hdr = document.getElementById(headerId);
      const body = document.getElementById(bodyId);
      hdr.addEventListener('click', () => {
        const collapsed = hdr.classList.toggle('collapsed');
        body.classList.toggle('hidden', collapsed);
      });
    }
    wireSection('hdr-chat', 'body-chat');
    wireSection('hdr-graphs', 'body-graphs');

    // ── Search ─────────────────────────────────────────────────────────
    let allGraphs = [];

    document.getElementById('search').addEventListener('input', (e) => {
      renderCards(allGraphs, e.target.value.toLowerCase());
    });

    // ── New Graph ──────────────────────────────────────────────────────
    document.getElementById('btn-new-graph').addEventListener('click', () => {
      vscode.postMessage({ type: 'new-graph' });
    });

    // ── Card rendering ─────────────────────────────────────────────────
    function formatDate(iso) {
      if (!iso) return '';
      try {
        return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      } catch { return ''; }
    }

    function renderCards(graphs, query) {
      const list = document.getElementById('graph-list');
      const filtered = query
        ? graphs.filter(g => g.name.toLowerCase().includes(query) || g.description.toLowerCase().includes(query))
        : graphs;

      if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-state">' + (query ? 'No matches.' : 'No saved graphs yet.') + '</div>';
        return;
      }

      list.innerHTML = filtered.map(g => {
        const desc = g.description || formatDate(g.savedAt) || '—';
        const safeFile = g.file.replace(/"/g, '&quot;');
        const safeName = g.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeDesc = desc.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return \`<div class="graph-card" data-file="\${safeFile}" data-name="\${safeName}">
          <div class="card-name">\${safeName}</div>
          <div class="card-bottom">
            <span class="card-desc">\${safeDesc}</span>
            <button class="btn-timeline" data-file="\${safeFile}" data-name="\${safeName}" title="Open timeline view for this graph">Timeline</button>
          </div>
        </div>\`;
      }).join('');

      list.querySelectorAll('.graph-card').forEach(card => {
        card.addEventListener('click', () => {
          vscode.postMessage({ type: 'open-graph', file: card.dataset.file, name: card.dataset.name });
        });
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showContextMenu(e.clientX, e.clientY, card.dataset.file, card.dataset.name);
        });
      });

      list.querySelectorAll('.btn-timeline').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'open-timeline', file: btn.dataset.file, name: btn.dataset.name });
        });
      });
    }

    // ── Context menu ───────────────────────────────────────────────────
    const ctxMenu = document.getElementById('ctx-menu');
    function showContextMenu(x, y, file, name) {
      ctxMenu.innerHTML = '<div class="ctx-item" data-action="export">Export…</div>';
      ctxMenu.classList.remove('hidden');
      // Clamp to viewport
      const vw = window.innerWidth, vh = window.innerHeight;
      ctxMenu.style.left = '0px';
      ctxMenu.style.top = '0px';
      const rect = ctxMenu.getBoundingClientRect();
      ctxMenu.style.left = Math.min(x, vw - rect.width - 4) + 'px';
      ctxMenu.style.top  = Math.min(y, vh - rect.height - 4) + 'px';
      ctxMenu.querySelector('[data-action="export"]').addEventListener('click', (ev) => {
        ev.stopPropagation();
        hideContextMenu();
        vscode.postMessage({ type: 'export-graph', file, name });
      });
    }
    function hideContextMenu() {
      ctxMenu.classList.add('hidden');
      ctxMenu.innerHTML = '';
    }
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.graph-card')) { hideContextMenu(); }
    });
    window.addEventListener('blur', hideContextMenu);

    // ── Message handler ────────────────────────────────────────────────
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'graph-list') {
        allGraphs = msg.files;
        const query = document.getElementById('search').value.toLowerCase();
        renderCards(allGraphs, query);
      }
    });

    // Signal ready so the extension sends the initial list
    vscode.postMessage({ type: 'ready' });
  </script>
  <script nonce="${nonce}" src="${markdownScriptUri}"></script>
  <script nonce="${nonce}" src="${chatScriptUri}"></script>
</body>
</html>`;
  }
}
