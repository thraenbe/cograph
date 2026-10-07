import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultExec } from '../../vcs/ghCliSource';
import type { Exec, ExecResult } from '../../vcs/ghCliSource';
import {
  DEFAULT_BUDGET, HeadTreeError, analyzerKeepsPath, branchRef, branchRefs, clearRepoRefs, clearTrees, evictTrees, fetchBranch,
  fetchPullRequestHead, githubRemote, listTrees, materializeCommit, mergeBase, pullRequestRef, pullRequestRefs, repoKey, treeDir,
} from '../../vcs/engine/headTree';
import type { HeadTreeDeps, TreeMarker } from '../../vcs/engine/headTree';
import { analyzeTree, relPath } from '../../vcs/engine/treeAnalysis';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');

function sh(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}
const GIT_ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };

/** Source files in four languages, plus files the graph never shows. */
const BASE_FILES: Record<string, string> = {
  'src/app.ts': 'import { helper } from "./util";\nexport function main() { helper(); other(); }\nexport function other() {}\n',
  'src/util.ts': 'export function helper() { return 1; }\n',
  'web/page.js': 'function render() { paint(); }\nfunction paint() {}\nmodule.exports = { render };\n',
  'py/tool.py': 'def run():\n    step()\n\ndef step():\n    pass\n',
  'java/App.java': 'public class App {\n  public void start() { work(); }\n  void work() {}\n}\n',
  'cpp/main.cpp': '#include "lib.h"\nint helper() { return 1; }\nint main() { return helper(); }\n',
  'cpp/lib.h': 'int helper();\n',
  'README.md': '# demo\n',
  'package.json': '{ "name": "demo", "workspaces": ["packages/*"] }\n',
  'tsconfig.json': '{ "compilerOptions": { "paths": { "@u/*": ["src/*"] } } }\n',
  'types/api.d.ts': 'export declare function x(): void;\n',
  'build/gen.ts': 'export function generated() {}\n',
};

/** A bare "origin" with main, a PR branch exposed as refs/pull/1/head, and a clone to work in. */
function makeRepos(root: string) {
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(origin, { recursive: true });
  sh(origin, ['init', '--bare', '--quiet', '-b', 'main']);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  sh(seed, ['init', '--quiet', '-b', 'main']);
  for (const [rel, text] of Object.entries(BASE_FILES)) {
    fs.mkdirSync(path.dirname(path.join(seed, rel)), { recursive: true });
    fs.writeFileSync(path.join(seed, rel), text);
  }
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '--quiet', '-m', 'base'], GIT_ID);
  const baseSha = sh(seed, ['rev-parse', 'HEAD']);
  // The pull request: a new function in util.ts, a new file, a deleted file, a doc change.
  sh(seed, ['checkout', '--quiet', '-b', 'feature']);
  fs.writeFileSync(path.join(seed, 'src/util.ts'), 'export function helper() { return extra(); }\nexport function extra() { return 2; }\n');
  fs.writeFileSync(path.join(seed, 'src/new.ts'), 'export function fresh() {}\n');
  fs.rmSync(path.join(seed, 'web/page.js'));
  fs.writeFileSync(path.join(seed, 'README.md'), '# demo, changed\n');
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '--quiet', '-m', 'feature'], GIT_ID);
  const headSha = sh(seed, ['rev-parse', 'HEAD']);
  // main moves on after the branch point, so the merge base differs from main's tip.
  sh(seed, ['checkout', '--quiet', 'main']);
  fs.writeFileSync(path.join(seed, 'src/later.ts'), 'export function later() {}\n');
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '--quiet', '-m', 'later'], GIT_ID);
  const mainSha = sh(seed, ['rev-parse', 'HEAD']);
  sh(seed, ['push', '--quiet', origin, 'main', 'feature:refs/pull/1/head']);
  sh(root, ['clone', '--quiet', origin, work]);
  sh(work, ['remote', 'set-url', 'origin', origin]);
  return { origin, work, baseSha, headSha, mainSha };
}

/** Node ids and edges of a graph with paths made relative to `root`, so two trees compare. */
function shape(root: string, graph: { nodes: any[]; edges: any[] }) {
  const key = (n: any) => (n.isLibrary ? `lib:${n.libraryName}:${n.name}` : `${relPath(root, n.file)}::${n.name}::${n.line}`);
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const nodes = graph.nodes.map(key).sort();
  const edges = graph.edges
    .map(e => { const s = byId.get(e.source), t = byId.get(e.target); return s && t ? `${key(s)} -> ${key(t)}` : null; })
    .filter((x): x is string => !!x).sort();
  return { nodes, edges };
}

