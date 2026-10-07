import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Exec, ExecResult } from '../ghCliSource';

/**
 * Materialise a commit of the user's repository into a directory of its own, so
 * it can be analysed like a workspace — without touching the user's checkout.
 *
 * Only the files the graph can show are copied (the caller says which, usually
 * `isAnalyzablePath`): every analyzer parses files one by one and reads no
 * manifest, so a source-only copy analyses exactly like the full tree. The copy
 * is made with git alone (`read-tree` into a temporary index, then
 * `checkout-index --prefix`): no tar, no `git worktree` entry, and the real
 * index is never written.
 *
 * No vscode import. The VS Code caller supplies the storage directory, the
 * exec, progress and cancellation.
 */

export type HeadTreeProblemKind =
  | 'git-missing' | 'not-a-repo' | 'no-remote' | 'offline' | 'fetch-failed' | 'no-such-ref'
  | 'too-large' | 'cancelled' | 'error';

export class HeadTreeError extends Error {
  constructor(readonly kind: HeadTreeProblemKind, message: string, readonly detail?: string) {
    super(message);
    this.name = 'HeadTreeError';
  }
}

export interface TreeBudget {
  /** Most trees kept across all repositories. */
  maxTrees: number;
  /** Most bytes kept across all repositories. */
  maxBytes: number;
}

export const DEFAULT_BUDGET: TreeBudget = { maxTrees: 6, maxBytes: 400 * 1024 * 1024 };
/** A commit with more analysable files than this is refused rather than copied. */
export const MAX_TREE_FILES = 50_000;
const MARKER = '.cograph-tree.json';

export interface HeadTreeDeps {
  /** Top level of the user's repository. */
  repoRoot: string;
  /** Where trees live: `<storage>/<repo key>/<sha>/`. */
  storageDir: string;
  exec: Exec;
  /** Which repository-relative POSIX paths to copy; `analyzerKeepsPath` unless a test says otherwise. */
  keep?: (relPath: string) => boolean;
  log?: (line: string) => void;
  signal?: AbortSignal;
  budget?: TreeBudget;
  now?: () => number;
}

/** A ref this tree was fetched through, with the value it had: deleted with the tree, if it still has that value. */
export interface TreeRef { name: string; value: string }

export interface TreeMarker {
  sha: string;
  repoRoot: string;
  files: number;
  bytes: number;
  createdAt: number;
  lastUsedAt: number;
  refs?: TreeRef[];
}

export interface MaterializedTree {
  dir: string;
  sha: string;
  files: number;
  bytes: number;
  /** A complete copy from an earlier run was found and used. */
  reused: boolean;
}

// What each analyzer's own walk parses (scripts/analyze*.{js,py}). The structure
// scanner is stricter (it also skips build/, target/ for every language), so a
// copy made by ITS rule would miss functions the workspace graph has — and a
// diff would report them as removed. The regression test in vcsHeadTree.test.ts
// compares a copy with a full checkout and fails if this table drifts.
const ANALYZER_SKIP: Record<string, Set<string>> = {
  typescript: new Set(['node_modules', 'out', 'dist']),
  javascript: new Set(['node_modules', 'out', 'dist']),
  python: new Set(['node_modules', 'out', 'dist', '__pycache__']),
  java: new Set(['node_modules', 'out', 'dist', 'target', 'build']),
  cpp: new Set(['node_modules', 'out', 'dist', 'target', 'build', 'CMakeFiles']),
};
const EXT_LANGUAGE: Record<string, string> = {
  '.py': 'python',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.java': 'java',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c++': 'cpp',
  '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.h++': 'cpp', '.h': 'cpp',
};

/** Would one of the analyzers parse this repository-relative POSIX path? The copy rule. */
export function analyzerKeepsPath(relPath: string): boolean {
  const segs = relPath.split('/').filter(Boolean);
  if (segs.length === 0) { return false; }
  const name = segs[segs.length - 1];
  if (name.endsWith('.d.ts')) { return false; }
  const dot = name.lastIndexOf('.');
  const language = dot < 0 ? null : EXT_LANGUAGE[name.slice(dot)];
  if (!language) { return false; }
  const skip = ANALYZER_SKIP[language];
  return !segs.slice(0, -1).some(d => d.startsWith('.') || skip.has(d) || (language === 'cpp' && d.startsWith('cmake-build-')));
}

