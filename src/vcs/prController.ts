import * as fs from 'fs';
import * as path from 'path';
import type { FileStatus, GitStatusOverride } from '../gitService';
import type { StructureTree } from '../structureScanner';
import type { ScopeSpec } from '../subgraphScope';
import { statusesFromDiff } from './engine/diffStatuses';
import { diffGraphs } from './engine/graphDiff';
import type { StructuralDiff } from './engine/graphDiff';
import { DEFAULT_BUDGET, HeadTreeError, branchRefs, evictTrees, fetchBranch, fetchPullRequestHead, githubRemote, lockTree, materializeCommit, mergeBase, pullRequestRefs, unlockTree } from './engine/headTree';
import type { TreeBudget } from './engine/headTree';
import { analyzeTreeCached } from './engine/treeAnalysis';
import { flushCacheWrites } from '../cacheStore';
import type { AnalyzedTree, TreeAnalyzer } from './engine/treeAnalysis';
import { defaultExec } from './ghCliSource';
import type { Exec } from './ghCliSource';
import { buildPrView, gitBlobSha, prViewName } from './prView';
import type { PrViewCounts, PrViewFile, UnchangedFolders } from './prView';
import type { PrFile, PrFileStatus, PrListOptions, PrListResult, PrProblem, PullRequest, PullRequestSource } from './types';

/** Which tree a pull-request view shows. The panel title and the banner always say. */
export type PrTree =
  | { kind: 'checkout'; branch: string }
  | { kind: 'head'; sha: string; base?: string };

/** Host → graph webview: enter a pull-request view. Leaving is `{type:'pr-view', active:false}`. */
export interface PrViewMessage {
  type: 'pr-view';
  active: true;
  number: number;
  name: string;
  title: string;
  headRef: string;
  baseRef: string;
  tree: PrTree;
  /** Set by the panel that shows the view: its popups take no edits. */
  readOnly?: boolean;
  /** Present when the colours come from the structural diff against the merge base. */
  diff?: StructuralDiff['summary'];
  /** Structure-tree folder paths to open; everything else is closed. */
  expand: string[];
  /** The PR's file statuses, keyed like `fileGitStatus` everywhere else. */
  fileGitStatus: Record<string, FileStatus>;
  counts: PrViewCounts;
}

/** Everything a graph panel needs to show one pull request. */
export interface PrGraphView {
  number: number;
  name: string;
  spec: ScopeSpec;
  override: GitStatusOverride;
  message: PrViewMessage;
}

/** The part of GraphProvider the controller drives. */
export interface PrGraph {
  /** False when no panel could be opened (no workspace folder). */
  showPullRequest(view: PrGraphView): boolean;
  exitPullRequest(): void;
  /** Number of the pull request on screen, or null. */
  activePullRequest(): number | null;
  onPullRequestChange(listener: (active: number | null) => void): { dispose(): void };
}

/** A provider that exists for one pull request, in a panel of its own: the PR's head tree, or the checkout. */
export interface PrHeadGraph extends PrGraph {
  isOpen(): boolean;
  close(): void;
}

/** A progress UI with cancellation; VS Code supplies `window.withProgress`, tests call the task directly. */
export type ProgressRunner = <T>(title: string, task: (report: (message: string) => void, signal: AbortSignal) => Promise<T>) => Promise<T>;

export interface PrControllerDeps {
  workspaceRoot: () => string | undefined;
  scanStructure: (root: string) => StructureTree;
  unchangedFolders: () => UnchangedFolders;
  log: (line: string) => void;
  exec?: Exec;
  /** Git blob id of a working file; null when it cannot be read. */
  blobShaOf?: (absPath: string) => string | null;
  /** Where materialised trees live; without it only the checkout view (a) exists. */
  storageDir?: string;
  /**
   * A panel of its own for one pull request: clicking a PR always opens a NEW panel and never
   * takes over the user's graph. 'head' roots a materialised copy, 'checkout' the workspace.
   * Without it the checkout view falls back to the main panel (hosts without global storage).
   */
  createHeadGraph?: (root: string, title: string, kind: PrTree['kind'], editorLabel: string) => PrHeadGraph;
  /** Show text as a read-only document labelled `<label>/<relPath>` (the PR's version of a file the checkout lacks). */
  showText?: (label: string, relPath: string, text: string) => Promise<void>;
  progress?: ProgressRunner;
  budget?: TreeBudget;
  /** Fetch + copy a PR head (the engine by default; tests hand in a directory of their own). */
  materializeHead?: MaterializeHead;
  /** Fetch the base branch, find the merge base with the head, copy it (the engine by default). */
  materializeBase?: MaterializeBase;
  /** Analyses a directory; without it the head is coloured from the PR's file list, not a diff. */
  analyzer?: TreeAnalyzer;
}

