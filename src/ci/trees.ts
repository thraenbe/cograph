import * as fs from 'fs';
import { ANALYZER_SCRIPTS, mergeResults, spawnAnalyzers } from '../analyzerSpawn';
import type { AnalyzerResult, AnalyzerStatus, SpawnAnalyzersOptions } from '../analyzerSpawn';
import { scanStructure } from '../structureScanner';
import type { StructureTree } from '../structureScanner';
import type { TourProgress, TourTarget, TourTrees } from '../tour/tourApi';
import { diffGraphs } from '../vcs/engine/graphDiff';
import { analyzerKeepsPath, copyRefusesPath, materializeCommit } from '../vcs/engine/headTree';
import type { HeadTreeDeps } from '../vcs/engine/headTree';
import { changedPaths, commitFiles, listCommits } from '../vcs/engine/localBranch';
import type { BranchChangedPath } from '../vcs/engine/localBranch';
import type { AnalyzedTree } from '../vcs/engine/treeAnalysis';
import type { Exec } from '../vcs/ghCliSource';
import type { PullRequest } from '../vcs/types';

/**
 * `TourTrees` from the object store alone: no fetch, no `gh`, the working tree never read. What a
 * platform knows about the change comes from `--context`. No vscode import.
 *
 * The integrity rule: a language whose analyzer failed as a process (no interpreter, timeout,
 * output cap, crash), on either side, leaves both sides before the diff. One side's timeout
 * would otherwise paint all of that language as added or removed; with it, the tour says what
 * is missing. A file that will not parse is not such a failure: it is counted, and the
 * language stays, so one poison file switches nothing off (F7). A changed file the copy refused
 * saw no analyzer at all, so a pull request could hide a function behind its name: it is counted
 * too, and the tour reads partial, because what is missing is the change itself.
 */

/** The file `--context` names; the platform adapter writes it. Its strings are the change's author's: data. */
export interface CiContext {
  platform: string;
  repoWebUrl: string;
  change: { id: string | number; title: string; url: string; author: string; headRef: string; baseRef: string };
  fileLinkTemplate: string;
}

export interface CiTreesDeps {
  repoRoot: string;
  /** `<work-dir>/trees`. */
  storageDir: string;
  /** `<work-dir>`: where analyzers run and their lists go, never the checkout (F16). */
  workDir: string;
  exec: Exec;
  log: (line: string) => void;
  scriptsDir: string;
  pythonBin: string | null;
  /** For the analyzers. */
  env: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  maxFileBytes?: number;
  nodeArgs?: string[];
}

export interface CiChange {
  head: string;
  /** The target commit or the merge base; null or unrelated makes a head-only tour. */
  base: string | null;
  context: CiContext | null;
}

export interface CiTrees extends TourTrees {
  /** The head's structure tree, which the stage needs and `TourTrees` does not carry. */
  structure: StructureTree;
}

/** Analyzer output cap of a CI run. Five buffered at the extension's 500 MB cost 6.56 GB on one file (F3). */
export const CI_MAX_OUTPUT_BYTES = 200 * 1024 * 1024;
/**
 * One file must not cost a language (F7), and at 24 MB of one-line functions one did: past the
 * output cap in TypeScript, past the heap in Java. The largest real source of the corpus is 1.18 MB.
 */
export const CI_MAX_FILE_BYTES = 16 * 1024 * 1024;

