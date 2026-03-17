import * as vscode from 'vscode';

export { MAX_OUTPUT_BYTES, ANALYSIS_TIMEOUT_MS } from './analyzerRunner';

import { GitService } from './gitService';
import { AnalyzerRunner } from './analyzerRunner';
import { LibraryDescriber } from './libraryDescriber';
import { getFuncSource, findPythonFuncEnd, findJsFuncEnd, saveFuncSource } from './sourceEditor';
import { getLoadingHtml, getEmptyStateHtml, getErrorHtml, getWebviewHtml } from './webviewHtmlBuilder';

interface GraphNode {
  id: string;
  name: string;
  file: string | null;
  line: number;
  language?: 'python' | 'typescript' | 'javascript';
  gitStatus?: { unstaged: 'added' | 'modified' | 'deleted' | null; staged: 'added' | 'modified' | 'deleted' | null };
  isLibrary?: boolean;
  libraryName?: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: Array<{ source: string; target: string; isLibraryEdge?: boolean }>;
}

export class GraphProvider {
  private panel: vscode.WebviewPanel | undefined;
  private readonly context: vscode.ExtensionContext;
  private cachedNodes: GraphNode[] = [];
  private gitRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly gitService = new GitService();
  private readonly analyzerRunner: AnalyzerRunner;
  private readonly libraryDescriber: LibraryDescriber;
  private _outputChannel?: vscode.OutputChannel;

