import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export const MAX_OUTPUT_BYTES = 500 * 1024 * 1024; // 500 MB guard
export const ANALYSIS_TIMEOUT_MS = 300_000;         // 5 min

/** How many times the initial analysis is retried when it comes back empty. */
export const MAX_ANALYSIS_RETRIES = 3;
/** Backoff before each retry (indexed by attempt). */
export const RETRY_BACKOFF_MS = [800, 1500, 3000];

/** Source extensions any analyzer can handle — used by the readiness probe. */
const SOURCE_EXTS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java',
  '.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.h',
]);
/** Directories skipped by every analyzer's file walk (kept in sync with scripts/). */
const SKIP_DIR_NAMES = new Set(['node_modules', 'out', 'dist', 'target', 'build', 'CMakeFiles']);

export type AnalyzerStatus =
  | 'ok'             // produced ≥1 node
  | 'empty'          // ran cleanly, 0 nodes
  | 'timeout'        // killed at ANALYSIS_TIMEOUT_MS
  | 'spawn-error'    // failed to start
  | 'exit-nonzero'   // exited with a non-zero code
  | 'parse-error'    // stdout was not valid JSON
  | 'output-too-large'; // exceeded MAX_OUTPUT_BYTES

export interface AnalyzerResult {
  graph: GraphData;
  status: AnalyzerStatus;
  lang: string;
  detail?: string;
}

/** Metadata accompanying a finished analysis run, so the UI can react to failures. */
export interface AnalyzerRunMeta {
  statuses: AnalyzerResult[];
  /** True if at least one supported source file exists on disk. */
  candidateFilesFound: boolean;
}

import type { GraphNode, GraphEdge, GraphData } from './graphProvider';

