import * as path from 'path';
import type { GraphData } from '../graphProvider';
import type { StructureTree } from '../structureScanner';
import { buildDigestIndex, buildFileDigest } from './annotationDigest';
import type { DigestIndex } from './annotationDigest';
import { buildFilePrompt, buildFolderPrompt, normalizeSummaries } from './annotationPrompt';
import { childrenHash, fingerprint, folderChildren, toRel } from './annotationStore';
import type { Fingerprint } from './annotationStore';
import type { AnnotationFile, FolderChild, FolderDigest } from './annotationTypes';
import type { JsonResult } from './provider';

/**
 * Plans and executes one annotation run: files in batches, then folders deepest
 * level first from child summaries only. Persists after every batch (resumable),
 * stops at the run budget, and treats cancellation as a normal outcome.
 * No vscode import — the provider call and persistence are injected.
 */

export const FILE_BATCH_SIZE = 40;
export const FILE_BATCH_SIZE_READ_SOURCE = 10;
export const FOLDER_BATCH_SIZE = 25;
export const CONCURRENCY = 3;
/** No single call may eat more than this share of the run, whatever the run budget is. */
const PER_CALL_BUDGET_USD = 0.25;
const CANCELLED = 'Request cancelled.';

export interface RunOptions {
  readSource: boolean;
  maxRunBudgetUsd: number;
  fileBatchSize?: number;
  folderBatchSize?: number;
  concurrency?: number;
  now?: () => string;
}

export interface RunPlan {
  /** Absolute paths of files with no summary or a stale one, shallow paths first. */
  files: string[];
  /** Absolute paths of folders that may need a summary (upper bound). */
  folders: string[];
  requests: number;
  estimatedInputTokens: number;
}

export interface RunProgress {
  phase: 'files' | 'folders';
  done: number;
  total: number;
  costUsd: number;
  costKnown: boolean;
}

export interface RunResult {
  filesDone: number;
  foldersDone: number;
  pending: string[];
  costUsd: number;
  costKnown: boolean;
  stoppedAtBudget: boolean;
  cancelled: boolean;
}

export interface CallRequest { prompt: string; tools: 'none' | 'read-only'; maxBudgetUsd: number; }

export interface RunnerDeps {
  root: string;
  tree: StructureTree;
  graph: GraphData;
  /** Mutated in place as batches complete. */
  data: AnnotationFile;
  stale: Set<string>;
  callJson: (req: CallRequest, signal: AbortSignal) => Promise<JsonResult>;
  save: (data: AnnotationFile) => void;
  onProgress?: (p: RunProgress) => void;
  signal: AbortSignal;
  options: RunOptions;
}

function depthOf(abs: string): number { return abs.split(/[\\/]+/).length; }

function fileBatchSize(o: RunOptions): number {
  return o.fileBatchSize ?? (o.readSource ? FILE_BATCH_SIZE_READ_SOURCE : FILE_BATCH_SIZE);
}

/** What a run would do. Pure apart from reading `tree`, `data` and `stale`; sends nothing. */
export function planRun(root: string, tree: StructureTree, data: AnnotationFile, stale: Set<string>, o: RunOptions): RunPlan {
  const files = tree.files.map(f => f.path)
    .filter(abs => { const rel = toRel(root, abs); return !data.files[rel] || stale.has(rel); })
    .sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
  const touched = new Set<string>();
  for (const f of files) {
    for (let dir = path.dirname(f); tree.folders[dir] && !touched.has(dir); dir = path.dirname(dir)) { touched.add(dir); }
  }
  const folders = Object.keys(tree.folders).filter(abs => {
    const rel = toRel(root, abs);
    return touched.has(abs) || !data.folders[rel] || stale.has(rel);
  });
  const depths = new Set(folders.map(f => tree.folders[f].depth)).size;
  const fileBatches = Math.ceil(files.length / fileBatchSize(o));
  const folderBatches = Math.max(depths, Math.ceil(folders.length / (o.folderBatchSize ?? FOLDER_BATCH_SIZE)));
  const requests = fileBatches + (folders.length ? folderBatches : 0);
  // ~300 tokens per file digest, ~150 per folder block, ~2.7k fixed per request (measured).
  const estimatedInputTokens = files.length * 300 + folders.length * 150 + requests * 2700;
  return { files, folders, requests, estimatedInputTokens };
}

class RunState {
  costUsd = 0;
  costKnown = true;
  done = 0;
  filesDone = 0;
  foldersDone = 0;
  stoppedAtBudget = false;
  cancelled = false;
  error: Error | null = null;
  constructor(readonly total: number) {}
  get halted(): boolean { return this.stoppedAtBudget || this.cancelled || this.error !== null; }
}

export async function executeRun(deps: RunnerDeps): Promise<RunResult> {
  const plan = planRun(deps.root, deps.tree, deps.data, deps.stale, deps.options);
  const state = new RunState(plan.files.length + plan.folders.length);
  const index = buildDigestIndex(deps.graph);

  const missing = await runFileBatches(deps, state, index, plan.files);
  if (missing.length && !state.halted) { await runFileBatches(deps, state, index, missing); } // one retry round
  if (!state.halted) { await runFolderLevels(deps, state, plan.folders); }

  if (state.error) { throw state.error; }
  return {
    filesDone: state.filesDone,
    foldersDone: state.foldersDone,
    pending: pendingPaths(deps),
    costUsd: state.costUsd,
    costKnown: state.costKnown,
    stoppedAtBudget: state.stoppedAtBudget,
    cancelled: state.cancelled,
  };
}

