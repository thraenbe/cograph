import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnAnalyzers } from '../../analyzerSpawn';
import { defaultExec } from '../../vcs/ghCliSource';
import type { Exec } from '../../vcs/ghCliSource';
import { HeadTreeError } from '../../vcs/engine/headTree';
import type { HeadTreeDeps } from '../../vcs/engine/headTree';
import {
  baseTip, commitsAhead, headOf, isDirty, listCommits, parseNameStatus, prepareBranch, resolveBaseRef,
} from '../../vcs/engine/localBranch';
import { relPath } from '../../vcs/engine/treeAnalysis';
import { scanStructure } from '../../structureScanner';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
const GIT_ID = { GIT_AUTHOR_NAME: 'Ada Tester', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };

function sh(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

/**
 * origin (bare, main), a clone with a local branch `feat/x` two commits ahead of
 * the branch point, and main moved on in origin after the branch point, so the
 * merge base is not main's tip.
 */
function makeRepos(root: string) {
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(origin);
  sh(origin, ['init', '--bare', '--quiet', '-b', 'main']);
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  sh(work, ['init', '--quiet', '-b', 'main']);
  write(work, {
    'src/app.ts': 'import { helper } from "./util";\nexport function main() { helper(); }\n',
    'src/util.ts': 'export function helper() { return 1; }\n',
    'src/old.ts': 'export function gone() {}\n',
    'py/tool.py': 'def run():\n    step()\n\ndef step():\n    pass\n',
    'docs/guide.md': '# guide\n',
    'build/gen.ts': 'export function generated() {}\n',
  });
  sh(work, ['add', '-A']);
  sh(work, ['commit', '--quiet', '-m', 'base'], GIT_ID);
  const branchPoint = sh(work, ['rev-parse', 'HEAD']);
  sh(work, ['remote', 'add', 'origin', origin]);
  sh(work, ['push', '--quiet', 'origin', 'main']);
  sh(work, ['remote', 'set-head', 'origin', 'main']);
  sh(work, ['checkout', '--quiet', '-b', 'feat/x']);
  write(work, { 'src/util.ts': 'export function helper() { return extra(); }\nexport function extra() { return 2; }\n' });
  sh(work, ['add', '-A']);
  sh(work, ['commit', '--quiet', '-m', 'add extra', '-m', 'Body line one.\n\nBody after a blank — with unicode ✓.'], GIT_ID);
  sh(work, ['mv', 'docs/guide.md', 'docs/handbook.md']);
  fs.rmSync(path.join(work, 'src/old.ts'));
  write(work, { 'src/new.ts': 'export function fresh() {}\n', 'package.json': '{ "name": "demo" }\n' });
  sh(work, ['add', '-A']);
  sh(work, ['commit', '--quiet', '-m', 'second'], GIT_ID);
  const head = sh(work, ['rev-parse', 'HEAD']);
  // main moves on in origin, after the branch point, from another clone.
  const other = path.join(root, 'other');
  sh(root, ['clone', '--quiet', origin, other]);
  write(other, { 'src/later.ts': 'export function later() {}\n' });
  sh(other, ['add', '-A']);
  sh(other, ['commit', '--quiet', '-m', 'later'], GIT_ID);
  sh(other, ['push', '--quiet', 'origin', 'main']);
  const mainTip = sh(other, ['rev-parse', 'HEAD']);
  return { origin, work, branchPoint, head, mainTip };
}

/** defaultExec, with `gh` answered by the test. */
function withGh(gh: (args: string[]) => { code: number; stdout: string; stderr?: string }): Exec {
  return async (command, args, cwd, opts) => {
    if (command === 'gh') { const r = gh(args); return { code: r.code, stdout: r.stdout, stderr: r.stderr ?? '', notFound: false }; }
    return defaultExec(command, args, cwd, opts);
  };
}

suite('vcs engine — localBranch on real repositories (no network)', () => {
  let root: string;
  let repos: ReturnType<typeof makeRepos>;
  let storage: string;
  let deps: HeadTreeDeps;
  const log: string[] = [];

  suiteSetup(function () {
    try { sh(os.tmpdir(), ['--version']); } catch { this.skip(); }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-branch-'));
    repos = makeRepos(root);
  });
  suiteTeardown(() => { if (root) { fs.rmSync(root, { recursive: true, force: true }); } });

  setup(() => {
    storage = fs.mkdtempSync(path.join(root, 'storage-'));
    log.length = 0;
    deps = { repoRoot: repos.work, storageDir: storage, exec: defaultExec, log: (l) => log.push(l) };
  });

  test('HEAD, its branch, and the base from origin/HEAD', async () => {
    assert.deepStrictEqual(await headOf(deps), { sha: repos.head, branch: 'feat/x' });
    assert.strictEqual(await resolveBaseRef(deps), 'main');
  });

  test('without origin/HEAD the base is gh\'s default branch, and main when gh has none', async () => {
    sh(repos.work, ['remote', 'set-head', 'origin', '--delete']);
    try {
      const seen: string[][] = [];
      const gh = withGh((args) => { seen.push(args); return { code: 0, stdout: 'trunk\n' }; });
      assert.strictEqual(await resolveBaseRef({ ...deps, exec: gh }), 'trunk');
      assert.deepStrictEqual(seen[0], ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
      assert.strictEqual(await resolveBaseRef({ ...deps, exec: withGh(() => ({ code: 1, stdout: '', stderr: 'not logged in' })) }), 'main');
      assert.strictEqual(await resolveBaseRef({ ...deps, exec: withGh(() => ({ code: 0, stdout: '--evil\n' })) }), 'main', 'an option-shaped name is never used');
    } finally {
      sh(repos.work, ['remote', 'set-head', 'origin', 'main']);
    }
  });

  test('a branch is prepared against the merge base GitHub would use, with commits, paths and both copies', async function () {
    this.timeout(30_000);
    const prepared = await prepareBranch(deps, {});
    assert.strictEqual(prepared.branch, 'feat/x');
    assert.strictEqual(prepared.baseRef, 'main');
    assert.strictEqual(prepared.head.sha, repos.head);
    assert.strictEqual(prepared.base?.sha, repos.branchPoint, 'the merge base, not main\'s moved-on tip');
    assert.ok(sh(repos.work, ['rev-parse', 'refs/cograph/base/main']) === repos.mainTip, 'the base tip was fetched');
    assert.deepStrictEqual(prepared.commits.map(c => c.subject), ['add extra', 'second']);
    assert.deepStrictEqual(prepared.commits[0].body, 'Body line one.\n\nBody after a blank — with unicode ✓.');
    assert.strictEqual(prepared.commits[0].author, 'Ada Tester');
    assert.match(prepared.commits[0].date, /^\d{4}-\d\d-\d\dT/);
    const byPath = Object.fromEntries(prepared.changedPaths.map(p => [p.path, p]));
    assert.deepStrictEqual(byPath['src/util.ts'], { path: 'src/util.ts', status: 'modified', analysable: true });
    assert.deepStrictEqual(byPath['src/new.ts'], { path: 'src/new.ts', status: 'added', analysable: true });
    assert.deepStrictEqual(byPath['src/old.ts'], { path: 'src/old.ts', status: 'deleted', analysable: true });
    assert.deepStrictEqual(byPath['docs/handbook.md'], { path: 'docs/handbook.md', status: 'renamed', previousPath: 'docs/guide.md', analysable: false });
    assert.strictEqual(byPath['package.json'].analysable, false);
    assert.ok(!byPath['src/later.ts'], 'main\'s later commit is not the branch\'s change');
    assert.ok(prepared.head.files.includes('package.json'), 'files lists every file of the commit');
    assert.ok(!fs.existsSync(path.join(prepared.head.dir, 'package.json')), 'the copy holds source files only');
    assert.ok(fs.existsSync(path.join(prepared.base!.dir, 'src', 'old.ts')));
    assert.ok(prepared.base!.files.includes('docs/guide.md'));
    assert.strictEqual(prepared.dirty, false);
    assert.strictEqual(sh(repos.work, ['branch', '--show-current']), 'feat/x', 'the checkout is untouched');
    assert.strictEqual(sh(repos.work, ['status', '--porcelain']), '');
  });

  test('REGRESSION: the head copy scans and analyses exactly like the checkout it came from', async function () {
    this.timeout(60_000);
    const prepared = await prepareBranch(deps, {});
    const scanRel = (dir: string) => scanStructure(dir).files.map(f => relPath(dir, f.path)).sort();
    assert.deepStrictEqual(scanRel(prepared.head.dir), scanRel(repos.work));
    const shape = async (dir: string) => {
      const { graph } = await spawnAnalyzers(dir, { scriptsDir: SCRIPTS, pythonBin: 'python3' });
      const key = (n: any) => (n.isLibrary ? `lib:${n.libraryName}:${n.name}` : `${relPath(dir, n.file)}::${n.name}::${n.line}`);
      const byId = new Map(graph.nodes.map(n => [n.id, n]));
      return {
        nodes: graph.nodes.map(key).sort(),
        edges: graph.edges.map(e => `${key(byId.get(e.source))} -> ${key(byId.get(e.target))}`).sort(),
      };
    };
    const copy = await shape(prepared.head.dir);
    const checkout = await shape(repos.work);
    assert.ok(copy.nodes.length >= 6, copy.nodes.join(','));
    assert.deepStrictEqual(copy, checkout);
    assert.ok(copy.edges.some(e => e.includes('src/util.ts::helper') && e.includes('::extra')));
  });

  test('a dirty tree is reported, untracked files included', async () => {
    fs.writeFileSync(path.join(repos.work, 'scratch.txt'), 'x');
    try { assert.strictEqual(await isDirty(deps), true); } finally { fs.rmSync(path.join(repos.work, 'scratch.txt')); }
    assert.strictEqual(await isDirty(deps), false);
  });

  test('offline, the base comes from the local branch, then from the remote-tracking ref, else there is none', async function () {
    this.timeout(30_000);
    sh(repos.work, ['remote', 'set-url', 'origin', path.join(root, 'nowhere.git')]);
    try {
      const local = await baseTip(deps, 'main');
      assert.deepStrictEqual([local?.sha, local?.via, local?.refs], [repos.branchPoint, 'local', []]);
      assert.ok(log.some(l => /\[tour\] base main not fetched/.test(l)), log.join('\n'));
      sh(repos.work, ['branch', '-m', 'main', 'main-away']);
      try {
        const tracking = await baseTip(deps, 'main');
        assert.strictEqual(tracking?.via, 'remote-tracking');
        assert.strictEqual(await baseTip(deps, 'no-such-branch'), null);
        const prepared = await prepareBranch(deps, { baseRef: 'no-such-branch' });
        assert.strictEqual(prepared.base, null);
        assert.deepStrictEqual(prepared.changedPaths, []);
        assert.ok(prepared.commits.length >= 3, 'every commit of HEAD when there is no base');
      } finally {
        sh(repos.work, ['branch', '-m', 'main-away', 'main']);
      }
    } finally {
      sh(repos.work, ['remote', 'set-url', 'origin', repos.origin]);
    }
  });

  test('a detached HEAD, the base branch itself and another branch are refused with one sentence', async () => {
    sh(repos.work, ['checkout', '--quiet', '--detach']);
    try {
      assert.strictEqual((await headOf(deps)).branch, null);
      await assert.rejects(prepareBranch(deps, {}), (e: any) => e instanceof HeadTreeError && /detached/.test(e.message));
    } finally { sh(repos.work, ['checkout', '--quiet', 'feat/x']); }
    await assert.rejects(prepareBranch(deps, { baseRef: 'feat/x' }), /is the base branch/);
    await assert.rejects(prepareBranch(deps, { branch: 'main' }), /not checked out/);
  });

  test('a cancel before git runs ends with a cancelled error and copies nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(prepareBranch({ ...deps, signal: ac.signal }, { baseRef: 'main' }), (e: any) => e instanceof HeadTreeError && e.kind === 'cancelled');
    assert.deepStrictEqual(fs.readdirSync(storage), []);
  });

  test('commitsAhead and listCommits over a range', async () => {
    assert.strictEqual(await commitsAhead(defaultExec, repos.work, repos.branchPoint), 2);
    assert.strictEqual(await commitsAhead(defaultExec, repos.work, repos.head), 0);
    assert.strictEqual(await commitsAhead(defaultExec, repos.work, 'no-such-ref'), null);
    assert.deepStrictEqual((await listCommits(deps, repos.head, repos.head)), []);
  });
});

suite('vcs engine — parseNameStatus', () => {
  test('renames, copies, odd paths and unknown letters', () => {
    const z = ['M', 'a b.ts', 'R087', 'old.py', 'new.py', 'C100', 'x.ts', 'y.ts', 'D', 'gone.md', 'T', 'link.ts', 'A', 'tab\there.ts', ''].join('\0');
    assert.deepStrictEqual(parseNameStatus(z), [
      { path: 'a b.ts', status: 'modified', analysable: true },
      { path: 'new.py', status: 'renamed', previousPath: 'old.py', analysable: true },
      { path: 'y.ts', status: 'added', analysable: true },
      { path: 'gone.md', status: 'deleted', analysable: false },
      { path: 'link.ts', status: 'modified', analysable: true },
      { path: 'tab\there.ts', status: 'added', analysable: true },
    ]);
    assert.deepStrictEqual(parseNameStatus(''), []);
    assert.deepStrictEqual(parseNameStatus('R100\0only-one\0'), [], 'a truncated record is dropped, not misread');
  });
});