const LANGUAGE_NAMES: Record<string, string> = { python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript', java: 'Java', cpp: 'C++', c: 'C' };

/** No analyzer text here: a Python traceback quotes the source. */
const FAILURE_WORDS: Record<Exclude<AnalyzerStatus, 'ok' | 'empty'>, string> = {
  'spawn-error': 'could not start on this runner',
  timeout: 'ran out of time',
  'exit-nonzero': 'stopped with an error',
  'parse-error': 'returned no readable result',
  'output-too-large': 'produced more output than a tour can take',
};

/** No name in it: a file's name is the change's author's text, and `filesNotParsed` has the count. */
const REFUSED_NOTE = 'Changed files with a control character in their name are missing from this tour: their functions are left out of the map and the diff.';

const SFC_FILE = /\.(vue|svelte)$/i;

/** Languages this tree has files in. A component's language is known only to the analyzer, so it counts for both. */
function languagesOf(tree: StructureTree): Set<string> {
  const langs = new Set<string>(tree.files.map(f => f.language));
  if (tree.files.some(f => SFC_FILE.test(f.path))) { langs.add('javascript'); langs.add('typescript'); }
  return langs;
}

interface AnalysedSide { sha: string; root: string; tree: StructureTree; statuses: AnalyzerResult[]; oversized: number }

async function analyseSide(deps: CiTreesDeps, sha: string, root: string, signal: AbortSignal): Promise<AnalysedSide> {
  const tree = scanStructure(root);
  const options: SpawnAnalyzersOptions = {
    scriptsDir: deps.scriptsDir, pythonBin: deps.pythonBin, log: deps.log, signal,
    cwd: deps.workDir, env: deps.env, nodeArgs: deps.nodeArgs,
    maxOutputBytes: deps.maxOutputBytes ?? CI_MAX_OUTPUT_BYTES, maxFileBytes: deps.maxFileBytes ?? CI_MAX_FILE_BYTES,
  };
  const { statuses, oversized } = await spawnAnalyzers(root, options);
  return { sha, root, tree, statuses, oversized };
}

/** Languages that failed as a process on this side, with how. An interpreter this tree has no use for is no failure. */
function failures(side: AnalysedSide): Map<string, AnalyzerStatus> {
  const present = languagesOf(side.tree);
  return new Map(side.statuses.filter(s => s.status !== 'ok' && s.status !== 'empty' && present.has(s.lang)).map(s => [s.lang, s.status]));
}

function noteFor(lang: string, status: AnalyzerStatus): string {
  const words = FAILURE_WORDS[status as keyof typeof FAILURE_WORDS];
  return `${LANGUAGE_NAMES[lang] ?? lang} is missing from this tour: its analyzer ${words}. Its functions are left out of the map and the diff.`;
}

function analysedTree(side: AnalysedSide, dropped: Map<string, AnalyzerStatus>): AnalyzedTree {
  return { root: side.root, sha: side.sha, tree: side.tree, graph: mergeResults(side.statuses.filter(s => !dropped.has(s.lang))) };
}

/** In `ANALYZER_SCRIPTS` order, so two builds of one input give the same sentences. */
function notesFor(dropped: Map<string, AnalyzerStatus>): string[] {
  return ANALYZER_SCRIPTS.filter(s => dropped.has(s.lang)).map(s => noteFor(s.lang, dropped.get(s.lang) as AnalyzerStatus));
}

/** Changed files the copy refused. Either name of a rename counts: the side it names lost the file. */
function refusedChanges(paths: BranchChangedPath[]): number {
  const refused = (file: string | undefined) => file !== undefined && analyzerKeepsPath(file) && copyRefusesPath(file);
  return paths.filter(p => refused(p.path) || refused(p.previousPath)).length;
}

/** A change's number; null when it has none, and the tour is then one of a branch. */
function changeNumber(context: CiContext | null): number | null {
  const n = Number(context?.change.id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** What the host tours. */
export function ciTarget(context: CiContext | null): TourTarget {
  const number = changeNumber(context);
  if (number !== null) { return { kind: 'pr', number }; }
  return { kind: 'branch', ...(context ? { branch: context.change.headRef, baseRef: context.change.baseRef } : {}) };
}

function pullRequestOf(context: CiContext, head: string, changed: number): PullRequest | null {
  const number = changeNumber(context);
  if (number === null) { return null; }
  const { title, author, headRef, baseRef, url } = context.change;
  return {
    number, title: String(title ?? ''), author: String(author ?? ''), headRef: String(headRef ?? ''), baseRef: String(baseRef ?? ''),
    headOid: head, state: 'open', isDraft: false, checks: 'none', changedFiles: changed, additions: 0, deletions: 0, updatedAt: '', url: String(url ?? ''),
  };
}

/** The merge base from the objects at hand; null when `fetch` found none or the commit is not here. */
async function commonAncestor(deps: CiTreesDeps, head: string, base: string | null): Promise<string | null> {
  if (!base) { return null; }
  const res = await deps.exec('git', ['merge-base', head, base], deps.repoRoot);
  if (res.code === 0 && res.stdout.trim()) { return res.stdout.trim(); }
  deps.log('[ci] no merge base here: a head-only tour');
  return null;
}

export async function prepareCiTrees(deps: CiTreesDeps, change: CiChange, target: TourTarget, progress: TourProgress, signal: AbortSignal): Promise<CiTrees> {
  const treeDeps: HeadTreeDeps = { repoRoot: deps.repoRoot, storageDir: deps.storageDir, exec: deps.exec, log: deps.log, signal };
  fs.mkdirSync(deps.workDir, { recursive: true });
  const baseSha = await commonAncestor(deps, change.head, change.base);
  progress('copying the files…');
  const headCopy = await materializeCommit(treeDeps, change.head);
  const baseCopy = baseSha ? await materializeCommit(treeDeps, baseSha) : null;
  progress('analysing…');
  const headSide = await analyseSide(deps, change.head, headCopy.dir, signal);
  const baseSide = baseCopy && baseSha ? await analyseSide(deps, baseSha, baseCopy.dir, signal) : null;
  const dropped = new Map([...(baseSide ? failures(baseSide) : []), ...failures(headSide)]);
  for (const [lang, status] of dropped) { deps.log(`[ci] analyzer ${lang}: ${status}`); }
  const head = analysedTree(headSide, dropped);
  const base = baseSide ? analysedTree(baseSide, dropped) : null;
  progress('diffing…');
  const [headFiles, baseFiles, commits, paths] = await Promise.all([
    commitFiles(treeDeps, change.head),
    baseSha ? commitFiles(treeDeps, baseSha) : Promise.resolve([]),
    listCommits(treeDeps, baseSha, change.head),
    baseSha ? changedPaths(treeDeps, baseSha, change.head) : Promise.resolve([]),
  ]);
  const refused = refusedChanges(paths);
  const filesNotParsed = headSide.statuses.filter(s => !dropped.has(s.lang)).reduce((n, s) => n + (s.filesNotParsed ?? 0), headSide.oversized + refused);
  const notes = [...notesFor(dropped), ...(refused ? [REFUSED_NOTE] : [])];
  return {
    repoRoot: deps.repoRoot, target,
    head: { sha: change.head, dir: head.root, graph: head.graph, files: headFiles },
    base: base && baseSha ? { sha: baseSha, dir: base.root, graph: base.graph, files: baseFiles } : null,
    diff: base ? diffGraphs(base, head) : null,
    pr: change.context ? pullRequestOf(change.context, change.head, paths.length) : null,
    prFiles: null, commits, changedPaths: paths, checkoutBranch: null, dirty: false,
    ...(notes.length ? { analysisNotes: notes } : {}),
    ...(filesNotParsed ? { filesNotParsed } : {}),
    structure: head.tree,
  };
}

/** `manifest.summary.analysis`: a language gone or a changed file refused is partial, a file not parsed is counted and is not. */
export function analysisState(trees: TourTrees): 'complete' | 'partial' {
  return trees.analysisNotes?.length ? 'partial' : 'complete';
}
