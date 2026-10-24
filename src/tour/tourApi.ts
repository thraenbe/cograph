/**
 * The PR tour's contract, public side: what the extension injects into the private
 * package (`TourHostApi`, docs/tour-protocol.md section 2) and what it gets back
 * (`TourHost`, section 3). The private package keeps an identical copy; nothing in
 * either repository imports the other at build time, so a change here is a change
 * to the contract and is made in both copies the same day.
 *
 * Types only, no vscode import: the fixture recorder and the engine compile it too.
 */
import type { JsonRequest, JsonResult } from '../graphIntelligence/provider';
import type { FuncBriefResult } from '../funcBrief';
import type { ImpactResult } from '../mcp/queries';
import type { StructuralDiff } from '../vcs/engine/graphDiff';
import type { EngineGraph } from '../vcs/engine/types';
import type { PrFile, PullRequest } from '../vcs/types';

export const TOUR_API_VERSION = 1;

export interface TourTarget {
  kind: 'pr' | 'branch';
  /** kind 'pr' */
  number?: number;
  /** kind 'branch': the local branch (HEAD). Resolved by the host when absent. */
  branch?: string;
  /** kind 'branch': the base branch name, e.g. 'main'. Resolved by the host when absent
   *  (origin/HEAD, else the repository's default branch from gh, else 'main'). */
  baseRef?: string;
}

export interface TourTree {
  sha: string;
  /** The materialised copy (analysable files only). */
  dir: string;
  graph: EngineGraph;
  /** Repo-relative POSIX paths of every file of the commit (not only the copied ones). */
  files: string[];
}

export interface TourCommit { sha: string; subject: string; body: string; author: string; date: string }

export interface TourChangedPath {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string;
  /** True when the structure scanner would show the file (so it can be in the graph). */
  analysable: boolean;
}

export interface TourTrees {
  repoRoot: string;
  target: TourTarget;
  head: TourTree;
  /** null when the base could not be fetched; then diff is null and the tour says so. */
  base: TourTree | null;
  diff: StructuralDiff | null;
  /** The pull request, kind 'pr' only. */
  pr: PullRequest | null;
  /** gh's file list with hunks, kind 'pr' only; null when the list could not be fetched. */
  prFiles: PrFile[] | null;
  /** base..head, oldest first. For a PR: the PR's commits. */
  commits: TourCommit[];
  /** `git diff --name-status base head`, every file, source or not. */
  changedPaths: TourChangedPath[];
  /** The checkout's branch, when the workspace is a checkout of this repository. */
  checkoutBranch: string | null;
  /** The working tree has uncommitted changes (branch targets only; false for a PR). */
  dirty: boolean;
}

export interface TourProgress { (message: string): void }

/** The engine's shell-free runner, exactly src/vcs/ghCliSource.ts: an argument array, never a shell. */
export interface ExecResult { code: number | null; stdout: string; stderr: string }
export interface ExecOptions { env?: Record<string, string>; stdin?: string; timeoutMs?: number; signal?: AbortSignal }
export type Exec = (command: string, args: string[], cwd: string, opts?: ExecOptions) => Promise<ExecResult>;

