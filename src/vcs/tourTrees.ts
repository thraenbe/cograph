import type { TourChangedPath, TourCommit, TourTarget, TourTree, TourTrees } from '../tour/tourApi';
import { diffGraphs } from './engine/graphDiff';
import type { StructuralDiff } from './engine/graphDiff';
import { HeadTreeError, branchRefs, fetchBranch, fetchPullRequestHead, githubRemote, materializeCommit, mergeBase, pullRequestRefs } from './engine/headTree';
import type { HeadTreeDeps } from './engine/headTree';
import { changedPaths, commitFiles, listCommits, prepareBranch } from './engine/localBranch';
import { analyzeTreeCached } from './engine/treeAnalysis';
import type { AnalyzedTree, TreeAnalyzer } from './engine/treeAnalysis';
import type { Exec } from './ghCliSource';
import type { PrFile, PullRequest, PullRequestSource } from './types';

/**
 * Head and base of a pull request or of the checked-out branch: materialised,
 * analysed, diffed. The pull-request panel (PrController.open) and the tour
 * (PrController.prepareDiff → TourHostApi.prepareTrees) share this one path.
 * No vscode import: the fixture recorder runs it from plain Node.
 */

export interface TreeCommon {
  repoRoot: string; storageDir: string; exec: Exec; log: (line: string) => void; report: (m: string) => void; signal: AbortSignal;
}

export type MaterializeHead = (opts: Omit<TreeCommon, 'signal'> & { signal: AbortSignal; prNumber: number }) => Promise<{ sha: string; dir: string }>;
export type MaterializeBase = (opts: Omit<TreeCommon, 'signal'> & { signal: AbortSignal; baseRef: string; headSha: string }) => Promise<{ sha: string; dir: string }>;

/** The engine's way: fetch the ref, then copy the commit's analysable files. */
export const materializeHeadWithGit: MaterializeHead = async ({ repoRoot, storageDir, prNumber, exec, log, report, signal }) => {
  const treeDeps = { repoRoot, storageDir, exec, log, signal };
  report('fetching the pull request…');
  const sha = await fetchPullRequestHead(treeDeps, prNumber, await githubRemote(treeDeps));
  report('copying its files…');
  const copied = await materializeCommit(treeDeps, sha, pullRequestRefs(prNumber, sha));
  return { sha, dir: copied.dir };
};

export const materializeBaseWithGit: MaterializeBase = async ({ repoRoot, storageDir, baseRef, headSha, exec, log, report, signal }) => {
  const treeDeps = { repoRoot, storageDir, exec, log, signal };
  report('fetching its base…');
  const remote = await githubRemote(treeDeps);
  const tip = await fetchBranch(treeDeps, baseRef, remote);
  const sha = await mergeBase(treeDeps, headSha, tip);
  const copied = await materializeCommit(treeDeps, sha, branchRefs(baseRef, tip));
  return { sha, dir: copied.dir };
};

/**
 * A merged pull request's base as GitHub shows it: the merge base of its head with the base branch
 * as it was at the merge (the merge commit's first parent). The live merge base of a merged head is
 * the head itself, which would make every merged pull request look empty. Falls back to the live
 * merge base when the merge commit is not known.
 */
export const materializeMergedBaseWithGit = (prNumber: number): MaterializeBase => async (opts) => {
  const { repoRoot, storageDir, baseRef, headSha, exec, log, report, signal } = opts;
  const treeDeps = { repoRoot, storageDir, exec, log, signal };
  const view = await exec('gh', ['pr', 'view', String(prNumber), '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'], repoRoot, { timeoutMs: 30_000, signal });
  const merge = view.code === 0 ? view.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(merge)) {
    log(`[tour] #${prNumber} is merged but gh gave no merge commit; diffing against the live merge base`);
    return materializeBaseWithGit(opts);
  }
  report('fetching its base…');
  const tip = await fetchBranch(treeDeps, baseRef, await githubRemote(treeDeps));
  const parent = await exec('git', ['rev-parse', '--verify', `${merge}^1`], repoRoot, { signal });
  if (parent.code !== 0) { return materializeBaseWithGit(opts); }
  const sha = await mergeBase(treeDeps, headSha, parent.stdout.trim());
  log(`[tour] #${prNumber} merged in ${merge.slice(0, 7)}: base ${sha.slice(0, 7)}`);
  const copied = await materializeCommit(treeDeps, sha, branchRefs(baseRef, tip));
  return { sha, dir: copied.dir };
};

