import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { GraphIntelligenceResult, ProgressEvent } from './graphIntelligence/provider';
import type { GraphData } from './graphProvider';
import { PROVIDER_CATALOG, getProviderInfo, findProviderForModel } from './graphIntelligence/provider';
import { ChatStore, type ChatMessage, DEFAULT_CHAT_KEY } from './graphIntelligence/chatStore';

export interface SavedGraphMeta {
  name: string;
  description: string;
  savedAt: string;
  file: string;
  /** True for the special, pinned AI Workflow Graph card. */
  isWorkflow?: boolean;
  /** Workflow card lifecycle state; undefined for ordinary saved graphs. */
  status?: 'before' | 'generating' | 'ready';
}

// Forward reference — the actual GraphProvider is passed in at construction time
// to avoid a circular module import.
export interface GraphController {
  show(): void;
  isOpen(): boolean;
  reloadLayout(): void;
  loadGraph(data: unknown, filePath?: string): Promise<void>;
  openTimeline(savedGraphFile: string, name: string): void;
  runGraphIntelligence?(
    prompt: string,
    providerId: string,
    sessionId: string | null,
    onProgress?: (ev: ProgressEvent) => void,
  ): Promise<GraphIntelligenceResult>;
  abortIntelligence?(): void;
  generateWorkflow?(
    providerId: string,
    onProgress?: (ev: ProgressEvent) => void,
  ): Promise<GraphIntelligenceResult>;
  showWorkflowGraph?(graph: GraphData, filePath: string, name: string): Promise<void>;
}

/** Filename of the special, pinned AI Workflow Graph inside `.cograph/`. */
export const WORKFLOW_FILE = '__workflow__.json';

/** Map a streaming progress event to a short label for the generating card. */
export function workflowProgressDetail(ev: ProgressEvent): string {
  switch (ev.kind) {
    case 'init': return 'analyzing graph…';
    case 'thinking': return 'thinking…';
    case 'tool-use': return ev.name ? `${ev.name}…` : 'working…';
    case 'text': return 'writing summary…';
    case 'result': return 'finishing…';
    case 'error': return 'error';
    default: return 'working…';
  }
}

