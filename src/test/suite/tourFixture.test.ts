import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'tour-fixture.mjs');
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x', GIT_TERMINAL_PROMPT: '0' };

function sh(cwd: string, args: string[]): string {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}

suite('scripts/tour-fixture.mjs — a branch fixture recorded from plain Node', () => {
  let root: string;
  let work: string;

  suiteSetup(function () {
    try { sh(os.tmpdir(), ['--version']); } catch { this.skip(); }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-fixture-'));
    const origin = path.join(root, 'origin.git');
    fs.mkdirSync(origin);
    sh(origin, ['init', '--bare', '--quiet', '-b', 'main']);
    work = path.join(root, 'work');
    fs.mkdirSync(path.join(work, 'src'), { recursive: true });
    sh(work, ['init', '--quiet', '-b', 'main']);
    fs.writeFileSync(path.join(work, 'src', 'a.ts'), 'export function a() { b(); }\nexport function b() {}\n');
    sh(work, ['add', '-A']);
    sh(work, ['commit', '--quiet', '-m', 'base']);
    sh(work, ['remote', 'add', 'origin', origin]);
    sh(work, ['push', '--quiet', 'origin', 'main']);
    sh(work, ['checkout', '--quiet', '-b', 'feat/y']);
    fs.writeFileSync(path.join(work, 'src', 'a.ts'), 'export function a() { c(); }\nexport function c() {}\n');
    sh(work, ['commit', '--quiet', '-am', 'swap b for c']);
  });
  suiteTeardown(() => { if (root) { fs.rmSync(root, { recursive: true, force: true }); } });

  test('writes <name>.json with every copy path rewritten, copies both trees, and leaves the refs as they were', function () {
    this.timeout(60_000);
    sh(work, ['update-ref', 'refs/cograph/base/main', 'HEAD~1']);
    const before = sh(work, ['for-each-ref', 'refs/cograph/']);
    const out = path.join(root, 'out');
    const stdout = cp.execFileSync(process.execPath, [SCRIPT, 'feat/y', out], {
      cwd: work, encoding: 'utf8', env: { ...GIT_ENV, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.match(stdout, /^branch-feat-y: head [0-9a-f]{7} base [0-9a-f]{7} · 1 commits · 1 paths · \+1 ~1 -1 functions/);
    const json = fs.readFileSync(path.join(out, 'branch-feat-y.json'), 'utf8');
    assert.ok(!json.includes(root), 'no absolute path of this machine');
    const trees = JSON.parse(json);
    assert.deepStrictEqual([trees.repoRoot, trees.head.dir, trees.base.dir], ['fixtures/trees/branch-feat-y', 'fixtures/trees/branch-feat-y/head', 'fixtures/trees/branch-feat-y/base']);
    assert.ok(trees.head.graph.nodes.every((n: { file: string | null }) => !n.file || n.file.startsWith('fixtures/trees/branch-feat-y/head/')));
    assert.deepStrictEqual(trees.target, { kind: 'branch', branch: 'feat/y', baseRef: 'main' });
    assert.ok(fs.readFileSync(path.join(out, 'branch-feat-y', 'head', 'src', 'a.ts'), 'utf8').includes('c()'));
    assert.ok(fs.readFileSync(path.join(out, 'branch-feat-y', 'base', 'src', 'a.ts'), 'utf8').includes('b()'));
    assert.ok(!fs.existsSync(path.join(out, 'branch-feat-y', 'head', '.cograph')), 'no analysis cache in the fixture');
    assert.ok(!fs.existsSync(path.join(out, 'branch-feat-y', 'head', '.cograph-tree.json')), 'no tree marker in the fixture');
    assert.strictEqual(sh(work, ['for-each-ref', 'refs/cograph/']), before, 'a ref that existed before is put back, none is left behind');
  });

  test('a branch that is not checked out is refused with one sentence', () => {
    const res = cp.spawnSync(process.execPath, [SCRIPT, 'main', path.join(root, 'out2')], { cwd: work, encoding: 'utf8', env: { ...GIT_ENV, ELECTRON_RUN_AS_NODE: '1' } });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /Check out main first/);
  });
});