export class AnalyzerRunner {
  private activeProcs: cp.ChildProcess[] = [];
  private reanalysisTimer: ReturnType<typeof setTimeout> | undefined;
  private resolvedPythonBin: string | null | undefined = undefined;
  /** Bumped by killAll() / each new run so a stale retry loop aborts itself. */
  private runToken = 0;
  /** Monotonic counter for unique subset temp-file names. */
  private subsetSeq = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly showError: (msg: string) => void,
    private readonly onResult: (stdout: string, workspaceRoot: string, meta: AnalyzerRunMeta) => void,
    private readonly log: (msg: string) => void = () => { /* no-op */ },
    private readonly onRetry: (attempt: number, max: number) => void = () => { /* no-op */ },
  ) {}

  killAll(): void {
    this.runToken++; // invalidate any in-flight retry loop
    for (const proc of this.activeProcs) {
      if (proc && typeof proc.kill === 'function') {
        try { proc.kill(); } catch { /* already exited */ }
      }
    }
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

  /**
   * Run the analyzers. On the initial load (`allowRetry`), an empty result is
   * retried with backoff — this recovers the "workspace not fully loaded yet" /
   * transient-analyzer-failure cases that previously produced a permanent blank
   * graph. Reanalysis-on-save passes no options, so it never loops.
   */
  run(workspaceRoot: string, opts: { allowRetry?: boolean } = {}): void {
    this.runWithRetry(workspaceRoot, opts.allowRetry ?? false, ++this.runToken)
      .catch((err: unknown) => this.log(`Analysis run failed unexpectedly: ${(err as Error).message}`));
  }

  private async runWithRetry(workspaceRoot: string, allowRetry: boolean, token: number): Promise<void> {
    const pythonBin = this.resolvePythonBin();
    if (!pythonBin) {
      this.showError('CoGraph: Python not found. Install Python 3 and ensure it is on PATH.');
      return;
    }

    let merged: GraphData = { nodes: [], edges: [], files: [] };
    let statuses: AnalyzerResult[] = [];

    for (let attempt = 0; attempt <= MAX_ANALYSIS_RETRIES; attempt++) {
      const result = await this.runOnce(workspaceRoot, pythonBin);
      if (token !== this.runToken) { return; } // superseded by killAll() or a newer run
      merged = result.merged;
      statuses = result.statuses;

      // Surface every non-clean analyzer outcome — never swallow it silently.
      for (const s of statuses) {
        if (s.status !== 'ok' && s.status !== 'empty') {
          this.log(`Analyzer [${s.lang}] ${s.status}${s.detail ? `: ${s.detail}` : ''}`);
        }
      }

      if (merged.nodes.length > 0) { break; } // success — even a partial graph beats retrying

      // Retrying a timeout / oversized output just wastes minutes; those need a smaller scope.
      const hardLimit = statuses.some(s => s.status === 'timeout' || s.status === 'output-too-large');
      if (!allowRetry || attempt >= MAX_ANALYSIS_RETRIES || hardLimit) { break; }

      this.onRetry(attempt + 1, MAX_ANALYSIS_RETRIES);
      await this.delay(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
      if (token !== this.runToken) { return; }
    }

    const candidateFilesFound = this.countCandidateSourceFiles(workspaceRoot, 1) > 0;
    this.onResult(JSON.stringify(merged), workspaceRoot, { statuses, candidateFilesFound });
  }

  private runOnce(workspaceRoot: string, pythonBin: string): Promise<{ merged: GraphData; statuses: AnalyzerResult[] }> {
    const ext = this.context.extensionPath;
    const spawns: Array<Promise<AnalyzerResult>> = [
      this.spawnAnalyzerProcess(pythonBin, [path.join(ext, 'scripts', 'analyze.py'), workspaceRoot], 'python'),
      this.spawnAnalyzerProcess(process.execPath, [path.join(ext, 'scripts', 'analyze_ts.js'), workspaceRoot], 'typescript'),
      this.spawnAnalyzerProcess(process.execPath, [path.join(ext, 'scripts', 'analyze_js.js'), workspaceRoot], 'javascript'),
      this.spawnAnalyzerProcess(process.execPath, [path.join(ext, 'scripts', 'analyze_java.js'), workspaceRoot], 'java'),
      this.spawnAnalyzerProcess(process.execPath, [path.join(ext, 'scripts', 'analyze_cpp.js'), workspaceRoot], 'cpp'),
    ];
    return Promise.all(spawns).then((statuses) => {
      const merged: GraphData = {
        nodes: statuses.flatMap(r => r.graph.nodes),
        edges: statuses.flatMap(r => r.graph.edges),
        files: statuses.flatMap(r => r.graph.files ?? []),
      };
      return { merged, statuses };
    });
  }

  /**
   * Parse only the given files (lazy per-folder expansion / single-file
   * incremental re-analysis) and return the merged subset graph. Reuses
   * spawnAnalyzerProcess, so killAll() cancels subset parses too. Each analyzer
   * self-filters the list to its own extensions, so a mixed list is safe.
   *
   * Caveat: call targets resolve only within the parsed set, so edges into
   * un-parsed files may be incomplete until the full background pass reconciles.
   */
  async runSubset(workspaceRoot: string, files: string[]): Promise<GraphData> {
    const empty: GraphData = { nodes: [], edges: [], files: [] };
    if (files.length === 0) { return empty; }
    const pythonBin = this.resolvePythonBin();

    let listPath: string;
    try {
      listPath = path.join(os.tmpdir(), `cograph-subset-${process.pid}-${this.subsetSeq++}.txt`);
      fs.writeFileSync(listPath, files.join('\n'), 'utf8');
    } catch {
      return empty;
    }

    try {
      const ext = this.context.extensionPath;
      const withList = (script: string) => [path.join(ext, 'scripts', script), workspaceRoot, '--files', listPath];
      const spawns: Array<Promise<AnalyzerResult>> = [
        this.spawnAnalyzerProcess(process.execPath, withList('analyze_ts.js'), 'typescript'),
        this.spawnAnalyzerProcess(process.execPath, withList('analyze_js.js'), 'javascript'),
        this.spawnAnalyzerProcess(process.execPath, withList('analyze_java.js'), 'java'),
        this.spawnAnalyzerProcess(process.execPath, withList('analyze_cpp.js'), 'cpp'),
      ];
      if (pythonBin) {
        spawns.push(this.spawnAnalyzerProcess(pythonBin, withList('analyze.py'), 'python'));
      }
      const statuses = await Promise.all(spawns);
      for (const s of statuses) {
        if (s.status !== 'ok' && s.status !== 'empty') {
          this.log(`Subset analyzer [${s.lang}] ${s.status}${s.detail ? `: ${s.detail}` : ''}`);
        }
      }
      return {
        nodes: statuses.flatMap(r => r.graph.nodes),
        edges: statuses.flatMap(r => r.graph.edges),
        files: statuses.flatMap(r => r.graph.files ?? []),
      };
    } finally {
      try { fs.unlinkSync(listPath); } catch { /* best effort cleanup */ }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Count supported source files on disk, stopping at `cap`. Cheap readiness
   * probe that distinguishes "no source yet / still loading" from "files present
   * but analysis returned empty", so the empty-state can say something useful.
   */
  countCandidateSourceFiles(root: string, cap = 1): number {
    let count = 0;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop() as string;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIR_NAMES.has(entry.name) && !entry.name.startsWith('.') && !entry.name.startsWith('cmake-build-')) {
            stack.push(path.join(dir, entry.name));
          }
        } else if (entry.isFile()) {
          const dot = entry.name.lastIndexOf('.');
          if (dot >= 0 && SOURCE_EXTS.has(entry.name.slice(dot))) {
            count++;
            if (count >= cap) { return count; }
          }
        }
      }
    }
    return count;
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

  private spawnAnalyzerProcess(bin: string, args: string[], lang: string): Promise<AnalyzerResult> {
    const empty: GraphData = { nodes: [], edges: [], files: [] };
    const fail = (status: AnalyzerStatus, detail?: string): AnalyzerResult => ({ graph: empty, status, lang, detail });
    return new Promise((resolve) => {
      let proc: cp.ChildProcess;
      try {
        proc = cp.spawn(bin, args);
      } catch (err: unknown) {
        resolve(fail('spawn-error', (err as Error).message));
        return;
      }
      
      if (!proc) {
        resolve(fail('spawn-error', 'spawn returned undefined'));
        return;
      }

      if (!proc.stdout || !proc.stderr) {
        if (typeof proc.kill === 'function') { try { proc.kill(); } catch { /* ignore */ } }
        resolve(fail('spawn-error', 'missing stdio streams'));
        return;
      }

      this.activeProcs.push(proc);

      let stdout = '';
      let stdoutBytes = 0;
      let stderr = '';
      let timedOut = false;
      let tooLarge = false;

      const timer = setTimeout(() => {
        timedOut = true;
        if (proc && typeof proc.kill === 'function') { try { proc.kill(); } catch { /* ignore */ } }
        resolve(fail('timeout', `exceeded ${ANALYSIS_TIMEOUT_MS / 1000}s`));
      }, ANALYSIS_TIMEOUT_MS);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          tooLarge = true;
          if (proc && typeof proc.kill === 'function') { try { proc.kill(); } catch { /* ignore */ } }
          resolve(fail('output-too-large', '> 500 MB'));
          return;
        }
        stdout += chunk.toString();
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('error', (err: Error) => {
        clearTimeout(timer);
        this.activeProcs = this.activeProcs.filter(p => p !== proc);
        resolve(fail('spawn-error', err.message));
      });

      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        this.activeProcs = this.activeProcs.filter(p => p !== proc);
        if (timedOut || tooLarge) { return; } // already resolved above
        if (code !== 0) {
          resolve(fail('exit-nonzero', `exit ${code}${stderr ? ` — ${stderr.slice(0, 300).trim()}` : ''}`));
          return;
        }
        try {
          const graph = JSON.parse(stdout) as GraphData;
          resolve({ graph, status: graph.nodes.length > 0 ? 'ok' : 'empty', lang });
        } catch {
          resolve(fail('parse-error', stderr ? stderr.slice(0, 300).trim() : 'invalid JSON'));
        }
      });
    });
  }
}
