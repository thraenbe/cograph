import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

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
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cograph.savedGraphs';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _graphController: GraphController,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._buildHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          this._sendGraphList();
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

  private _buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
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
  </style>
</head>
<body>

  <!-- CHAT section -->
  <div class="section-header collapsed" id="hdr-chat">
    <span class="chevron">▼</span>
    <span>Chat</span>
  </div>
  <div class="section-body hidden" id="body-chat">
    <p class="placeholder">Chat coming soon.</p>
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

  <script>
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
</body>
</html>`;
  }
}
