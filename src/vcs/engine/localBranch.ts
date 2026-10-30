import { isAnalyzablePath } from '../../structureScanner';
import type { Exec, ExecResult } from '../ghCliSource';
import { HeadTreeError, branchRefs, fetchBranch, githubRemote, materializeCommit, mergeBase } from './headTree';
import type { HeadTreeDeps, MaterializedTree } from './headTree';

/**
 * The branch you are on as a tour target: HEAD against its merge base with the
 * base branch, from local refs. The head needs no fetch (it is your commit); the
 * base tip is fetched so the merge base is the one GitHub would use, and when the
 * remote cannot be reached the local copy of the base branch stands in (logged).
 * Both sides are materialised exactly as a pull request's are (headTree.ts).
 *
 * No vscode import.
 */

export interface BranchCommit { sha: string; subject: string; body: string; author: string; date: string }

export interface BranchChangedPath {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string;
  analysable: boolean;
}

export interface BranchSide { sha: string; dir: string; files: string[] }

export interface PreparedBranch {
  branch: string;
  baseRef: string;
  head: BranchSide;
  /** null when no copy of the base branch exists, fetched or local. */
  base: BranchSide | null;
  commits: BranchCommit[];
  changedPaths: BranchChangedPath[];
  dirty: boolean;
}

async function git(deps: HeadTreeDeps, args: string[], timeoutMs?: number): Promise<ExecResult> {
  if (deps.signal?.aborted) { throw new HeadTreeError('cancelled', 'Cancelled.'); }
  const res = await deps.exec('git', args, deps.repoRoot, { ...(timeoutMs ? { timeoutMs } : {}), ...(deps.signal ? { signal: deps.signal } : {}) });
  if (deps.signal?.aborted) { throw new HeadTreeError('cancelled', 'Cancelled.'); }
  if (res.notFound) { throw new HeadTreeError('git-missing', 'Git was not found on this machine.'); }
  return res;
}

function firstLine(text: string): string {
  return text.split('\n').map(l => l.trim()).find(l => l) ?? '';
}