  private get outputChannel() {
    if (!this._outputChannel) {
      this._outputChannel = vscode.window.createOutputChannel('CoGraph');
    }
    return this._outputChannel;
  }

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.analyzerRunner = new AnalyzerRunner(
      context,
      (msg) => this.showError(msg),
      (stdout, workspaceRoot) => this.handleAnalysisResult(stdout, workspaceRoot),
    );
    this.libraryDescriber = new LibraryDescriber(
      context.extensionPath,
      () => this.analyzerRunner.resolvePythonBin(),
      () => this.outputChannel,
    );
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
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview'),
        ],
      }
    );

    const scheduleRefresh = () => {
      if (this.gitRefreshTimer) { clearTimeout(this.gitRefreshTimer); }
      this.gitRefreshTimer = setTimeout(() => this.refreshGitStatus(workspaceRoot), 300);
    };

    const saveListener = vscode.workspace.onDidSaveTextDocument(doc => {
      if (vscode.workspace.getWorkspaceFolder(doc.uri)) {
        scheduleRefresh();
        if (doc.uri.fsPath.endsWith('.py') ||
            doc.uri.fsPath.endsWith('.ts') ||
            doc.uri.fsPath.endsWith('.tsx') ||
            doc.uri.fsPath.endsWith('.js') ||
            doc.uri.fsPath.endsWith('.jsx') ||
            doc.uri.fsPath.endsWith('.mjs') ||
            doc.uri.fsPath.endsWith('.cjs')) {
          this.analyzerRunner.scheduleReanalysis(workspaceRoot);
        }
      }
    });

    const gitIndexWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(workspaceRoot), '.git/index')
    );
    gitIndexWatcher.onDidChange(scheduleRefresh);
    gitIndexWatcher.onDidCreate(scheduleRefresh);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      saveListener.dispose();
      gitIndexWatcher.dispose();
      if (this.gitRefreshTimer) { clearTimeout(this.gitRefreshTimer); }
      this.analyzerRunner.clearReanalysisTimer();
      this.analyzerRunner.killAll();
      this.cachedNodes = [];
    });

    this.panel.webview.onDidReceiveMessage((message) => {
      if (message.type === 'navigate') {
        this.navigateTo(message.file, message.line);
      } else if (message.type === 'open-docs') {
        const { libraryName, language } = message;
        const url = language === 'python'
          ? `https://docs.python.org/3/library/${libraryName.split('.')[0]}`
          : `https://www.npmjs.com/package/${libraryName}`;
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else if (message.type === 'get-lib-description') {
        const { libraryName, functionName, language, reqId } = message;
        this.libraryDescriber.fetchLibDescription(libraryName, functionName, language, workspaceRoot)
          .then(description => {
            this.panel?.webview.postMessage({ type: 'lib-description', description, reqId });
          });
      } else if (message.type === 'get-func-source') {
        const { file, line, reqId } = message;
        try {
          const source = getFuncSource(file, line);
          const endLine = line + source.split('\n').length - 1;
          const ext = file.split('.').pop() ?? '';
          const languageId = ext === 'py' ? 'python' : ext === 'js' ? 'javascript' : 'typescript';
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const colorize = (vscode.languages as any).colorize;
          if (typeof colorize === 'function') {
            colorize(source, languageId, { tabSize: 4 }).then(
              (colorizedHtml: string) => {
                this.panel?.webview.postMessage({ type: 'func-source', source, colorizedHtml, endLine, reqId });
              },
              () => {
                this.panel?.webview.postMessage({ type: 'func-source', source, endLine, reqId });
              }
            );
          } else {
            this.panel?.webview.postMessage({ type: 'func-source', source, endLine, reqId });
          }
        } catch (err: unknown) {
          this.panel?.webview.postMessage({ type: 'func-source', source: '', error: (err as Error).message, reqId });
        }
      } else if (message.type === 'save-func-source') {
        const { file, line, newSource } = message;
        try {
          saveFuncSource(file, line, newSource);
          this.refreshGitStatus(workspaceRoot);
          this.analyzerRunner.scheduleReanalysis(workspaceRoot);
        } catch (err: unknown) {
          vscode.window.showErrorMessage(`CoGraph: Failed to save — ${(err as Error).message}`);
        }
      }
    });

    this.panel.webview.html = getLoadingHtml();
    this.analyzerRunner.run(workspaceRoot);
  }

  /** Show error in the panel (if alive) and as a VS Code notification. */
  private showError(message: string): void {
    if (this.panel) {
      this.panel.webview.html = getErrorHtml(message);
    }
    vscode.window.showErrorMessage(message);
  }

  private refreshGitStatus(workspaceRoot: string): void {
    if (!this.panel || this.cachedNodes.length === 0) { return; }
    this.gitService.applyGitStatuses(this.cachedNodes, workspaceRoot);
    this.panel.webview.postMessage({
      type: 'git-update',
      nodes: this.cachedNodes.map(n => ({ id: n.id, gitStatus: n.gitStatus })),
    });
  }

  /** Parse stdout, guard empty graphs, and post the graph message. */
  private handleAnalysisResult(stdout: string, workspaceRoot: string): void {
    if (!this.panel) { return; }

    let graph: GraphData;
    try {
      graph = JSON.parse(stdout);
    } catch {
      this.showError('CoGraph: Failed to parse graph data.');
      return;
    }

    if (graph.nodes.length === 0) {
      this.panel.webview.html = getEmptyStateHtml();
      return;
    }

    const isReanalysis = this.cachedNodes.length > 0;
    const gitAvailable = this.gitService.applyGitStatuses(graph.nodes, workspaceRoot);
    this.cachedNodes = graph.nodes.filter(n => !n.isLibrary);

    if (isReanalysis) {
      this.panel.webview.postMessage({ type: 'graph', data: graph, gitAvailable, isReanalysis: true });
    } else {
      this.panel.webview.html = getWebviewHtml(this.panel.webview, this.context.extensionUri);
      setTimeout(() => {
        this.panel?.webview.postMessage({ type: 'graph', data: graph, gitAvailable, isReanalysis: false });
      }, 150);
    }
  }

  private async navigateTo(file: string, line: number) {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const position = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
  }

  // ── Thin delegates kept for test compatibility ────────────────────────────

  resolvePythonBin(): string | null {
    return this.analyzerRunner.resolvePythonBin();
  }

  private parseGitStatus(workspaceRoot: string) {
    return this.gitService.parseGitStatus(workspaceRoot);
  }

  private parseGitDiff(workspaceRoot: string, staged: boolean) {
    return this.gitService.parseGitDiff(workspaceRoot, staged);
  }

  private applyGitStatuses(nodes: GraphNode[], workspaceRoot: string) {
    return this.gitService.applyGitStatuses(nodes, workspaceRoot);
  }

  private getFuncSource(file: string, line: number) {
    return getFuncSource(file, line);
  }

  private findPythonFuncEnd(lines: string[], startIdx: number) {
    return findPythonFuncEnd(lines, startIdx);
  }

  private findJsFuncEnd(lines: string[], startIdx: number) {
    return findJsFuncEnd(lines, startIdx);
  }

  private saveFuncSource(file: string, line: number, newSource: string) {
    return saveFuncSource(file, line, newSource);
  }

  private getErrorHtml(message: string) {
    return getErrorHtml(message);
  }
}