export type MaterializeBase = (opts: {
  repoRoot: string; storageDir: string; baseRef: string; headSha: string; exec: Exec; log: (line: string) => void;
  report: (message: string) => void; signal: AbortSignal;
}) => Promise<{ sha: string; dir: string }>;

export const materializeBaseWithGit: MaterializeBase = async ({ repoRoot, storageDir, baseRef, headSha, exec, log, report, signal }) => {
  const treeDeps = { repoRoot, storageDir, exec, log, signal };
  report('fetching its base…');
  const remote = await githubRemote(treeDeps);
  const tip = await fetchBranch(treeDeps, baseRef, remote);
  const sha = await mergeBase(treeDeps, headSha, tip);
  const copied = await materializeCommit(treeDeps, sha, branchRefs(baseRef, tip));
  return { sha, dir: copied.dir };
};

export type MaterializeHead = (opts: {
  repoRoot: string; storageDir: string; prNumber: number; exec: Exec; log: (line: string) => void;
  report: (message: string) => void; signal: AbortSignal;
}) => Promise<{ sha: string; dir: string }>;

/** The engine's way: fetch the ref, then copy the commit's analysable files. */
export const materializeHeadWithGit: MaterializeHead = async ({ repoRoot, storageDir, prNumber, exec, log, report, signal }) => {
  const treeDeps = { repoRoot, storageDir, exec, log, signal };
  report('fetching the pull request…');
  const sha = await fetchPullRequestHead(treeDeps, prNumber, await githubRemote(treeDeps));
  report('copying its files…');
  const copied = await materializeCommit(treeDeps, sha, pullRequestRefs(prNumber, sha));
  return { sha, dir: copied.dir };
};

/** What the sidebar shows of the structural diff. */
export interface PrDiffDetail {
  summary: StructuralDiff['summary'];
  base: string;
  /** Functions the PR removes, with who called them in the base (the list is cut at MAX_REMOVED). */
  removed: Array<{ key: string; callers: string[] }>;
  removedCut: boolean;
}

export const MAX_REMOVED = 50;

export interface PrOpened {
  number: number;
  tree: PrTree;
  counts: PrViewCounts;
  files: PrViewFile[];
  /** The source stopped before the PR's last file. */
  truncated: boolean;
  diff?: PrDiffDetail;
}

export type PrOpenResult = { ok: true; opened: PrOpened } | { ok: false; problem: PrProblem };

const NO_WORKSPACE: PrProblem = { kind: 'no-workspace', message: 'Open a folder to see its pull requests.' };

function readBlobSha(absPath: string): string | null {
  try { return gitBlobSha(fs.readFileSync(absPath)); } catch { return null; }
}

/**
 * The repository's top level, derived from the workspace path itself (so drive
 * letter and separators stay exactly as the structure tree spells them):
 * `git rev-parse --show-prefix` says how deep inside the repository we are.
 */
export function repoRootFrom(workspaceRoot: string, showPrefix: string): string {
  const depth = showPrefix.trim().split('/').filter(Boolean).length;
  let root = workspaceRoot;
  for (let i = 0; i < depth; i++) { root = path.dirname(root); }
  return root;
}

const directProgress: ProgressRunner = (_title, task) => task(() => undefined, new AbortController().signal);

/** The PR's files as the structural diff knows them, for when the GitHub file list is unavailable. */
function diffFiles(diff: StructuralDiff): PrFile[] {
  const byFile = new Map<string, PrFileStatus>();
  for (const f of diff.files.added) { byFile.set(f, 'added'); }
  for (const f of diff.files.removed) { byFile.set(f, 'deleted'); }
  for (const fn of diff.functions) { if (fn.kind !== 'moved' && !byFile.has(fn.file)) { byFile.set(fn.file, 'modified'); } }
  return [...byFile].map(([path, status]) => ({ path, status, previousPath: null, additions: 0, deletions: 0, blobSha: null, hunks: null }));
}

/** Lists pull requests and turns one into a view of the graph. No UI of its own. */
export class PrController {
  private readonly exec: Exec;
  private readonly blobShaOf: (absPath: string) => string | null;
  private readonly listeners = new Set<(active: number | null) => void>();
  /** The pull-request panel on screen, if any: a head copy (sha) or the checkout (sha 'checkout'). */
  private head: { number: number; sha: string; dir: string; baseDir?: string; graph: PrHeadGraph; sub: { dispose(): void } } | null = null;