export interface TourGitActions {
  /** Each one shows a native VS Code confirmation first (the exact command and text) and
   *  resolves { ok: false, reason: 'cancelled' } when declined. The private side never confirms
   *  on its own and never runs gh or git for these. */
  push(branch: string): Promise<{ ok: true; remote: string } | { ok: false; reason: string }>;
  createPr(opts: { title: string; body: string; base: string; head: string; draft: boolean }): Promise<{ ok: true; number: number; url: string } | { ok: false; reason: string }>;
  editPrBody(number: number, body: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  commentPr(number: number, body: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }>;
}

export interface TourAi {
  enabled(): boolean;
  providerId(): 'claude-code' | 'codex';
  /** The model alias the tour should pass (resolved from cograph.tour.ai.model / annotate.model). */
  model(): string | undefined;
  /** The opt-in gate: a modal that describes what will be sent and costs; true = go. */
  confirmGate(description: string): Promise<boolean>;
  runJson(req: JsonRequest, signal?: AbortSignal): Promise<JsonResult>;
}

export interface TourHostApi {
  version: 1;
  repoRoot: string;
  /** <globalStorage>/pr-trees */
  storageDir: string;
  /** Appends to the "CoGraph Version Control" output channel with a [tour] tag. */
  log(line: string): void;
  /** Reads `cograph.<key>` (key without the prefix, e.g. 'tour.chapters'); fallback when unset. */
  settings<T>(key: string, fallback: T): T;
  exec: Exec;
  /** Materialises and analyses head and base, diffs them, lists commits and changed paths. */
  prepareTrees(target: TourTarget, progress: TourProgress, signal: AbortSignal): Promise<TourTrees>;
  /** `git show <sha>:<path>` from the fetched objects; null when absent or above maxBytes. */
  readFileAtRef(sha: string, path: string, maxBytes: number): Promise<string | null>;
  /** The MCP impact query over any graph (the head graph). Seeds are node ids of that graph. */
  impact(graph: EngineGraph, seeds: string[]): ImpactResult;
  /** Signature, doc, first lines of a function in a file on disk (a copy's file). */
  funcBrief(absPath: string, line: number, maxLines: number): FuncBriefResult;
  /** The workspace's Annotate summaries, keyed by repo-relative POSIX path; null when none. */
  annotations(): { files: Record<string, { summary: string }>; folders: Record<string, { summary: string }> } | null;
  /** null when cograph.graphIntelligence.enabled is false. */
  ai: TourAi | null;
  git: TourGitActions;
  /** Opens a file of a tree copy read-only (cograph-pr scheme) or the user's own file for a branch target. */
  navigate(absPath: string, line: number): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** A native information message with one button; no side effect. */
  notify(message: string): void;
}

// ── Section 3: what the private package returns ─────────────────────────────

export interface TourRouteRequest {
  method: 'GET' | 'POST';
  /** Path without query, e.g. '/tour/abc/script'. */
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  /** Parsed JSON body for POST (the server caps it at 1 MB), undefined for GET. */
  body?: unknown;
}

export interface TourRouteResponse {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

export interface TourRoute {
  method: 'GET' | 'POST';
  /** Express-style pattern with :params, matched by the public server, e.g. '/tour/:id/script'. */
  pattern: string;
  handler(req: TourRouteRequest): Promise<TourRouteResponse>;
}

/** Section 6. The public side never parses a script; it only carries it. */
export type TourScript = { version: 1 } & Record<string, unknown>;

export interface TourPrepared {
  tourId: string;
  script: TourScript;
  /** Absolute path of the materialised head copy: the public side roots the stage provider there. */
  headDir: string;
  /** Statuses for the stage colours, the shape GitService.setOverride takes (EngineStatusOverride
   *  serialised: files as [path, status][], hunks as [path, hunks][]). */
  statuses: { files: [string, { unstaged: 'added' | 'modified' | 'deleted' | null; staged: null }][]; hunks: [string, { start: number; end: number; isNew: boolean }[]][] };
  /** What the stage's pr-view message needs: name, title, refs, expand list (ancestor folders of changed files). */
  view: { name: string; title: string; headRef: string; baseRef: string; expand: string[]; counts: { total: number; inGraph: number; other: number } };
}

export interface TourHost {
  version: 1;
  /** Builds the script (or loads it from the cache). Shows the AI gate through api.ai when AI is on. */
  prepare(target: TourTarget, progress: TourProgress, signal: AbortSignal): Promise<TourPrepared>;
  /** Routes the public server mounts (token, Host and Origin are enforced before any of them run). */
  routes: TourRoute[];
  /** Directory holding tour.js and tour.css, served by the public server at /tour-assets/. */
  webAssetsDir: string;
  dispose(): void;
}

/** The package's host entry. */
export type CreateTour = (api: TourHostApi) => TourHost;