/** Summarise `files` in parallel batches. Returns the absolute paths the model left unanswered. */
async function runFileBatches(deps: RunnerDeps, state: RunState, index: DigestIndex, files: string[]): Promise<string[]> {
  const langByFile = new Map(deps.tree.files.map(f => [f.path, f.language as string]));
  const missing: string[] = [];
  await pool(chunk(files, fileBatchSize(deps.options)), deps, state, async (batch) => {
    // Fingerprint BEFORE reading for the digest, so the stored hash is the content that was summarised.
    const prints = new Map<string, Fingerprint>();
    for (const abs of batch) { const fp = fingerprint(abs); if (fp) { prints.set(abs, fp); } }
    const readable = batch.filter(abs => prints.has(abs));
    if (!readable.length) { return; }
    const digests = readable.map(abs => buildFileDigest(deps.root, abs, langByFile.get(abs) ?? 'unknown', index));
    const prompt = buildFilePrompt(digests, deps.options.readSource);
    const result = await call(deps, state, prompt, deps.options.readSource ? 'read-only' : 'none');
    const rels = readable.map(abs => toRel(deps.root, abs));
    const { entries } = normalizeSummaries(result.data, rels);
    const at = now(deps);
    readable.forEach((abs, i) => {
      const entry = entries.get(rels[i]);
      if (!entry) { missing.push(abs); return; }
      deps.data.files[rels[i]] = { ...entry, ...prints.get(abs)!, at };
      deps.stale.delete(rels[i]);
      state.filesDone++;
      state.done++;
    });
    deps.save(deps.data);
    report(deps, state, 'files');
  });
  return missing;
}

/** Folders deepest level first; a level finishes before its parents start, since parents read its summaries. */
async function runFolderLevels(deps: RunnerDeps, state: RunState, folders: string[]): Promise<void> {
  const byDepth = new Map<number, string[]>();
  for (const abs of folders) {
    const d = deps.tree.folders[abs].depth;
    byDepth.set(d, [...(byDepth.get(d) ?? []), abs]);
  }
  for (const depth of [...byDepth.keys()].sort((a, b) => b - a)) {
    if (state.halted) { return; }
    const work: Array<{ abs: string; rel: string; children: FolderChild[]; hash: string }> = [];
    for (const abs of byDepth.get(depth)!) {
      const rel = toRel(deps.root, abs);
      const children = folderChildren(deps.root, deps.tree, abs, deps.data);
      const hash = childrenHash(children);
      if (deps.data.folders[rel]?.childrenHash === hash) { deps.stale.delete(rel); state.done++; continue; } // already fresh
      if (!children.some(c => c.summary)) { state.done++; continue; } // nothing to summarise from yet
      work.push({ abs, rel, children, hash });
    }
    await pool(chunk(work, deps.options.folderBatchSize ?? FOLDER_BATCH_SIZE), deps, state, async (batch) => {
      const digests: FolderDigest[] = batch.map(w => ({ path: w.rel, children: w.children }));
      const result = await call(deps, state, buildFolderPrompt(digests), 'none');
      const { entries } = normalizeSummaries(result.data, batch.map(w => w.rel));
      const at = now(deps);
      for (const w of batch) {
        const entry = entries.get(w.rel);
        state.done++;
        if (!entry) { continue; }
        deps.data.folders[w.rel] = { ...entry, childrenHash: w.hash, at };
        deps.stale.delete(w.rel);
        state.foldersDone++;
      }
      deps.save(deps.data);
      report(deps, state, 'folders');
    });
  }
}

async function call(deps: RunnerDeps, state: RunState, prompt: string, tools: 'none' | 'read-only'): Promise<JsonResult> {
  const remaining = deps.options.maxRunBudgetUsd - state.costUsd;
  const maxBudgetUsd = Math.max(0.01, Math.min(PER_CALL_BUDGET_USD, remaining));
  const result = await deps.callJson({ prompt, tools, maxBudgetUsd }, deps.signal);
  if (result.usage) { state.costUsd += result.usage.costUsd; } else { state.costKnown = false; }
  return result;
}

/** Run batches with bounded concurrency. Stops scheduling on budget, cancel or the first error; in-flight batches finish. */
async function pool<T>(batches: T[], deps: RunnerDeps, state: RunState, worker: (batch: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < batches.length && !state.halted) {
      if (deps.signal.aborted) { state.cancelled = true; return; }
      if (state.costKnown && state.costUsd >= deps.options.maxRunBudgetUsd) { state.stoppedAtBudget = true; return; }
      const batch = batches[next++];
      try {
        await worker(batch);
      } catch (err) {
        if (deps.signal.aborted || (err as Error).message === CANCELLED) { state.cancelled = true; }
        else if (!state.error) { state.error = err as Error; }
      }
    }
  };
  const lanes = Math.max(1, Math.min(deps.options.concurrency ?? CONCURRENCY, batches.length));
  await Promise.all(Array.from({ length: lanes }, lane));
}

function pendingPaths(deps: RunnerDeps): string[] {
  const files = deps.tree.files.map(f => toRel(deps.root, f.path)).filter(rel => !deps.data.files[rel] || deps.stale.has(rel));
  const folders = Object.keys(deps.tree.folders).map(f => toRel(deps.root, f)).filter(rel => !deps.data.folders[rel] || deps.stale.has(rel));
  return [...files, ...folders];
}

function report(deps: RunnerDeps, state: RunState, phase: 'files' | 'folders'): void {
  deps.onProgress?.({ phase, done: state.done, total: state.total, costUsd: state.costUsd, costKnown: state.costKnown });
}

function now(deps: RunnerDeps): string { return (deps.options.now ?? (() => new Date().toISOString()))(); }

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) { out.push(items.slice(i, i + Math.max(1, size))); }
  return out;
}