  constructor(
    private readonly source: PullRequestSource,
    private readonly graph: PrGraph,
    private readonly deps: PrControllerDeps,
  ) {
    this.exec = deps.exec ?? defaultExec;
    this.blobShaOf = deps.blobShaOf ?? readBlobSha;
    graph.onPullRequestChange(() => this.emit());
  }

  /** The head panel's pull request when one is open, else the main panel's. */
  activePullRequest(): number | null {
    if (this.head?.graph.isOpen()) { return this.head.graph.activePullRequest() ?? this.head.number; }
    return this.graph.activePullRequest();
  }

  onActiveChange(listener: (active: number | null) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private emit(): void {
    const active = this.activePullRequest();
    for (const l of [...this.listeners]) { l(active); }
  }

  async list(opts: PrListOptions): Promise<PrListResult> {
    const root = this.deps.workspaceRoot();
    if (!root) { return { ok: false, problem: NO_WORKSPACE }; }
    try {
      return await this.source.list(root, opts);
    } catch (err) {
      return { ok: false, problem: this.unexpected('list', err) };
    }
  }

  /** Can the head be materialised at all on this install? */
  headAvailable(): boolean {
    return !!(this.deps.storageDir && this.deps.createHeadGraph);
  }

  /** Does the checkout view get a panel of its own (the rule), or the main panel (minimal hosts)? */
  private ownPanels(): boolean {
    return !!this.deps.createHeadGraph;
  }

  /**
   * Show a pull request. `tree` 'head' (the default where available) fetches and
   * analyses the PR's own commit in a second, read-only panel; 'checkout' colours
   * the current checkout's graph with the PR's changes (the fallback).
   */
  async open(pr: PullRequest, tree: PrTree['kind'] = this.headAvailable() ? 'head' : 'checkout'): Promise<PrOpenResult> {
    const root = this.deps.workspaceRoot();
    if (!root) { return { ok: false, problem: NO_WORKSPACE }; }
    try {
      return tree === 'head' && this.headAvailable() ? await this.openHead(pr, root) : await this.openCheckout(pr, root);
    } catch (err) {
      return { ok: false, problem: this.unexpected(`open #${pr.number}`, err) };
    }
  }

  private async repoRoot(root: string): Promise<string> {
    const prefix = await this.exec('git', ['rev-parse', '--show-prefix'], root);
    return prefix.code === 0 ? repoRootFrom(root, prefix.stdout) : root;
  }

  private async openCheckout(pr: PullRequest, root: string): Promise<PrOpenResult> {
    const fetched = await this.source.files(root, pr.number);
    if (!fetched.ok) { return fetched; }
    const branch = await this.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
    const tree: PrTree = { kind: 'checkout', branch: branch.code === 0 ? branch.stdout.trim() : '' };
    const view = buildPrView({
      pr, files: fetched.files, tree: this.deps.scanStructure(root), workspaceRoot: root,
      repoRoot: await this.repoRoot(root), unchangedFolders: this.deps.unchangedFolders(), blobShaOf: this.blobShaOf,
    });
    // Its own panel, like the head: the user's graph is never taken over by a pull request. Files it
    // opens are labelled as the checkout's, not the PR's: this panel's colours say what the PR
    // changes, but the file on disk may not hold that change at all.
    const editorLabel = `your checkout${tree.branch ? ` · ${tree.branch}` : ''} (not PR #${pr.number})`;
    const graph = this.ownPanels() ? this.panelFor(pr, { sha: 'checkout', dir: root }, 'checkout', editorLabel) : this.graph;
    const shown = graph.showPullRequest(this.graphView(pr, tree, view));
    if (!shown) { return { ok: false, problem: NO_WORKSPACE }; }
    this.logCounts(pr, 'checkout', view.counts);
    this.emit();
    return { ok: true, opened: { number: pr.number, tree, counts: view.counts, files: view.files, truncated: fetched.truncated } };
  }

  private async openHead(pr: PullRequest, root: string): Promise<PrOpenResult> {
    const storageDir = this.deps.storageDir as string;
    this.pendingBaseDir = undefined;
    const repoRoot = await this.repoRoot(root);
    const progress = this.deps.progress ?? directProgress;
    let materialised: { sha: string; dir: string; diff: StructuralDiff | null; baseSha?: string };
    let cancelled = false;
    let copied = false; // a finished copy survives a later cancel: it is whole, and reused next time
    try {
      materialised = await progress(`Pull request #${pr.number}`, async (report, signal) => {
        signal.addEventListener('abort', () => { cancelled = true; });
        const common = { repoRoot, storageDir, exec: this.exec, log: this.deps.log, report, signal };
        const head = await (this.deps.materializeHead ?? materializeHeadWithGit)({ ...common, prNumber: pr.number });
        copied = true;
        if (!this.deps.analyzer) { return { ...head, diff: null }; }
        report('analysing the pull request…');
        const headTree = await analyzeTreeCached(head.dir, this.deps.analyzer, head.sha, signal);
        const base = await this.baseTree(pr, head.sha, common);
        return { ...head, diff: base ? diffGraphs(base, headTree) : null, baseSha: base?.sha };
      });
    } catch (err) {
      // A cancel anywhere — fetch, copy, either analysis — ends the open with nothing shown; a
      // complete copy stays (it is whole and reusable), an unfinished one was already removed.
      if (cancelled || (err instanceof HeadTreeError && err.kind === 'cancelled')) {
        this.deps.log(`[vcs] head of #${pr.number}: cancelled${copied ? ' (copy kept)' : ''}`);
        return { ok: false, problem: { kind: 'error', message: copied ? 'Cancelled. The copied files are kept, so the next open is faster.' : 'Cancelled.' } };
      }
      if (err instanceof HeadTreeError) {
        this.deps.log(`[vcs] head of #${pr.number} unavailable (${err.kind}): ${err.detail ?? err.message}`);
        return { ok: false, problem: { kind: 'head-unavailable', message: err.message, detail: err.detail, fallback: 'checkout' } };
      }
      throw err;
    }
    const { diff, baseSha } = materialised;
    const fetched = await this.source.files(root, pr.number);
    // With the diff, the file list only feeds the sidebar's listing: a gh hiccup now must not throw away a head
    // that git has fetched and the engine has analysed. Without a diff the list is what the colours come from.
    if (!fetched.ok && !diff) { return fetched; }
    if (!fetched.ok) { this.deps.log(`[vcs] file list of #${pr.number} unavailable (${fetched.problem.kind}); the diff stands on its own`); }
    const files = fetched.ok ? fetched.files : diffFiles(diff as StructuralDiff);
    const tree: PrTree = { kind: 'head', sha: materialised.sha, ...(baseSha ? { base: baseSha } : {}) };
    const view = buildPrView({
      pr, files, tree: this.deps.scanStructure(materialised.dir), workspaceRoot: materialised.dir,
      repoRoot: materialised.dir, unchangedFolders: this.deps.unchangedFolders(), blobShaOf: () => null, treeIsHead: true,
    });
    // With a diff, the colours come from it: one hunk per added / changed function, nothing from patches.
    if (diff) { view.override = statusesFromDiff(diff, materialised.dir); }
    const headGraph = this.panelFor(pr, materialised, 'head', prViewName(pr, tree));
    // After the switch: a head panel that was just closed no longer protects its copy. Its debounced
    // cache write lands first, or it would recreate a marker-less directory under an evicted tree.
    const protect = [materialised.dir, ...(this.head?.baseDir ? [this.head.baseDir] : [])];
    try {
      await flushCacheWrites();
      await evictTrees(storageDir, this.deps.budget ?? DEFAULT_BUDGET, protect, this.exec, this.deps.log);
    } catch (err) { this.deps.log(`[vcs] eviction failed: ${(err as Error).message}`); }
    const shown = headGraph.showPullRequest(this.graphView(pr, tree, view, diff?.summary));
    if (!shown) { return { ok: false, problem: NO_WORKSPACE }; }
    this.logCounts(pr, `head ${materialised.sha.slice(0, 7)}${diff ? ` vs base ${baseSha?.slice(0, 7)}: +${diff.summary.added} ~${diff.summary.changed} -${diff.summary.removed} functions` : ''}`, view.counts);
    this.emit();
    const removed = diff ? diff.impact.filter(i => i.kind === 'removed') : [];
    return {
      ok: true,
      opened: {
        number: pr.number, tree, counts: view.counts, files: view.files, truncated: fetched.ok ? fetched.truncated : false,
        ...(diff && baseSha ? { diff: {
          summary: diff.summary, base: baseSha,
          removed: removed.slice(0, MAX_REMOVED).map(i => ({ key: i.key, callers: i.callers })),
          removedCut: removed.length > MAX_REMOVED,
        } } : {}),
      },
    };
  }

  /** The merge base, materialised and analysed; null (logged) when it cannot be had — the head is still shown. */
  private async baseTree(pr: PullRequest, headSha: string, common: {
    repoRoot: string; storageDir: string; exec: Exec; log: (line: string) => void; report: (m: string) => void; signal: AbortSignal;
  }): Promise<AnalyzedTree | null> {
    if (!pr.baseRef) { return null; }
    try {
      const base = await (this.deps.materializeBase ?? materializeBaseWithGit)({ ...common, baseRef: pr.baseRef, headSha });
      common.report('analysing the base…');
      const analysed = await analyzeTreeCached(base.dir, this.deps.analyzer as TreeAnalyzer, base.sha, common.signal);
      this.pendingBaseDir = base.dir;
      return analysed;
    } catch (err) {
      // A cancel is the user's, not the base's: it ends the whole open.
      if (common.signal.aborted || (err instanceof HeadTreeError && err.kind === 'cancelled')) { throw err; }
      this.deps.log(`[vcs] base of #${pr.number} unavailable, colouring from the PR's file list: ${(err as Error).message}`);
      return null;
    }
  }

  private pendingBaseDir: string | undefined;

  /** One pull-request panel at a time: the same tree's panel is reused, any other is closed first. */
  private panelFor(pr: PullRequest, m: { sha: string; dir: string }, kind: PrTree['kind'], editorLabel: string): PrHeadGraph {
    const baseDir = this.pendingBaseDir;
    this.pendingBaseDir = undefined;
    if (this.head && this.head.sha === m.sha && this.head.graph.isOpen()) {
      this.head.number = pr.number;
      this.head.baseDir = baseDir;
      return this.head.graph;
    }
    if (this.head) { this.head.sub.dispose(); this.head.graph.close(); }
    const title = prViewName(pr, kind === 'head' ? { kind, sha: m.sha } : { kind: 'checkout' });
    const graph = (this.deps.createHeadGraph as NonNullable<PrControllerDeps['createHeadGraph']>)(m.dir, title, kind, editorLabel);
    // While shown, the copy is held: another window's eviction or clear leaves it alone.
    if (kind === 'head') { lockTree(m.dir); if (baseDir) { lockTree(baseDir); } }
    const release = () => { if (kind === 'head') { unlockTree(m.dir); if (baseDir) { unlockTree(baseDir); } } };
    const sub = graph.onPullRequestChange(() => {
      this.emit();
      // Closed from its tab: nothing to keep — the provider, its analyzer and its channel can go.
      if (!graph.isOpen() && this.head?.graph === graph) { release(); this.head.sub.dispose(); this.head = null; }
    });
    this.head = { number: pr.number, sha: m.sha, dir: m.dir, baseDir, graph, sub: { dispose: () => { release(); sub.dispose(); } } };
    return graph;
  }

  private graphView(pr: PullRequest, tree: PrTree, view: ReturnType<typeof buildPrView>, diff?: StructuralDiff['summary']): PrGraphView {
    const name = prViewName(pr, tree);
    return {
      number: pr.number, name, spec: view.spec, override: view.override,
      message: {
        type: 'pr-view', active: true, number: pr.number, name, title: pr.title, headRef: pr.headRef, baseRef: pr.baseRef,
        tree, ...(diff ? { diff } : {}), expand: view.expand, fileGitStatus: Object.fromEntries(view.override.files), counts: view.counts,
      },
    };
  }

  private logCounts(pr: PullRequest, where: string, c: PrViewCounts): void {
    this.deps.log(`[vcs] PR #${pr.number} in ${where}: ${c.inGraph}/${c.total} files in graph, ${c.exact} exact, ${c.missing} absent, ${c.other} not shown`);
  }

  /** The PR's own version of one of its files, read-only (for a file the checkout does not have). */
  async openPrFile(pr: PullRequest, relPath: string): Promise<PrProblem | null> {
    const root = this.deps.workspaceRoot();
    if (!root) { return NO_WORKSPACE; }
    if (!pr.headOid) { return { kind: 'error', message: 'The pull request\'s head commit is not known.' }; }
    try {
      const res = await this.source.fileText(root, relPath, pr.headOid);
      if (!res.ok) { return res.problem; }
      await this.deps.showText?.(prViewName(pr, { kind: 'head', sha: pr.headOid }), relPath, res.text);
      return null;
    } catch (err) {
      return this.unexpected(`file ${relPath} of #${pr.number}`, err);
    }
  }

  /** Leave: close the pull-request panel when one is open, otherwise end a checkout view on the main panel. */
  exit(): void {
    if (this.head?.graph.isOpen()) { this.head.graph.close(); return; }
    this.graph.exitPullRequest();
  }

  private unexpected(what: string, err: unknown): PrProblem {
    const detail = (err as Error)?.message ?? String(err);
    this.deps.log(`[vcs] ${what} failed: ${detail}`);
    return { kind: 'error', message: 'Pull requests could not be loaded.', detail };
  }
}