/** Stable, path-safe key for a repository, so two checkouts of one repo share nothing by accident. */
export function repoKey(repoRoot: string): string {
  const norm = path.resolve(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

export function treeDir(deps: Pick<HeadTreeDeps, 'storageDir' | 'repoRoot'>, sha: string): string {
  return path.join(deps.storageDir, repoKey(deps.repoRoot), sha);
}

/** The ref a pull request's head is fetched into. Namespaced: nothing of the user's is touched. */
export function pullRequestRef(prNumber: number): string {
  return `refs/cograph/pr/${prNumber}`;
}

export function branchRef(branch: string): string {
  return `refs/cograph/base/${branch.replace(/^refs\/heads\//, '')}`;
}

function firstLine(text: string): string {
  return text.split('\n').map(l => l.trim()).find(l => l) ?? '';
}

function throwFor(res: ExecResult, what: string): never {
  const text = `${res.stderr}\n${res.stdout}`;
  const detail = firstLine(res.stderr) || firstLine(res.stdout);
  if (res.notFound) { throw new HeadTreeError('git-missing', 'Git was not found on this machine.', detail); }
  if (/not a git repository/i.test(text)) { throw new HeadTreeError('not-a-repo', 'This folder is not a git repository.', detail); }
  if (/does not appear to be a git repository|No such remote|not a valid remote/i.test(text)) {
    throw new HeadTreeError('no-remote', 'The repository has no remote to fetch the pull request from.', detail);
  }
  if (/Could not resolve host|Could not read from remote|Connection (timed out|refused)|unable to access|network is unreachable|Temporary failure/i.test(text)) {
    throw new HeadTreeError('offline', 'The remote could not be reached. Check the connection and try again.', detail);
  }
  if (/couldn't find remote ref|fatal: invalid refspec|unknown revision|bad revision|Not a valid object name/i.test(text)) {
    throw new HeadTreeError('no-such-ref', `${what} does not exist on the remote.`, detail);
  }
  if (/Permission denied|Authentication failed|could not read Username|Repository not found/i.test(text)) {
    throw new HeadTreeError('fetch-failed', `${what} could not be fetched: the remote refused access.`, detail);
  }
  throw new HeadTreeError('fetch-failed', `${what} could not be fetched.`, detail || `git exited with ${res.code}`);
}

async function git(deps: HeadTreeDeps, args: string[], opts?: { env?: Record<string, string>; stdin?: string; timeoutMs?: number }): Promise<ExecResult> {
  if (deps.signal?.aborted) { throw new HeadTreeError('cancelled', 'Cancelled.'); }
  return deps.exec('git', args, deps.repoRoot, opts);
}

/** The refs that bring a PR head: the one git fetched it into, valued at the head itself. */
export function pullRequestRefs(prNumber: number, sha: string): TreeRef[] {
  return [{ name: pullRequestRef(prNumber), value: sha }];
}

/** The ref that brought a base branch tip (the merge base is reached through it). */
export function branchRefs(branch: string, tip: string): TreeRef[] {
  return [{ name: branchRef(branch), value: tip }];
}

/** `git fetch <remote> +<refspec>`, then the sha it resolved to. */
async function fetchInto(deps: HeadTreeDeps, remote: string, src: string, dst: string, what: string): Promise<string> {
  const fetched = await git(deps, ['fetch', '--no-tags', '--quiet', remote, `+${src}:${dst}`], { timeoutMs: 120_000 });
  if (fetched.code !== 0) { throwFor(fetched, what); }
  const sha = await git(deps, ['rev-parse', '--verify', `${dst}^{commit}`]);
  if (sha.code !== 0) { throwFor(sha, what); }
  return sha.stdout.trim();
}

/** Fetch a pull request's head commit from the remote; returns its sha. */
export async function fetchPullRequestHead(deps: HeadTreeDeps, prNumber: number, remote = 'origin'): Promise<string> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) { throw new HeadTreeError('error', 'That is not a pull request number.'); }
  return fetchInto(deps, remote, `refs/pull/${prNumber}/head`, pullRequestRef(prNumber), `Pull request #${prNumber}`);
}

/** Fetch a branch tip from the remote; returns its sha. */
export async function fetchBranch(deps: HeadTreeDeps, branch: string, remote = 'origin'): Promise<string> {
  if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-')) { throw new HeadTreeError('error', `"${branch}" is not a branch name.`); }
  return fetchInto(deps, remote, `refs/heads/${branch}`, branchRef(branch), `Branch ${branch}`);
}

/** The merge base of two commits (what GitHub diffs a pull request against). */
export async function mergeBase(deps: HeadTreeDeps, a: string, b: string): Promise<string> {
  const res = await git(deps, ['merge-base', a, b]);
  if (res.code !== 0) { throwFor(res, 'The merge base'); }
  return res.stdout.trim();
}

