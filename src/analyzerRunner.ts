import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export const MAX_OUTPUT_BYTES = 500 * 1024 * 1024; // 500 MB guard
export const ANALYSIS_TIMEOUT_MS = 300_000;         // 5 min

interface GraphNode {
  id: string; name: string; file: string | null; line: number;
  language?: 'python' | 'typescript' | 'javascript'; gitStatus?: unknown;
  isLibrary?: boolean; libraryName?: string;
}
interface GraphEdge { source: string; target: string; isLibraryEdge?: boolean; }
interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; }

export class AnalyzerRunner {
  private activeProcs: cp.ChildProcess[] = [];
  private reanalysisTimer: ReturnType<typeof setTimeout> | undefined;
  private resolvedPythonBin: string | null | undefined = undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly showError: (msg: string) => void,
    private readonly onResult: (stdout: string, workspaceRoot: string) => void,
  ) {}

  killAll(): void {
    for (const proc of this.activeProcs) { proc.kill(); }
    this.activeProcs = [];
  }

  clearReanalysisTimer(): void {
    if (this.reanalysisTimer) { clearTimeout(this.reanalysisTimer); }
  }

  scheduleReanalysis(workspaceRoot: string): void {
    this.clearReanalysisTimer();
    this.reanalysisTimer = setTimeout(() => {
      this.killAll();
      this.run(workspaceRoot);
    }, 1000);
  }

  run(workspaceRoot: string): void {
    const pythonBin = this.resolvePythonBin();
    if (!pythonBin) {
      this.showError('CoGraph: Python not found. Install Python 3 and ensure it is on PATH.');
      return;
    }
    const pyScript = path.join(this.context.extensionPath, 'scripts', 'analyze.py');
    const tsScript = path.join(this.context.extensionPath, 'scripts', 'analyze_ts.js');
    const jsScript = path.join(this.context.extensionPath, 'scripts', 'analyze_js.js');
    const pyPromise = this.spawnAnalyzerProcess(pythonBin, [pyScript, workspaceRoot], true);
    const tsPromise = this.spawnAnalyzerProcess(process.execPath, [tsScript, workspaceRoot], false);
    const jsPromise = this.spawnAnalyzerProcess(process.execPath, [jsScript, workspaceRoot], false);
    Promise.all([pyPromise, tsPromise, jsPromise]).then(([pyGraph, tsGraph, jsGraph]) => {
      const merged: GraphData = {
        nodes: [...pyGraph.nodes, ...tsGraph.nodes, ...jsGraph.nodes],
        edges: [...pyGraph.edges, ...tsGraph.edges, ...jsGraph.edges],
      };
      this.onResult(JSON.stringify(merged), workspaceRoot);
    });
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
      vscode.workspace.getConfiguration('python').get<string>('pythonPath') || undefined,
    );

    // 3. Workspace-local virtualenvs (common project layouts, Unix and Windows)
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
      const venvLayouts = process.platform === 'win32'
        ? [
            path.join('.venv', 'Scripts', 'python.exe'),
            path.join('venv', 'Scripts', 'python.exe'),
            path.join('.env', 'Scripts', 'python.exe'),
          ]
        : [
            path.join('.venv', 'bin', 'python'),
            path.join('venv', 'bin', 'python'),
            path.join('.env', 'bin', 'python'),
          ];
      for (const rel of venvLayouts) {
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
}
