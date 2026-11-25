import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
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
/** Only the start of a failed analyzer's stderr is shown; the rest must not grow past what a string can hold. */
const MAX_STDERR_CHARS = 64 * 1024;

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
  /** Files the analyzer could not use; they are missing from its graph, the rest is complete. */
  filesNotParsed?: number;
}

export interface SpawnHooks {
  log: (msg: string) => void;
  /** The child started: the caller holds it so it can kill it. */
  onStart?: (proc: cp.ChildProcess) => void;
  /** The child is gone (closed or failed): the caller lets go of it. */
  onEnd?: (proc: cp.ChildProcess) => void;
}

/** Where a run differs from the extension's: unset means this process's own. */
export interface SpawnLimits {
  /** Above this much stdout the analyzer is killed; MAX_OUTPUT_BYTES when unset. */
  maxOutputBytes?: number;
  cwd?: string;
  /** The child's whole environment, not an addition to this process's. */
  env?: NodeJS.ProcessEnv;
}

/** Run one analyzer; never rejects — every failure comes back as a status. */
export function spawnAnalyzer(bin: string, args: string[], lang: string, hooks: SpawnHooks, limits: SpawnLimits = {}): Promise<AnalyzerResult> {
  const maxOutputBytes = limits.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const empty: GraphData = { nodes: [], edges: [], files: [] };
  const fail = (status: AnalyzerStatus, detail?: string): AnalyzerResult => ({ graph: empty, status, lang, detail });
  return new Promise((resolve) => {
    let proc: cp.ChildProcess;
    try {
      proc = cp.spawn(bin, args, { cwd: limits.cwd, env: limits.env });
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
    // A pipe cuts anywhere, also inside a UTF-8 character; decoded per chunk, both halves turn into U+FFFD and JSON.parse never notices.
    const stdoutText = new StringDecoder('utf8');
    const stderrText = new StringDecoder('utf8');
    let timedOut = false;
    let tooLarge = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (proc && typeof proc.kill === 'function') { try { proc.kill(); } catch { /* ignore */ } }
      resolve(fail('timeout', `exceeded ${ANALYSIS_TIMEOUT_MS / 1000}s`));
    }, ANALYSIS_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        tooLarge = true;
        if (proc && typeof proc.kill === 'function') { try { proc.kill(); } catch { /* ignore */ } }
        resolve(fail('output-too-large', `> ${Math.round(maxOutputBytes / (1024 * 1024))} MB`));
        return;
      }
      stdout += stdoutText.write(chunk);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) { stderr += stderrText.write(chunk); }
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
      stdout += stdoutText.end();
      stderr += stderrText.end();
      if (code !== 0) {
        resolve(fail('exit-nonzero', `exit ${code}${stderr ? ` — ${stderr.slice(0, 300).trim()}` : ''}`));
        return;
      }
      try {
        const graph = JSON.parse(stdout) as GraphData;
        // D6: analyzers report how many ambiguous call names they narrowed /
        // dropped (only present when > 0) — make the effect visible in the log.
        const stats = (graph as { stats?: { ambiguousNarrowed?: number; ambiguousDropped?: number; filesNotParsed?: number } }).stats;
        if (stats?.ambiguousNarrowed || stats?.ambiguousDropped) {
          hooks.log(`Analyzer [${lang}]: ${stats.ambiguousNarrowed ?? 0} ambiguous calls narrowed, `
            + `${stats.ambiguousDropped ?? 0} dropped (names with more than 8 definitions)`);
        }
        if (stats?.filesNotParsed) { hooks.log(`Analyzer [${lang}]: ${stats.filesNotParsed} files not parsed`); }
        resolve({ graph, status: graph.nodes.length > 0 ? 'ok' : 'empty', lang, ...(stats?.filesNotParsed ? { filesNotParsed: stats.filesNotParsed } : {}) });
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

/**
 * Absolute path to an analyzer script under `root` (the extension, or a package laid out like it).
 * Packaged builds ship esbuild-bundled node analyzers under dist/scripts (self-contained, no
 * node_modules in the .vsix); dev and test hosts fall back to the sources under scripts/. The
 * Python analyzers only ever exist under scripts/.
 */
export function analyzerScriptPath(root: string, name: string): string {
  const bundled = path.join(root, 'dist', 'scripts', name);
  return fs.existsSync(bundled) ? bundled : path.join(root, 'scripts', name);
}

/** The first candidate that runs `--version`; null when none does. */
export function probePython(candidates: Array<string | undefined>): string | null {
  for (const bin of candidates.filter(Boolean) as string[]) {
    try {
      cp.execFileSync(bin, ['--version'], { timeout: 2000 });
      return bin;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Nothing found AND an analyzer did not run cleanly: that is a failure, not a tree without
 * functions, and diffing an empty tree would paint every function as added or removed.
 * The sentence to fail with, or null.
 */
export function analysisFailed(graph: GraphData, statuses: AnalyzerResult[]): string | null {
  const failed = statuses.filter(s => s.status !== 'ok' && s.status !== 'empty');
  if (graph.nodes.length > 0 || failed.length === 0) { return null; }
  return `Analysis failed: ${failed.map(s => `${s.lang} ${s.status}${s.detail ? ` (${s.detail})` : ''}`).join('; ')}`;
}

export function mergeResults(statuses: AnalyzerResult[]): GraphData {
  return {
    nodes: statuses.flatMap(r => r.graph.nodes),
    edges: statuses.flatMap(r => r.graph.edges),
    files: statuses.flatMap(r => r.graph.files ?? []),
  };
}

/** A name holding a line break stays off the `--files` list: it would be two lines, and the second a path the name picks. */
export function listableFiles(files: string[], log: (msg: string) => void, kind: string): string[] {
  const listed = files.filter(f => !/[\r\n]/.test(f));
  if (listed.length < files.length) { log(`${files.length - listed.length} files with a line break in their name left out of the ${kind} analysis`); }
  return listed;
}

export interface SpawnAnalyzersOptions extends SpawnLimits {
  /** Directory holding analyze.py and analyze_*.js (scripts/ or dist/scripts/). */
  scriptsDir: string;
  /** Python interpreter; the Python analyzer is reported as a spawn error when it is null. */
  pythonBin: string | null;
  /** Interpreter for the node analyzers; the running Node by default. */
  nodeBin?: string;
  /** Node flags before each node analyzer's script, such as a heap limit. */
  nodeArgs?: string[];
  /** A larger file stays off the list and is counted in `oversized`: unset, none does. */
  maxFileBytes?: number;
  log?: (msg: string) => void;
  /** Kills every child on abort. */
  signal?: AbortSignal;
}

let listSeq = 0;

/**
 * One full analysis of `dir` outside VS Code: the structure scanner's file list
 * (`--files`, so the graph covers what the Folder tree shows), the six analyzers
 * in parallel, their graphs merged. With a `cwd`, the list is written there.
 */
export async function spawnAnalyzers(dir: string, opts: SpawnAnalyzersOptions): Promise<{ graph: GraphData; statuses: AnalyzerResult[]; oversized: number }> {
  if (opts.signal?.aborted) { throw new Error('Cancelled.'); } // an abort before the listener exists would never fire it
  const log = opts.log ?? (() => undefined);
  const limits: SpawnLimits = { maxOutputBytes: opts.maxOutputBytes, cwd: opts.cwd, env: opts.env };
  const listPath = path.join(opts.cwd ?? os.tmpdir(), `cograph-spawn-${process.pid}-${listSeq++}.txt`);
  const files = listableFiles(listProjectSourceFiles(dir).map(f => f.path), log, 'full');
  const listed = opts.maxFileBytes === undefined ? files : files.filter(f => fs.statSync(f).size <= (opts.maxFileBytes as number));
  fs.writeFileSync(listPath, listed.join('\n'), 'utf8');
  const live = new Set<cp.ChildProcess>();
  const kill = () => { for (const p of live) { try { p.kill(); } catch { /* gone */ } } };
  opts.signal?.addEventListener('abort', kill);
  try {
    const statuses = await Promise.all(ANALYZER_SCRIPTS.map(({ script, lang, python }) => {
      const bin = python ? opts.pythonBin : (opts.nodeBin ?? process.execPath);
      if (!bin) { return Promise.resolve<AnalyzerResult>({ graph: { nodes: [], edges: [], files: [] }, status: 'spawn-error', lang, detail: 'no Python interpreter' }); }
      return spawnAnalyzer(bin, [...(python ? [] : opts.nodeArgs ?? []), path.join(opts.scriptsDir, script), dir, '--files', listPath], lang, {
        log, onStart: (p) => live.add(p), onEnd: (p) => live.delete(p),
      }, limits);
    }));
    if (opts.signal?.aborted) { throw new Error('Cancelled.'); }
    return { graph: mergeResults(statuses), statuses, oversized: files.length - listed.length };
  } finally {
    opts.signal?.removeEventListener('abort', kill);
    fs.rmSync(listPath, { force: true });
  }
}
