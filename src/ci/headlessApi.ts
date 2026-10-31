import * as path from 'path';
import { parseAnnotations } from '../graphIntelligence/annotationStore';
import type { AnnotationFile } from '../graphIntelligence/annotationTypes';
import type { JsonRequest, JsonResult } from '../graphIntelligence/provider';
import type { TourAi, TourGitActions, TourHostApi, TourTarget } from '../tour/tourApi';
import { createTourHostApi } from '../tour/tourHostApi';
import type { TourHostDeps } from '../tour/tourHostApi';
import { ANNOTATIONS_FILE, TEAM_FILE } from './partialClone';
import { gitExec, toolEnv } from './toolEnv';
import { ciTarget, prepareCiTrees } from './trees';
import type { CiContext, CiTrees, CiTreesDeps } from './trees';

/**
 * `createTourHostApi` without VS Code, a checkout or a person: contract section 10, field by
 * field in section 2 of the core plan. `git`, `navigate` and friends are never reached, since
 * a headless run mounts no routes; they say so instead of doing something. No vscode import.
 */

/** The provider a CLI brings. Absent, the tour is the deterministic one. */
export interface HeadlessAi {
  model(): string | undefined;
  runJson(req: JsonRequest, signal?: AbortSignal): Promise<JsonResult>;
}

export interface HeadlessOptions {
  repoRoot: string;
  /** `--work-dir`: everything this run writes stays under it. The parent removes it, also after a kill. */
  workDir: string;
  head: string;
  /** `--base`. */
  base: string | null;
  /** `--config-sha`: the target tip's commit, where the team's files are read. Default: `base`. */
  configSha?: string | null;
  context: CiContext | null;
  /** Directory holding analyze.py and analyze_*.js. */
  scriptsDir: string;
  pythonBin: string | null;
  sourceMode: 'slices' | 'none';
  log: (line: string) => void;
  ai?: HeadlessAi | null;
  /** On top of the defaults; `tour.ai.mode` and the source-reading keys are not the caller's to set. */
  settings?: Record<string, unknown>;
  /** Default: `toolEnv()`. */
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  /** Default: a 4 GB heap, since guava's Java analysis peaks at 3.35 GB and Node's own default follows the machine's memory. */
  nodeArgs?: string[];
}

export interface HeadlessRun {
  api: TourHostApi;
  target: TourTarget;
  /** What `prepareTrees` made; throws before it ran. */
  trees(): CiTrees;
}

const ANALYZER_HEAP = '--max-old-space-size=4096';
/** Above the host's own cap on the team file, so the host can say the file was too large. */
const TEAM_FILE_MAX_BYTES = 1024 * 1024;
const ANNOTATIONS_MAX_BYTES = 8 * 1024 * 1024;

const NOT_IN_CI = { ok: false as const, reason: 'not available in CI' };
const NO_GIT_ACTIONS: TourGitActions = {
  push: async () => NOT_IN_CI, createPr: async () => NOT_IN_CI, editPrBody: async () => NOT_IN_CI, commentPr: async () => NOT_IN_CI,
};

/** A repository's `ask` means no calls: the gate has nobody to ask, and only an explicit `on` from the job runs the model. */
function headlessAi(ai: HeadlessAi): TourAi {
  return { enabled: () => true, providerId: () => 'anthropic-api', model: () => ai.model(), confirmGate: async () => false, runJson: (req, signal) => ai.runJson(req, signal) };
}

function headlessSettings(opts: HeadlessOptions): (key: string, fallback: unknown) => unknown {
  const map = new Map(Object.entries({
    ...opts.settings,
    'tour.ai.mode': opts.ai ? 'on' : 'off',
    'graphIntelligence.enabled': !!opts.ai,
    'tour.ai.readSource': false,
    'graphIntelligence.annotate.readSource': false,
  }));
  return (key, fallback) => (map.has(key) ? map.get(key) : fallback);
}

export function createHeadlessApi(opts: HeadlessOptions): HeadlessRun {
  const env = opts.env ?? toolEnv();
  const exec = gitExec(env);
  const storageDir = path.join(opts.workDir, 'trees');
  const target = ciTarget(opts.context);
  const configSha = opts.configSha ?? opts.base;
  if (!opts.configSha) { opts.log('[ci] no target tip given: the team\'s files come from --base, which a pull request can pick'); }
  const treesDeps: CiTreesDeps = {
    repoRoot: opts.repoRoot, storageDir, workDir: opts.workDir, exec, log: opts.log, env,
    scriptsDir: opts.scriptsDir, pythonBin: opts.pythonBin, maxOutputBytes: opts.maxOutputBytes, nodeArgs: opts.nodeArgs ?? [ANALYZER_HEAP],
  };
  const setting = headlessSettings(opts);
  let trees: CiTrees | null = null;
  let annotations: AnnotationFile | null = null;
  const deps: TourHostDeps = {
    repoRoot: opts.repoRoot, storageDir, exec,
    appendLine: opts.log,
    setting: <T>(key: string, fallback: T) => setting(key, fallback) as T,
    prepareDiff: async (_target, progress, signal) => {
      annotations = await readAnnotations();
      trees = await prepareCiTrees(treesDeps, { head: opts.head, base: opts.base, context: opts.context }, target, progress, signal);
      return trees;
    },
    confirm: async () => false,
    runJson: async () => { throw new Error('A headless run has no provider but its own.'); },
    loadAnnotations: () => annotations,
    openFile: async (_kind, absPath) => opts.log(`[ci] nothing opens in CI: ${absPath}`),
    openExternal: async (url) => opts.log(`[ci] nothing opens in CI: ${url}`),
    notify: (message) => opts.log(`[ci] ${message}`),
  };
  const base = createTourHostApi(deps);
  const atConfig = (rel: string, maxBytes: number) => (configSha ? base.readFileAtRef(configSha, rel, maxBytes) : Promise.resolve(null));
  const readAnnotations = async () => {
    const text = await atConfig(ANNOTATIONS_FILE, ANNOTATIONS_MAX_BYTES);
    return text === null ? null : parseAnnotations(text);
  };
  const api: TourHostApi = {
    ...base,
    ai: opts.ai ? headlessAi(opts.ai) : null,
    git: NO_GIT_ACTIONS,
    teamFile: () => atConfig(TEAM_FILE, TEAM_FILE_MAX_BYTES),
    sourceMode: opts.sourceMode,
  };
  return {
    api, target,
    trees: () => {
      if (!trees) { throw new Error('The trees are not prepared yet.'); }
      return trees;
    },
  };
}
