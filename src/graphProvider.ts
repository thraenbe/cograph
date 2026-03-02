import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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
      { enableScripts: true }
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

  private runAnalyzer(workspaceRoot: string) {
    const scriptPath = path.join(this.context.extensionPath, 'scripts', 'analyze.py');
    const proc = cp.spawn('python3', [scriptPath, workspaceRoot]);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.on('close', (code) => {
      if (code !== 0) {
        vscode.window.showErrorMessage(`CoGraph: Analysis failed.\n${stderr}`);
        return;
      }

      let graph: GraphData;
      try {
        graph = JSON.parse(stdout);
      } catch {
        vscode.window.showErrorMessage('CoGraph: Failed to parse graph data.');
        return;
      }

      this.panel?.webview.postMessage({ type: 'graph', data: graph });
      if (this.panel) {
        this.panel.webview.html = this.getWebviewHtml(this.panel.webview);
      }
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
    return `<!DOCTYPE html><html><body><p>Analyzing project...</p></body></html>`;
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const webviewDir = path.join(this.context.extensionPath, 'src', 'webview');
    const htmlPath = path.join(webviewDir, 'index.html');
    return fs.readFileSync(htmlPath, 'utf8');
  }
}