interface LastUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  at: string;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cograph.savedGraphs';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _graphController: GraphController,
    private readonly _chatStore: ChatStore | null = null,
    private readonly _workspaceState: vscode.Memento | null = null,
  ) {}

  /** Current saved-graph context that the chat is reasoning about, if any. */
  private _currentGraph: { name: string; file: string } | null = null;

  /** Transient: true while the AI Workflow Graph is being generated (not persisted). */
  private _workflowGenerating = false;

  /** Usage data from the most recent successful turn, surfaced by /cost. */
  private _lastUsage: LastUsage | null = null;

  private static readonly STATE_KEY_GRAPHS_HEIGHT = 'cograph.sidebar.graphsHeight';

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
          this._view?.webview.postMessage({ type: 'provider-catalog', catalog: PROVIDER_CATALOG });
          this._sendActiveModel();
          this._sendAiEnabled();
          // Restore previously-saved splitter height.
          const savedHeight = this._workspaceState?.get<number>(SidebarProvider.STATE_KEY_GRAPHS_HEIGHT);
          if (typeof savedHeight === 'number' && savedHeight > 0) {
            this._view?.webview.postMessage({ type: 'graphs-height', px: savedHeight });
          }
          // Push the current graph context — this also (re)loads the per-graph chat history.
          this._sendGraphContextAndHistory();
          break;
        }
        case 'chat-send': {
          // Guard: AI features must be enabled before any chat can run.
          if (!this._aiEnabled()) {
            this._view?.webview.postMessage({ type: 'chat-status', stage: 'idle' });
            this._view?.webview.postMessage({ type: 'chat-input-restore', text: msg.prompt });
            this.appendSystem('AI features are off — enable them to chat.');
            await this._openAiSettings();
            break;
          }
          // Guard: a graph must be selected before any chat can run.
          if (!this._currentGraph) {
            this._view?.webview.postMessage({ type: 'chat-status', stage: 'idle' });
            this._view?.webview.postMessage({ type: 'chat-input-restore', text: msg.prompt });
            await this._showGraphPicker();
            // After the picker, leave the input populated so the user can
            // press Enter to send into the now-selected graph's chat.
            break;
          }
          const userMsg: ChatMessage = { role: 'user', text: msg.prompt, at: new Date().toISOString() };
          // Capture the key/provider in use at send-time so a graph or provider
          // swap mid-stream doesn't accidentally write into the wrong chat.
          const sendKey = this._chatStore?.getActiveKey() ?? DEFAULT_CHAT_KEY;
          const sendProvider = vscode.workspace.getConfiguration('cograph')
            .get<string>('graphIntelligence.provider', 'claude-code');
          this._chatStore?.append(userMsg, sendKey);
          this._view?.webview.postMessage({ type: 'chat-append', message: userMsg });
          this._view?.webview.postMessage({ type: 'chat-status', stage: 'thinking' });
          try {
            if (!this._graphController.runGraphIntelligence) {
              throw new Error('Graph Intelligence not available.');
            }
            const onProgress = (ev: ProgressEvent) => {
              if (ev.kind === 'result' && ev.usage) {
                const info = getProviderInfo(sendProvider);
                const modelKey = info?.modelSettingKey ?? 'graphIntelligence.model';
                const modelName = vscode.workspace.getConfiguration('cograph')
                  .get<string>(modelKey, info?.defaultModel ?? '');
                this._lastUsage = {
                  provider: sendProvider,
                  model: modelName,
                  inputTokens: ev.usage.inputTokens,
                  outputTokens: ev.usage.outputTokens,
                  costUsd: ev.usage.costUsd,
                  at: new Date().toISOString(),
                };
              }
              this._view?.webview.postMessage({ type: 'chat-progress', event: ev });
            };
            const sessionId = this._chatStore?.getSessionId(sendProvider, sendKey) ?? null;
            const result = await this._graphController.runGraphIntelligence(msg.prompt, sendProvider, sessionId, onProgress);
            const aiMsg: ChatMessage = { role: 'assistant', text: result.text, at: new Date().toISOString() };
            this._chatStore?.append(aiMsg, sendKey);
            if (result.sessionId !== undefined) {
              this._chatStore?.setSessionId(sendProvider, result.sessionId ?? null, sendKey);
            }
            // Only echo to the UI if the user hasn't switched graphs in the meantime.
            if (this._chatStore?.getActiveKey() === sendKey) {
              this._view?.webview.postMessage({ type: 'chat-append', message: aiMsg });
            }
          } catch (err) {
            const errMsg: ChatMessage = { role: 'error', text: (err as Error).message, at: new Date().toISOString() };
            this._chatStore?.append(errMsg, sendKey);
            if (this._chatStore?.getActiveKey() === sendKey) {
              this._view?.webview.postMessage({ type: 'chat-append', message: errMsg });
            }
          } finally {
            this._view?.webview.postMessage({ type: 'chat-status', stage: 'idle' });
          }
          break;
        }
        case 'chat-cancel':
          // Idle the UI immediately so the user gets instant feedback,
          // then abort the backend. The chat-send finally{} will post idle
          // again once the rejection finishes propagating — that's harmless.
          this._view?.webview.postMessage({ type: 'chat-status', stage: 'idle' });
          this._graphController.abortIntelligence?.();
          break;
        case 'chat-clear':
          this._chatStore?.clear();
          break;
        case 'chat-model-change': {
          await this._setProviderAndModel(msg.provider, msg.model);
          break;
        }
        case 'chat-provider-change': {
          await this._setProviderAndModel(msg.provider, undefined);
          break;
        }
        case 'chat-set-session': {
          // /resume <id> — attach a session id to the current provider+graph.
          const sendKey = this._chatStore?.getActiveKey() ?? DEFAULT_CHAT_KEY;
          const provider = vscode.workspace.getConfiguration('cograph')
            .get<string>('graphIntelligence.provider', 'claude-code');
          const id = typeof msg.sessionId === 'string' && msg.sessionId.trim() ? msg.sessionId.trim() : null;
          this._chatStore?.setSessionId(provider, id, sendKey);
          const info = getProviderInfo(provider);
          const label = info?.displayName ?? provider;
          this.appendSystem(id ? `Resume: attached ${label} session ${id.slice(0, 8)}…` : `Resume: cleared ${label} session.`);
          break;
        }
        case 'chat-show-cost': {
          if (!this._lastUsage) {
            this.appendSystem('Cost: no usage data yet — send a prompt first.');
            break;
          }
          const u = this._lastUsage;
          const tokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
          const costStr = u.costUsd > 0 ? ` · $${u.costUsd.toFixed(3)}` : '';
          this.appendSystem(`Cost: ${u.model} · ${tokens(u.inputTokens)} in / ${tokens(u.outputTokens)} out${costStr}`);
          break;
        }
        case 'chat-open-settings':
          await this._openAiSettings();
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
        case 'workflow-generate':
        case 'workflow-update':
          if (!this._aiEnabled()) {
            await this._openAiSettings();
            break;
          }
          await this._generateWorkflow();
          break;
        case 'open-ai-settings':
          await this._openAiSettings();
          break;
        case 'workflow-open': {
          try {
            const raw = fs.readFileSync(msg.file, 'utf8');
            const data = JSON.parse(raw);
            if (!data?.graph?.nodes) { throw new Error('Workflow graph not generated yet.'); }
            if (!this._graphController.showWorkflowGraph) { throw new Error('Workflow graphs not supported.'); }
            await this._graphController.showWorkflowGraph(data.graph, msg.file, data.name || 'Workflow');
          } catch (err) {
            vscode.window.showErrorMessage(`CoGraph: Failed to open workflow graph — ${(err as Error).message}`);
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
              if (this._currentGraph?.file === msg.file) {
                this.setCurrentGraph(null);
              }
            } catch (err) {
              vscode.window.showErrorMessage(`CoGraph: Failed to delete — ${(err as Error).message}`);
            }
          }
          break;
        }
        case 'chat-new-session': {
          if (!this._chatStore) { break; }
          // Reset ALL provider sessions for this graph so the next prompt starts
          // fresh regardless of which provider it ends up routed to.
          this._chatStore.clearSession();
          const now = new Date();
          const hh = String(now.getHours()).padStart(2, '0');
          const mm = String(now.getMinutes()).padStart(2, '0');
          const divider: ChatMessage = {
            role: 'system',
            text: `── new session · ${hh}:${mm} ──`,
            at: now.toISOString(),
          };
          this._chatStore.append(divider);
          this._view?.webview.postMessage({ type: 'chat-append', message: divider, divider: true });
          break;
        }
        case 'chat-pick-graph': {
          await this._showGraphPicker();
          break;
        }
        case 'set-graphs-height': {
          const px = Number(msg.px);
          if (Number.isFinite(px) && px > 0) {
            await this._workspaceState?.update(SidebarProvider.STATE_KEY_GRAPHS_HEIGHT, Math.round(px));
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

  /** Update the "currently active graph" indicator shown in the chat toolbar, and
   *  swap the active chat to that graph's per-graph history. */
  setCurrentGraph(meta: { name: string; file: string } | null): void {
    this._currentGraph = meta;
    const newKey = meta ? ChatStore.keyFromName(meta.name) : DEFAULT_CHAT_KEY;
    this._chatStore?.setActive(newKey);
    this._sendGraphContextAndHistory();
  }

  private _sendGraphContextAndHistory(): void {
    this._view?.webview.postMessage({ type: 'graph-context-set', graph: this._currentGraph });
    if (this._chatStore) {
      this._view?.webview.postMessage({ type: 'chat-history', messages: this._chatStore.load() });
    } else {
      this._view?.webview.postMessage({ type: 'chat-history', messages: [] });
    }
  }

  /** Append a system-style chat message (e.g. "Graph: X Updated") and persist it. */
  appendSystem(text: string): void {
    if (!this._chatStore) { return; }
    const sysMsg: ChatMessage = {
      role: 'system',
      text,
      at: new Date().toISOString(),
    };
    this._chatStore.append(sysMsg);
    this._view?.webview.postMessage({ type: 'chat-append', message: sysMsg });
  }

  private _configTarget(): vscode.ConfigurationTarget {
    return vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  }

  /** Update provider (and optionally model) settings, then re-broadcast to the webview. */
  private async _setProviderAndModel(provider: string | undefined, model: string | undefined): Promise<void> {
    const target = this._configTarget();
    const cfg = vscode.workspace.getConfiguration('cograph');
    try {
      // Resolve provider: explicit > inferred from model > current
      let resolvedProvider = provider;
      if (!resolvedProvider && model) {
        resolvedProvider = findProviderForModel(model)?.id;
      }
      if (resolvedProvider) {
        const info = getProviderInfo(resolvedProvider);
        if (!info) {
          vscode.window.showErrorMessage(`CoGraph: Unknown provider "${resolvedProvider}".`);
          return;
        }
        await cfg.update('graphIntelligence.provider', resolvedProvider, target);
      }
      if (model) {
        const info = getProviderInfo(resolvedProvider ?? cfg.get<string>('graphIntelligence.provider', 'claude-code'));
        const modelKey = info?.modelSettingKey ?? 'graphIntelligence.model';
        await cfg.update(modelKey, model, target);
      }
      this._sendActiveModel();
    } catch (err) {
      vscode.window.showErrorMessage(`CoGraph: Failed to change model — ${(err as Error).message}`);
    }
  }

  /** Re-read provider+model from settings and push to the webview. */
  private _sendActiveModel(): void {
    const cfg = vscode.workspace.getConfiguration('cograph');
    const provider = cfg.get<string>('graphIntelligence.provider', 'claude-code');
    const info = getProviderInfo(provider);
    const modelKey = info?.modelSettingKey ?? 'graphIntelligence.model';
    const model = cfg.get<string>(modelKey, info?.defaultModel ?? 'sonnet');
    this._view?.webview.postMessage({ type: 'chat-model-set', provider, model });
  }

  /** Whether the user has opted into AI features (Chat + Workflow Graph). */
  private _aiEnabled(): boolean {
    return vscode.workspace.getConfiguration('cograph')
      .get<boolean>('graphIntelligence.enabled', false);
  }

  /** Push the current AI-enabled state so the webview can gray-out/un-gray. */
  private _sendAiEnabled(): void {
    this._view?.webview.postMessage({ type: 'ai-enabled', enabled: this._aiEnabled() });
  }

  /** Re-read the AI-enabled flag and push it to the webview (called on config change). */
  public refreshAiEnabled(): void {
    this._sendAiEnabled();
  }

  /** Open native VS Code settings filtered to CoGraph's AI settings. */
  private async _openAiSettings(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'cograph.graphIntelligence');
    } catch (err) {
      vscode.window.showErrorMessage(`CoGraph: Could not open settings — ${(err as Error).message}`);
    }
  }

  private async _showGraphPicker(): Promise<void> {
    const files = this._listCographFiles();
    type Item = vscode.QuickPickItem & { kind?: vscode.QuickPickItemKind; meta?: SavedGraphMeta; action?: 'new' };
    const activeFile = this._currentGraph?.file;
    const items: Item[] = files.map(f => ({
      label: (f.file === activeFile ? '$(circle-filled) ' : '$(circle-outline) ') + f.name,
      description: f.file === activeFile ? '(active)' : (f.description || ''),
      meta: f,
    }));
    if (items.length > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({ label: '$(add) New graph…', action: 'new' });
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Select graph for chat',
      placeHolder: 'Pick a saved graph to switch context, or create a new one',
      matchOnDescription: true,
    });
    if (!picked) { return; }
    if (picked.action === 'new') {
      if (this._graphController.isOpen()) {
        this._graphController.reloadLayout();
      } else {
        this._graphController.show();
      }
      return;
    }
    if (picked.meta) {
      try {
        const raw = fs.readFileSync(picked.meta.file, 'utf8');
        const data = JSON.parse(raw);
        await this._graphController.loadGraph(data, picked.meta.file);
      } catch (err) {
        vscode.window.showErrorMessage(`CoGraph: Failed to load graph — ${(err as Error).message}`);
      }
    }
  }

  private _sendGraphList(): void {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const regular = this._listCographFiles();
    // The Workflow Graph is always the first (pinned) card, in one of three states.
    const files = ws
      ? [this._workflowMeta(path.join(ws, '.cograph')), ...regular]
      : regular;
    this._view?.webview.postMessage({ type: 'graph-list', files });
  }

  /** Build the pinned Workflow card metadata from disk + transient generating state. */
  private _workflowMeta(dir: string): SavedGraphMeta {
    const file = path.join(dir, WORKFLOW_FILE);
    let status: SavedGraphMeta['status'] = 'before';
    let savedAt = '';
    if (this._workflowGenerating) {
      status = 'generating';
    } else if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data && data.graph && Array.isArray(data.graph.nodes)) {
          status = 'ready';
          savedAt = data.savedAt || '';
        }
      } catch { /* corrupt file → treat as before */ }
    }
    return { name: 'Workflow', description: '', savedAt, file, isWorkflow: true, status };
  }

  /**
   * Generate (or re-generate) the AI Workflow Graph: drive the provider through
   * GraphController.generateWorkflow, stream progress to the pinned card, persist
   * the normalized result to `.cograph/__workflow__.json`, and refresh the list.
   */
  private async _generateWorkflow(): Promise<void> {
    if (this._workflowGenerating) { return; }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { vscode.window.showErrorMessage('CoGraph: No workspace folder open.'); return; }
    if (!this._graphController.generateWorkflow) {
      vscode.window.showErrorMessage('CoGraph: Workflow generation not available.');
      return;
    }
    const provider = vscode.workspace.getConfiguration('cograph')
      .get<string>('graphIntelligence.provider', 'claude-code');

    this._workflowGenerating = true;
    this._sendGraphList();
    this._postWorkflowStatus('generating', 'starting…');
    try {
      const onProgress = (ev: ProgressEvent) => this._postWorkflowStatus('generating', workflowProgressDetail(ev));
      const result = await this._graphController.generateWorkflow(provider, onProgress);
      const dir = path.join(ws, '.cograph');
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      const file = path.join(dir, WORKFLOW_FILE);
      const payload = {
        version: 1,
        name: 'Workflow',
        isWorkflow: true,
        status: 'ready',
        description: '',
        savedAt: new Date().toISOString(),
        graph: result.graph,
        text: result.text,
      };
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
      this._workflowGenerating = false;
      this._sendGraphList();
      this.appendSystem('Workflow graph generated.');
    } catch (err) {
      this._workflowGenerating = false;
      this._sendGraphList();
      vscode.window.showErrorMessage(`CoGraph: Workflow generation failed — ${(err as Error).message}`);
    }
  }

  private _postWorkflowStatus(status: 'before' | 'generating' | 'ready', detail?: string): void {
    this._view?.webview.postMessage({ type: 'workflow-status', status, detail });
  }

  private _listCographFiles(): SavedGraphMeta[] {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { return []; }
    const dir = path.join(ws, '.cograph');
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && f !== WORKFLOW_FILE)
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

    html, body { height: 100%; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ── Pane layout: Chat (top, flex) / Splitter / Saved Graphs (bottom, sized) ── */
    .pane {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 0;
    }
    .pane--chat   { flex: 1 1 auto; min-height: 140px; }
    .pane--graphs { flex: 0 0 var(--cg-graphs-height, 240px); min-height: 80px; }
    .pane .section-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
    .pane.pane--collapsed { flex: 0 0 auto; min-height: 0; }
    .pane.pane--collapsed .section-body { display: none; }

    /* When either pane is collapsed, the splitter has no meaning. */
    body.no-splitter .splitter { display: none; }

    /* ── AI-features gate (transparency / opt-in consent) ──────────────── */
    #pane-chat { position: relative; }
    #chat-gate { display: none; }
    body.ai-disabled #chat-gate {
      display: flex;
      position: absolute;
      inset: 0;
      z-index: 30;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      text-align: center;
      padding: 16px;
      background: rgba(0, 0, 0, 0.45);
    }
    body.ai-disabled #body-chat {
      filter: grayscale(1);
      opacity: 0.45;
      pointer-events: none;
    }
    .ai-gate-title { font-size: 12px; font-weight: 600; color: var(--vscode-foreground); }
    .ai-gate-text { font-size: 11px; opacity: 0.85; max-width: 230px; line-height: 1.45; color: var(--vscode-foreground); }
    .ai-gate-btn {
      padding: 6px 14px; font-size: 12px; font-weight: 600; border-radius: 4px; cursor: pointer;
      border: 1px solid var(--vscode-button-background, #0e639c);
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    .ai-gate-btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    /* Locked AI Workflow Graph card while AI is disabled. */
    .workflow-card.locked { opacity: 0.6; border-style: dashed; cursor: pointer; }
    .workflow-card.locked:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }

    /* Splitter mimics VS Code's sash between sidebar sections: invisible by
       default, faint hover highlight, 8px hit zone straddling the section border. */
    .splitter {
      flex: 0 0 0;                 /* zero visible thickness */
      background: transparent;
      cursor: ns-resize;
      position: relative;
      user-select: none;
    }
    .splitter::before {            /* hit zone + hover indicator */
      content: '';
      position: absolute;
      left: 0; right: 0;
      top: -4px; bottom: -4px;     /* 8px straddling the boundary */
      background: transparent;
    }
    .splitter:hover::before,
    .splitter.dragging::before {
      background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder, #007acc));
      opacity: 0.5;
    }
    body.dragging-splitter, body.dragging-splitter * { cursor: ns-resize !important; }

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

    /* ── Pinned AI Workflow Graph card (3 states) ───────────────────── */
    .workflow-card {
      border: 2px dotted var(--vscode-focusBorder, #007fd4);
      border-radius: 6px;
      background: var(--vscode-editor-background, #1e1e1e);
      padding: 9px 11px;
      display: grid;
      gap: 5px;
      cursor: pointer;
      margin-bottom: 6px;
    }
    .workflow-card.before:hover,
    .workflow-card.ready:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
    .workflow-card.ready {
      border-style: solid;
      border-width: 3px;
    }
    .workflow-card.generating {
      cursor: default;
      border-style: dashed;
      background-image: repeating-linear-gradient(45deg,
        transparent, transparent 6px,
        rgba(127,127,127,0.07) 6px, rgba(127,127,127,0.07) 12px);
      background-size: 200% 100%;
      animation: wf-march 0.8s linear infinite;
    }
    @keyframes wf-march { from { background-position: 0 0; } to { background-position: 34px 0; } }
    .wf-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .wf-title {
      font-size: 12px; font-weight: 600; color: var(--vscode-foreground);
      display: flex; align-items: center; gap: 6px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .wf-glyph { color: var(--vscode-focusBorder, #007fd4); font-weight: 700; }
    .wf-sub { font-size: 11px; opacity: 0.7; }
    .btn-wf-update {
      font-size: 10px; padding: 2px 7px; border-radius: 4px; cursor: pointer; border: none;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    .btn-wf-update:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    .wf-bar { height: 3px; border-radius: 2px; overflow: hidden; background: rgba(127,127,127,0.2); }
    .wf-bar > span {
      display: block; height: 100%; width: 40%; border-radius: 2px;
      background: var(--vscode-focusBorder, #007fd4);
      animation: wf-slide 1.1s ease-in-out infinite;
    }
    @keyframes wf-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }

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

    /* Chat section header: just the chevron + CHAT label, plus a live-dot for streaming */
    .chat-section-header { position: relative; }
    .chat-live-dot {
      width: 6px;
      height: 6px;
      margin-left: 6px;
      border-radius: 50%;
      background: var(--cg-accent);
      opacity: 0;
      transition: opacity 200ms ease;
      box-shadow: 0 0 6px var(--cg-accent-dim);
    }
    .chat-live-dot.live {
      opacity: 1;
      animation: cg-pulse 1.4s ease-in-out infinite;
    }
    @keyframes cg-pulse {
      0%, 100% { transform: scale(1);   opacity: 1; }
      50%      { transform: scale(1.6); opacity: 0.35; }
    }

    /* ── Chat toolbar (row 2 of header) ────────────────────────────────── */
    #body-chat {
      display: flex;
      flex-direction: column;
      padding: 8px 12px;
      overflow: visible;      /* model menu may overlay; inner #chat-scroll is the only scroller */
      min-height: 0;
    }
    .chat-toolbar {
      position: relative;
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 8px;
    }
    .chip {
      flex: 1 1 0;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 5px 8px;
      font-family: var(--cg-mono);
      font-size: 10.5px;
      letter-spacing: 0.02em;
      text-transform: none;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 999px;
      cursor: pointer;
      transition: border-color 180ms ease, color 180ms ease, background 180ms ease;
    }
    .chip:hover {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .chip:focus-visible {
      outline: 2px solid var(--vscode-focusBorder, #007fd4);
      outline-offset: 1px;
    }
    .chip-glyph { font-size: 9px; opacity: 0.7; flex-shrink: 0; }
    .chip-glyph--graph { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .chip-glyph--graph.active { color: var(--cg-accent); opacity: 1; }
    .chip-glyph--model { font-size: 8px; }
    .chip-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .chip--model.streaming {
      color: var(--cg-accent);
      border-color: var(--cg-accent-dim);
    }
    .chip-icon {
      flex: 0 0 auto;
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      transition: color 180ms ease, border-color 180ms ease, background 180ms ease;
    }
    .chip-icon:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-list-hoverBackground);
    }
    .chip-icon:focus-visible {
      outline: 2px solid var(--vscode-focusBorder, #007fd4);
      outline-offset: 1px;
    }

    .model-menu {
      position: absolute;
      right: 32px;             /* sits just under-left of the gear */
      top: calc(100% + 4px);
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
    .model-menu .mm-header {
      padding: 8px 10px 4px;
      font-family: var(--cg-mono);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
    }
    .model-menu .mm-header:not(:first-child) {
      border-top: 1px solid var(--vscode-menu-border, #454545);
      margin-top: 4px;
    }
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
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 8px;
    }

    /* Empty-state suggested-prompt chips (shown when chat history is empty) */
    .empty-prompts {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 6px 0 8px;
      padding: 4px 0;
    }
    .empty-prompts-label {
      font-family: var(--cg-mono);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      opacity: 0.7;
      margin-bottom: 2px;
    }
    .empty-prompt-chip {
      text-align: left;
      padding: 7px 10px;
      font-size: 12px;
      color: var(--vscode-foreground);
      background: transparent;
      border: 1px dashed var(--vscode-widget-border, #444);
      border-radius: 6px;
      cursor: pointer;
      transition: border-color 180ms ease, background 180ms ease, color 180ms ease;
    }
    .empty-prompt-chip:hover {
      border-style: solid;
      border-color: var(--cg-accent-dim);
      background: color-mix(in srgb, var(--cg-accent) 6%, transparent);
    }

    /* System bubbles — used for "Graph: X Updated" and "── new session ──" dividers */
    .bubble--system {
      align-self: center;
      max-width: 92%;
      padding: 4px 12px;
      background: transparent;
      border: none;
      border-top: 1px solid var(--cg-accent-dim);
      border-bottom: 1px solid var(--cg-accent-dim);
      color: var(--vscode-descriptionForeground);
      font-family: var(--cg-mono);
      font-size: 10.5px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      text-align: center;
      border-radius: 0;
      white-space: pre-wrap;
    }
    .bubble--system.bubble--divider {
      border-top: none;
      border-bottom: none;
      color: var(--cg-accent);
      opacity: 0.75;
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
    .input-wrap { position: relative; }
    .slash-menu {
      position: absolute;
      bottom: calc(100% + 4px);
      left: 0;
      right: 0;
      z-index: 30;
      background: var(--vscode-menu-background, #252526);
      color: var(--vscode-menu-foreground, #cccccc);
      border: 1px solid var(--vscode-menu-border, #454545);
      border-radius: 6px;
      padding: 4px 0;
      box-shadow: 0 4px 14px rgba(0,0,0,0.35);
      font-size: 12px;
      max-height: 200px;
      overflow-y: auto;
    }
    .slash-menu.hidden { display: none; }
    .slash-item {
      display: grid;
      grid-template-columns: 130px 1fr;
      gap: 8px;
      padding: 5px 10px;
      cursor: pointer;
      align-items: baseline;
    }
    .slash-item:hover,
    .slash-item.selected {
      background: var(--vscode-menu-selectionBackground, #094771);
    }
    .slash-name {
      font-family: var(--cg-mono);
      font-size: 11.5px;
      color: var(--cg-accent);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .slash-desc {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.3;
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
<body class="ai-disabled">

  <!-- CHAT pane (fixed top) -->
  <div class="pane pane--chat" id="pane-chat">
    <div class="section-header chat-section-header" id="hdr-chat">
      <span class="chevron">▼</span>
      <span>Chat</span>
      <span class="chat-live-dot" aria-hidden="true"></span>
    </div>
    <div class="section-body" id="body-chat">
      <div class="chat-toolbar" id="chat-toolbar">
        <button id="btn-new-session" class="chip chip--action" type="button" title="Start a new chat session">
          <span class="chip-glyph">+</span><span class="chip-label">New Session</span>
        </button>
        <button id="btn-graph-pick" class="chip chip--graph" type="button" title="Choose the graph this chat is about">
          <span id="graph-dot" class="chip-glyph chip-glyph--graph">○</span><span id="graph-name" class="chip-label">Open a graph…</span>
        </button>
        <button id="model-pill" class="chip chip--model" type="button" title="Change model">
          <span id="model-glyph" class="chip-glyph chip-glyph--model">◆</span><span id="model-name" class="chip-label">sonnet</span>
        </button>
        <button id="model-settings" class="chip-icon" type="button" title="Graph Intelligence settings" aria-label="Settings">⚙</button>
        <div id="model-menu" class="model-menu hidden"></div>
      </div>
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
        <div class="input-wrap">
          <div id="slash-menu" class="slash-menu hidden"></div>
          <textarea id="chat-input" rows="2" placeholder="Ask CoGraph…  (type / for commands)"></textarea>
        </div>
        <div class="chat-form-actions">
          <button id="chat-cancel" type="button" style="display:none">Cancel</button>
          <button id="chat-send" type="submit">Send</button>
        </div>
      </form>
    </div>
    <div id="chat-gate">
      <div class="ai-gate-title">AI features are off</div>
      <div class="ai-gate-text">Chat and the AI Workflow Graph run an AI CLI on your behalf. Enable them to get started — you can choose the model, timeout and more.</div>
      <button id="btn-enable-ai" class="ai-gate-btn" type="button">Enable AI Features</button>
    </div>
  </div>

  <!-- Splitter between Chat (above) and Saved Graphs (below) -->
  <div class="splitter" id="cg-splitter" role="separator" aria-orientation="horizontal" title="Drag to resize"></div>

  <!-- SAVED GRAPHS pane (fixed bottom) -->
  <div class="pane pane--graphs" id="pane-graphs">
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
  </div>

  <div id="ctx-menu" class="hidden"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ── Section collapsing (also toggles pane state so the splitter hides) ───
    function refreshSplitterVisibility() {
      const anyCollapsed =
        document.getElementById('pane-chat').classList.contains('pane--collapsed') ||
        document.getElementById('pane-graphs').classList.contains('pane--collapsed');
      document.body.classList.toggle('no-splitter', anyCollapsed);
    }
    function wireSection(headerId, bodyId, paneId) {
      const hdr = document.getElementById(headerId);
      const body = document.getElementById(bodyId);
      const pane = document.getElementById(paneId);
      hdr.addEventListener('click', () => {
        const collapsed = hdr.classList.toggle('collapsed');
        body.classList.toggle('hidden', collapsed);
        pane.classList.toggle('pane--collapsed', collapsed);
        refreshSplitterVisibility();
      });
    }
    wireSection('hdr-chat',   'body-chat',   'pane-chat');
    wireSection('hdr-graphs', 'body-graphs', 'pane-graphs');

    // ── Splitter drag (resizes the Saved-Graphs pane height) ─────────────
    (function wireSplitter() {
      const splitter = document.getElementById('cg-splitter');
      const paneGraphs = document.getElementById('pane-graphs');
      if (!splitter || !paneGraphs) { return; }

      const MIN_GRAPHS = 80;
      const MIN_CHAT = 140;

      let startY = 0;
      let startHeight = 0;

      function onMove(e) {
        const total = document.body.clientHeight;
        const maxGraphs = Math.max(MIN_GRAPHS, total - MIN_CHAT - 4 /* splitter */);
        const next = Math.max(MIN_GRAPHS, Math.min(maxGraphs, startHeight - (e.clientY - startY)));
        document.body.style.setProperty('--cg-graphs-height', next + 'px');
      }
      function onUp() {
        splitter.classList.remove('dragging');
        document.body.classList.remove('dragging-splitter');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        const px = paneGraphs.offsetHeight;
        vscode.postMessage({ type: 'set-graphs-height', px });
      }
      splitter.addEventListener('mousedown', (e) => {
        if (document.body.classList.contains('no-splitter')) { return; }
        e.preventDefault();
        startY = e.clientY;
        startHeight = paneGraphs.offsetHeight;
        splitter.classList.add('dragging');
        document.body.classList.add('dragging-splitter');
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    })();

    // ── Search ─────────────────────────────────────────────────────────
    let allGraphs = [];

    // Whether the user has opted into AI features (Chat + Workflow Graph).
    let aiEnabled = false;

    document.getElementById('search').addEventListener('input', (e) => {
      renderCards(allGraphs, e.target.value.toLowerCase());
    });

    // ── New Graph ──────────────────────────────────────────────────────
    document.getElementById('btn-new-graph').addEventListener('click', () => {
      vscode.postMessage({ type: 'new-graph' });
    });

    // ── Enable AI Features (consent gate) ──────────────────────────────
    document.getElementById('btn-enable-ai').addEventListener('click', () => {
      vscode.postMessage({ type: 'open-ai-settings' });
    });

    // ── Card rendering ─────────────────────────────────────────────────
    function formatDate(iso) {
      if (!iso) return '';
      try {
        return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      } catch { return ''; }
    }

    function renderWorkflowCard(g) {
      const status = g.status || 'before';
      const safeFile = g.file.replace(/"/g, '&quot;');
      if (!aiEnabled) {
        return \`<div class="workflow-card locked" title="Enable AI Features to generate the Workflow Graph">
          <div class="wf-row">
            <span class="wf-title"><span class="wf-glyph">⇉</span> Workflow Graph</span>
          </div>
          <div class="wf-sub">Enable AI Features to generate</div>
        </div>\`;
      }
      if (status === 'ready') {
        return \`<div class="workflow-card ready" data-file="\${safeFile}" title="Open the AI Workflow Graph">
          <div class="wf-row">
            <span class="wf-title"><span class="wf-glyph">⇉</span> Workflow Graph</span>
            <button class="btn-wf-update" title="Regenerate the workflow graph">Update</button>
          </div>
          <div class="wf-sub">Backend → Frontend · AI generated</div>
        </div>\`;
      }
      if (status === 'generating') {
        return \`<div class="workflow-card generating">
          <div class="wf-row">
            <span class="wf-title"><span class="wf-glyph">⇉</span> Generating workflow graph</span>
          </div>
          <div class="wf-sub" id="wf-detail">working…</div>
          <div class="wf-bar"><span></span></div>
        </div>\`;
      }
      return \`<div class="workflow-card before" title="Generate the AI Workflow Graph">
        <div class="wf-row">
          <span class="wf-title"><span class="wf-glyph">⇉</span> Generate workflow graph</span>
        </div>
        <div class="wf-sub">AI-generated Backend → Frontend pipeline</div>
      </div>\`;
    }

    function wireWorkflowCard(list) {
      const locked = list.querySelector('.workflow-card.locked');
      if (locked) {
        locked.addEventListener('click', () => vscode.postMessage({ type: 'open-ai-settings' }));
        return;
      }
      const before = list.querySelector('.workflow-card.before');
      if (before) {
        before.addEventListener('click', () => vscode.postMessage({ type: 'workflow-generate' }));
      }
      const ready = list.querySelector('.workflow-card.ready');
      if (ready) {
        ready.addEventListener('click', (e) => {
          if (e.target.closest('.btn-wf-update')) { return; }
          vscode.postMessage({ type: 'workflow-open', file: ready.dataset.file });
        });
        const upd = ready.querySelector('.btn-wf-update');
        if (upd) {
          upd.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'workflow-update' });
          });
        }
      }
    }

    function renderCards(graphs, query) {
      const list = document.getElementById('graph-list');
      const workflow = graphs.find(g => g.isWorkflow);
      const rest = graphs.filter(g => !g.isWorkflow);
      const filtered = query
        ? rest.filter(g => g.name.toLowerCase().includes(query) || g.description.toLowerCase().includes(query))
        : rest;

      let html = workflow ? renderWorkflowCard(workflow) : '';
      if (filtered.length === 0) {
        if (query) { html += '<div class="empty-state">No matches.</div>'; }
        else if (!rest.length) { html += '<div class="empty-state">No saved graphs yet.</div>'; }
      } else {
        html += filtered.map(g => {
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
      }
      list.innerHTML = html;

      wireWorkflowCard(list);

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

    // ── Toolbar buttons (New Session, Graph picker) ─────────────────────
    const btnNewSession = document.getElementById('btn-new-session');
    if (btnNewSession) {
      btnNewSession.addEventListener('click', () => {
        vscode.postMessage({ type: 'chat-new-session' });
        const input = document.getElementById('chat-input');
        if (input) { input.focus(); }
      });
    }
    const btnGraphPick = document.getElementById('btn-graph-pick');
    if (btnGraphPick) {
      btnGraphPick.addEventListener('click', () => {
        vscode.postMessage({ type: 'chat-pick-graph' });
      });
    }

    // ── Message handler ────────────────────────────────────────────────
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'graph-list') {
        allGraphs = msg.files;
        const query = document.getElementById('search').value.toLowerCase();
        renderCards(allGraphs, query);
      } else if (msg.type === 'graph-context-set') {
        const dot  = document.getElementById('graph-dot');
        const name = document.getElementById('graph-name');
        const btn  = document.getElementById('btn-graph-pick');
        if (msg.graph && msg.graph.name) {
          if (dot)  { dot.textContent = '◉'; dot.classList.add('active'); }
          if (name) { name.textContent = msg.graph.name; }
          if (btn)  { btn.title = 'Chat about: ' + msg.graph.name + ' — click to switch'; }
        } else {
          if (dot)  { dot.textContent = '○'; dot.classList.remove('active'); }
          if (name) { name.textContent = 'Open a graph…'; }
          if (btn)  { btn.title = 'Choose a graph for this chat'; }
        }
      } else if (msg.type === 'graphs-height') {
        if (typeof msg.px === 'number' && msg.px > 0) {
          document.body.style.setProperty('--cg-graphs-height', msg.px + 'px');
        }
      } else if (msg.type === 'workflow-status') {
        if (msg.status === 'generating' && msg.detail) {
          const d = document.getElementById('wf-detail');
          if (d) { d.textContent = msg.detail; }
        }
      } else if (msg.type === 'ai-enabled') {
        aiEnabled = !!msg.enabled;
        document.body.classList.toggle('ai-disabled', !aiEnabled);
        // Re-render the saved-graphs list so the workflow card reflects the new state.
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