/** The GitHub remote `gh` talks to: the one whose URL names a GitHub host, else `origin`. */
export async function githubRemote(deps: HeadTreeDeps): Promise<string> {
  const res = await git(deps, ['remote', '-v']);
  if (res.code !== 0) { throwFor(res, 'The remote list'); }
  let fallback: string | null = null;
  for (const line of res.stdout.split('\n')) {
    const [name, url] = line.trim().split(/\s+/);
    if (!name || !url) { continue; }
    if (/github/i.test(url)) { return name; }
    fallback ??= name;
  }
  if (!fallback) { throw new HeadTreeError('no-remote', 'The repository has no remote to fetch the pull request from.'); }
  return fallback;
}

function mergeRefs(have: TreeRef[] | undefined, add: TreeRef[]): TreeRef[] {
  const out = new Map((have ?? []).map(r => [r.name, r]));
  for (const r of add) { out.set(r.name, r); }
  return [...out.values()];
}

function readMarker(dir: string): TreeMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')) as Partial<TreeMarker>;
    return typeof raw.sha === 'string' && typeof raw.files === 'number' ? (raw as TreeMarker) : null;
  } catch { return null; }
}

function writeMarker(dir: string, marker: TreeMarker): void {
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(marker, null, 2), 'utf8');
}

/** Repository-relative POSIX paths of the commit the caller wants copied. */
async function listFiles(deps: HeadTreeDeps, sha: string): Promise<string[]> {
  const res = await git(deps, ['ls-tree', '-r', '-z', '--name-only', sha]);
  if (res.code !== 0) { throwFor(res, `Commit ${sha.slice(0, 7)}`); }
  const keep = deps.keep ?? analyzerKeepsPath;
  return res.stdout.split('\0').filter(p => p && keep(p));
}

function dirBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); } else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* gone */ } }
    }
  }
  return total;
}

/**
 * Copy the analysable files of `sha` into its tree directory. A complete earlier
 * copy is reused (and its last-use time refreshed). A half-written one — no
 * marker — is removed and made again.
 */
