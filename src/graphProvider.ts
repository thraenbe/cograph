import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

export const MAX_OUTPUT_BYTES = 500 * 1024 * 1024; // 500 MB guard
export const ANALYSIS_TIMEOUT_MS = 300_000;         // 5 min

interface GraphNode {
  id: string;
  name: string;
  file: string;
  line: number;
}

interface GraphEdge {
  source: string;
  target: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export class GraphProvider {
  private panel: vscode.WebviewPanel | undefined;
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  show() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('CoGraph: No workspace folder open.');
      return;
    }

    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'cograph',
      'CoGraph',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview'),
        ],
      }
    );

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage((message) => {
      if (message.type === 'navigate') {
        this.navigateTo(message.file, message.line);
      }
    });

    this.panel.webview.html = this.getLoadingHtml();
    this.runAnalyzer(workspaceRoot);
  }

  /** Try `python3` then `python`; return first working binary or null. */
  resolvePythonBin(): string | null {
    for (const bin of ['python3', 'python']) {
      try {
        cp.execFileSync(bin, ['--version'], { timeout: 3000 });
        return bin;
      } catch {
        // try next
      }
    }
    return null;
  }

  /** Show error in the panel (if alive) and as a VS Code notification. */
  private showError(message: string): void {
    if (this.panel) {
      this.panel.webview.html = this.getErrorHtml(message);
    }
    vscode.window.showErrorMessage(message);
  }

  /** Parse stdout, guard empty graphs, and post the graph message. */
  private handleAnalysisResult(stdout: string): void {
    if (!this.panel) {
      return;
    }

    let graph: GraphData;
    try {
      graph = JSON.parse(stdout);
    } catch {
      this.showError('CoGraph: Failed to parse graph data.');
      return;
    }

    if (graph.nodes.length === 0) {
      this.panel.webview.html = this.getEmptyStateHtml();
      return;
    }

    const webviewHtml = this.getWebviewHtml(this.panel.webview);
    this.panel.webview.html = webviewHtml;

    // Delay postMessage so webview JS is fully initialised before the data arrives.
    setTimeout(() => {
      this.panel?.webview.postMessage({ type: 'graph', data: graph });
    }, 150);
  }

  private runAnalyzer(workspaceRoot: string): void {
    const pythonBin = this.resolvePythonBin();
    if (!pythonBin) {
      this.showError('CoGraph: Python not found. Install Python 3 and ensure it is on PATH.');
      return;
    }

    const scriptPath = path.join(this.context.extensionPath, 'scripts', 'analyze.py');
    const proc = cp.spawn(pythonBin, [scriptPath, workspaceRoot]);

    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      this.showError(`CoGraph: Analysis timed out after ${ANALYSIS_TIMEOUT_MS / 1000}s.`);
    }, ANALYSIS_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        proc.kill();
        this.showError('CoGraph: Analysis output too large (> 500 MB). Try a smaller workspace.');
        return;
      }
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      this.showError(`CoGraph: Failed to start Python — ${err.message}`);
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        return; // already handled above
      }
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        return; // already handled above
      }
      if (code !== 0) {
        const detail = stderr.slice(0, 500);
        this.showError(`CoGraph: Analysis failed (exit ${code}).\n${detail}`);
        return;
      }
      this.handleAnalysisResult(stdout);
    });
  }

  private async navigateTo(file: string, line: number) {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const position = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
  }

  private getLoadingHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { display:flex; align-items:center; justify-content:center; height:100vh; margin:0;
         background:var(--vscode-editor-background); color:var(--vscode-editor-foreground); font-family:sans-serif; }
  .spinner { width:40px; height:40px; border:4px solid transparent;
             border-top-color:var(--vscode-focusBorder); border-radius:50%; animation:spin 0.8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  p { margin-top:16px; }
</style>
</head>
<body>
  <div style="text-align:center">
    <div class="spinner"></div>
    <p>Analyzing project…</p>
  </div>
</body>
</html>`;
  }

  private getEmptyStateHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { display:flex; align-items:center; justify-content:center; height:100vh; margin:0;
         background:var(--vscode-editor-background); color:var(--vscode-editor-foreground); font-family:sans-serif; }
</style>
</head>
<body>
  <div style="text-align:center">
    <div style="font-size:48px">&#x2205;</div>
    <p>No Python functions found in this workspace.</p>
  </div>
</body>
</html>`;
  }

  private getErrorHtml(message: string): string {
    const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { display:flex; align-items:center; justify-content:center; height:100vh; margin:0;
         background:var(--vscode-editor-background); font-family:sans-serif; }
  .box { max-width:600px; padding:24px; border-radius:6px;
         background:var(--vscode-inputValidation-errorBackground,#5a1d1d);
         color:var(--vscode-errorForeground,#f48771); }
  .icon { font-size:32px; }
  pre { white-space:pre-wrap; word-break:break-word; margin:8px 0 0; font-size:13px; }
</style>
</head>
<body>
  <div class="box">
    <div class="icon">&#x26A0;</div>
    <pre>${escaped}</pre>
  </div>
</body>
</html>`;
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const webviewDir = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview');
    const stateUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'state.js'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'main.js'));
    const clusteringUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'clustering.js'));
    const renderingUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'rendering.js'));
    const controlsUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'controls.js'));
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'styles.css'));
    const nonce = crypto.randomUUID();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com;
             style-src 'unsafe-inline' ${webview.cspSource};
             img-src ${webview.cspSource} data:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CoGraph</title>
  <link rel="stylesheet" href="${stylesUri}" />
  <script nonce="${nonce}"
    src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
</head>
<body>
  <div id="graph"></div>
  <div id="flow-notice">Dagre layout not available in D3 mode</div>
  <div id="complexity-widget">
    <div class="complexity-header">
      <label for="slider-complexity">Detail</label>
      <span id="val-complexity">1.00</span>
    </div>
    <input type="range" id="slider-complexity" min="0" max="1" step="0.01" value="1" />
  </div>
  <button id="settings-btn" title="Settings">&#9881;</button>
  <div id="settings-panel">

    <div class="panel-section">
      <h4>Layout Mode</h4>
      <div class="layout-toggle">
        <button id="btn-layout-dynamic" class="layout-btn active">&#9889; Dynamic</button>
        <button id="btn-layout-static" class="layout-btn">&#9679; Static</button>
      </div>
    </div>

    <div class="panel-section">
      <h4>Filters</h4>
      <input id="search" type="text" placeholder="Filter functions..." />
      <div class="toggle-row">
        <span>Existing files only</span>
        <label class="switch"><input type="checkbox" id="toggle-existing" /><span class="pill"></span></label>
      </div>
      <div class="toggle-row">
        <span>Show Orphans</span>
        <label class="switch"><input type="checkbox" id="toggle-orphans" checked /><span class="pill"></span></label>
      </div>
    </div>

    <div class="panel-section">
      <h4>Groups</h4>
      <div class="toggle-row">
        <span>Group by File Structure</span>
        <label class="switch"><input type="checkbox" id="toggle-group-file" /><span class="pill"></span></label>
      </div>
      <div class="toggle-row stub" title="Coming soon">
        <span>Group by Inheritance</span>
        <label class="switch"><input type="checkbox" id="toggle-group-inherit" disabled /><span class="pill"></span></label>
      </div>
      <div class="toggle-row">
        <span>Group by Flow (L&#8594;R)</span>
        <label class="switch"><input type="checkbox" id="toggle-group-flow" /><span class="pill"></span></label>
      </div>
      <button id="btn-new-group" disabled>+ Create new Group</button>
    </div>

    <div class="panel-section">
      <h4>Display</h4>
      <div class="toggle-row">
        <span>Arrows</span>
        <label class="switch"><input type="checkbox" id="toggle-arrows" checked /><span class="pill"></span></label>
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-text-fade">Text Fade Threshold</label><span id="val-text-fade">0.5</span></div>
        <input type="range" id="slider-text-fade" min="0" max="2" step="0.1" value="0.5" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-node-size">Node Size</label><span id="val-node-size">2.5</span></div>
        <input type="range" id="slider-node-size" min="0.1" max="5" step="0.1" value="2.5" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-link-thickness">Link Thickness</label><span id="val-link-thickness">4</span></div>
        <input type="range" id="slider-link-thickness" min="0.1" max="8" step="0.1" value="4" />
      </div>
    </div>

    <div class="panel-section" id="forces-section">
      <h4>Forces</h4>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-center-force">Center Force</label><span id="val-center-force">1</span></div>
        <input type="range" id="slider-center-force" min="0" max="5" step="0.05" value="1" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-repel-force">Repel Force</label><span id="val-repel-force">500</span></div>
        <input type="range" id="slider-repel-force" min="0" max="8192" step="50" value="500" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-link-force">Link Force</label><span id="val-link-force">1</span></div>
        <input type="range" id="slider-link-force" min="0.1" max="2" step="0.1" value="1" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-link-distance">Link Distance</label><span id="val-link-distance">40</span></div>
        <input type="range" id="slider-link-distance" min="10" max="80" step="5" value="40" />
      </div>
    </div>

  </div>
  <script nonce="${nonce}" src="${stateUri}"></script>
  <script nonce="${nonce}" src="${clusteringUri}"></script>
  <script nonce="${nonce}" src="${renderingUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}" src="${controlsUri}"></script>
</body>
</html>`;
  }
}
