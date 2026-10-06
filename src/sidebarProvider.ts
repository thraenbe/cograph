import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { GraphIntelligenceResult, ProgressEvent } from './graphIntelligence/provider';
import type { GraphData } from './graphProvider';
import { ANNOTATION_CARD_CSS, ANNOTATION_CARD_SCRIPT } from './graphIntelligence/annotationCard';
import { readSubgraphField, normalize as normalizeScope } from './subgraphScope';
import { scanStructure } from './structureScanner';
import { buildPickerFolders, SUBGRAPH_PICKER_CSS, SUBGRAPH_PICKER_MARKUP, SUBGRAPH_PICKER_SCRIPT } from './subgraphPicker';
import { SAVED_LAYOUT_VERSION } from './graphProvider';
import type { AnnotationStatus } from './graphIntelligence/annotationTypes';

export interface SavedGraphMeta {
  name: string;
  description: string;
  savedAt: string;
  file: string;
  /** True for the special, pinned AI Workflow Graph card. */
  isWorkflow?: boolean;
  /** Workflow card lifecycle state; undefined for ordinary saved graphs. */
  status?: 'before' | 'generating' | 'ready';
  /** True when the file carries a `subgraph` field (round 3): a scoped saved graph. */
  isSubgraph?: boolean;
  /** Number of included folders of a subgraph. */
  folderCount?: number;
}

