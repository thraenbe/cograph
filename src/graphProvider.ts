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
  file: string | null;
  line: number;
  language?: 'python' | 'typescript';
  gitStatus?: { unstaged: 'added' | 'modified' | 'deleted' | null; staged: 'added' | 'modified' | 'deleted' | null };
  isLibrary?: boolean;
  libraryName?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  isLibraryEdge?: boolean;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export class GraphProvider {
  private panel: vscode.WebviewPanel | undefined;
  private readonly context: vscode.ExtensionContext;
  private cachedNodes: GraphNode[] = [];
  private gitRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private reanalysisTimer: ReturnType<typeof setTimeout> | undefined;
  private activeProcs: cp.ChildProcess[] = [];
  private resolvedPythonBin: string | null | undefined = undefined; // undefined = not yet resolved
  private _outputChannel?: vscode.OutputChannel;

  private get outputChannel() {
    if (!this._outputChannel) {
      this._outputChannel = vscode.window.createOutputChannel('CoGraph');
    }
    return this._outputChannel;
  }

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
      if (doc.uri.fsPath.startsWith(workspaceRoot)) {
        scheduleRefresh();
        if (doc.uri.fsPath.endsWith('.py') ||
            doc.uri.fsPath.endsWith('.ts') ||
            doc.uri.fsPath.endsWith('.tsx')) {
          this.scheduleReanalysis(workspaceRoot);
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
      if (this.reanalysisTimer) { clearTimeout(this.reanalysisTimer); }
      for (const proc of this.activeProcs) { proc.kill(); }
      this.activeProcs = [];
      this.cachedNodes = [];
    });

    this.panel.webview.onDidReceiveMessage((message) => {
      if (message.type === 'navigate') {
        this.navigateTo(message.file, message.line);
      } else if (message.type === 'open-docs') {
        const { libraryName, language } = message;
        let url: string;
        if (language === 'python') {
          url = `https://docs.python.org/3/library/${libraryName.split('.')[0]}`;
        } else {
          url = `https://www.npmjs.com/package/${libraryName}`;
        }
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else if (message.type === 'get-lib-description') {
        const { libraryName, functionName, language } = message;
        const { reqId } = message;
        this.fetchLibDescription(libraryName, functionName, language, workspaceRoot)
          .then(description => {
            this.panel?.webview.postMessage({ type: 'lib-description', description, reqId });
          });
      }
    });

    this.panel.webview.html = this.getLoadingHtml();
    this.runAnalyzer(workspaceRoot);
  }

  private parseGitStatus(workspaceRoot: string): Map<string, { unstaged: 'added'|'modified'|'deleted'|null; staged: 'added'|'modified'|'deleted'|null }> | null {
    try {
      const out = cp.execFileSync('git', ['status', '--porcelain', '-z'], {
        cwd: workspaceRoot, timeout: 5000, encoding: 'utf8'
      });
      const map = new Map();
      for (const entry of out.split('\0').filter((e: string) => e.length >= 4)) {
        const X = entry[0], Y = entry[1];
        const rel = entry.slice(3);
        const abs = path.join(workspaceRoot, rel);
        let unstaged: 'added'|'modified'|'deleted'|null = null;
        if (X === '?' && Y === '?') { unstaged = 'added'; }
        else if (Y === 'M') { unstaged = 'modified'; }
        else if (Y === 'D') { unstaged = 'deleted'; }
        else if (X === 'A' && Y === ' ') { unstaged = 'added'; }
        let staged: 'added' | 'modified' | 'deleted' | null = null;
        if (X === 'A') { staged = 'added'; }
        else if (X === 'D') { staged = 'deleted'; }
        else if (X !== ' ' && X !== '?') { staged = 'modified'; }
        map.set(abs, { unstaged, staged });
      }
      return map;
    } catch { return null; }
  }

  private parseGitDiff(workspaceRoot: string, staged: boolean): Map<string, Array<{start: number; end: number; isNew: boolean}>> {
    try {
      const args = ['diff', '--unified=0'];
      if (staged) { args.push('--cached'); }
      const out = cp.execFileSync('git', args, {
        cwd: workspaceRoot, timeout: 5000, encoding: 'utf8'
      });
      const map = new Map<string, Array<{start: number; end: number; isNew: boolean}>>();
      let currentFile: string | null = null;
      for (const line of out.split('\n')) {
        if (line.startsWith('+++ b/')) {
          currentFile = path.join(workspaceRoot, line.slice(6).trimEnd());
          if (!map.has(currentFile)) { map.set(currentFile, []); }
        } else if (line.startsWith('@@') && currentFile) {
          const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
          if (m) {
            const oldCount  = m[2] !== undefined ? parseInt(m[2], 10) : 1;
            const newStart  = parseInt(m[3], 10);
            const newCount  = m[4] !== undefined ? parseInt(m[4], 10) : 1;
            const end = newCount > 0 ? newStart + newCount - 1 : newStart;
            map.get(currentFile)!.push({ start: newStart, end, isNew: oldCount === 0 });
          }
        }
      }
      return map;
    } catch { return new Map(); }
  }

  /** Try the VS Code Python extension interpreter, then workspace venvs, then `python3`/`python`; return first working binary or null. Caches result. */
  resolvePythonBin(): string | null {
    if (this.resolvedPythonBin !== undefined) { return this.resolvedPythonBin; }

    const candidates: (string | undefined)[] = [];

    // 1. VS Code Python extension live API (most reliable — reflects active environment)
    const pythonExt = vscode.extensions.getExtension('ms-python.python');
    if (pythonExt?.isActive) {
      try {
        const api = pythonExt.exports as any;
        const apiPath =
          api.settings?.getExecutionDetails?.()?.execCommand?.[0] ||
          api.environment?.getActiveInterpreterPath?.() ||
          api.environments?.getActiveEnvironmentPath?.()?.path;
        candidates.push(apiPath || undefined);
      } catch { /* Python ext API unavailable */ }
    }

    // 2. VS Code configuration settings
    candidates.push(
      vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath') || undefined,
      vscode.workspace.getConfiguration('python').get<string>('pythonPath') || undefined, // legacy
    );

    // 3. Workspace-local virtualenvs (common project layouts)
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
      for (const rel of ['.venv/bin/python', 'venv/bin/python', '.env/bin/python']) {
        candidates.push(path.join(wsRoot, rel));
      }
    }

    // 4. PATH fallback
    candidates.push('python3', 'python');

    for (const bin of candidates.filter(Boolean) as string[]) {
      try {
        cp.execFileSync(bin, ['--version'], { timeout: 2000 });
        this.resolvedPythonBin = bin;
        return bin;
      } catch { /* try next */ }
    }

    this.resolvedPythonBin = null;
    return null;
  }

  /** Show error in the panel (if alive) and as a VS Code notification. */
  private showError(message: string): void {
    if (this.panel) {
      this.panel.webview.html = this.getErrorHtml(message);
    }
    vscode.window.showErrorMessage(message);
  }

  private applyGitStatuses(nodes: GraphNode[], workspaceRoot: string): boolean {
    const gitMap = this.parseGitStatus(workspaceRoot);
    if (gitMap === null) { return false; }

    const nodesByFile = new Map<string, GraphNode[]>();
    for (const node of nodes) {
      if (!node.file) continue;
      if (!nodesByFile.has(node.file)) { nodesByFile.set(node.file, []); }
      nodesByFile.get(node.file)!.push(node);
    }
    for (const list of nodesByFile.values()) {
      list.sort((a, b) => a.line - b.line);
    }

    const unstagedDiff = this.parseGitDiff(workspaceRoot, false);
    const stagedDiff   = this.parseGitDiff(workspaceRoot, true);

    for (const node of nodes) {
      if (!node.file) continue;
      const fileStatus = gitMap.get(node.file);
      if (!fileStatus) { node.gitStatus = { unstaged: null, staged: null }; continue; }
      if (fileStatus.unstaged === 'added' || fileStatus.unstaged === 'deleted') {
        node.gitStatus = fileStatus; continue;
      }
      const siblings  = nodesByFile.get(node.file)!;
      const idx       = siblings.indexOf(node);
      const nodeStart = node.line;
      const nodeEnd   = idx + 1 < siblings.length ? siblings[idx + 1].line - 1 : Infinity;
      const hunkStatus = (hunks: Array<{start: number; end: number; isNew: boolean}>): 'added'|'modified'|null => {
        const overlapping = hunks.filter(h => h.start <= nodeEnd && h.end >= nodeStart);
        if (overlapping.length === 0) { return null; }
        const defLineIsNew = overlapping.some(h => h.isNew && h.start <= nodeStart && nodeStart <= h.end);
        return defLineIsNew ? 'added' : 'modified';
      };
      node.gitStatus = {
        unstaged: hunkStatus(unstagedDiff.get(node.file) ?? []),
        staged:   hunkStatus(stagedDiff.get(node.file)   ?? []),
      };
    }
    return true;
  }

  private refreshGitStatus(workspaceRoot: string): void {
    if (!this.panel || this.cachedNodes.length === 0) { return; }
    this.applyGitStatuses(this.cachedNodes, workspaceRoot);
    this.panel.webview.postMessage({
      type: 'git-update',
      nodes: this.cachedNodes.map(n => ({ id: n.id, gitStatus: n.gitStatus })),
    });
  }

  /** Parse stdout, guard empty graphs, and post the graph message. */
  private handleAnalysisResult(stdout: string, workspaceRoot: string): void {
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

    const isReanalysis = this.cachedNodes.length > 0;
    const gitAvailable = this.applyGitStatuses(graph.nodes, workspaceRoot);
    this.cachedNodes = graph.nodes.filter(n => !n.isLibrary);

    if (isReanalysis) {
      this.panel.webview.postMessage({ type: 'graph', data: graph, gitAvailable, isReanalysis: true });
    } else {
      this.panel.webview.html = this.getWebviewHtml(this.panel.webview);
      // Delay postMessage so webview JS is fully initialised before the data arrives.
      setTimeout(() => {
        this.panel?.webview.postMessage({ type: 'graph', data: graph, gitAvailable, isReanalysis: false });
      }, 150);
    }
  }

  private scheduleReanalysis(workspaceRoot: string): void {
    if (this.reanalysisTimer) { clearTimeout(this.reanalysisTimer); }
    this.reanalysisTimer = setTimeout(() => {
      for (const proc of this.activeProcs) { proc.kill(); }
      this.activeProcs = [];
      this.runAnalyzer(workspaceRoot);
    }, 1000);
  }

  private spawnAnalyzerProcess(bin: string, args: string[], fatal: boolean): Promise<GraphData> {
    const empty: GraphData = { nodes: [], edges: [] };
    return new Promise((resolve) => {
      let proc: cp.ChildProcess;
      try {
        proc = cp.spawn(bin, args);
      } catch (err: unknown) {
        if (fatal) {
          this.showError(`CoGraph: Failed to start analyzer — ${(err as Error).message}`);
        }
        resolve(empty);
        return;
      }
      this.activeProcs.push(proc);

      let stdout = '';
      let stdoutBytes = 0;
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
        if (fatal) {
          this.showError(`CoGraph: Analysis timed out after ${ANALYSIS_TIMEOUT_MS / 1000}s.`);
        }
        resolve(empty);
      }, ANALYSIS_TIMEOUT_MS);

      proc.stdout!.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          proc.kill();
          if (fatal) {
            this.showError('CoGraph: Analysis output too large (> 500 MB). Try a smaller workspace.');
          }
          return;
        }
        stdout += chunk.toString();
      });

      proc.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        this.activeProcs = this.activeProcs.filter(p => p !== proc);
        if (fatal) {
          this.showError(`CoGraph: Failed to start analyzer — ${err.message}`);
        }
        resolve(empty);
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        this.activeProcs = this.activeProcs.filter(p => p !== proc);
        if (timedOut || stdoutBytes > MAX_OUTPUT_BYTES) {
          return; // already resolved above
        }
        if (code !== 0) {
          if (fatal) {
            const detail = stderr.slice(0, 500);
            this.showError(`CoGraph: Analysis failed (exit ${code}).\n${detail}`);
          }
          resolve(empty);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as GraphData);
        } catch {
          if (fatal) {
            this.showError('CoGraph: Failed to parse graph data.');
          }
          resolve(empty);
        }
      });
    });
  }

  private runAnalyzer(workspaceRoot: string): void {
    const pythonBin = this.resolvePythonBin();
    if (!pythonBin) {
      this.showError('CoGraph: Python not found. Install Python 3 and ensure it is on PATH.');
      return;
    }

    const pyScript = path.join(this.context.extensionPath, 'scripts', 'analyze.py');
    const tsScript = path.join(this.context.extensionPath, 'scripts', 'analyze_ts.js');

    const pyPromise = this.spawnAnalyzerProcess(pythonBin, [pyScript, workspaceRoot], true);
    const tsPromise = this.spawnAnalyzerProcess(process.execPath, [tsScript, workspaceRoot], false);

    Promise.all([pyPromise, tsPromise]).then(([pyGraph, tsGraph]) => {
      const merged: GraphData = {
        nodes: [...pyGraph.nodes, ...tsGraph.nodes],
        edges: [...pyGraph.edges, ...tsGraph.edges],
      };
      this.handleAnalysisResult(JSON.stringify(merged), workspaceRoot);
    });
  }

  private fetchLibDescription(libraryName: string, functionName: string, language: string, workspaceRoot: string): Promise<string> {
    if (language === 'python') {
      return this.fetchPythonDescription(libraryName, functionName);
    }
    return Promise.resolve(this.fetchTsDescription(libraryName, functionName, workspaceRoot));
  }

  private fetchPythonDescription(libraryName: string, functionName: string): Promise<string> {
    const pythonBin = this.resolvePythonBin();
    if (!pythonBin) { return Promise.resolve(''); }
    this.outputChannel.appendLine(`[CoGraph] Using Python: ${pythonBin}`);
    const script = path.join(this.context.extensionPath, 'scripts', 'describe_lib.py');
    return new Promise(resolve => {
      let resolved = false;
      const done = (val: string) => { if (!resolved) { resolved = true; resolve(val); } };
      let proc: cp.ChildProcess;
      try {
        proc = cp.spawn(pythonBin, [script, libraryName, functionName]);
      } catch {
        done('');
        return;
      }
      let stdout = '';
      proc.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr!.on('data', (chunk: Buffer) => {
        this.outputChannel.appendLine(`[describe_lib] ${chunk.toString().trim()}`);
      });
      proc.on('close', () => done(stdout.trim()));
      proc.on('error', () => done(''));
      setTimeout(() => { proc.kill(); done(''); }, 5000);
    });
  }

  private fetchTsDescription(libraryName: string, functionName: string, workspaceRoot: string): string {
    const nmDir = path.join(workspaceRoot, 'node_modules');
    const pkgDirs = [
      path.join(nmDir, '@types', libraryName),
      path.join(nmDir, libraryName),
    ];
    const candidates: string[] = [];
    for (const pkgDir of pkgDirs) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        const typesFile = pkg.types || pkg.typings;
        if (typesFile) { candidates.push(path.join(pkgDir, typesFile)); }
      } catch { /* no package.json */ }
      candidates.push(path.join(pkgDir, 'index.d.ts'));
    }
    const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`/\\*\\*([\\s\\S]*?)\\*/[\\s\\S]{0,300}?\\b${escaped}\\s*[(<]`, 'g');
    for (const filePath of candidates) {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(content)) !== null) {
          const desc = match[1]
            .split('\n')
            .map((l: string) => l.replace(/^\s*\*\s?/, '').trim())
            .filter((l: string) => l && !l.startsWith('@'))
            .join('\n')
            .trim();
          if (desc) { return desc; }
        }
      } catch { /* skip */ }
    }
    return '';
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
    <p>No functions found in this workspace.</p>
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
  <div id="top-left-controls">
    <div id="panel-detail" class="tl-panel">
      <div class="tl-slider-header">
        <label for="slider-complexity">Detail</label>
        <span id="val-complexity">0.99</span>
      </div>
      <input type="range" id="slider-complexity" min="0" max="1" step="0.01" value="0.99" />
      <div class="tl-legend-header" id="toggle-detail-legend">
        <span>Legend</span>
        <span class="tl-chevron">▾</span>
      </div>
      <div class="tl-legend" id="detail-legend-body">
        <div class="tl-legend-row">
          <span class="tl-legend-dot" style="background:#d4d4d4"></span>
          <span class="tl-legend-label">Function Node</span>
        </div>
        <div class="tl-legend-row">
          <span class="tl-legend-dot" style="background:#7c4dbb"></span>
          <span class="tl-legend-label">Clustered Node</span>
        </div>
        <div class="tl-legend-row">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="#c8a84b" style="flex-shrink:0"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zM2.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-11zM3 5.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0 2a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0 2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5z"/></svg>
          <span class="tl-legend-label">Library Node</span>
        </div>
      </div>
    </div>
    <div id="panel-git" class="tl-panel" style="display:none">
      <button id="btn-git-mode" class="tl-btn" title="Toggle git diff colors">Git</button>
      <div class="tl-legend-header" id="toggle-git-legend">
        <span>Legend</span>
        <span class="tl-chevron">▾</span>
      </div>
      <div class="tl-legend" id="git-legend-body">
        <div class="tl-legend-row">
          <span class="tl-legend-dot" style="background:#ff9800"></span>
          <span class="tl-legend-label">Modified Func</span>
        </div>
        <div class="tl-legend-row">
          <span class="tl-legend-dot" style="background:#4caf50"></span>
          <span class="tl-legend-label">New Func</span>
        </div>
        <div class="tl-legend-row">
          <span class="tl-legend-dot" style="background:#555555"></span>
          <span class="tl-legend-label">Deleted</span>
        </div>
        <div class="tl-legend-row">
          <span class="tl-legend-dot tl-legend-dot--staged"></span>
          <span class="tl-legend-label">Staged</span>
        </div>
      </div>
    </div>
    <div id="panel-lang" class="tl-panel">
      <button id="btn-language-mode" class="tl-btn" title="Toggle language colors">Lang</button>
      <div id="language-legend"></div>
    </div>
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
        <span>Show Orphans</span>
        <label class="switch"><input type="checkbox" id="toggle-orphans" checked /><span class="pill"></span></label>
      </div>
      <div class="toggle-row">
        <span>Show Libraries</span>
        <label class="switch"><input type="checkbox" id="toggle-libraries" /><span class="pill"></span></label>
      </div>
    </div>

    <div class="panel-section">
      <h4>Groups</h4>
      <div class="toggle-row stub" title="Coming soon">
        <span>Group by File Structure</span>
        <label class="switch"><input type="checkbox" id="toggle-group-file" disabled /><span class="pill"></span></label>
      </div>
      <div class="toggle-row stub" title="Coming soon">
        <span>Group by Inheritance</span>
        <label class="switch"><input type="checkbox" id="toggle-group-inherit" disabled /><span class="pill"></span></label>
      </div>
      <div class="toggle-row stub" title="Coming soon">
        <span>Group by Flow (L&#8594;R)</span>
        <label class="switch"><input type="checkbox" id="toggle-group-flow" disabled /><span class="pill"></span></label>
      </div>
      <button id="btn-new-group" class="stub" disabled>+ Create new Group</button>
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
        <div class="slider-header"><label for="slider-text-size">Text Size</label><span id="val-text-size">1</span></div>
        <input type="range" id="slider-text-size" min="0.5" max="2" step="0.1" value="1" />
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
  <div id="lib-doc-popup">
    <div id="lib-doc-card">
      <div id="lib-doc-header">
        <div>
          <span id="lib-doc-title"></span>
          <span id="lib-doc-lang-badge"></span>
        </div>
        <button id="lib-doc-close" title="Close">&#x2715;</button>
      </div>
      <div id="lib-doc-desc-row">
        <span id="lib-doc-desc"></span>
      </div>
      <div id="lib-doc-body">
        <div id="lib-doc-function-row">
          <span class="lib-doc-label">Function</span>
          <span id="lib-doc-function"></span>
        </div>
        <div id="lib-doc-package-row">
          <span class="lib-doc-label">Package</span>
          <span id="lib-doc-package"></span>
        </div>
        <div id="lib-doc-url-row">
          <span class="lib-doc-label">Docs</span>
          <span id="lib-doc-url"></span>
        </div>
      </div>
      <div id="lib-doc-footer">
        <button id="lib-doc-goto-btn">Go to documentation &#x2197;</button>
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