/** The real analyzer scripts, run on a directory (python only when a python3 exists). */
function runAnalyzers(dir: string): { nodes: any[]; edges: any[]; languages: string[] } {
  const nodes: any[] = []; const edges: any[] = []; const languages: string[] = [];
  const runs: Array<[string, string[]]> = [
    [process.execPath, [path.join(SCRIPTS, 'analyze_ts.js'), dir]],
    [process.execPath, [path.join(SCRIPTS, 'analyze_js.js'), dir]],
    [process.execPath, [path.join(SCRIPTS, 'analyze_java.js'), dir]],
    [process.execPath, [path.join(SCRIPTS, 'analyze_cpp.js'), dir]],
    ['python3', [path.join(SCRIPTS, 'analyze.py'), dir]],
  ];
  for (const [bin, args] of runs) {
    let out: string;
    try { out = cp.execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); } catch { continue; }
    try {
      const g = JSON.parse(out);
      nodes.push(...g.nodes); edges.push(...g.edges);
      languages.push(path.basename(args[0]));
    } catch { /* an analyzer that printed nothing usable */ }
  }
  return { nodes, edges, languages };
}

suite('vcs engine — headTree on a real repository (no network)', () => {
  let root: string;
  let repos: ReturnType<typeof makeRepos>;
  let storage: string;
  let deps: HeadTreeDeps;
  const log: string[] = [];

  suiteSetup(function () {
    try { sh(os.tmpdir(), ['--version']); } catch { this.skip(); }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-head-'));
    repos = makeRepos(root);
  });
  suiteTeardown(() => { if (root) { fs.rmSync(root, { recursive: true, force: true }); } });

  setup(() => {
    storage = fs.mkdtempSync(path.join(root, 'storage-'));
    log.length = 0;
    deps = { repoRoot: repos.work, storageDir: storage, exec: defaultExec, log: (l) => log.push(l) };
  });

  test('fetching a pull request head lands in a namespaced ref and changes nothing of the user\'s', async () => {
    const before = [sh(repos.work, ['rev-parse', 'HEAD']), sh(repos.work, ['status', '--porcelain']), sh(repos.work, ['branch', '--show-current'])];
    const sha = await fetchPullRequestHead(deps, 1);
    assert.strictEqual(sha, repos.headSha);
    assert.strictEqual(sh(repos.work, ['rev-parse', pullRequestRef(1)]), repos.headSha);
    const after = [sh(repos.work, ['rev-parse', 'HEAD']), sh(repos.work, ['status', '--porcelain']), sh(repos.work, ['branch', '--show-current'])];
    assert.deepStrictEqual(after, before);
    assert.ok(!sh(repos.work, ['branch', '--list']).includes('feature'), 'no local branch was created');
  });

  test('fetching a branch and finding the merge base', async () => {
    const main = await fetchBranch(deps, 'main');
    assert.strictEqual(main, repos.mainSha);
    assert.strictEqual(sh(repos.work, ['rev-parse', branchRef('main')]), repos.mainSha);
    const head = await fetchPullRequestHead(deps, 1);
    assert.strictEqual(await mergeBase(deps, head, main), repos.baseSha, 'the branch point, not main\'s tip');
    assert.strictEqual(await githubRemote(deps), 'origin');
  });

  test('a pull request that does not exist, and a branch name that is not one', async () => {
    await assert.rejects(fetchPullRequestHead(deps, 99), (e: HeadTreeError) => e.kind === 'no-such-ref');
    await assert.rejects(fetchBranch(deps, '--upload-pack=x'), (e: HeadTreeError) => e.kind === 'error');
    await assert.rejects(fetchBranch(deps, 'nope'), (e: HeadTreeError) => e.kind === 'no-such-ref');
  });

  test('materialising copies only the files the graph shows, without touching the real index', async () => {
    const indexBefore = fs.statSync(path.join(repos.work, '.git', 'index')).mtimeMs;
    const sha = await fetchPullRequestHead(deps, 1);
    const tree = await materializeCommit(deps, sha);
    assert.strictEqual(tree.dir, treeDir(deps, sha));
    assert.strictEqual(tree.reused, false);
    const copied: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { walk(p); } else { copied.push(relPath(tree.dir, p) as string); } } };
    walk(tree.dir);
    assert.deepStrictEqual(copied.filter(p => !p.startsWith('.')).sort(),
      ['build/gen.ts', 'cpp/lib.h', 'cpp/main.cpp', 'java/App.java', 'py/tool.py', 'src/app.ts', 'src/new.ts', 'src/util.ts'],
      'the PR head: new.ts present, page.js gone, no README / package.json / d.ts; build/gen.ts stays because the TS analyzer parses it');
    assert.strictEqual(tree.files, 8);
    assert.ok(tree.bytes > 0);
    assert.strictEqual(fs.readFileSync(path.join(tree.dir, 'src/util.ts'), 'utf8').includes('extra()'), true, 'the head\'s content, not the checkout\'s');
    assert.strictEqual(fs.statSync(path.join(repos.work, '.git', 'index')).mtimeMs, indexBefore, 'the user\'s index was not written');
    assert.strictEqual(sh(repos.work, ['status', '--porcelain']), '');
    assert.strictEqual(fs.readdirSync(path.dirname(tree.dir)).filter(n => n.startsWith('.index-')).length, 0, 'the temporary index is gone');
  });

  test('a copy that was written to is never reused: an editor save into the tree discards it', async () => {
    const sha = await fetchPullRequestHead(deps, 1);
    const first = await materializeCommit({ ...deps, now: () => 1000 }, sha);
    // The analysis cache the panel writes under the copy is not a modification.
    fs.mkdirSync(path.join(first.dir, '.cograph'), { recursive: true });
    fs.writeFileSync(path.join(first.dir, '.cograph', 'cache.json'), '{}');
    assert.strictEqual((await materializeCommit(deps, sha)).reused, true);
    // Someone saved into the copy, as if it were their file.
    const edited = path.join(first.dir, 'src', 'util.ts');
    fs.writeFileSync(edited, fs.readFileSync(edited, 'utf8') + '\nexport function sneaked() {}\n');
    const again = await materializeCommit({ ...deps, now: () => 3000 }, sha);
    assert.strictEqual(again.reused, false, 'discarded and copied afresh');
    assert.ok(!fs.readFileSync(edited, 'utf8').includes('sneaked'), 'the edit is gone from the copy');
    assert.ok(!fs.existsSync(path.join(first.dir, '.cograph')), 'and so is the cache built on it');
    assert.ok(log.some(l => l.includes('was modified since it was copied')));
    // A marker from before fingerprints never passes either.
    const marker = JSON.parse(fs.readFileSync(path.join(first.dir, '.cograph-tree.json'), 'utf8'));
    delete marker.fingerprint;
    fs.writeFileSync(path.join(first.dir, '.cograph-tree.json'), JSON.stringify(marker));
    assert.strictEqual((await materializeCommit(deps, sha)).reused, false);
  });

  test('a second request reuses the copy; a copy without its marker is made again', async () => {
    const sha = await fetchPullRequestHead(deps, 1);
    const first = await materializeCommit({ ...deps, now: () => 1000 }, sha);
    const again = await materializeCommit({ ...deps, now: () => 2000 }, sha);
    assert.deepStrictEqual([again.reused, again.dir, again.files], [true, first.dir, first.files]);
    const marker = JSON.parse(fs.readFileSync(path.join(first.dir, '.cograph-tree.json'), 'utf8')) as TreeMarker;
    assert.deepStrictEqual([marker.createdAt, marker.lastUsedAt, marker.sha], [1000, 2000, sha]);
    fs.rmSync(path.join(first.dir, '.cograph-tree.json'));
    fs.writeFileSync(path.join(first.dir, 'src', 'util.ts'), 'garbage');
    const remade = await materializeCommit(deps, sha);
    assert.strictEqual(remade.reused, false);
    assert.ok(fs.readFileSync(path.join(first.dir, 'src', 'util.ts'), 'utf8').includes('extra()'));
  });

  test('REGRESSION: the copy analyses exactly like a full checkout of the same commit, in every language', async function () {
    this.timeout(60_000);
    const sha = await fetchPullRequestHead(deps, 1);
    const tree = await materializeCommit(deps, sha);
    // A full checkout of the same commit, with every non-source file in place.
    const full = path.join(root, 'full-checkout');
    sh(root, ['clone', '--quiet', repos.origin, full]);
    sh(full, ['checkout', '--quiet', sha]);
    const fromCopy = runAnalyzers(tree.dir);
    const fromFull = runAnalyzers(full);
    assert.ok(fromCopy.languages.length >= 4, `analyzers ran: ${fromCopy.languages.join(', ')}`);
    assert.deepStrictEqual(fromCopy.languages, fromFull.languages);
    const a = shape(tree.dir, fromCopy);
    const b = shape(full, fromFull);
    assert.ok(a.nodes.length >= 10, `enough nodes to mean something: ${a.nodes.length}`);
    assert.deepStrictEqual(a.nodes, b.nodes, 'every function of the full checkout, and no other');
    assert.deepStrictEqual(a.edges, b.edges, 'every call edge of the full checkout, and no other');
    assert.ok(a.edges.some(e => e.includes('src/util.ts::helper') && e.includes('::extra')), 'the head\'s new call is there');
    assert.ok(a.nodes.some(n => n.startsWith('build/gen.ts')), 'what the analyzers walk in a checkout, they walk in the copy');
  });

  test('a tree remembers the refs that brought it; eviction deletes a ref only while it still points at that commit', async () => {
    const head = await fetchPullRequestHead(deps, 1);
    const tip = await fetchBranch(deps, 'main');
    const base = await mergeBase(deps, head, tip);
    await materializeCommit({ ...deps, now: () => 1 }, head, pullRequestRefs(1, head));
    await materializeCommit({ ...deps, now: () => 2 }, base, branchRefs('main', tip));
    assert.strictEqual(sh(repos.work, ['rev-parse', pullRequestRef(1)]), head);
    assert.strictEqual(sh(repos.work, ['rev-parse', branchRef('main')]), tip);
    // Budget 0: everything goes, and so do both refs — nothing keeps the fetched objects alive.
    const removed = await evictTrees(storage, { maxTrees: 0, maxBytes: 0 }, [], defaultExec);
    assert.deepStrictEqual(removed.map(t => t.marker.sha).sort(), [base, head].sort());
    assert.strictEqual(sh(repos.work, ['for-each-ref', 'refs/cograph/']), '', 'no refs/cograph/* left');
    assert.strictEqual(sh(repos.work, ['status', '--porcelain']), '');
    assert.strictEqual(sh(repos.work, ['branch', '--show-current']), 'main', 'the user\'s checkout is as it was');
  });

  test('a ref re-pointed by a newer fetch survives the eviction of the old tree', async () => {
    const head = await fetchPullRequestHead(deps, 1);
    await materializeCommit({ ...deps, now: () => 1 }, head, pullRequestRefs(1, head));
    // The PR was re-pushed: the same ref now points elsewhere (here: at main's tip).
    sh(repos.work, ['update-ref', pullRequestRef(1), repos.mainSha]);
    const removed = await evictTrees(storage, { maxTrees: 0, maxBytes: 0 }, [], defaultExec);
    assert.strictEqual(removed.length, 1);
    assert.strictEqual(sh(repos.work, ['rev-parse', pullRequestRef(1)]), repos.mainSha, 'the ref of the NEWER head was not touched');
    assert.deepStrictEqual(await clearRepoRefs(repos.work, defaultExec), [pullRequestRef(1)]);
    assert.strictEqual(sh(repos.work, ['for-each-ref', 'refs/cograph/']), '');
    assert.deepStrictEqual(await clearRepoRefs(repos.work, defaultExec), []);
  });

  test('clearing the store deletes the trees and the refs they were fetched through', async () => {
    const head = await fetchPullRequestHead(deps, 1);
    await materializeCommit(deps, head, pullRequestRefs(1, head));
    const cleared = await clearTrees(storage, defaultExec);
    assert.ok(cleared.trees === 1 && cleared.bytes > 0 && !fs.existsSync(storage));
    assert.strictEqual(sh(repos.work, ['for-each-ref', 'refs/cograph/']), '');
  });

  test('a cancel mid-copy leaves no directory, no marker and no temporary index; the next open copies afresh', async () => {
    const sha = await fetchPullRequestHead(deps, 1);
    const ac = new AbortController();
    // Cancel while checkout-index runs: the real git is used, the signal flips during the call.
    const exec: Exec = (cmd, args, cwd, opts) => {
      if (args[0] === 'checkout-index') { ac.abort(); }
      return defaultExec(cmd, args, cwd, opts);
    };
    await assert.rejects(materializeCommit({ ...deps, exec, signal: ac.signal }, sha), (e: HeadTreeError) => e.kind === 'cancelled');
    const dir = treeDir(deps, sha);
    assert.ok(!fs.existsSync(dir), 'the half copy is gone');
    assert.deepStrictEqual(listTrees(storage), [], 'nothing counts against the budget');
    assert.strictEqual(fs.readdirSync(path.dirname(dir)).filter(n => n.startsWith('.index-')).length, 0);
    const whole = await materializeCommit(deps, sha);
    assert.deepStrictEqual([whole.reused, whole.files], [false, 8], 'made again, from scratch');
  });

  test('a git failure mid-copy is cleaned up the same way and named', async () => {
    const sha = await fetchPullRequestHead(deps, 1);
    const exec: Exec = async (cmd, args, cwd, opts) => args[0] === 'checkout-index'
      ? { code: 128, stdout: '', stderr: 'fatal: disk full', notFound: false }
      : defaultExec(cmd, args, cwd, opts);
    await assert.rejects(materializeCommit({ ...deps, exec }, sha), (e: HeadTreeError) => e.kind === 'fetch-failed' && e.detail === 'fatal: disk full');
    assert.ok(!fs.existsSync(treeDir(deps, sha)));
    assert.deepStrictEqual(listTrees(storage), []);
  });

  test('a cancel is never reported as a git failure, and git is not started after it', async () => {
    const ac = new AbortController();
    const started: string[] = [];
    const exec: Exec = async (_c, args) => { started.push(args[0]); ac.abort(); return { code: 128, stdout: '', stderr: 'fatal: killed', notFound: false }; };
    await assert.rejects(fetchPullRequestHead({ ...deps, exec, signal: ac.signal }, 1), (e: HeadTreeError) => e.kind === 'cancelled');
    assert.deepStrictEqual(started, ['fetch'], 'rev-parse never ran');
  });

  test('analyzeTree gives the structure tree and the graph of a directory through the injected analyzer', async () => {
    const sha = await fetchPullRequestHead(deps, 1);
    const tree = await materializeCommit(deps, sha);
    const seen: string[] = [];
    const analyzed = await analyzeTree(tree.dir, async (dir) => { seen.push(dir); return { nodes: [], edges: [] }; }, sha);
    assert.deepStrictEqual(seen, [tree.dir]);
    assert.deepStrictEqual([analyzed.root, analyzed.sha, analyzed.tree.totalFiles, analyzed.graph.nodes.length], [tree.dir, sha, 7, 0],
      'the structure tree skips build/, as it does in the workspace');
    assert.strictEqual(relPath(tree.dir, path.join(tree.dir, 'src', 'a.ts')), 'src/a.ts');
    assert.strictEqual(relPath(tree.dir, path.join(root, 'elsewhere')), null);
  });
});