export interface HeadAnalysis {
  sha: string;
  dir: string;
  head: AnalyzedTree | null;
  base: AnalyzedTree | null;
  diff: StructuralDiff | null;
}

export interface AnalyseHooks {
  materializeHead: MaterializeHead;
  materializeBase: MaterializeBase;
  /** Without one, nothing is analysed and there is no diff (the head is coloured from the file list). */
  analyzer?: TreeAnalyzer;
  /** Called the moment the head copy is complete (it survives a later cancel). */
  onCopied?: () => void;
}

/** A pull request's head and merge base, analysed and diffed. The base is null (logged) when it cannot be had. */
export async function analysePullRequest(pr: PullRequest, common: TreeCommon, hooks: AnalyseHooks): Promise<HeadAnalysis> {
  const copied = await hooks.materializeHead({ ...common, prNumber: pr.number });
  hooks.onCopied?.();
  if (!hooks.analyzer) { return { ...copied, head: null, base: null, diff: null }; }
  common.report('analysing the pull request…');
  const head = await analyzeTreeCached(copied.dir, hooks.analyzer, copied.sha, common.signal);
  const base = await analyseBase(pr, copied.sha, common, hooks);
  return { ...copied, head, base, diff: base ? diffGraphs(base, head) : null };
}

async function analyseBase(pr: PullRequest, headSha: string, common: TreeCommon, hooks: AnalyseHooks): Promise<AnalyzedTree | null> {
  if (!pr.baseRef) { return null; }
  try {
    const base = await hooks.materializeBase({ ...common, baseRef: pr.baseRef, headSha });
    common.report('analysing the base…');
    return await analyzeTreeCached(base.dir, hooks.analyzer as TreeAnalyzer, base.sha, common.signal);
  } catch (err) {
    // A cancel is the user's, not the base's: it ends the whole open.
    if (common.signal.aborted || (err instanceof HeadTreeError && err.kind === 'cancelled')) { throw err; }
    common.log(`[vcs] base of #${pr.number} unavailable, colouring from the PR's file list: ${(err as Error).message}`);
    return null;
  }
}

export interface TourTreesDeps extends AnalyseHooks {
  workspaceRoot: string;
  analyzer: TreeAnalyzer;
  source: PullRequestSource;
}

/** The workspace's branch, or null (detached, or not a checkout). */
async function checkoutBranch(exec: Exec, workspaceRoot: string): Promise<string | null> {
  const res = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot);
  const name = res.code === 0 ? res.stdout.trim() : '';
  return name && name !== 'HEAD' ? name : null;
}

async function findPullRequest(source: PullRequestSource, root: string, number: number): Promise<PullRequest> {
  const viewed = source.view ? await source.view(root, number) : null;
  if (viewed?.ok) { return viewed.pullRequest; }
  if (viewed && !viewed.ok && viewed.problem.kind !== 'error') { throw new HeadTreeError('fetch-failed', viewed.problem.message, viewed.problem.detail); }
  const listed = await source.list(root, { state: 'all', limit: 200 });
  const pr = listed.ok ? listed.pullRequests.find(p => p.number === number) : undefined;
  if (!pr) { throw new HeadTreeError('no-such-ref', `Pull request #${number} was not found.`, listed.ok ? undefined : listed.problem.message); }
  return pr;
}

function tourTree(t: AnalyzedTree, files: string[]): TourTree {
  return { sha: t.sha as string, dir: t.root, graph: t.graph, files };
}

