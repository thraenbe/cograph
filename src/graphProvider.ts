import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export { MAX_OUTPUT_BYTES, ANALYSIS_TIMEOUT_MS } from './analyzerRunner';

import { GitService } from './gitService';
import { AnalyzerRunner } from './analyzerRunner';
import { LibraryDescriber } from './libraryDescriber';
import { getFuncSource, findPythonFuncEnd, findJsFuncEnd, saveFuncSource } from './sourceEditor';
import { getLoadingHtml, getEmptyStateHtml, getErrorHtml, getWebviewHtml } from './webviewHtmlBuilder';
import type { SidebarProvider } from './sidebarProvider';

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
  private timelinePanel: vscode.WebviewPanel | undefined;
  private readonly context: vscode.ExtensionContext;
  private cachedNodes: GraphNode[] = [];
  private gitRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly gitService = new GitService();
  private readonly analyzerRunner: AnalyzerRunner;
  private readonly libraryDescriber: LibraryDescriber;
  private _outputChannel?: vscode.OutputChannel;
  private _sidebar?: SidebarProvider;
  private currentSavedGraphPath: string | undefined;
  private isDirty = false;
  private static readonly DIRTY_PREFIX = '● ';

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
      this.currentSavedGraphPath = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
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
      } else if (message.type === 'request-rename-folder') {
        const { folderPath } = message;
        const newName = await vscode.window.showInputBox({
          prompt: 'Rename folder',
          value: path.basename(folderPath),
          validateInput: v => v.trim() ? null : 'Name cannot be empty',
        });
        if (newName?.trim() && newName !== path.basename(folderPath)) {
          const newFolderUri = vscode.Uri.file(path.join(path.dirname(folderPath), newName.trim()));
          await vscode.workspace.fs.rename(vscode.Uri.file(folderPath), newFolderUri);
          this.analyzerRunner.scheduleReanalysis(workspaceRoot);
        }
      } else if (message.type === 'request-new-file') {
        const { folderPath } = message;
        const fileName = await vscode.window.showInputBox({
          prompt: 'New file name',
          placeHolder: 'e.g. utils.py',
          validateInput: v => v.trim() ? null : 'Name cannot be empty',
        });
        if (fileName?.trim()) {
          const fileUri = vscode.Uri.file(path.join(folderPath, fileName.trim()));
          await vscode.workspace.fs.writeFile(fileUri, new Uint8Array());
          await vscode.window.showTextDocument(fileUri);
          this.analyzerRunner.scheduleReanalysis(workspaceRoot);
        }
      } else if (message.type === 'dirty-state') {
        this.setDirty(!!message.dirty);
      } else if (message.type === 'save-graph') {
        const isSaveAs = message.mode === 'save-as' || !this.currentSavedGraphPath;
        let targetPath: string;
        let name: string;

        if (isSaveAs) {
          const currentClean = this.getCleanTitle();
          const defaultName = currentClean && currentClean !== 'CoGraph'
            ? currentClean
            : 'My Layout';
          const input = await vscode.window.showInputBox({
            prompt: 'Name this graph layout',
            value: defaultName,
            validateInput: v => v.trim() ? null : 'Name cannot be empty',
          });
          if (!input?.trim()) { return; }
          name = input.trim();
          const dir = path.join(workspaceRoot, '.cograph');
          if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
          const filename = name.replace(/[^a-zA-Z0-9_\- ]/g, '_') + '.json';
          targetPath = path.join(dir, filename);
        } else {
          targetPath = this.currentSavedGraphPath!;
          try {
            const existing = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
            name = existing.name ?? path.basename(targetPath, '.json');
          } catch {
            name = path.basename(targetPath, '.json');
          }
        }

        const data = {
          version: 1,
          name,
          description: '',
          savedAt: new Date().toISOString(),
          ...message.payload,
        };
        try {
          fs.writeFileSync(targetPath, JSON.stringify(data, null, 2), 'utf8');
        } catch (err: unknown) {
          vscode.window.showErrorMessage(`CoGraph: Failed to save — ${(err as Error).message}`);
          return;
        }
        this.currentSavedGraphPath = targetPath;
        this.isDirty = false;
        this.setPanelTitle(name);
        this.panel?.webview.postMessage({ type: 'clear-dirty' });
        this._sidebar?.refresh();
        vscode.window.showInformationMessage(
          isSaveAs ? `CoGraph: Layout saved as "${name}".` : `CoGraph: Saved "${name}".`,
        );
      }
    });

    this.panel.webview.html = getLoadingHtml();
    this.analyzerRunner.run(workspaceRoot);
  }

  isOpen(): boolean {
    return !!this.panel;
  }

  reloadLayout(): void {
    this.panel?.webview.postMessage({ type: 'reload-layout' });
  }

  setSidebarProvider(sidebar: SidebarProvider): void {
    this._sidebar = sidebar;
  }

  /** Set a panel title, preserving the dirty-indicator prefix if dirty. */
  private setPanelTitle(baseTitle: string): void {
    if (!this.panel) { return; }
    this.panel.title = this.isDirty
      ? `${GraphProvider.DIRTY_PREFIX}${baseTitle}`
      : baseTitle;
  }

  /** Get the current title with any dirty prefix stripped. */
  private getCleanTitle(): string {
    if (!this.panel) { return 'CoGraph'; }
    return this.panel.title.startsWith(GraphProvider.DIRTY_PREFIX)
      ? this.panel.title.slice(GraphProvider.DIRTY_PREFIX.length)
      : this.panel.title;
  }

  /** Toggle the dirty indicator — prefixes `● ` onto the panel title. */
  private setDirty(dirty: boolean): void {
    if (this.isDirty === dirty) { return; }
    this.isDirty = dirty;
    if (!this.panel) { return; }
    this.setPanelTitle(this.getCleanTitle());
  }

  /** Load a previously saved graph layout into the open (or freshly opened) panel. */
  async loadGraph(data: unknown, filePath?: string): Promise<void> {
    if (!this.panel) {
      this.show();
      // Wait for the panel to finish loading the graph before applying positions
      await new Promise<void>(resolve => {
        const disposable = (this.panel as vscode.WebviewPanel).webview.onDidReceiveMessage((msg) => {
          if (msg.type === 'graph-ready') {
            disposable.dispose();
            resolve();
          }
        });
        // Fallback: proceed after 2 s even if we never receive graph-ready
        setTimeout(resolve, 2000);
      });
    } else {
      this.panel.reveal();
    }
    // Loading a saved graph resets the dirty state
    this.isDirty = false;
    // Update panel title to the saved graph's name
    const name = (data as { name?: string })?.name;
    if (this.panel && name) {
      this.setPanelTitle(name);
    } else if (this.panel) {
      // Re-render existing title without any stale dirty prefix
      this.setPanelTitle(this.getCleanTitle());
    }
    this.currentSavedGraphPath = filePath;
    this.panel?.webview.postMessage({ type: 'graph-loaded', payload: data });
  }

  /**
   * Open a dedicated timeline window for a saved graph. Creates a second webview panel
   * (separate from the main graph) with timeline controls enabled. Runs a fresh analyzer
   * on the current workspace, applies the saved layout's positions/settings, and posts
   * per-node git-blame introduction timestamps once available.
   */
  openTimeline(savedGraphFile: string, name: string): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showErrorMessage('CoGraph: No workspace folder open.');
      return;
    }

    if (this.timelinePanel) {
      this.timelinePanel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'cograph-timeline',
      `Timeline: ${name}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview'),
        ],
      },
    );
    this.timelinePanel = panel;

    let savedPayload: unknown = null;
    try {
      savedPayload = JSON.parse(fs.readFileSync(savedGraphFile, 'utf8'));
    } catch (err: unknown) {
      this.outputChannel.appendLine(`Timeline: could not read "${savedGraphFile}" — ${(err as Error).message}`);
    }

    panel.webview.html = getLoadingHtml();

    panel.onDidDispose(() => {
      if (this.timelinePanel === panel) {
        this.timelinePanel = undefined;
      }
    });

    panel.webview.onDidReceiveMessage((message) => {
      if (message.type === 'navigate') {
        this.navigateTo(message.file, message.line);
      }
    });

    const runner = new AnalyzerRunner(
      this.context,
      (msg) => {
        if (this.timelinePanel === panel) {
          panel.webview.html = getErrorHtml(msg);
        }
      },
      (stdout, wsRoot) => {
        if (this.timelinePanel !== panel) { return; }
        let graph: GraphData;
        try {
          graph = JSON.parse(stdout);
        } catch {
          panel.webview.html = getErrorHtml('CoGraph: Failed to parse graph data.');
          return;
        }
        if (graph.nodes.length === 0) {
          panel.webview.html = getEmptyStateHtml();
          return;
        }
        const gitAvailable = this.gitService.applyGitStatuses(graph.nodes, wsRoot);
        const fileGitStatus = this.gitService.fileStatuses;
        panel.webview.html = getWebviewHtml(
          panel.webview,
          this.context.extensionUri,
          { timelineMode: true },
        );
        setTimeout(() => {
          panel.webview.postMessage({ type: 'graph', data: graph, gitAvailable, fileGitStatus, isReanalysis: false });
          if (savedPayload) {
            panel.webview.postMessage({ type: 'graph-loaded', payload: savedPayload });
          }
          this.postTimelineData(panel, graph, wsRoot);
        }, 150);
      },
    );
    runner.run(workspaceRoot);
  }

  /**
   * Compute per-node introduction timestamps via git blame and post them to the given panel.
   * Runs async (setImmediate) so the initial graph render is not blocked.
   */
  private postTimelineData(
    panel: vscode.WebviewPanel,
    graph: GraphData,
    workspaceRoot: string,
  ): void {
    setImmediate(() => {
      if (this.timelinePanel !== panel) { return; }
      try {
        const intro = this.gitService.getIntroductionTimes(graph.nodes, workspaceRoot);
        const entries: Array<{ id: string; ts: number }> = [];
        for (const [id, ts] of intro) { entries.push({ id, ts }); }
        panel.webview.postMessage({ type: 'timeline-data', nodes: entries });
      } catch (err: unknown) {
        this.outputChannel.appendLine(`Timeline: blame failed — ${(err as Error).message}`);
      }
    });
  }

  /** Ask the webview to post a `save-graph` message back with the current state. */
  requestSave(mode: 'save' | 'save-as'): void {
    if (!this.panel) { return; }
    this.panel.webview.postMessage({ type: 'save-request', mode });
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
      fileGitStatus: this.gitService.fileStatuses,
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
    const fileGitStatus = this.gitService.fileStatuses;
    this.cachedNodes = graph.nodes.filter(n => !n.isLibrary);

    if (isReanalysis) {
      this.panel.webview.postMessage({ type: 'graph', data: graph, gitAvailable, fileGitStatus, isReanalysis: true });
    } else {
      this.panel.webview.html = getWebviewHtml(this.panel.webview, this.context.extensionUri);
      setTimeout(() => {
        this.panel?.webview.postMessage({ type: 'graph', data: graph, gitAvailable, fileGitStatus, isReanalysis: false });
      }, 150);
    }
  }

  private async navigateTo(file: string, line: number) {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    const position = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
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