export async function materializeCommit(deps: HeadTreeDeps, sha: string, refs: TreeRef[] = []): Promise<MaterializedTree> {
  if (!/^[0-9a-f]{40}$/.test(sha)) { throw new HeadTreeError('error', `"${sha}" is not a commit id.`); }
  const dir = treeDir(deps, sha);
  const now = deps.now?.() ?? Date.now();
  const existing = readMarker(dir);
  if (existing) {
    writeMarker(dir, { ...existing, lastUsedAt: now, refs: mergeRefs(existing.refs, refs) });
    deps.log?.(`[vcs] tree ${sha.slice(0, 7)} reused (${existing.files} files)`);
    return { dir, sha, files: existing.files, bytes: existing.bytes, reused: true };
  }

  const files = await listFiles(deps, sha);
  if (files.length > MAX_TREE_FILES) {
    throw new HeadTreeError('too-large', `This commit has ${files.length.toLocaleString()} source files; CoGraph copies at most ${MAX_TREE_FILES.toLocaleString()}.`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(path.dirname(dir), `.index-${sha.slice(0, 12)}-${process.pid}`);
  try {
    const env = { GIT_INDEX_FILE: indexFile };
    const read = await git(deps, ['read-tree', sha], { env });
    if (read.code !== 0) { throwFor(read, `Commit ${sha.slice(0, 7)}`); }
    if (files.length) {
      // --prefix must end in a slash; git wants forward slashes in it on every platform.
      const prefix = dir.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
      const out = await git(deps, ['checkout-index', '--force', '--quiet', `--prefix=${prefix}`, '--stdin', '-z'], {
        env, stdin: files.join('\0') + '\0', timeoutMs: 300_000,
      });
      if (out.code !== 0) { throwFor(out, `Commit ${sha.slice(0, 7)}`); }
    }
    if (deps.signal?.aborted) { throw new HeadTreeError('cancelled', 'Cancelled.'); }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
  const bytes = dirBytes(dir);
  writeMarker(dir, { sha, repoRoot: deps.repoRoot, files: files.length, bytes, createdAt: now, lastUsedAt: now, refs: mergeRefs([], refs) });
  deps.log?.(`[vcs] tree ${sha.slice(0, 7)} materialised: ${files.length} files, ${Math.round(bytes / 1024)} KB`);
  return { dir, sha, files: files.length, bytes, reused: false };
}

export interface StoredTree { dir: string; marker: TreeMarker }

/** Every complete tree under the storage directory, any repository. */
export function listTrees(storageDir: string): StoredTree[] {
  const out: StoredTree[] = [];
  let repos: string[] = [];
  try { repos = fs.readdirSync(storageDir); } catch { return out; }
  for (const repo of repos) {
    const repoDir = path.join(storageDir, repo);
    let shas: string[] = [];
    try { shas = fs.readdirSync(repoDir); } catch { continue; }
    for (const sha of shas) {
      const dir = path.join(repoDir, sha);
      const marker = readMarker(dir);
      if (marker) { out.push({ dir, marker }); }
    }
  }
  return out;
}

/**
 * Delete the refs a tree was fetched through — each only if it still points
 * where it did when the tree was made (`update-ref -d <ref> <old>` refuses
 * otherwise), so a ref re-pointed by a newer fetch of the same PR survives.
 * Without this the objects behind an evicted tree stay reachable and `.git`
 * grows where the tree budget cannot see it.
 */
export async function dropTreeRefs(marker: TreeMarker, exec: Exec, log?: (line: string) => void): Promise<void> {
  for (const ref of marker.refs ?? []) {
    const res = await exec('git', ['update-ref', '-d', ref.name, ref.value], marker.repoRoot);
    if (res.code !== 0) { log?.(`[vcs] kept ${ref.name} (no longer ${ref.value.slice(0, 7)} or already gone)`); }
  }
}

/**
 * Enforce the budget: least recently used first, until both the count and the
 * byte limits hold. `protect` names dirs that must stay (the ones on screen).
 * Returns what was removed. Leftovers without a marker (a crashed copy) go too.
 * With an `exec`, each evicted tree's refs go with it.
 */
export async function evictTrees(storageDir: string, budget: TreeBudget = DEFAULT_BUDGET, protect: string[] = [], exec?: Exec, log?: (line: string) => void): Promise<StoredTree[]> {
  const keep = new Set(protect.map(p => path.resolve(p)));
  const trees = listTrees(storageDir).sort((a, b) => a.marker.lastUsedAt - b.marker.lastUsedAt);
  const removed: StoredTree[] = [];
  let count = trees.length;
  let bytes = trees.reduce((n, t) => n + t.marker.bytes, 0);
  for (const t of trees) {
    if (count <= budget.maxTrees && bytes <= budget.maxBytes) { break; }
    if (keep.has(path.resolve(t.dir))) { continue; }
    fs.rmSync(t.dir, { recursive: true, force: true });
    if (exec) { await dropTreeRefs(t.marker, exec, log); }
    removed.push(t);
    count--;
    bytes -= t.marker.bytes;
  }
  // Half-written copies have no marker and are never listed; sweep them here.
  let repos: string[] = [];
  try { repos = fs.readdirSync(storageDir); } catch { return removed; }
  for (const repo of repos) {
    const repoDir = path.join(storageDir, repo);
    let entries: string[] = [];
    try { entries = fs.readdirSync(repoDir); } catch { continue; }
    for (const name of entries) {
      const dir = path.join(repoDir, name);
      if (keep.has(path.resolve(dir))) { continue; }
      if (name.startsWith('.index-') || (fs.statSync(dir).isDirectory() && !readMarker(dir))) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    if (fs.readdirSync(repoDir).length === 0) { fs.rmSync(repoDir, { recursive: true, force: true }); }
  }
  return removed;
}

/** Remove every tree and, with an `exec`, the refs each was fetched through (the "clear" command). Returns bytes freed. */
export async function clearTrees(storageDir: string, exec?: Exec, log?: (line: string) => void): Promise<number> {
  const trees = listTrees(storageDir);
  const bytes = trees.reduce((n, t) => n + t.marker.bytes, 0);
  if (exec) { for (const t of trees) { await dropTreeRefs(t.marker, exec, log); } }
  fs.rmSync(storageDir, { recursive: true, force: true });
  return bytes;
}

/** Delete every `refs/cograph/*` ref of a repository (what "clear" leaves nothing of). Returns the names deleted. */
export async function clearRepoRefs(repoRoot: string, exec: Exec): Promise<string[]> {
  const res = await exec('git', ['for-each-ref', '--format=%(refname)', 'refs/cograph/'], repoRoot);
  if (res.code !== 0) { return []; }
  const names = res.stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('refs/cograph/'));
  const deleted: string[] = [];
  for (const name of names) {
    const del = await exec('git', ['update-ref', '-d', name], repoRoot);
    if (del.code === 0) { deleted.push(name); }
  }
  return deleted;
}
