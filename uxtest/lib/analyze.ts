// Runs the REAL analyzers (same recipe as ~/cograph/test-projects/measure.mjs)
// once per repo + commit and caches the merged graph under uxtest/.cache/.
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { REPO_ROOT } from '../harness/vscodeStub';
import type { GraphLite } from '../harness/fakeHost';
import { log } from './log';

export interface AnalyzedRepo {
  name: string;
  root: string;
  structure: { root: string; folders: Record<string, unknown>; files: unknown[]; totalFiles: number };
  graph: GraphLite;
  analyzers: Record<string, { nodes: number; edges: number } | { error: string }>;
  analysisMs: number;
  functions: number;
}

export const CACHE_DIR = path.join(REPO_ROOT, 'uxtest', '.cache');

const ANALYZERS: Array<[bin: string, script: string, lang: string]> = [
  ['python3', 'scripts/analyze.py', 'python'],
  [process.execPath, 'scripts/analyze_ts.js', 'typescript'],
  [process.execPath, 'scripts/analyze_js.js', 'javascript'],
  [process.execPath, 'scripts/analyze_java.js', 'java'],
  [process.execPath, 'scripts/analyze_cpp.js', 'cpp'],
];

function headSha(root: string): string {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) { return head.slice(0, 8); }
    const ref = path.join(root, '.git', head.slice(5).trim());
    return fs.existsSync(ref) ? fs.readFileSync(ref, 'utf8').trim().slice(0, 8) : 'packed';
  } catch { return 'nogit'; } // not a git checkout: cache key degrades to the name only
}

function runAnalyzer(bin: string, args: string[], timeoutMs: number): Promise<{ graph?: GraphLite; error?: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 1024, timeout: timeoutMs }, (err, stdout) => {
      if (err && !stdout) { return resolve({ error: String(err.message).slice(0, 200) }); }
      try { return resolve({ graph: JSON.parse(stdout) as GraphLite }); }
      catch (e) { return resolve({ error: 'bad json: ' + String((e as Error).message).slice(0, 120) }); }
    });
  });
}

export async function analyzeRepo(name: string, root: string, timeoutMs: number, force = false): Promise<AnalyzedRepo> {
  const cacheFile = path.join(CACHE_DIR, `${name}-${headSha(root)}.json`);
  if (!force && fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as AnalyzedRepo;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { scanStructure } = require(path.join(REPO_ROOT, 'out', 'structureScanner.js'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mergeGraph } = require(path.join(REPO_ROOT, 'out', 'graphMerge.js'));
  const t0 = Date.now();
  const structure = scanStructure(root);
  const results = await Promise.all(
    ANALYZERS.map(([bin, script]) => runAnalyzer(bin, [path.join(REPO_ROOT, script), root], timeoutMs)));
  let graph: GraphLite = { nodes: [], edges: [], files: [] };
  const analyzers: AnalyzedRepo['analyzers'] = {};
  results.forEach((r, i) => {
    const lang = ANALYZERS[i][2];
    if (!r.graph) { analyzers[lang] = { error: r.error ?? 'unknown' }; return; }
    analyzers[lang] = { nodes: r.graph.nodes?.length ?? 0, edges: r.graph.edges?.length ?? 0 };
    graph = mergeGraph(graph, { nodes: r.graph.nodes || [], edges: r.graph.edges || [], files: r.graph.files || [] });
  });
  const out: AnalyzedRepo = {
    name, root, structure, graph, analyzers, analysisMs: Date.now() - t0,
    functions: graph.nodes.filter(n => !n.isLibrary && n.file).length,
  };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(out));
  log.info('repo-analyzed', { name, functions: out.functions, analysisMs: out.analysisMs, cacheFile });
  return out;
}
