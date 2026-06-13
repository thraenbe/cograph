import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export { MAX_OUTPUT_BYTES, ANALYSIS_TIMEOUT_MS } from './analyzerRunner';

import { GitService } from './gitService';
import { AnalyzerRunner, type AnalyzerRunMeta } from './analyzerRunner';
import { scanStructure, type StructureTree } from './structureScanner';
import { mergeGraph } from './graphMerge';
import { LibraryDescriber } from './libraryDescriber';
import { getFuncSource, findPythonFuncEnd, findJsFuncEnd, saveFuncSource } from './sourceEditor';
import { getLoadingHtml, getEmptyStateHtml, getErrorHtml, getWebviewHtml, type EmptyStateInfo } from './webviewHtmlBuilder';
import type { SidebarProvider } from './sidebarProvider';
import { createProvider, getProviderInfo } from './graphIntelligence/provider';
import type { GraphIntelligenceProvider, GraphIntelligenceResult } from './graphIntelligence/provider';

export interface GraphEdge { source: string; target: string; isLibraryEdge?: boolean; }

export interface GraphNode {
  id: string;
  name: string;
  file: string | null;
  line: number;
  language?: 'python' | 'typescript' | 'javascript' | 'java' | 'cpp';
  gitStatus?: { unstaged: 'added' | 'modified' | 'deleted' | null; staged: 'added' | 'modified' | 'deleted' | null };
  isLibrary?: boolean;
  libraryName?: string;
  className?: string;
  classExtends?: string;
  classImplements?: string[];
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  files?: string[];
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
  private cachedGraph: GraphData | undefined;
  /** True when a file-cluster skeleton is shown, so a 0-node / async result must not reset the view. */
  private skeletonActive = false;
  /** Structure scanned in show() but not yet delivered (small-repo path: sent once the graph view is up). */
  private pendingStructure: StructureTree | undefined;
  private graphReadyResolve: (() => void) | undefined;
  private graphReadyPromise: Promise<void> | undefined;
  private intelController: AbortController | undefined;
  private _providerFactory?: (id: string, ch: vscode.OutputChannel) => GraphIntelligenceProvider;

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
      (stdout, workspaceRoot, meta) => this.handleAnalysisResult(stdout, workspaceRoot, meta),
      (msg) => this.outputChannel.appendLine(msg),
      (attempt, max) => {
        // Don't reset the panel HTML during retries when a skeleton is showing —
        // that would wipe the user's drill-down.
        if (this.panel && !this.skeletonActive) {
          this.panel.webview.html = getLoadingHtml(`Analyzing project… (retry ${attempt}/${max})`);
        }
      },
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
            doc.uri.fsPath.endsWith('.cjs') ||
            doc.uri.fsPath.endsWith('.java') ||
            doc.uri.fsPath.endsWith('.cpp') ||
            doc.uri.fsPath.endsWith('.cc') ||
            doc.uri.fsPath.endsWith('.cxx') ||
            doc.uri.fsPath.endsWith('.c++') ||
            doc.uri.fsPath.endsWith('.hpp') ||
            doc.uri.fsPath.endsWith('.hh') ||
            doc.uri.fsPath.endsWith('.hxx') ||
            doc.uri.fsPath.endsWith('.h++') ||
            doc.uri.fsPath.endsWith('.h')) {
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
      this.cachedGraph = undefined;
      this.graphReadyPromise = undefined;
      this.graphReadyResolve = undefined;
      this.intelController?.abort();
      this.currentSavedGraphPath = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'navigate') {
        this.navigateTo(message.file, message.line);
      } else if (message.type === 'open-docs') {
        const { libraryName, language } = message;
        let url: string;
        if (language === 'python') {
          url = `https://docs.python.org/3/library/${libraryName.split('.')[0]}`;
        } else if (language === 'java') {
          if (libraryName.startsWith('java.') || libraryName.startsWith('javax.')) {
            const pkgPath = libraryName.replace(/\./g, '/');
            url = `https://docs.oracle.com/en/java/javase/21/docs/api/java.base/${pkgPath}/package-summary.html`;
          } else {
            url = `https://javadoc.io/doc/${libraryName}`;
          }
        } else if (language === 'cpp') {
          const q = encodeURIComponent(`${libraryName}::${message.functionName ?? ''}`);
          url = `https://en.cppreference.com/mwiki/index.php?search=${q}`;
        } else {
          url = `https://www.npmjs.com/package/${libraryName}`;
        }
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
          const languageId = ext === 'py' ? 'python'
            : ext === 'js' ? 'javascript'
            : ext === 'java' ? 'java'
            : (ext === 'cpp' || ext === 'cc' || ext === 'cxx' || ext === 'c++'
                || ext === 'hpp' || ext === 'hh' || ext === 'hxx' || ext === 'h++'
                || ext === 'h') ? 'cpp'
            : 'typescript';
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
      } else if (message.type === 'retry-analysis') {
        // Triggered from the empty-state Retry button: re-run as a fresh initial
        // load (with backoff) so a transient/unready failure can recover.
        this.cachedNodes = [];
        this.cachedGraph = undefined;
        if (this.panel) { this.panel.webview.html = getLoadingHtml(); }
        this.analyzerRunner.run(workspaceRoot, { allowRetry: true });
      } else if (message.type === 'expand-folder') {
        // Lazy per-folder parse: analyze just this folder's files on demand.
        this.parseSubset(workspaceRoot, message.files ?? [], message.folderPath);
      } else if (message.type === 'parse-file') {
        const filePath: string = message.filePath ?? '';
        this.parseSubset(workspaceRoot, filePath ? [filePath] : [], path.dirname(filePath));
      } else if (message.type === 'cancel-analysis') {
        this.analyzerRunner.killAll();
        this.panel?.webview.postMessage({ type: 'analysis-state', backgroundParsing: false, cancelled: true });
      } else if (message.type === 'open-chat') {
        // Focuses the Cograph activity-bar view. The current graph context is
        // already up-to-date — setCurrentGraph is invoked from loadGraph and
        // from the save-graph handler.
        await vscode.commands.executeCommand('cograph.savedGraphs.focus');
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
        this._sidebar?.setCurrentGraph({ name, file: targetPath });
        this._sidebar?.appendSystem(`Graph: ${name} Updated`);
        vscode.window.showInformationMessage(
          isSaveAs ? `CoGraph: Layout saved as "${name}".` : `CoGraph: Saved "${name}".`,
        );
      }
    });

    // Cheap, parse-free structure scan → instant folder skeleton for large repos.
    const structure = scanStructure(workspaceRoot);
    const cfg = vscode.workspace.getConfiguration('cograph');
    const threshold = cfg.get<number>('largeRepo.fileThreshold', 2000);
    const autoEngage = cfg.get<boolean>('largeRepo.autoEngage', true) && structure.totalFiles >= threshold;
    this.skeletonActive = autoEngage;
    this.pendingStructure = undefined;

    if (autoEngage) {
      // Paint the skeleton immediately; the analyzer enriches it in the background.
      this.panel.webview.html = getWebviewHtml(this.panel.webview, this.context.extensionUri);
      setTimeout(() => {
        this.panel?.webview.postMessage({ type: 'structure', tree: structure, autoEngage: true });
        this.panel?.webview.postMessage({ type: 'analysis-state', backgroundParsing: true });
      }, 150);
    } else {
      // Small repo: behave as before, but keep the structure to enable the toggle once the view is up.
      this.panel.webview.html = getLoadingHtml();
      this.pendingStructure = structure;
    }
    this.analyzerRunner.run(workspaceRoot, { allowRetry: true });
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
    if (name && filePath) {
      this._sidebar?.setCurrentGraph({ name, file: filePath });
    }
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
          panel.webview.html = getEmptyStateHtml({ showRetry: false });
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
  private handleAnalysisResult(stdout: string, workspaceRoot: string, meta?: AnalyzerRunMeta): void {
    if (!this.panel) { return; }

    let graph: GraphData;
    try {
      graph = JSON.parse(stdout);
    } catch {
      this.showError('CoGraph: Failed to parse graph data.');
      return;
    }

    // A 0-node result is only a dead-end when NO skeleton is shown. With the
    // file-cluster skeleton up, the structure stays and analysis just adds nothing.
    if (graph.nodes.length === 0 && !this.skeletonActive) {
      this.panel.webview.html = getEmptyStateHtml(this.buildEmptyStateInfo(meta));
      return;
    }

    const isReanalysis = this.cachedNodes.length > 0;
    const gitAvailable = this.gitService.applyGitStatuses(graph.nodes, workspaceRoot);
    const fileGitStatus = this.gitService.fileStatuses;
    this.cachedNodes = graph.nodes.filter(n => !n.isLibrary);
    this.cachedGraph = graph;
    if (this.graphReadyResolve) {
      this.graphReadyResolve();
      this.graphReadyResolve = undefined;
    }

    if (isReanalysis || this.skeletonActive) {
      // Webview already up (reanalysis) or showing the skeleton — deliver data without resetting the view.
      this.panel.webview.postMessage({ type: 'graph', data: graph, gitAvailable, fileGitStatus, isReanalysis: true });
      if (this.skeletonActive) {
        // Background full pass finished — hide the Stop button / progress indicator.
        this.panel.webview.postMessage({ type: 'analysis-state', backgroundParsing: false });
      }
    } else {
      this.panel.webview.html = getWebviewHtml(this.panel.webview, this.context.extensionUri);
      const pending = this.pendingStructure;
      this.pendingStructure = undefined;
      setTimeout(() => {
        this.panel?.webview.postMessage({ type: 'graph', data: graph, gitAvailable, fileGitStatus, isReanalysis: false });
        // Deliver the (dormant) structure so the Clusters toggle works on small repos too.
        if (pending) {
          this.panel?.webview.postMessage({ type: 'structure', tree: pending, autoEngage: false });
        }
      }, 150);
    }
  }

  /** Map analyzer run metadata onto the actionable empty-state's display info. */
  private buildEmptyStateInfo(meta?: AnalyzerRunMeta): EmptyStateInfo {
    if (!meta) { return { showRetry: true }; }
    const failures = meta.statuses
      .filter(s => s.status !== 'ok' && s.status !== 'empty')
      .map(s => ({ lang: s.lang, status: s.status, detail: s.detail }));
    return {
      failures,
      candidateFilesFound: meta.candidateFilesFound,
      timedOut: meta.statuses.some(s => s.status === 'timeout'),
      tooLarge: meta.statuses.some(s => s.status === 'output-too-large'),
      showRetry: true,
    };
  }

  /**
   * Lazily parse a subset of files (a folder's direct files, or one file) and
   * patch the result into the webview without disturbing the user's drill-down.
   * Posts `analysis-state` (spinner on/off) and `graph-patch` (merge by id).
   */
  private async parseSubset(workspaceRoot: string, files: string[], folderTag: string): Promise<void> {
    if (!this.panel || files.length === 0) { return; }
    this.panel.webview.postMessage({ type: 'analysis-state', parsingFolder: folderTag });
    try {
      const patch = await this.analyzerRunner.runSubset(workspaceRoot, files);
      this.cachedGraph = mergeGraph(this.cachedGraph, patch);
      this.cachedNodes = this.cachedGraph.nodes.filter(n => !n.isLibrary);
      this.gitService.applyGitStatuses(patch.nodes, workspaceRoot);
      this.panel?.webview.postMessage({
        type: 'graph-patch',
        patch,
        parsedFolder: folderTag,
        fileGitStatus: this.gitService.fileStatuses,
      });
    } catch (err: unknown) {
      this.outputChannel.appendLine(`Subset parse failed for ${folderTag}: ${(err as Error).message}`);
      this.panel?.webview.postMessage({ type: 'analysis-state', parsingFolder: folderTag, error: (err as Error).message });
    }
  }

  private async navigateTo(file: string, line: number) {
    const doc = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    const position = new vscode.Position(line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  // ── Graph Intelligence ────────────────────────────────────────────────────

  setProviderFactoryForTesting(
    fn: (id: string, ch: vscode.OutputChannel) => GraphIntelligenceProvider,
  ): void {
    this._providerFactory = fn;
  }

  private waitForGraphReady(): Promise<void> {
    if (this.cachedGraph) { return Promise.resolve(); }
    if (this.graphReadyPromise) { return this.graphReadyPromise; }

    this.graphReadyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.graphReadyResolve = undefined;
        reject(new Error('Graph analysis timed out after 30 seconds.'));
      }, 30_000);
      this.graphReadyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    return this.graphReadyPromise;
  }

  async runGraphIntelligence(
    prompt: string,
    providerId: string,
    sessionId: string | null,
    onProgress?: (ev: import('./graphIntelligence/provider').ProgressEvent) => void,
  ): Promise<GraphIntelligenceResult> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { throw new Error('No workspace folder open.'); }

    if (!this.panel) { this.show(); }
    if (!this.panel) { throw new Error('Failed to open graph panel.'); }
    await this.waitForGraphReady();
    if (!this.cachedGraph) { throw new Error('Graph not ready yet.'); }

    this.intelController?.abort();
    this.intelController = new AbortController();

    const config = vscode.workspace.getConfiguration('cograph');
    const info = getProviderInfo(providerId);
    const modelKey = info?.modelSettingKey ?? 'graphIntelligence.model';
    const model = config.get<string>(modelKey, info?.defaultModel ?? 'sonnet');
    const effort = config.get<string>('graphIntelligence.effort', 'auto');
    const maxTurns = config.get<number>('graphIntelligence.maxTurns', 15);
    const maxBudgetUsd = config.get<number>('graphIntelligence.maxBudgetUsd', 2.0);
    const factory = this._providerFactory ?? createProvider;
    const provider = factory(providerId, this.outputChannel);

    const result = await provider.run(
      { prompt, graph: this.cachedGraph, workspaceRoot, sessionId, model, effort, maxTurns, maxBudgetUsd, onProgress },
      this.intelController.signal,
    );

    this.cachedGraph = result.graph;
    this.cachedNodes = result.graph.nodes.filter(n => !n.isLibrary);
    this.panel?.webview.postMessage({
      type: 'graph',
      data: result.graph,
      gitAvailable: this.gitService.applyGitStatuses(result.graph.nodes, workspaceRoot),
      fileGitStatus: this.gitService.fileStatuses,
      isReanalysis: true,
    });

    return result;
  }

  abortIntelligence(): void {
    this.intelController?.abort();
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
