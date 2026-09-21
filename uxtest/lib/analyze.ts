// Runs the REAL analyzers OF THE CHECKOUT UNDER TEST (EXT_ROOT; same recipe as
// ~/cograph/test-projects/measure.mjs) once per repo commit + analyzer version and caches the
// merged graph under uxtest/.cache/. The analyzer hash in the key makes it impossible to serve a
// graph produced by other analyzers (e.g. pre-D6 call narrowing) to a newer checkout.
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import { EXT_ROOT, REPO_ROOT } from '../harness/vscodeStub';
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
  analyzerHash?: string;
}

export const CACHE_DIR = path.join(REPO_ROOT, 'uxtest', '.cache');

const ANALYZERS: Array<[bin: string, script: string, lang: string]> = [
  ['python3', 'scripts/analyze.py', 'python'],
  [process.execPath, 'scripts/analyze_ts.js', 'typescript'],
  [process.execPath, 'scripts/analyze_js.js', 'javascript'],
  [process.execPath, 'scripts/analyze_java.js', 'java'],
  [process.execPath, 'scripts/analyze_cpp.js', 'cpp'],
];

/** Hash of everything that shapes the graph: analyzer scripts + the compiled scanner/merger. */
export function analyzerHash(extRoot: string = EXT_ROOT): string {
  const h = crypto.createHash('sha1');
  const scripts = path.join(extRoot, 'scripts');
  const files = fs.existsSync(scripts)
    ? fs.readdirSync(scripts).filter(f => /\.(js|py)$/.test(f) && !/^test_|polyfill/.test(f)).sort().map(f => path.join(scripts, f)) : [];
  for (const f of [...files, path.join(extRoot, 'out', 'structureScanner.js'), path.join(extRoot, 'out', 'graphMerge.js')]) {
    if (fs.existsSync(f)) { h.update(path.basename(f)); h.update(fs.readFileSync(f)); }
  }
  return h.digest('hex').slice(0, 8);
}

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
  const cacheFile = path.join(CACHE_DIR, `${name}-${headSha(root)}-${analyzerHash()}.json`);
  if (!force && fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as AnalyzedRepo;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { scanStructure } = require(path.join(EXT_ROOT, 'out', 'structureScanner.js'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mergeGraph } = require(path.join(EXT_ROOT, 'out', 'graphMerge.js'));
  const t0 = Date.now();
  const structure = scanStructure(root);
  const results = await Promise.all(
    ANALYZERS.map(([bin, script]) => runAnalyzer(bin, [path.join(EXT_ROOT, script), root], timeoutMs)));
  let graph: GraphLite = { nodes: [], edges: [], files: [] };
  const analyzers: AnalyzedRepo['analyzers'] = {};
  results.forEach((r, i) => {
    const lang = ANALYZERS[i][2];
    if (!r.graph) { analyzers[lang] = { error: r.error ?? 'unknown' }; return; }
    analyzers[lang] = { nodes: r.graph.nodes?.length ?? 0, edges: r.graph.edges?.length ?? 0 };
    graph = mergeGraph(graph, { nodes: r.graph.nodes || [], edges: r.graph.edges || [], files: r.graph.files || [] });
  });
  const out: AnalyzedRepo = {
    name, root, structure, graph, analyzers, analysisMs: Date.now() - t0, analyzerHash: analyzerHash(),
    functions: graph.nodes.filter(n => !n.isLibrary && n.file).length,
  };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(out));
  log.info('repo-analyzed', { name, functions: out.functions, analysisMs: out.analysisMs, cacheFile });
  return out;
}
