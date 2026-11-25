import { analyzerKeepsPath } from '../vcs/engine/headTree';
import type { ExecOptions, ExecResult } from '../vcs/ghCliSource';

/**
 * A partial clone (`filter: blob:none`) holds no blobs, and `build` needs some and makes no
 * network call. So `fetch`, which has the job's credentials, brings them all in one request: what
 * the copies hold, what either side of the change reads, and the target tip's team files. git's
 * own way, one fetch per missing object, took 81 fetches for flask's 83 files.
 */

export type GitRun = (args: string[], opts?: Omit<ExecOptions, 'signal'>) => Promise<ExecResult>;

/** Paths the host reads at the target tip; `headlessApi.ts` is the reader. */
export const TEAM_FILE = '.cograph/tour.json';
export const ANNOTATIONS_FILE = '.cograph/annotations/annotations.json';

const ZERO = /^0+$/;
const IS_BLOB = /^(100|120)/;

/** Blob ids of a `ls-tree -r -z` listing whose path passes `keep`. */
function blobsOfTree(listing: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of listing.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0 || !IS_BLOB.test(entry) || !keep(entry.slice(tab + 1))) { continue; }
    out.push(entry.slice(entry.lastIndexOf(' ', tab) + 1, tab));
  }
  return out;
}

/** Both sides' blobs of a `diff --raw -z --no-abbrev`: `:<mode> <mode> <oid> <oid> <status>`, NUL, path. */
function blobsOfChange(raw: string): string[] {
  const out: string[] = [];
  for (const field of raw.split('\0')) {
    const m = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) /.exec(field);
    if (!m) { continue; }
    if (IS_BLOB.test(m[1]) && !ZERO.test(m[3])) { out.push(m[3]); }
    if (IS_BLOB.test(m[2]) && !ZERO.test(m[4])) { out.push(m[4]); }
  }
  return out;
}

async function wantedBlobs(run: GitRun, head: string, mergeBase: string | null, tip: string | null): Promise<Set<string>> {
  const wanted = new Set<string>();
  for (const sha of mergeBase ? [head, mergeBase] : [head]) {
    const tree = await run(['ls-tree', '-r', '-z', sha], { timeoutMs: 120_000 });
    if (tree.code === 0) { for (const oid of blobsOfTree(tree.stdout, analyzerKeepsPath)) { wanted.add(oid); } }
  }
  if (mergeBase) {
    const change = await run(['diff', '--raw', '--no-renames', '--no-abbrev', '-z', mergeBase, head], { timeoutMs: 60_000 });
    if (change.code === 0) { for (const oid of blobsOfChange(change.stdout)) { wanted.add(oid); } }
  }
  if (tip) {
    const team = await run(['ls-tree', '-r', '-z', tip, '--', TEAM_FILE, ANNOTATIONS_FILE]);
    if (team.code === 0) { for (const oid of blobsOfTree(team.stdout, () => true)) { wanted.add(oid); } }
  }
  return wanted;
}

/** The remote blobs come from, or null when this is no partial clone. Git marks one in either of two ways, by version. */
async function promisorRemote(run: GitRun): Promise<string | null> {
  const config = await run(['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$']);
  for (const line of config.code === 0 ? config.stdout.split('\n') : []) {
    const [key, value] = [line.slice(0, line.lastIndexOf(' ')), line.slice(line.lastIndexOf(' ') + 1)];
    if (key === 'extensions.partialclone' && value) { return value; }
    const remote = /^remote\.(.+)\.promisor$/.exec(key);
    if (remote && value === 'true') { return remote[1]; }
  }
  return null;
}

/**
 * Bring what `build` will read; false when git said no. A clone that is not partial costs one
 * `git config`. The lazy fetch is off for the look at what is missing, or that look would fetch it.
 */
export async function fetchMissingBlobs(run: GitRun, head: string, mergeBase: string | null, tip: string | null, log: (line: string) => void): Promise<boolean> {
  const promisor = await promisorRemote(run);
  if (!promisor) { return true; }
  const wanted = await wantedBlobs(run, head, mergeBase, tip);
  const check = await run(['cat-file', '--batch-check'], { stdin: [...wanted].map(oid => `${oid}\n`).join(''), env: { GIT_NO_LAZY_FETCH: '1' }, timeoutMs: 120_000 });
  if (check.code !== 0) { return false; }
  const missing = check.stdout.split('\n').filter(l => l.endsWith(' missing')).map(l => l.split(' ')[0]);
  if (!missing.length) { return true; }
  log(`[ci] partial clone: fetching ${missing.length} of ${wanted.size} blobs from ${promisor}`);
  // What git runs for one lazy fetch, with every id at once.
  const fetched = await run(
    ['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', '--filter=blob:none', '--stdin', '--', promisor],
    { stdin: missing.map(oid => `${oid}\n`).join(''), timeoutMs: 240_000 },
  );
  return fetched.code === 0;
}