// Forward reference — the actual GraphProvider is passed in at construction time
// to avoid a circular module import.
export interface GraphController {
  show(): void;
  isOpen(): boolean;
  reloadLayout(): void;
  loadGraph(data: unknown, filePath?: string): Promise<void>;
  openTimeline(savedGraphFile: string, name: string): void;
  abortIntelligence?(): void;
  generateWorkflow?(
    providerId: string,
    onProgress?: (ev: ProgressEvent) => void,
  ): Promise<GraphIntelligenceResult>;
  showWorkflowGraph?(graph: GraphData, filePath: string, name: string): Promise<void>;
  annotateGraph?(providerId: string): Promise<unknown>;
  cancelAnnotate?(): void;
  annotationStatus?(): AnnotationStatus;
  onAnnotationStatus?(listener: (s: AnnotationStatus) => void): { dispose(): void };
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

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cograph.savedGraphs';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _graphController: GraphController,
    private readonly _workspaceState: vscode.Memento | null = null,
  ) {}

  /** The saved graph currently open in the panel, if any. */
  private _currentGraph: { name: string; file: string } | null = null;

  /** Transient: true while the AI Workflow Graph is being generated (not persisted). */
  private _workflowGenerating = false;

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

    const annotateSub = this._graphController.onAnnotationStatus?.((status) => {
      this._view?.webview.postMessage({ type: 'annotate-status', status });
    });

    webviewView.onDidDispose(() => {
      this._view = undefined;
      annotateSub?.dispose();
      this._graphController.abortIntelligence?.();
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready': {
          this._sendGraphList();
          this._sendAiEnabled();
          this._sendAnnotateStatus();
          // Restore previously-saved splitter height.
          const savedHeight = this._workspaceState?.get<number>(SidebarProvider.STATE_KEY_GRAPHS_HEIGHT);
          if (typeof savedHeight === 'number' && savedHeight > 0) {
            this._view?.webview.postMessage({ type: 'graphs-height', px: savedHeight });
          }
          break;
        }
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
        case 'annotate-generate':
        case 'annotate-update':
          if (!this._aiEnabled()) {
            await this._openAiSettings();
            break;
          }
          await this._annotateGraph();
          break;
        case 'annotate-cancel':
          // Deliberately not gated: stopping a run must work even if AI was just switched off.
          this._graphController.cancelAnnotate?.();
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
        case 'subgraph-picker-open':
          this._openSubgraphPicker();
          break;
        case 'subgraph-create':
          await this._createSubgraph(String(msg.name ?? ''), Array.isArray(msg.include) ? msg.include.map(String) : []);
          break;
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

  /** Record which saved graph is open (called by the graph panel on load/save/close). */
  setCurrentGraph(meta: { name: string; file: string } | null): void {
    this._currentGraph = meta;
  }

  /** Whether the user has opted into AI features (Workflow Graph + Annotate Graph). */
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
    } catch (err) {
      this._workflowGenerating = false;
      this._sendGraphList();
      vscode.window.showErrorMessage(`CoGraph: Workflow generation failed — ${(err as Error).message}`);
    }
  }

  /** Push the Annotate Graph card state (also sent on every status change via the subscription). */
  private _sendAnnotateStatus(): void {
    const status = this._graphController.annotationStatus?.();
    if (status) { this._view?.webview.postMessage({ type: 'annotate-status', status }); }
  }

  /** Start, resume or update annotations. The controller confirms an estimate with the user first. */
  private async _annotateGraph(): Promise<void> {
    if (!this._graphController.annotateGraph) {
      vscode.window.showErrorMessage('CoGraph: Annotate Graph is not available.');
      return;
    }
    const provider = vscode.workspace.getConfiguration('cograph')
      .get<string>('graphIntelligence.provider', 'claude-code');
    try {
      await this._graphController.annotateGraph(provider);
    } catch (err) {
      vscode.window.showErrorMessage(`CoGraph: Annotate Graph failed — ${(err as Error).message}`);
    } finally {
      this._sendAnnotateStatus();
    }
  }

  private _postWorkflowStatus(status: 'before' | 'generating' | 'ready', detail?: string): void {
    this._view?.webview.postMessage({ type: 'workflow-status', status, detail });
  }

  /** Scan the workspace and hand the picker its folder rows plus a free default name. */
  private _openSubgraphPicker(): void {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { vscode.window.showErrorMessage('CoGraph: No workspace folder open.'); return; }
    try {
      const folders = buildPickerFolders(scanStructure(ws), ws);
      if (folders.length === 0) {
        vscode.window.showInformationMessage('CoGraph: No source folders found in this workspace.');
        return;
      }
      const taken = new Set(this._listCographFiles().map(g => g.name));
      let n = 1;
      while (taken.has(`Subgraph ${n}`)) { n++; }
      this._view?.webview.postMessage({ type: 'subgraph-picker', root: ws, folders, defaultName: `Subgraph ${n}` });
    } catch (err) {
      vscode.window.showErrorMessage(`CoGraph: Could not read the folder tree — ${(err as Error).message}`);
    }
  }

  /** Write `.cograph/<name>.json` with the subgraph field (no layout yet) and open it. */
  private async _createSubgraph(rawName: string, include: string[]): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { vscode.window.showErrorMessage('CoGraph: No workspace folder open.'); return; }
    const name = rawName.trim();
    const spec = normalizeScope({ include, exclude: [] });
    if (!name) { vscode.window.showErrorMessage('CoGraph: The subgraph needs a name.'); return; }
    if (spec.include.length === 0) { vscode.window.showErrorMessage('CoGraph: Pick at least one folder for the subgraph.'); return; }
    if (spec.include.length === 1 && spec.include[0] === '.') {
      vscode.window.showErrorMessage('CoGraph: That is the whole project — use "+ New Graph" for that.');
      return;
    }
    const dir = path.join(ws, '.cograph');
    const file = path.join(dir, name.replace(/[^a-zA-Z0-9_\- ]/g, '_') + '.json');
    try {
      if (fs.existsSync(file)) {
        const choice = await vscode.window.showWarningMessage(`"${name}" already exists. Replace it?`, { modal: true }, 'Replace');
        if (choice !== 'Replace') { return; }
      }
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      const data = { version: SAVED_LAYOUT_VERSION, name, description: '', savedAt: new Date().toISOString(), subgraph: spec };
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
      this._sendGraphList();
      await this._graphController.loadGraph(data, file);
    } catch (err) {
      vscode.window.showErrorMessage(`CoGraph: Failed to create the subgraph — ${(err as Error).message}`);
    }
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
          const spec = readSubgraphField(data);
          return {
            name: data.name || f.replace('.json', ''),
            description: data.description || '',
            savedAt: data.savedAt || '',
            file: path.join(dir, f),
            ...(spec ? { isSubgraph: true, folderCount: spec.include.length } : {}),
          };
        } catch {
          return null;
        }
      })
      .filter((x): x is SavedGraphMeta => x !== null);
  }

  private _buildHtml(_webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
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

    /* ── Pane layout: Primary (top, flex) / Splitter / Saved Graphs (bottom, sized) ──
       The primary pane held Chat (since removed); it is an empty, hidden slot until the
       next primary view fills it. While hidden, Saved Graphs takes the full height. */
    .pane {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      min-height: 0;
    }
    .pane--primary { flex: 1 1 auto; min-height: 140px; }
    #pane-primary[hidden] { display: none; }
    #pane-primary[hidden] ~ .splitter { display: none; }
    #pane-primary[hidden] ~ .pane--graphs:not(.pane--collapsed) { flex: 1 1 auto; }
    .pane--graphs { flex: 0 0 var(--cg-graphs-height, 240px); min-height: 80px; }
    .pane .section-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
    .pane.pane--collapsed { flex: 0 0 auto; min-height: 0; }
    .pane.pane--collapsed .section-body { display: none; }

    /* When either pane is collapsed, the splitter has no meaning. */
    body.no-splitter .splitter { display: none; }

    /* ── AI-features gate (transparency / opt-in consent) ──────────────── */
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
${ANNOTATION_CARD_CSS}${SUBGRAPH_PICKER_CSS}
    .card-glyph {
      display: inline-block; margin-right: 5px; font-weight: 700;
      color: var(--vscode-focusBorder, #007fd4);
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

  </style>
</head>
<body class="ai-disabled">

  <!-- PRIMARY pane (top): an empty slot since Chat was removed; hidden while empty -->
  <div class="pane pane--primary" id="pane-primary" hidden></div>

  <!-- Splitter between the primary pane (above) and Saved Graphs (below) -->
  <div class="splitter" id="cg-splitter" role="separator" aria-orientation="horizontal" title="Drag to resize"></div>

  <!-- SAVED GRAPHS pane (fixed bottom) -->
  <div class="pane pane--graphs" id="pane-graphs">
    <div class="section-header" id="hdr-graphs">
      <span class="chevron">▼</span>
      <span>Saved Graphs</span>
    </div>
    <div class="section-body" id="body-graphs">
      <button id="btn-new-graph">+ New Graph</button>${SUBGRAPH_PICKER_MARKUP}
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
      const anyCollapsed = Array.from(document.querySelectorAll('.pane'))
        .some((pane) => pane.classList.contains('pane--collapsed'));
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
    wireSection('hdr-graphs', 'body-graphs', 'pane-graphs');

    // ── Splitter drag (resizes the Saved-Graphs pane height) ─────────────
    (function wireSplitter() {
      const splitter = document.getElementById('cg-splitter');
      const paneGraphs = document.getElementById('pane-graphs');
      if (!splitter || !paneGraphs) { return; }

      const MIN_GRAPHS = 80;
      const MIN_PRIMARY = 140;

      let startY = 0;
      let startHeight = 0;

      function onMove(e) {
        const total = document.body.clientHeight;
        const maxGraphs = Math.max(MIN_GRAPHS, total - MIN_PRIMARY - 4 /* splitter */);
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

    // Whether the user has opted into AI features (Workflow Graph + Annotate Graph).
    let aiEnabled = false;

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

${ANNOTATION_CARD_SCRIPT}
${SUBGRAPH_PICKER_SCRIPT}
    wireSubgraphPicker();

    function renderCards(graphs, query) {
      const list = document.getElementById('graph-list');
      const workflow = graphs.find(g => g.isWorkflow);
      const rest = graphs.filter(g => !g.isWorkflow);
      const filtered = query
        ? rest.filter(g => g.name.toLowerCase().includes(query) || g.description.toLowerCase().includes(query))
        : rest;

      let html = (workflow ? renderWorkflowCard(workflow) : '') + renderAnnotateCard();
      if (filtered.length === 0) {
        if (query) { html += '<div class="empty-state">No matches.</div>'; }
        else if (!rest.length) { html += '<div class="empty-state">No saved graphs yet.</div>'; }
      } else {
        html += filtered.map(g => {
          const folders = g.isSubgraph ? (g.folderCount === 1 ? '1 folder' : (g.folderCount || 0) + ' folders') : '';
          const desc = g.description || (g.isSubgraph ? 'Subgraph · ' + folders : '') || formatDate(g.savedAt) || '—';
          const safeFile = g.file.replace(/"/g, '&quot;');
          const safeName = g.name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const safeDesc = desc.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const glyph = g.isSubgraph ? '<span class="card-glyph" title="Subgraph: a scoped view of the project">⊂</span>' : '';
          return \`<div class="graph-card\${g.isSubgraph ? ' subgraph' : ''}" data-file="\${safeFile}" data-name="\${safeName}">
            <div class="card-name">\${glyph}\${safeName}</div>
            <div class="card-bottom">
              <span class="card-desc">\${safeDesc}</span>
              <button class="btn-timeline" data-file="\${safeFile}" data-name="\${safeName}" title="Open timeline view for this graph">Timeline</button>
            </div>
          </div>\`;
        }).join('');
      }
      list.innerHTML = html;

      wireWorkflowCard(list);
      wireAnnotateCard(list);

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
      } else if (msg.type === 'subgraph-picker') {
        spOpen(msg);
      } else if (msg.type === 'graphs-height') {
        if (typeof msg.px === 'number' && msg.px > 0) {
          document.body.style.setProperty('--cg-graphs-height', msg.px + 'px');
        }
      } else if (msg.type === 'workflow-status') {
        if (msg.status === 'generating' && msg.detail) {
          const d = document.getElementById('wf-detail');
          if (d) { d.textContent = msg.detail; }
        }
      } else if (msg.type === 'annotate-status') {
        onAnnotateStatus(msg);
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
</body>
</html>`;
  }
}
