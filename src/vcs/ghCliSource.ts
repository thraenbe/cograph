import * as cp from 'child_process';
import { parsePatchHunks } from './prPatch';
import type {
  PrChecks, PrFile, PrFileStatus, PrFilesResult, PrListOptions, PrListResult, PrProblem, PrState,
  PullRequest, PullRequestSource,
} from './types';

export interface ExecResult {
  /** Exit code; null when the process could not be started or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The executable itself was not found. */
  notFound: boolean;
}

export interface ExecOptions {
  /** Extra environment on top of the extension host's. */
  env?: Record<string, string>;
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  timeoutMs?: number;
}

export type Exec = (command: string, args: string[], cwd: string, opts?: ExecOptions) => Promise<ExecResult>;

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;
/** GitHub's files endpoint never returns more than this many files of one PR. */
const FILES_ENDPOINT_CAP = 3000;

const LIST_FIELDS = [
  'number', 'title', 'author', 'headRefName', 'baseRefName', 'headRefOid', 'state', 'isDraft',
  'changedFiles', 'additions', 'deletions', 'updatedAt', 'url',
];

/**
 * Run a CLI without ever rejecting: a missing binary, a non-zero exit and a
 * timeout all come back as data. Arguments are passed as an array; on Windows the
 * shell resolves `.cmd` shims (as gitService does), which is safe here because
 * every argument this module builds is a constant, an enum value or an integer.
 */
export const defaultExec: Exec = (command, args, cwd, opts = {}) => new Promise((resolve) => {
  const child = cp.execFile(command, args, {
    cwd, timeout: opts.timeoutMs ?? TIMEOUT_MS, encoding: 'utf8', maxBuffer: MAX_BUFFER,
    shell: process.platform === 'win32',
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
    resolve({
      code: !e ? 0 : (typeof e.code === 'number' ? e.code : null),
      stdout: String(stdout ?? ''),
      stderr: String(stderr ?? '') || (e ? e.message : ''),
      notFound: e?.code === 'ENOENT',
    });
  });
  if (opts.stdin !== undefined && child.stdin) { child.stdin.end(opts.stdin); }
});

const NOT_FOUND_TEXT = /is not recognized as an internal or external command|command not found|ENOENT/i;

function firstLine(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  return line.length > 300 ? line.slice(0, 297) + '…' : line;
}

/** Host of a git remote URL (https, ssh or scp-like); null when it has none. */
export function remoteHost(url: string): string | null {
  const u = url.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(u);
  if (scheme) { return scheme[1].toLowerCase(); }
  const scp = /^(?:[^@/]+@)?([^/:]+):/.exec(u);
  return scp ? scp[1].toLowerCase() : null;
}

/** First remote's host from `git remote -v` output; null when there is no remote. */
export function firstRemoteHost(remoteVerbose: string): string | null {
  for (const line of remoteVerbose.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) { return remoteHost(parts[1]) ?? ''; }
  }
  return null;
}

/** Turn a failed `gh` run into the situation the user is actually in. */
export function classifyGhFailure(res: ExecResult, host: string | null): PrProblem {
  const text = `${res.stderr}\n${res.stdout}`;
  const detail = firstLine(res.stderr) || firstLine(res.stdout);
  if (res.notFound || NOT_FOUND_TEXT.test(res.stderr)) {
    return {
      kind: 'gh-missing',
      message: 'The GitHub CLI (gh) is not installed. CoGraph reads pull requests through it, with your own sign-in.',
    };
  }
  // Before the sign-in test: this message also tells the user to run `gh auth login`.
  if (/none of the git remotes|known GitHub host|no git remotes found|not a GitHub repository/i.test(text)) {
    return {
      kind: 'not-github',
      message: `The remote points at ${host || 'a host that is not GitHub'}. CoGraph lists pull requests from GitHub only.`,
      detail,
    };
  }
  if (/gh auth login|not logged in|HTTP 401|Bad credentials|authentication (token|failed)|gh auth refresh/i.test(text)) {
    return {
      kind: 'gh-unauthenticated',
      message: 'The GitHub CLI is not signed in. Run "gh auth login" in a terminal, then refresh.',
      detail,
    };
  }
  if (/Could not resolve to a Repository|HTTP 404|HTTP 403|SAML/i.test(text) && !/rate limit/i.test(text)) {
    return {
      kind: 'no-access',
      message: 'GitHub did not return this repository. Your account may not have access to it.',
      detail,
    };
  }
  if (/error connecting|no such host|dial tcp|i\/o timeout|connection refused|TLS handshake|internet connection|network is unreachable/i.test(text)) {
    return { kind: 'offline', message: 'GitHub could not be reached. Check the connection and refresh.', detail };
  }
  return { kind: 'error', message: 'Pull requests could not be loaded.', detail: detail || 'gh exited without a message.' };
}

/** GitHub check runs and commit statuses of a PR head → one verdict. */
export function rollupChecks(items: unknown): PrChecks {
  if (!Array.isArray(items) || items.length === 0) { return 'none'; }
  let pending = false;
  for (const raw of items) {
    const it = (raw ?? {}) as { status?: string; conclusion?: string; state?: string };
    const verdict = String(it.conclusion || it.state || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(verdict)) {
      return 'fail';
    }
    const running = it.status !== undefined && String(it.status).toUpperCase() !== 'COMPLETED';
    if (running || verdict === 'PENDING' || verdict === 'EXPECTED' || verdict === '') { pending = true; }
  }
  return pending ? 'pending' : 'pass';
}

