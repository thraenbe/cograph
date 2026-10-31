import { HeadTreeError, isBranchName } from '../vcs/engine/headTree';
import type { Exec, ExecOptions, ExecResult } from '../vcs/ghCliSource';
import { fetchMissingBlobs } from './partialClone';
import { gitExec } from './toolEnv';

/**
 * `cograph-tour fetch`: makes head, the merge base and the target tip available from whatever
 * the job's checkout left behind. It is the only step of a headless run that uses the network
 * for git, and it runs in the parent, which has the job's credentials. A default checkout is
 * one merge commit, depth 1, so both sides usually come from here; a full clone needs nothing.
 *
 * The rules that make it safe to run on any checkout:
 *  - A name is data. Only a checked name goes to git, as `refs/heads/<name>`, after `--`.
 *  - `--depth` only where the history is cut anyway. On a complete clone it would make the
 *    repository shallow and hide what is there, so a complete clone fetches plainly.
 *  - The target tip is looked up, not fetched blind: `--depth=1` on a commit the checkout holds
 *    deeper would shorten its history, and the next step would have to deepen it again.
 * No merge base is an answer, not a failure: `build` then makes a head-only tour.
 */

export interface EnsureCommitsOptions {
  repoRoot: string;
  /** Hex, 7 to 64: a platform may give a short id. */
  head: string;
  base: string;
  /** The target branch: brings the tip, which `tour.json` is read from. */
  baseRef?: string;
  headRef?: string;
  /** The job's own remote. */
  remote?: string;
  /** Default: `fetchExec()`, with the job's environment. */
  exec?: Exec;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Deepening stops here, inside the parent's limit for this step; the tour goes on head-only. */
  budgetMs?: number;
}

/** The line `cograph-tour fetch` prints. */
export interface EnsuredCommits { head: string; mergeBase: string | null; targetTip: string | null }

const REV = /^[0-9a-f]{7,64}$/;
const FULL_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Deepening grows fourfold: 32, 128, … 524,288 commits at round 8, more than the repositories of the corpus hold. */
const FIRST_DEEPEN = 32;
const DEEPEN_ROUNDS = 8;
const FETCH_TIMEOUT_MS = 120_000;
const BUDGET_MS = 240_000;

