import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GraphData } from './graphProvider';
import { listProjectSourceFiles } from './structureScanner';

/**
 * The analyzer subprocesses, without VS Code: one spawn with its guards (timeout,
 * output cap, parse), and a full pass over a directory. AnalyzerRunner spawns
 * through `spawnAnalyzer`; the fixture recorder (scripts/tour-fixture.mjs) runs
 * `spawnAnalyzers` from plain Node.
 */

export const MAX_OUTPUT_BYTES = 500 * 1024 * 1024; // 500 MB guard
export const ANALYSIS_TIMEOUT_MS = 300_000;         // 5 min

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

export interface SpawnHooks {
  log: (msg: string) => void;
  /** The child started: the caller holds it so it can kill it. */
  onStart?: (proc: cp.ChildProcess) => void;
  /** The child is gone (closed or failed): the caller lets go of it. */
  onEnd?: (proc: cp.ChildProcess) => void;
}

/** Run one analyzer; never rejects — every failure comes back as a status. */
export function spawnAnalyzer(bin: string, args: string[], lang: string, hooks: SpawnHooks): Promise<AnalyzerResult> {
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

    hooks.onStart?.(proc);

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
      hooks.onEnd?.(proc);
      resolve(fail('spawn-error', err.message));
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      hooks.onEnd?.(proc);
      if (timedOut || tooLarge) { return; } // already resolved above
      if (code !== 0) {
        resolve(fail('exit-nonzero', `exit ${code}${stderr ? ` — ${stderr.slice(0, 300).trim()}` : ''}`));
        return;
      }
      try {
        const graph = JSON.parse(stdout) as GraphData;
        // D6: analyzers report how many ambiguous call names they narrowed /
        // dropped (only present when > 0) — make the effect visible in the log.
        const stats = (graph as { stats?: { ambiguousNarrowed?: number; ambiguousDropped?: number } }).stats;
        if (stats) {
          hooks.log(`Analyzer [${lang}]: ${stats.ambiguousNarrowed ?? 0} ambiguous calls narrowed, `
            + `${stats.ambiguousDropped ?? 0} dropped (names with more than 8 definitions)`);
        }
        resolve({ graph, status: graph.nodes.length > 0 ? 'ok' : 'empty', lang });
      } catch {
        resolve(fail('parse-error', stderr ? stderr.slice(0, 300).trim() : 'invalid JSON'));
      }
    });
  });
}

/** The six analyzers of a full pass, in the order AnalyzerRunner starts them. */
export const ANALYZER_SCRIPTS: ReadonlyArray<{ script: string; lang: string; python: boolean }> = [
  { script: 'analyze.py', lang: 'python', python: true },
  { script: 'analyze_ts.js', lang: 'typescript', python: false },
  { script: 'analyze_js.js', lang: 'javascript', python: false },
  { script: 'analyze_java.js', lang: 'java', python: false },
  { script: 'analyze_cpp.js', lang: 'cpp', python: false },
  { script: 'analyze_c.js', lang: 'c', python: false },
];

export function mergeResults(statuses: AnalyzerResult[]): GraphData {
  return {
    nodes: statuses.flatMap(r => r.graph.nodes),
    edges: statuses.flatMap(r => r.graph.edges),
    files: statuses.flatMap(r => r.graph.files ?? []),
  };
}

export interface SpawnAnalyzersOptions {
  /** Directory holding analyze.py and analyze_*.js (scripts/ or dist/scripts/). */
  scriptsDir: string;
  /** Python interpreter; the Python analyzer is reported as a spawn error when it is null. */
  pythonBin: string | null;
  /** Interpreter for the node analyzers; the running Node by default. */
  nodeBin?: string;
  log?: (msg: string) => void;
  /** Kills every child on abort. */
  signal?: AbortSignal;
}

/**
 * One full analysis of `dir` outside VS Code: the structure scanner's file list
 * (`--files`, so the graph covers what the Folder tree shows), the six analyzers
 * in parallel, their graphs merged.
 */
export async function spawnAnalyzers(dir: string, opts: SpawnAnalyzersOptions): Promise<{ graph: GraphData; statuses: AnalyzerResult[] }> {
  const log = opts.log ?? (() => undefined);
  const listPath = path.join(os.tmpdir(), `cograph-spawn-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(listPath, listProjectSourceFiles(dir).map(f => f.path).join('\n'), 'utf8');
  const live = new Set<cp.ChildProcess>();
  const kill = () => { for (const p of live) { try { p.kill(); } catch { /* gone */ } } };
  opts.signal?.addEventListener('abort', kill);
  try {
    const statuses = await Promise.all(ANALYZER_SCRIPTS.map(({ script, lang, python }) => {
      const bin = python ? opts.pythonBin : (opts.nodeBin ?? process.execPath);
      if (!bin) { return Promise.resolve<AnalyzerResult>({ graph: { nodes: [], edges: [], files: [] }, status: 'spawn-error', lang, detail: 'no Python interpreter' }); }
      return spawnAnalyzer(bin, [path.join(opts.scriptsDir, script), dir, '--files', listPath], lang, {
        log, onStart: (p) => live.add(p), onEnd: (p) => live.delete(p),
      });
    }));
    if (opts.signal?.aborted) { throw new Error('Cancelled.'); }
    return { graph: mergeResults(statuses), statuses };
  } finally {
    opts.signal?.removeEventListener('abort', kill);
    fs.rmSync(listPath, { force: true });
  }
}
