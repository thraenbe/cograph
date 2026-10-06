import * as fs from 'fs';
import * as path from 'path';
import type { FileStatus, GitStatusOverride } from '../gitService';
import type { StructureTree } from '../structureScanner';
import type { ScopeSpec } from '../subgraphScope';
import { defaultExec } from './ghCliSource';
import type { Exec } from './ghCliSource';
import { buildPrView, gitBlobSha, prViewName } from './prView';
import type { PrViewCounts, PrViewFile, UnchangedFolders } from './prView';
import type { PrListOptions, PrListResult, PrProblem, PullRequest, PullRequestSource } from './types';

/** Host → graph webview: enter a pull-request view. Leaving is `{type:'pr-view', active:false}`. */
export interface PrViewMessage {
  type: 'pr-view';
  active: true;
  number: number;
  name: string;
  title: string;
  headRef: string;
  baseRef: string;
  /** Structure-tree folder paths to open; everything else is closed. */
  expand: string[];
  /** The PR's file statuses, keyed like `fileGitStatus` everywhere else. */
  fileGitStatus: Record<string, FileStatus>;
  counts: PrViewCounts;
}

/** Everything the graph panel needs to show one pull request. */
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

export interface PrControllerDeps {
  workspaceRoot: () => string | undefined;
  scanStructure: (root: string) => StructureTree;
  unchangedFolders: () => UnchangedFolders;
  log: (line: string) => void;
  exec?: Exec;
  /** Git blob id of a working file; null when it cannot be read. */
  blobShaOf?: (absPath: string) => string | null;
}

export interface PrOpened {
  number: number;
  counts: PrViewCounts;
  files: PrViewFile[];
  /** The source stopped before the PR's last file. */
  truncated: boolean;
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

/** Lists pull requests and turns one into a view of the graph. No UI of its own. */
export class PrController {
  private readonly exec: Exec;
  private readonly blobShaOf: (absPath: string) => string | null;

  constructor(
    private readonly source: PullRequestSource,
    private readonly graph: PrGraph,
    private readonly deps: PrControllerDeps,
  ) {
    this.exec = deps.exec ?? defaultExec;
    this.blobShaOf = deps.blobShaOf ?? readBlobSha;
  }

  activePullRequest(): number | null {
    return this.graph.activePullRequest();
  }

  onActiveChange(listener: (active: number | null) => void): { dispose(): void } {
    return this.graph.onPullRequestChange(listener);
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

  /** Fetch the PR's files and show them in the graph of the current checkout. */
  async open(pr: PullRequest): Promise<PrOpenResult> {
    const root = this.deps.workspaceRoot();
    if (!root) { return { ok: false, problem: NO_WORKSPACE }; }
    try {
      const fetched = await this.source.files(root, pr.number);
      if (!fetched.ok) { return fetched; }
      const prefix = await this.exec('git', ['rev-parse', '--show-prefix'], root);
      const view = buildPrView({
        pr,
        files: fetched.files,
        tree: this.deps.scanStructure(root),
        workspaceRoot: root,
        repoRoot: prefix.code === 0 ? repoRootFrom(root, prefix.stdout) : root,
        unchangedFolders: this.deps.unchangedFolders(),
        blobShaOf: this.blobShaOf,
      });
      const name = prViewName(pr);
      const shown = this.graph.showPullRequest({
        number: pr.number,
        name,
        spec: view.spec,
        override: view.override,
        message: {
          type: 'pr-view', active: true, number: pr.number, name, title: pr.title,
          headRef: pr.headRef, baseRef: pr.baseRef, expand: view.expand,
          fileGitStatus: Object.fromEntries(view.override.files), counts: view.counts,
        },
      });
      if (!shown) { return { ok: false, problem: NO_WORKSPACE }; }
      this.deps.log(`[vcs] PR #${pr.number}: ${view.counts.inGraph}/${view.counts.total} files in graph, `
        + `${view.counts.exact} exact, ${view.counts.missing} not in checkout, ${view.counts.other} not shown`);
      return { ok: true, opened: { number: pr.number, counts: view.counts, files: view.files, truncated: fetched.truncated } };
    } catch (err) {
      return { ok: false, problem: this.unexpected(`open #${pr.number}`, err) };
    }
  }

  exit(): void {
    this.graph.exitPullRequest();
  }

  private unexpected(what: string, err: unknown): PrProblem {
    const detail = (err as Error)?.message ?? String(err);
    this.deps.log(`[vcs] ${what} failed: ${detail}`);
    return { kind: 'error', message: 'Pull requests could not be loaded.', detail };
  }
}