function toState(raw: unknown): PrState {
  const s = String(raw ?? '').toLowerCase();
  return s === 'merged' ? 'merged' : s === 'closed' ? 'closed' : 'open';
}

function toInt(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** One entry of `gh pr list --json …` → a PullRequest; null when it has no number. */
export function toPullRequest(raw: unknown): PullRequest | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const number = toInt(r.number);
  if (!number) { return null; }
  const author = (r.author ?? {}) as { login?: unknown; name?: unknown };
  return {
    number,
    title: String(r.title ?? ''),
    author: String(author.login ?? author.name ?? ''),
    headRef: String(r.headRefName ?? ''),
    baseRef: String(r.baseRefName ?? ''),
    headOid: String(r.headRefOid ?? ''),
    state: toState(r.state),
    isDraft: r.isDraft === true,
    checks: rollupChecks(r.statusCheckRollup),
    changedFiles: toInt(r.changedFiles),
    additions: toInt(r.additions),
    deletions: toInt(r.deletions),
    updatedAt: String(r.updatedAt ?? ''),
    url: String(r.url ?? ''),
  };
}

function toFileStatus(raw: unknown): PrFileStatus | null {
  switch (String(raw ?? '')) {
    case 'added': case 'copied': return 'added';
    case 'removed': return 'deleted';
    case 'unchanged': return null;
    default: return 'modified'; // modified, renamed, changed, and anything GitHub adds later
  }
}

/** One entry of the pull-request files endpoint → a PrFile; null when it is unusable. */
export function toPrFile(raw: unknown): PrFile | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const path = String(r.filename ?? '');
  const status = toFileStatus(r.status);
  if (!path || !status) { return null; }
  return {
    path,
    status,
    previousPath: typeof r.previous_filename === 'string' && r.previous_filename ? r.previous_filename : null,
    additions: toInt(r.additions),
    deletions: toInt(r.deletions),
    blobSha: typeof r.sha === 'string' && r.sha ? r.sha : null,
    hunks: typeof r.patch === 'string' ? parsePatchHunks(r.patch) : null,
  };
}

/**
 * `gh api --paginate` prints one JSON document per page, back to back. Split them
 * (string- and escape-aware) and return every page's array items in order.
 */
export function parsePaginatedArrays(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) { escaped = false; } else if (c === '\\') { escaped = true; } else if (c === '"') { inString = false; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '[' || c === '{') { if (depth === 0) { start = i; } depth++; continue; }
    if (c === ']' || c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const doc: unknown = JSON.parse(text.slice(start, i + 1));
        if (Array.isArray(doc)) { out.push(...doc); }
        start = -1;
      }
    }
  }
  return out;
}

/** Pull requests through the GitHub CLI the developer is already signed in to. */
export class GhCliSource implements PullRequestSource {
  readonly id = 'gh';

  constructor(private readonly exec: Exec = defaultExec) {}

  async list(root: string, opts: PrListOptions): Promise<PrListResult> {
    const remotes = await this.exec('git', ['remote', '-v'], root);
    if (remotes.code !== 0) {
      return { ok: false, problem: { kind: 'not-a-repo', message: 'This folder is not a git repository.', detail: firstLine(remotes.stderr) } };
    }
    const host = firstRemoteHost(remotes.stdout);
    if (host === null) {
      return { ok: false, problem: { kind: 'no-remote', message: 'This repository has no remote, so there are no pull requests to list.' } };
    }

    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit) || 50));
    const state = opts.state === 'all' ? 'all' : 'open';
    // One more than asked for tells "that was all" apart from "there are more".
    const args = (fields: string[]) => ['pr', 'list', '--state', state, '--limit', String(limit + 1), '--json', fields.join(',')];
    let res = await this.exec('gh', args([...LIST_FIELDS, 'statusCheckRollup']), root);
    if (res.code !== 0 && !res.notFound && classifyGhFailure(res, host).kind === 'error') {
      // The check rollup makes the query heavy enough to time out on busy repositories.
      res = await this.exec('gh', args(LIST_FIELDS), root);
    }
    if (res.code !== 0) { return { ok: false, problem: classifyGhFailure(res, host) }; }

    let rows: unknown;
    try { rows = JSON.parse(res.stdout || '[]'); } catch (err) {
      return { ok: false, problem: { kind: 'error', message: 'Pull requests could not be loaded.', detail: `Unreadable gh output: ${(err as Error).message}` } };
    }
    const all = (Array.isArray(rows) ? rows : []).map(toPullRequest).filter((p): p is PullRequest => p !== null);
    return { ok: true, pullRequests: all.slice(0, limit), truncated: all.length > limit };
  }

  async files(root: string, prNumber: number): Promise<PrFilesResult> {
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      return { ok: false, problem: { kind: 'error', message: 'That is not a pull request number.' } };
    }
    const res = await this.exec('gh', ['api', '--paginate', `repos/{owner}/{repo}/pulls/${prNumber}/files?per_page=100`], root);
    if (res.code !== 0) { return { ok: false, problem: classifyGhFailure(res, null) }; }
    let items: unknown[];
    try { items = parsePaginatedArrays(res.stdout); } catch (err) {
      return { ok: false, problem: { kind: 'error', message: 'The pull request\'s files could not be read.', detail: `Unreadable gh output: ${(err as Error).message}` } };
    }
    const files = items.map(toPrFile).filter((f): f is PrFile => f !== null);
    return { ok: true, files, truncated: items.length >= FILES_ENDPOINT_CAP };
  }
}
