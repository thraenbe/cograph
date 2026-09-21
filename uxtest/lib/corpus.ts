// Repo resolution: corpus checkouts, absolute paths and the synthetic fixture.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { REPO_ROOT } from '../harness/vscodeStub';
import { analyzeRepo, type AnalyzedRepo } from './analyze';

export interface UxConfig {
  corpusDir: string;
  defaultRepos: string[];
  largeRepos: string[];
  knownAnalyzerFailures: string[];
  viewport: { width: number; height: number };
  analyzerTimeoutMs: number;
  still: { epsilonPx: number; quietFrames: number; timeoutMs: number };
  caps: { maxLabels: number; maxCrossingEdges: number; maxOverlapNodes: number };
  synthetic: Record<string, Record<string, number>>;
}

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadConfig(): UxConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'uxtest', 'uxtest.config.json'), 'utf8')) as UxConfig;
  const corpusDir = expandHome(process.env.UXTEST_CORPUS ?? raw.corpusDir);
  return { ...raw, corpusDir };
}

/** Repos selected for this run: UXTEST_REPOS=a,b,c or the configured default set. */
export function selectedRepos(cfg: UxConfig): string[] {
  const env = process.env.UXTEST_REPOS;
  return env ? env.split(',').map(s => s.trim()).filter(Boolean) : cfg.defaultRepos;
}

export type SizeClass = 'small' | 'medium' | 'large';
export function sizeClass(functions: number): SizeClass {
  if (functions < 2000) { return 'small'; }
  return functions < 8000 ? 'medium' : 'large';
}

function syntheticRepo(name: string, opts: Record<string, number>): AnalyzedRepo {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { makeSyntheticRepo } = require(path.join(REPO_ROOT, 'out', 'test', 'fixtures', 'syntheticGraph.js'));
  const { structure, graph } = makeSyntheticRepo({ ...opts, root: `/${name}` });
  return { name, root: `/${name}`, structure, graph, analyzers: {}, analysisMs: 0,
    functions: graph.nodes.filter((n: { isLibrary?: boolean }) => !n.isLibrary).length };
}

/** `synthetic-1k`, a corpus repo name, or a path to any checkout. */
export async function loadRepo(nameOrPath: string, cfg: UxConfig = loadConfig()): Promise<AnalyzedRepo> {
  if (cfg.synthetic[nameOrPath]) { return syntheticRepo(nameOrPath, cfg.synthetic[nameOrPath]); }
  const asPath = expandHome(nameOrPath);
  const root = path.isAbsolute(asPath) ? asPath : path.join(cfg.corpusDir, nameOrPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`repo "${nameOrPath}" not found at ${root} (set UXTEST_CORPUS or pass an absolute path)`);
  }
  return analyzeRepo(path.basename(root), root, cfg.analyzerTimeoutMs, process.env.UXTEST_REANALYZE === '1');
}