/** HEAD's commit and branch; the branch is null on a detached HEAD. */
export async function headOf(deps: HeadTreeDeps): Promise<{ sha: string; branch: string | null }> {
  const sha = await git(deps, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (sha.code !== 0) {
    const text = `${sha.stderr}\n${sha.stdout}`;
    if (/not a git repository/i.test(text)) { throw new HeadTreeError('not-a-repo', 'This folder is not a git repository.', firstLine(sha.stderr)); }
    throw new HeadTreeError('no-such-ref', 'This repository has no commit yet.', firstLine(sha.stderr));
  }
  const branch = await git(deps, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return { sha: sha.stdout.trim(), branch: branch.code === 0 && branch.stdout.trim() ? branch.stdout.trim() : null };
}

/**
 * The base branch's name: the remote's HEAD (`refs/remotes/<remote>/HEAD`), else the
 * repository's default branch as gh knows it, else 'main'.
 */
export async function resolveBaseRef(deps: HeadTreeDeps, remote = 'origin'): Promise<string> {
  const sym = await git(deps, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
  const fromRemote = sym.code === 0 ? sym.stdout.trim() : '';
  if (fromRemote.startsWith(`${remote}/`) && fromRemote.length > remote.length + 1) { return fromRemote.slice(remote.length + 1); }
  if (deps.signal?.aborted) { throw new HeadTreeError('cancelled', 'Cancelled.'); }
  const gh = await deps.exec('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], deps.repoRoot, { timeoutMs: 15_000, ...(deps.signal ? { signal: deps.signal } : {}) });
  const fromGh = gh.code === 0 ? gh.stdout.trim() : '';
  if (/^[\w./-]+$/.test(fromGh) && !fromGh.startsWith('-')) { return fromGh; }
  deps.log?.(`[tour] base branch: no ${remote}/HEAD and gh gave none (${firstLine(gh.stderr) || 'no output'}); using main`);
  return 'main';
}

/**
 * The base branch's tip: fetched from the remote (so the merge base matches GitHub's),
 * else the local branch, else the remote-tracking ref. `refs` are what the base tree
 * keeps alive (only a fetch makes one). Null when none of the three exists.
 */
export async function baseTip(deps: HeadTreeDeps, baseRef: string): Promise<{ sha: string; via: 'fetch' | 'local' | 'remote-tracking'; refs: ReturnType<typeof branchRefs> } | null> {
  let remote = 'origin';
  try {
    remote = await githubRemote(deps);
    const sha = await fetchBranch(deps, baseRef, remote);
    return { sha, via: 'fetch', refs: branchRefs(baseRef, sha) };
  } catch (err) {
    if (err instanceof HeadTreeError && (err.kind === 'cancelled' || err.kind === 'git-missing')) { throw err; }
    deps.log?.(`[tour] base ${baseRef} not fetched (${(err as Error).message}); trying the local copy`);
  }
  for (const [ref, via] of [[`refs/heads/${baseRef}`, 'local'], [`refs/remotes/${remote}/${baseRef}`, 'remote-tracking']] as const) {
    const res = await git(deps, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (res.code === 0 && res.stdout.trim()) {
      deps.log?.(`[tour] base ${baseRef} from ${ref} (${via}); it may be behind the remote`);
      return { sha: res.stdout.trim(), via, refs: [] };
    }
  }
  return null;
}

/** Every file of a commit, repository-relative POSIX. */
export async function commitFiles(deps: HeadTreeDeps, sha: string): Promise<string[]> {
  const res = await git(deps, ['ls-tree', '-r', '-z', '--name-only', sha]);
  if (res.code !== 0) { throw new HeadTreeError('no-such-ref', `Commit ${sha.slice(0, 7)} could not be listed.`, firstLine(res.stderr)); }
  return res.stdout.split('\0').filter(Boolean);
}

const RECORD = '\x1e';

/** `base..head`, oldest first. Subjects and bodies may hold any text; records are split on RS, fields on NUL. */
export async function listCommits(deps: HeadTreeDeps, base: string | null, head: string): Promise<BranchCommit[]> {
  const range = base ? `${base}..${head}` : head;
  const res = await git(deps, ['log', '--reverse', '--no-color', `--format=%H%x00%s%x00%b%x00%an%x00%aI${RECORD}`, range], 60_000);
  if (res.code !== 0) { throw new HeadTreeError('error', 'The commits could not be listed.', firstLine(res.stderr)); }
  const out: BranchCommit[] = [];
  for (const record of res.stdout.split(RECORD)) {
    const fields = record.replace(/^\n+/, '').split('\0');
    if (fields.length < 5 || !/^[0-9a-f]{40}$/.test(fields[0])) { continue; }
    out.push({ sha: fields[0], subject: fields[1], body: fields[2].replace(/\n+$/, ''), author: fields[3], date: fields[4].trim() });
  }
  return out;
}

const STATUS: Record<string, BranchChangedPath['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'modified', C: 'added' };

/** `git diff --name-status -M base head`, every file; `-z` so no path is ever quoted or split. */
export async function changedPaths(deps: HeadTreeDeps, base: string, head: string): Promise<BranchChangedPath[]> {
  const res = await git(deps, ['diff', '--name-status', '-M', '-z', '--no-color', base, head], 60_000);
  if (res.code !== 0) { throw new HeadTreeError('error', 'The changed files could not be listed.', firstLine(res.stderr)); }
  return parseNameStatus(res.stdout);
}

export function parseNameStatus(z: string): BranchChangedPath[] {
  const parts = z.split('\0');
  const out: BranchChangedPath[] = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++];
    if (!code) { continue; }
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const from = parts[i++];
      const to = parts[i++];
      if (!to) { break; }
      out.push(letter === 'R'
        ? { path: to, status: 'renamed', previousPath: from, analysable: isAnalyzablePath(to) }
        : { path: to, status: 'added', analysable: isAnalyzablePath(to) });
      continue;
    }
    const p = parts[i++];
    if (!p) { break; }
    out.push({ path: p, status: STATUS[letter] ?? 'modified', analysable: isAnalyzablePath(p) });
  }
  return out;
}

/** Uncommitted changes, untracked files included (a file never added is not in the commits either). */
export async function isDirty(deps: HeadTreeDeps): Promise<boolean> {
  const res = await git(deps, ['status', '--porcelain', '-z']);
  return res.code === 0 && res.stdout.length > 0;
}

/** Ahead count of HEAD over a commit, for the tour pill. */
export async function commitsAhead(exec: Exec, repoRoot: string, from: string, to = 'HEAD'): Promise<number | null> {
  const res = await exec('git', ['rev-list', '--count', `${from}..${to}`], repoRoot);
  const n = Number(res.stdout.trim());
  return res.code === 0 && Number.isInteger(n) ? n : null;
}

/**
 * Everything a branch tour needs from git: both copies materialised, the commits,
 * the changed paths and whether the tree is dirty. `report` gets the stage names.
 */
export async function prepareBranch(deps: HeadTreeDeps, opts: { branch?: string; baseRef?: string; report?: (m: string) => void }): Promise<PreparedBranch> {
  const report = opts.report ?? (() => undefined);
  const head = await headOf(deps);
  const branch = opts.branch ?? head.branch;
  if (!branch) { throw new HeadTreeError('error', 'HEAD is detached: check out a branch to tour it.'); }
  if (opts.branch && opts.branch !== head.branch) { throw new HeadTreeError('error', `The tour runs on the checked-out branch; ${opts.branch} is not checked out.`); }
  const baseRef = opts.baseRef ?? await resolveBaseRef(deps);
  if (baseRef === branch) { throw new HeadTreeError('error', `${branch} is the base branch: there is nothing to compare it with.`); }
  report('fetching the base…');
  const tip = await baseTip(deps, baseRef);
  const baseSha = tip ? await mergeBase(deps, head.sha, tip.sha) : null;
  report('copying the files…');
  const headTree: MaterializedTree = await materializeCommit(deps, head.sha);
  const baseTree = baseSha ? await materializeCommit(deps, baseSha, tip?.refs ?? []) : null;
  const [headFiles, baseFiles, commits, paths, dirty] = await Promise.all([
    commitFiles(deps, head.sha),
    baseSha ? commitFiles(deps, baseSha) : Promise.resolve(null),
    listCommits(deps, baseSha, head.sha),
    baseSha ? changedPaths(deps, baseSha, head.sha) : Promise.resolve([] as BranchChangedPath[]),
    isDirty(deps),
  ]);
  return {
    branch, baseRef,
    head: { sha: head.sha, dir: headTree.dir, files: headFiles },
    base: baseSha && baseTree && baseFiles ? { sha: baseSha, dir: baseTree.dir, files: baseFiles } : null,
    commits, changedPaths: paths, dirty,
  };
}