/** Commits and changed paths between two local commits (the fetch already brought both). */
async function history(deps: HeadTreeDeps, baseSha: string | null, headSha: string): Promise<{ commits: TourCommit[]; paths: TourChangedPath[] }> {
  const [commits, paths] = await Promise.all([
    listCommits(deps, baseSha, headSha),
    baseSha ? changedPaths(deps, baseSha, headSha) : Promise.resolve([] as TourChangedPath[]),
  ]);
  return { commits, paths };
}

async function prTrees(target: TourTarget, common: TreeCommon, deps: TourTreesDeps, pr?: PullRequest): Promise<TourTrees> {
  if (!target.number) { throw new HeadTreeError('error', 'That is not a pull request number.'); }
  const resolved = pr ?? await findPullRequest(deps.source, deps.workspaceRoot, target.number);
  const merged = resolved.state === 'merged' && deps.materializeBase === materializeBaseWithGit;
  const analysed = await analysePullRequest(resolved, common, merged ? { ...deps, materializeBase: materializeMergedBaseWithGit(resolved.number) } : deps);
  const head = analysed.head as AnalyzedTree;
  const treeDeps: HeadTreeDeps = { repoRoot: common.repoRoot, storageDir: common.storageDir, exec: common.exec, log: common.log, signal: common.signal };
  const baseSha = analysed.base?.sha ?? null;
  const [headFiles, baseFiles, hist, prFiles, branch] = await Promise.all([
    commitFiles(treeDeps, analysed.sha),
    baseSha ? commitFiles(treeDeps, baseSha) : Promise.resolve([]),
    history(treeDeps, baseSha, analysed.sha),
    deps.source.files(deps.workspaceRoot, resolved.number),
    checkoutBranch(common.exec, deps.workspaceRoot),
  ]);
  if (!prFiles.ok) { common.log(`[tour] file list of #${resolved.number} unavailable (${prFiles.problem.kind})`); }
  return {
    repoRoot: common.repoRoot, target: { kind: 'pr', number: resolved.number },
    head: tourTree(head, headFiles), base: analysed.base ? tourTree(analysed.base, baseFiles) : null, diff: analysed.diff,
    pr: resolved, prFiles: prFiles.ok ? prFiles.files as PrFile[] : null,
    commits: hist.commits, changedPaths: hist.paths, checkoutBranch: branch, dirty: false,
  };
}

async function branchTrees(target: TourTarget, common: TreeCommon, deps: TourTreesDeps): Promise<TourTrees> {
  const treeDeps: HeadTreeDeps = { repoRoot: common.repoRoot, storageDir: common.storageDir, exec: common.exec, log: common.log, signal: common.signal };
  const prepared = await prepareBranch(treeDeps, { branch: target.branch, baseRef: target.baseRef, report: common.report });
  common.report('analysing…');
  const head = await analyzeTreeCached(prepared.head.dir, deps.analyzer, prepared.head.sha, common.signal);
  const base = prepared.base ? await analyzeTreeCached(prepared.base.dir, deps.analyzer, prepared.base.sha, common.signal) : null;
  common.report('diffing…');
  return {
    repoRoot: common.repoRoot, target: { kind: 'branch', branch: prepared.branch, baseRef: prepared.baseRef },
    head: tourTree(head, prepared.head.files), base: base && prepared.base ? tourTree(base, prepared.base.files) : null,
    diff: base ? diffGraphs(base, head) : null, pr: null, prFiles: null,
    commits: prepared.commits, changedPaths: prepared.changedPaths, checkoutBranch: prepared.branch, dirty: prepared.dirty,
  };
}

/** Contract section 2, `prepareTrees`: both target kinds. `pr` saves the lookup when the caller has the record. */
export async function prepareTourTrees(target: TourTarget, common: TreeCommon, deps: TourTreesDeps, pr?: PullRequest): Promise<TourTrees> {
  if (target.kind === 'pr') { return prTrees(target, common, deps, pr); }
  if (target.kind === 'branch') { return branchTrees(target, common, deps); }
  throw new HeadTreeError('error', 'Unknown tour target.');
}
