import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

const MAX_OUTPUT_BYTES = 100 * 1024 * 1024; // 100 MB guard
const ANALYSIS_TIMEOUT_MS = 60_000;

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
        this.showError('CoGraph: Analysis output too large (> 100 MB). Try a smaller workspace.');
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
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'main.js'));
    const nonce = crypto.randomUUID();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com;
             style-src 'unsafe-inline';
             img-src ${webview.cspSource} data:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CoGraph</title>
  <script nonce="${nonce}"
    src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { display: flex; flex-direction: column; height: 100vh;
           background: var(--vscode-editor-background);
           color: var(--vscode-editor-foreground);
           font-family: var(--vscode-font-family); }
    #controls { padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    #search { width: 100%; padding: 4px 8px;
              background: var(--vscode-input-background);
              color: var(--vscode-input-foreground);
              border: 1px solid var(--vscode-input-border);
              border-radius: 4px; font-size: 13px; }
    #cy { flex: 1; width: 100%; }
  </style>
</head>
<body>
  <div id="controls">
    <input id="search" type="text" placeholder="Filter functions..." />
  </div>
  <div id="cy"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