suite('vcs engine — headTree budget and failures', () => {
  let storage: string;
  const key = repoKey('/some/repo');

  function fakeTree(sha: string, bytes: number, lastUsedAt: number): string {
    const dir = path.join(storage, key, sha);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.ts'), 'x'.repeat(bytes));
    const marker: TreeMarker = { sha, repoRoot: '/some/repo', files: 1, bytes, createdAt: lastUsedAt, lastUsedAt };
    fs.writeFileSync(path.join(dir, '.cograph-tree.json'), JSON.stringify(marker));
    return dir;
  }

  setup(() => { storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-budget-')); });
  teardown(() => fs.rmSync(storage, { recursive: true, force: true }));

  test('the copy rule is each analyzer\'s own walk, not the structure scanner\'s stricter one', () => {
    assert.strictEqual(analyzerKeepsPath('src/a.ts'), true);
    assert.strictEqual(analyzerKeepsPath('build/gen.ts'), true, 'the TS analyzer walks build/');
    assert.strictEqual(analyzerKeepsPath('build/App.java'), false, 'the Java analyzer does not');
    assert.strictEqual(analyzerKeepsPath('target/x.py'), true);
    assert.strictEqual(analyzerKeepsPath('dist/bundle.js'), false);
    assert.strictEqual(analyzerKeepsPath('out/a.cpp'), false);
    assert.strictEqual(analyzerKeepsPath('CMakeFiles/a.cpp'), false);
    assert.strictEqual(analyzerKeepsPath('cmake-build-debug/a.cpp'), false, 'the C++ analyzer skips cmake-build-* too');
    assert.strictEqual(analyzerKeepsPath('cmake-build-debug/a.ts'), true);
    assert.strictEqual(analyzerKeepsPath('pkg/__pycache__/a.py'), false);
    assert.strictEqual(analyzerKeepsPath('.github/a.py'), false);
    assert.strictEqual(analyzerKeepsPath('node_modules/x/a.js'), false);
    assert.strictEqual(analyzerKeepsPath('types/a.d.ts'), false);
    assert.strictEqual(analyzerKeepsPath('README.md'), false);
    assert.strictEqual(analyzerKeepsPath(''), false);
  });

  test('repository keys are stable across separators and case, and short', () => {
    assert.strictEqual(repoKey('/a/b/'), repoKey('/a/b'));
    assert.strictEqual(repoKey('C:\\Repo\\X'), repoKey('c:/repo/x'));
    assert.notStrictEqual(repoKey('/a/b'), repoKey('/a/c'));
    assert.strictEqual(repoKey('/a/b').length, 12);
  });

  test('eviction drops the least recently used until count and bytes fit, keeps protected trees, sweeps leftovers', async () => {
    const dirs = ['a', 'b', 'c', 'd'].map((n, i) => fakeTree(n.repeat(40), 100, i + 1)); // a is the oldest
    fs.mkdirSync(path.join(storage, key, 'e'.repeat(40)));                          // half-written: no marker
    fs.writeFileSync(path.join(storage, key, '.index-stale'), '');
    const removed = await evictTrees(storage, { maxTrees: 2, maxBytes: 1000 }, [dirs[0]]);
    assert.deepStrictEqual(removed.map(t => t.marker.sha[0]), ['b', 'c'], 'oldest first, the protected one skipped');
    assert.deepStrictEqual(listTrees(storage).map(t => t.marker.sha[0]).sort(), ['a', 'd']);
    assert.ok(!fs.existsSync(path.join(storage, key, 'e'.repeat(40))));
    assert.ok(!fs.existsSync(path.join(storage, key, '.index-stale')));
    const byBytes = await evictTrees(storage, { maxTrees: 10, maxBytes: 150 });
    assert.deepStrictEqual(byBytes.map(t => t.marker.sha[0]), ['a'], 'now the byte limit bites');
  });

  test('defaults, listing an empty store, clearing', async () => {
    assert.deepStrictEqual(DEFAULT_BUDGET, { maxTrees: 6, maxBytes: 400 * 1024 * 1024 });
    assert.deepStrictEqual(listTrees(path.join(storage, 'nope')), []);
    assert.deepStrictEqual(await evictTrees(path.join(storage, 'nope')), []);
    fakeTree('f'.repeat(40), 50, 1);
    assert.deepStrictEqual(await clearTrees(storage), { trees: 1, bytes: 50 });
    assert.ok(!fs.existsSync(storage));
  });

  test('git failures become named problems', async () => {
    const answer = (res: Partial<ExecResult>): Exec => async () => ({ code: 128, stdout: '', stderr: '', notFound: false, ...res });
    const deps = (exec: Exec): HeadTreeDeps => ({ repoRoot: '/r', storageDir: storage, exec });
    const kind = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return (e as HeadTreeError).kind; } };
    assert.strictEqual(await kind(fetchPullRequestHead(deps(answer({ notFound: true })), 1)), 'git-missing');
    assert.strictEqual(await kind(fetchPullRequestHead(deps(answer({ stderr: 'fatal: not a git repository' })), 1)), 'not-a-repo');
    assert.strictEqual(await kind(fetchPullRequestHead(deps(answer({ stderr: "fatal: 'origin' does not appear to be a git repository" })), 1)), 'no-remote');
    assert.strictEqual(await kind(fetchPullRequestHead(deps(answer({ stderr: 'fatal: unable to access: Could not resolve host: github.com' })), 1)), 'offline');
    assert.strictEqual(await kind(fetchPullRequestHead(deps(answer({ stderr: "fatal: couldn't find remote ref refs/pull/1/head" })), 1)), 'no-such-ref');
    assert.strictEqual(await kind(fetchPullRequestHead(deps(answer({ stderr: 'ERROR: Repository not found.' })), 1)), 'fetch-failed');
    assert.strictEqual(await kind(fetchPullRequestHead(deps(answer({ stderr: 'something else' })), 1)), 'fetch-failed');
    assert.strictEqual(await kind(fetchPullRequestHead(deps(answer({})), 0)), 'error');
    assert.strictEqual(await kind(materializeCommit(deps(answer({})), 'not-a-sha')), 'error');
    const aborted = new AbortController(); aborted.abort();
    assert.strictEqual(await kind(fetchPullRequestHead({ ...deps(answer({})), signal: aborted.signal }, 1)), 'cancelled');
  });
});
