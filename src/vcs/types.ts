/**
 * Version Control view — shared types. No vscode import, no I/O.
 *
 * `PullRequestSource` is the one seam between the view and wherever pull requests
 * come from. `GhCliSource` is the only implementation today; a token-based one can
 * be added without touching the sidebar or the graph.
 */

export type PrState = 'open' | 'closed' | 'merged';
export type PrStateFilter = 'open' | 'all';
export type PrChecks = 'pass' | 'fail' | 'pending' | 'none';

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  headRef: string;
  baseRef: string;
  /** Commit the PR's head points at; '' when the source does not say. */
  headOid: string;
  state: PrState;
  isDraft: boolean;
  checks: PrChecks;
  changedFiles: number;
  additions: number;
  deletions: number;
  /** ISO timestamp of the last update; '' when unknown. */
  updatedAt: string;
  url: string;
}

export type PrFileStatus = 'added' | 'modified' | 'deleted';

/** A changed stretch of a file, in line numbers of the PR head's version. */
export interface PrHunk {
  start: number;
  end: number;
  /** True when the stretch only adds lines (nothing was replaced or removed). */
  isNew: boolean;
}

export interface PrFile {
  /** Repository-relative POSIX path at the PR head (the old path for a deletion). */
  path: string;
  status: PrFileStatus;
  /** Set for a rename: where the file lived before. */
  previousPath: string | null;
  additions: number;
  deletions: number;
  /** Git blob id of the file at the PR head; null when the source does not say. */
  blobSha: string | null;
  /** Changed line ranges; null when the source sent no patch (binary or too large). */
  hunks: PrHunk[] | null;
}

/**
 * Why a list or a file set could not be produced. Each of these is an ordinary
 * situation for the view to explain, never an exception to surface.
 */
export type PrProblemKind =
  | 'no-workspace'
  | 'not-a-repo'
  | 'no-remote'
  | 'not-github'
  | 'gh-missing'
  | 'gh-unauthenticated'
  | 'no-access'
  | 'offline'
  | 'error';

export interface PrProblem {
  kind: PrProblemKind;
  /** One readable sentence. */
  message: string;
  /** Short technical detail (first line of stderr), for the tooltip and the log. */
  detail?: string;
}

export type PrListResult =
  | { ok: true; pullRequests: PullRequest[]; /** More exist than `limit` returned. */ truncated: boolean }
  | { ok: false; problem: PrProblem };

export type PrFilesResult =
  | { ok: true; files: PrFile[]; /** The source stopped before the PR's last file. */ truncated: boolean }
  | { ok: false; problem: PrProblem };

export interface PrListOptions {
  state: PrStateFilter;
  limit: number;
}

export interface PullRequestSource {
  /** Short id for logs, e.g. 'gh'. */
  readonly id: string;
  list(root: string, opts: PrListOptions): Promise<PrListResult>;
  files(root: string, prNumber: number): Promise<PrFilesResult>;
}
