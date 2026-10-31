import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Repositories for the CI suites: a bare origin over file://, so every shallow case runs with
 * no network, and the shapes a job's checkout leaves behind. Fixed author and dates, so a
 * commit id is the same on every run.
 */

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_TERMINAL_PROMPT: '0',
};

export function sh(cwd: string, args: string[], input?: string | Buffer, env?: Record<string, string>): string {
  return cp.execFileSync('git', args, { cwd, input, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...env }, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export interface Origin {
  /** Bare; what the checkouts fetch from. */
  bare: string;
  url: string;
  /** Where the commits are made, then pushed. */
  work: string;
}

export function makeOrigin(root: string): Origin {
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  sh(root, ['init', '--quiet', '--bare', '-b', 'main', bare]);
  for (const [key, value] of [['uploadpack.allowAnySHA1InWant', 'true'], ['uploadpack.allowFilter', 'true']]) { sh(bare, ['config', key, value]); }
  sh(work, ['init', '--quiet', '-b', 'main']);
  sh(work, ['remote', 'add', 'origin', bare]);
  return { bare, url: `file://${bare}`, work };
}

/** A commit on the current branch of `work`; a null content deletes the file. */
export function commit(work: string, files: Record<string, string | null>, message = 'change'): string {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(work, ...rel.split('/'));
    if (text === null) { fs.rmSync(abs); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  sh(work, ['add', '-A']);
  sh(work, ['commit', '--quiet', '--allow-empty', '-m', message]);
  return sh(work, ['rev-parse', 'HEAD']);
}

/** `count` commits on top of a branch, cheaply: fast-import, no working tree. Returns the new tip. */
export function pile(work: string, branch: string, count: number): string {
  const parent = sh(work, ['rev-parse', `refs/heads/${branch}`]);
  const blocks: string[] = [];
  for (let i = 0; i < count; i++) {
    const body = `${branch} ${i}\n`;
    blocks.push(`commit refs/heads/${branch}\ncommitter t <t@x> ${1_767_225_600 + i} +0000\ndata 4\npile\n${i === 0 ? `from ${parent}\n` : ''}M 100644 inline pile.txt\ndata ${body.length}\n${body}\n`);
  }
  sh(work, ['fast-import', '--quiet', '--force'], blocks.join(''));
  sh(work, ['checkout', '--quiet', branch]);
  return sh(work, ['rev-parse', `refs/heads/${branch}`]);
}

export function push(origin: Origin, ...refspecs: string[]): void {
  sh(origin.work, ['-c', 'core.hooksPath=/dev/null', 'push', '--quiet', '--force', 'origin', ...refspecs]);
}

/** What a default CI checkout leaves: a merge commit, depth 1, and neither side of the change. */
export function mergeCheckout(root: string, origin: Origin, head: string, base: string): string {
  const merge = sh(origin.work, ['commit-tree', `${head}^{tree}`, '-p', base, '-p', head, '-m', 'merge']);
  push(origin, `${merge}:refs/pull/1/merge`);
  return emptyCheckout(root, origin, ['--depth=1', 'origin', 'refs/pull/1/merge'], 'FETCH_HEAD');
}

/** `git init` plus a fetch, as the checkout actions do it. */
export function emptyCheckout(root: string, origin: Origin, fetch: string[], checkout?: string): string {
  const dir = fs.mkdtempSync(path.join(root, 'checkout-'));
  sh(dir, ['init', '--quiet']);
  sh(dir, ['remote', 'add', 'origin', origin.url]);
  sh(dir, ['fetch', '--quiet', '--no-tags', ...fetch]);
  if (checkout) { sh(dir, ['checkout', '--quiet', '--detach', checkout]); }
  return dir;
}

/** `git clone` with these flags. */
export function clone(root: string, origin: Origin, ...flags: string[]): string {
  const dir = fs.mkdtempSync(path.join(root, 'clone-'));
  sh(root, ['clone', '--quiet', ...flags, origin.url, dir]);
  return dir;
}