/** The job's environment, as the checkout left it, and nobody to ask for a password. */
export function fetchExec(): Exec {
  return gitExec({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
}

interface Ctx {
  run: (args: string[], opts?: Omit<ExecOptions, 'signal'>) => Promise<ExecResult>;
  remote: string;
  log: (line: string) => void;
  deadline: number;
}

/** First line of git's stderr, with any `user:token@` of a remote URL taken out. */
function reason(res: ExecResult): string {
  const line = res.stderr.split('\n').map(l => l.trim()).find(Boolean) ?? `exit ${res.code}`;
  return line.replace(/\/\/[^/@\s]+@/g, '//***@').slice(0, 300);
}

function context(opts: EnsureCommitsOptions): Ctx {
  const exec = opts.exec ?? fetchExec();
  return {
    remote: opts.remote ?? 'origin',
    log: opts.log ?? (() => undefined),
    deadline: Date.now() + (opts.budgetMs ?? BUDGET_MS),
    run: async (args, runOpts) => {
      if (opts.signal?.aborted) { throw new HeadTreeError('cancelled', 'Cancelled.'); }
      const res = await exec('git', args, opts.repoRoot, { ...runOpts, ...(opts.signal ? { signal: opts.signal } : {}) });
      if (opts.signal?.aborted) { throw new HeadTreeError('cancelled', 'Cancelled.'); }
      if (res.notFound) { throw new HeadTreeError('git-missing', 'Git was not found on this machine.'); }
      return res;
    },
  };
}

/** The full id of a commit this repository holds; null when it does not. */
async function commitOf(ctx: Ctx, rev: string): Promise<string | null> {
  const res = await ctx.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return res.code === 0 ? res.stdout.trim() : null;
}

async function isShallow(ctx: Ctx): Promise<boolean> {
  return (await ctx.run(['rev-parse', '--is-shallow-repository'])).stdout.trim() === 'true';
}

/** `--depth=1`, unless this is a complete clone. A repository with no commit yet (`git init`, then fetch) is not one. */
async function depthFlag(ctx: Ctx): Promise<string[]> {
  if (await isShallow(ctx)) { return ['--depth=1']; }
  return (await ctx.run(['rev-list', '--max-count=1', '--all'])).stdout.trim() ? [] : ['--depth=1'];
}

async function fetchFrom(ctx: Ctx, flags: string[], what: string[]): Promise<boolean> {
  const timeoutMs = Math.max(1000, Math.min(FETCH_TIMEOUT_MS, ctx.deadline - Date.now()));
  const res = await ctx.run(['fetch', '--no-tags', '--no-recurse-submodules', '--quiet', ...flags, '--', ctx.remote, ...what], { timeoutMs });
  if (res.code !== 0) { ctx.log(`[ci] git fetch ${flags.join(' ')}: ${reason(res)}`); }
  return res.code === 0;
}

function headsRef(name: string | undefined, ctx: Ctx): string | null {
  if (!name) { return null; }
  if (isBranchName(name)) { return `refs/heads/${name}`; }
  ctx.log('[ci] a branch name git must not see was left out');
  return null;
}

/** `rev` here, by fetching its id and else its branch (a server may refuse a bare id). Null when neither brings it. */
async function ensureCommit(ctx: Ctx, rev: string, branch: string | undefined): Promise<string | null> {
  const have = await commitOf(ctx, rev);
  if (have) { return have; }
  const flags = await depthFlag(ctx);
  if (FULL_ID.test(rev) && await fetchFrom(ctx, flags, [rev])) {
    const got = await commitOf(ctx, rev);
    if (got) { return got; }
  }
  const ref = headsRef(branch, ctx);
  return ref && await fetchFrom(ctx, flags, [ref]) ? commitOf(ctx, rev) : null;
}

/** The target branch's tip as the remote has it now; null when it cannot be had. */
async function ensureTip(ctx: Ctx, branch: string): Promise<string | null> {
  const ref = headsRef(branch, ctx);
  if (!ref) { return null; }
  const listed = await ctx.run(['ls-remote', '--quiet', '--', ctx.remote, ref], { timeoutMs: 30_000 });
  if (listed.code !== 0) { ctx.log(`[ci] git ls-remote: ${reason(listed)}`); return null; }
  const line = listed.stdout.split('\n').find(l => l.endsWith(`\t${ref}`));
  const tip = line && FULL_ID.test(line.split('\t')[0]) ? line.split('\t')[0] : null;
  if (!tip) { ctx.log('[ci] the target branch is not on the remote'); return null; }
  return ensureCommit(ctx, tip, branch);
}

async function mergeBaseOf(ctx: Ctx, a: string, b: string): Promise<string | null> {
  const res = await ctx.run(['merge-base', a, b]);
  return res.code === 0 ? res.stdout.trim() : null;
}

async function deepen(ctx: Ctx, step: number, ids: string[], branches: Array<string | undefined>): Promise<boolean> {
  const flag = [`--deepen=${step}`];
  if (await fetchFrom(ctx, flag, ids)) { return true; }
  const refs = branches.map(b => headsRef(b, ctx)).filter((r): r is string => !!r);
  return refs.length > 0 && fetchFrom(ctx, flag, refs);
}

/** The merge base, deepening the history until the two sides meet, the history ends, or the budget does. */
async function findMergeBase(ctx: Ctx, head: string, base: string, branches: Array<string | undefined>): Promise<string | null> {
  let step = FIRST_DEEPEN;
  let found = await mergeBaseOf(ctx, head, base);
  for (let round = 0; !found && round < DEEPEN_ROUNDS; round++) {
    if (Date.now() >= ctx.deadline || !await isShallow(ctx) || !await deepen(ctx, step, [head, base], branches)) { break; }
    found = await mergeBaseOf(ctx, head, base);
    step *= 4;
  }
  return found;
}

/** Throws only when head cannot be had: without it there is nothing to tour. */
export async function ensureCommits(opts: EnsureCommitsOptions): Promise<EnsuredCommits> {
  if (!REV.test(opts.head) || !REV.test(opts.base)) { throw new HeadTreeError('error', 'The base and head must be commit ids.'); }
  const ctx = context(opts);
  const head = await ensureCommit(ctx, opts.head, opts.headRef);
  if (!head) { throw new HeadTreeError('no-such-ref', `Commit ${opts.head.slice(0, 7)} could not be fetched.`); }
  const targetTip = opts.baseRef ? await ensureTip(ctx, opts.baseRef) : null;
  const base = await ensureCommit(ctx, opts.base, opts.baseRef) ?? targetTip;
  const mergeBase = base ? await findMergeBase(ctx, head, base, [opts.baseRef, opts.headRef]) : null;
  if (!mergeBase) { ctx.log('[ci] no merge base: the tour shows the head only'); }
  if (!await fetchMissingBlobs(ctx.run, head, mergeBase, targetTip, ctx.log)) {
    throw new HeadTreeError('fetch-failed', 'The files of this partial clone could not be fetched.');
  }
  return { head, mergeBase, targetTip };
}
