import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ensureCommits } from '../../ci/fetch';
import { createHeadlessApi } from '../../ci/headlessApi';
import type { HeadlessOptions } from '../../ci/headlessApi';
import { toolEnv } from '../../ci/toolEnv';
import { CI_MAX_FILE_BYTES, CI_MAX_OUTPUT_BYTES, analysisState, ciTarget } from '../../ci/trees';
import type { CiContext, CiTrees } from '../../ci/trees';
import { ANALYZER_SCRIPTS } from '../../analyzerSpawn';
import { clone, commit, makeOrigin, push, sh, tempDir } from '../ciRepo';
import type { Origin } from '../ciRepo';

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
const PYTHON = cp.spawnSync('python3', ['--version']).status === 0 ? 'python3' : 'python';
/** In the VS Code test host the running "node" is Electron, which needs this to act as Node. */
const ENV = { ...toolEnv(), ELECTRON_RUN_AS_NODE: '1' };

const CONTEXT: CiContext = {
  platform: 'github', repoWebUrl: 'https://github.com/o/r', fileLinkTemplate: 'https://github.com/o/r/blob/{sha}/{path}#L{line}',
  change: { id: 7, title: 'Add a thing', url: 'https://github.com/o/r/pull/7', author: 'someone', headRef: 'feature', baseRef: 'main' },
};

const PY_V1 = 'def stable():\n    return 1\n\ndef edited():\n    return 1\n';
const PY_V2 = 'def stable():\n    return 1\n\ndef edited():\n    return 2\n\ndef fresh():\n    return stable()\n';
const TS_V1 = 'export function keep(): number {\n  return 1;\n}\n';
const TS_V2 = 'export function keep(): number {\n  return 2;\n}\n';

/** A scripts folder whose analyzers run `body`, with `root` and `seen` in scope; `report(graph)` is their answer. */
function fakeScripts(root: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(root, 'scripts-'));
  const script = `(() => { const fs = require('fs'); const root = process.argv[2]; const lang = require('path').basename(process.argv[1]);
    const report = (nodes) => process.stdout.write(JSON.stringify({ nodes, edges: [], files: nodes.map(n => n.file) }));
    const fn = (name) => ({ id: root + '/a.py::' + name + '::1', name, file: root + '/a.py', line: 1 }); ${body} })();`;
  for (const { script: name } of ANALYZER_SCRIPTS) { fs.writeFileSync(path.join(dir, name), script); }
  return dir;
}

suite('ci trees: prepareCiTrees through the headless api', function () {
  this.timeout(60_000);
  let root: string;
  let origin: Origin;
  let forkPoint: string;
  let head: string;
  let tip: string;

  setup(() => {
    root = tempDir('cg-ci-trees-');
    origin = makeOrigin(root);
    forkPoint = commit(origin.work, { 'src/app.py': PY_V1, 'web/keep.ts': TS_V1, 'README.md': 'one\n' }, 'base');
    sh(origin.work, ['switch', '--quiet', '-c', 'feature']);
    head = commit(origin.work, { 'src/app.py': PY_V2, 'web/keep.ts': TS_V2, 'README.md': 'two\n' }, 'the change');
    sh(origin.work, ['switch', '--quiet', 'main']);
    tip = commit(origin.work, { 'other.py': 'def later():\n    pass\n' }, 'target moves on');
    push(origin, 'main', 'feature');
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  let n = 0;
  const options = (repoRoot: string, extra: Partial<HeadlessOptions> = {}): HeadlessOptions => ({
    repoRoot, workDir: path.join(root, `work-${n++}`), head, base: tip, configSha: tip, context: CONTEXT, scriptsDir: SCRIPTS, pythonBin: PYTHON,
    sourceMode: 'slices', log: () => undefined, env: ENV, ...extra,
  });
  const prepare = async (repoRoot: string, extra: Partial<HeadlessOptions> = {}): Promise<CiTrees> => {
    const run = createHeadlessApi(options(repoRoot, extra));
    await run.api.prepareTrees(run.target, () => undefined, new AbortController().signal);
    return run.trees();
  };
  const changes = (trees: CiTrees) => trees.diff?.functions.filter(f => f.kind !== 'moved').map(f => `${f.kind} ${f.name}`).sort();

  test('the change as a tour needs it, from the object store', async () => {
    const trees = await prepare(clone(root, origin));
    assert.strictEqual(trees.base?.sha, forkPoint, 'the merge base, not the moved target');
    assert.deepStrictEqual(changes(trees), ['added fresh', 'changed edited', 'changed keep']);
    assert.deepStrictEqual(trees.changedPaths.map(p => p.path).sort(), ['README.md', 'src/app.py', 'web/keep.ts']);
    assert.deepStrictEqual(trees.commits.map(c => c.subject), ['the change']);
    assert.deepStrictEqual([trees.prFiles, trees.checkoutBranch, trees.dirty], [null, null, false]);
    assert.deepStrictEqual(trees.target, { kind: 'pr', number: 7 });
    assert.deepStrictEqual(trees.pr, {
      number: 7, title: 'Add a thing', author: 'someone', headRef: 'feature', baseRef: 'main', headOid: head, state: 'open', isDraft: false,
      checks: 'none', changedFiles: 3, additions: 0, deletions: 0, updatedAt: '', url: 'https://github.com/o/r/pull/7',
    });
    assert.strictEqual(analysisState(trees), 'complete');
    assert.strictEqual(trees.analysisNotes, undefined);
    assert.strictEqual(trees.filesNotParsed, undefined);
    assert.ok(trees.head.dir.includes(path.join('trees')), trees.head.dir);
    assert.ok(trees.structure.files.some(f => f.path.endsWith('app.py')));
  });

  test('the working tree is never read: a checkout holding something else changes nothing', async () => {
    const planted = clone(root, origin);
    fs.writeFileSync(path.join(planted, 'src', 'app.py'), 'def planted_in_the_working_tree():\n    pass\n');
    fs.writeFileSync(path.join(planted, 'planted.py'), 'def planted_too():\n    pass\n');
    const trees = await prepare(planted);
    const names = trees.head.graph.nodes.map(x => x.name);
    assert.ok(!names.includes('planted_in_the_working_tree') && !names.includes('planted_too'), names.join(','));
    assert.deepStrictEqual(changes(trees), ['added fresh', 'changed edited', 'changed keep']);
  });

  test('`--base` may be the target tip or the merge base: one tour either way', async () => {
    const repo = clone(root, origin);
    const atTip = await prepare(repo, { base: tip });
    const atFork = await prepare(repo, { base: forkPoint });
    assert.strictEqual(atFork.base?.sha, atTip.base?.sha);
    assert.deepStrictEqual(changes(atFork), changes(atTip));
  });

  test('no base: a head-only tour, with the graph and no diff', async () => {
    const trees = await prepare(clone(root, origin), { base: null });
    assert.deepStrictEqual([trees.base, trees.diff, trees.changedPaths], [null, null, []]);
    assert.ok(trees.head.graph.nodes.some(x => x.name === 'fresh'));
    assert.ok(trees.commits.length >= 2, 'the newest commits of head stand in');
  });

  test('REGRESSION: an unrelated base is a head-only tour, never a diff against the tip', async () => {
    sh(origin.work, ['switch', '--quiet', '--orphan', 'island']);
    const lone = commit(origin.work, { 'lone.py': 'def lone():\n    pass\n' }, 'island');
    sh(origin.work, ['switch', '--quiet', 'main']);
    push(origin, 'island');
    const trees = await prepare(clone(root, origin), { head: lone });
    assert.deepStrictEqual([trees.base, trees.diff], [null, null], 'everything the base has would show as removed');
  });

  test('no context: a tour of the commit, no pull request invented', async () => {
    const trees = await prepare(clone(root, origin), { context: null });
    assert.deepStrictEqual([trees.pr, trees.target], [null, { kind: 'branch' }]);
  });

  test('a change whose id is no number is toured as its branch', () => {
    const context = { ...CONTEXT, change: { ...CONTEXT.change, id: 'abc' } };
    assert.deepStrictEqual(ciTarget(context), { kind: 'branch', branch: 'feature', baseRef: 'main' });
    assert.deepStrictEqual(ciTarget({ ...CONTEXT, change: { ...CONTEXT.change, id: '12' } }), { kind: 'pr', number: 12 });
  });

  suite('the integrity rule', () => {
    test('REGRESSION: no Python on the runner is partial, with a sentence, not a clean-looking tour', async () => {
      const trees = await prepare(clone(root, origin), { pythonBin: null });
      assert.strictEqual(analysisState(trees), 'partial');
      assert.deepStrictEqual(trees.analysisNotes, ['Python is missing from this tour: its analyzer could not start on this runner. Its functions are left out of the map and the diff.']);
      assert.deepStrictEqual(changes(trees), ['changed keep'], 'the other languages stay');
    });

    test('no Python and a tree with none: nothing is missing', async () => {
      const web = commit(origin.work, { 'src/app.py': null, 'other.py': null }, 'no python here');
      push(origin, 'main');
      const trees = await prepare(clone(root, origin), { pythonBin: null, head: web, base: null });
      assert.strictEqual(analysisState(trees), 'complete');
      assert.strictEqual(trees.analysisNotes, undefined);
    });

    for (const [side, bad] of [['head', () => head], ['base', () => forkPoint]] as const) {
      test(`REGRESSION: an analyzer that fails on the ${side} alone takes the language out of both sides, nothing shows as ${side === 'head' ? 'removed' : 'added'}`, async function () {
        const body = `if (lang !== 'analyze.py') { report([]); return; } if (root.includes('${bad()}')) { process.exit(9); } report([fn('f')]);`;
        const trees = await prepare(clone(root, origin), { scriptsDir: fakeScripts(root, body), pythonBin: process.execPath });
        assert.deepStrictEqual(changes(trees), [], 'one side\'s failure would paint all of it');
        assert.deepStrictEqual([trees.head.graph.nodes, trees.base?.graph.nodes], [[], []]);
        assert.strictEqual(trees.analysisNotes?.length, 1);
        assert.strictEqual(analysisState(trees), 'partial');
      });
    }

    test('only the failed language leaves: the graphs of the others stay on both sides', async () => {
      const python = path.join(fakeScripts(root, ''), '');
      for (const { script } of ANALYZER_SCRIPTS) { if (script !== 'analyze.py') { fs.copyFileSync(path.join(SCRIPTS, script), path.join(python, script)); } }
      for (const f of fs.readdirSync(SCRIPTS)) { if (!fs.existsSync(path.join(python, f)) && !fs.statSync(path.join(SCRIPTS, f)).isDirectory()) { fs.copyFileSync(path.join(SCRIPTS, f), path.join(python, f)); } }
      fs.writeFileSync(path.join(python, 'analyze.py'), 'process.exit(9);');
      const trees = await prepare(clone(root, origin), { scriptsDir: python, pythonBin: process.execPath, env: { ...ENV, NODE_PATH: path.join(SCRIPTS, '..', 'node_modules') } });
      assert.deepStrictEqual(changes(trees), ['changed keep']);
      assert.strictEqual(trees.analysisNotes?.length, 1);
      assert.match((trees.analysisNotes as string[])[0], /^Python is missing from this tour: its analyzer stopped with an error\./);
    });

    test('REGRESSION (F7): a poison file is counted, its language stays, and a new function beside it shows', async () => {
      commit(origin.work, {}, 'noop');
      sh(origin.work, ['switch', '--quiet', 'feature']);
      const poisoned = commit(origin.work, { 'src/poison.py': `x = ${'1+'.repeat(200_000)}1\n`, 'src/backdoor.py': 'def backdoor():\n    pass\n' }, 'poison');
      push(origin, 'feature');
      const trees = await prepare(clone(root, origin), { head: poisoned });
      assert.strictEqual(trees.filesNotParsed, 1);
      assert.strictEqual(analysisState(trees), 'complete', 'a file is not a process failure');
      assert.ok(changes(trees)?.includes('added backdoor'), String(changes(trees)));
    });

    test('REGRESSION (F3): an analyzer over the cap is a failed language with a sentence, and the default cap is 200 MB', async () => {
      assert.strictEqual(CI_MAX_OUTPUT_BYTES, 200 * 1024 * 1024);
      const body = 'process.stdout.write("x".repeat(4096)); setTimeout(() => {}, 100);';
      const trees = await prepare(clone(root, origin), { scriptsDir: fakeScripts(root, body), pythonBin: process.execPath, maxOutputBytes: 1024 });
      assert.match((trees.analysisNotes as string[])[0], /produced more output than a tour can take/);
    });

    test('REGRESSION (F3): the default cap holds at 200 MiB, far under the 500 of the extension', async () => {
      const body = `if (lang !== 'analyze.py') { report([]); return; }
        const block = 'x'.repeat(1024 * 1024); let n = 0;
        const go = () => { while (n < 201) { n++; if (!process.stdout.write(block)) { process.stdout.once('drain', go); return; } } };
        go();`;
      const trees = await prepare(clone(root, origin), { scriptsDir: fakeScripts(root, body), pythonBin: process.execPath });
      assert.match((trees.analysisNotes as string[])[0], /produced more output than a tour can take/);
    });

    test('REGRESSION (F7): one file past the size limit costs that file, in every language, and counts as not parsed', async () => {
      assert.strictEqual(CI_MAX_FILE_BYTES, 16 * 1024 * 1024);
      sh(origin.work, ['switch', '--quiet', 'feature']);
      // Just past the default, and cheap to analyse: without the limit it would parse and be counted nowhere.
      const big = commit(origin.work, { 'src/big.py': '#\n'.repeat(Math.ceil(CI_MAX_FILE_BYTES / 2) + 1), 'src/kept.py': 'def kept():\n    pass\n' }, 'big');
      push(origin, 'feature');
      const trees = await prepare(clone(root, origin, '--no-checkout'), { head: big });
      assert.strictEqual(trees.filesNotParsed, 1);
      assert.strictEqual(analysisState(trees), 'complete', 'the language stays');
      assert.ok(changes(trees)?.includes('added kept'), String(changes(trees)));
      assert.ok(!(trees.head.graph.files ?? []).some(f => f.endsWith('big.py')), 'no analyzer saw it');
    });

    test('what an analyzer printed stays out of the notes and the log: a traceback quotes source', async () => {
      const logged: string[] = [];
      const body = 'process.stderr.write("password = hunter2"); process.exit(1);';
      const trees = await prepare(clone(root, origin), { scriptsDir: fakeScripts(root, body), pythonBin: process.execPath, log: l => logged.push(l) });
      assert.ok(!JSON.stringify(trees.analysisNotes).includes('hunter2'));
      assert.ok(!logged.join('\n').includes('hunter2'), logged.join('\n'));
    });
  });

  test('REGRESSION (F16): analyzers run from the work dir, in the tool environment', async () => {
    const body = `if (lang === 'analyze_ts.js') { fs.writeFileSync(process.env.SEEN, JSON.stringify({ cwd: process.cwd(), token: process.env.GITHUB_TOKEN ?? null, heap: process.execArgv })); } report([]);`;
    const seen = path.join(root, 'seen.json');
    const workDir = path.join(root, 'neutral');
    process.env.GITHUB_TOKEN = 'token-of-the-job';
    try {
      await prepare(clone(root, origin), { workDir, scriptsDir: fakeScripts(root, body), pythonBin: process.execPath, env: { ...ENV, SEEN: seen } });
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
    const got = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.strictEqual(fs.realpathSync(got.cwd), fs.realpathSync(workDir));
    assert.strictEqual(got.token, null);
    assert.deepStrictEqual(got.heap, ['--max-old-space-size=4096'], 'guava needs more than the default on a small runner');
  });

  suite('what a copy is (docs/ci-engine.md)', () => {
    test('LFS-tracked source is its pointer text: nothing fetches, the file is counted, and no function appears', async () => {
      sh(origin.work, ['switch', '--quiet', 'feature']);
      const pointer = 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f3b6c0d2d8c8c7c1f1e7f3c1f1e\nsize 12345\n';
      const lfs = commit(origin.work, { '.gitattributes': 'src/big.py filter=lfs diff=lfs merge=lfs -text\n', 'src/big.py': pointer }, 'lfs');
      push(origin, 'feature');
      const trees = await prepare(clone(root, origin, '--no-checkout'), { head: lfs });
      assert.strictEqual(fs.readFileSync(path.join(trees.head.dir, 'src', 'big.py'), 'utf8'), pointer);
      assert.strictEqual(trees.filesNotParsed, 1);
      assert.ok(!trees.head.graph.nodes.some(x => x.file?.endsWith('big.py')));
    });

    test('files in a copy are not executable, whatever the commit says', async function () {
      if (process.platform === 'win32') { this.skip(); }
      sh(origin.work, ['switch', '--quiet', 'feature']);
      fs.writeFileSync(path.join(origin.work, 'run.py'), '#!/usr/bin/env python3\n');
      fs.chmodSync(path.join(origin.work, 'run.py'), 0o755);
      const executable = commit(origin.work, {}, 'script');
      assert.strictEqual(sh(origin.work, ['ls-tree', executable, 'run.py']).slice(0, 6), '100755');
      push(origin, 'feature');
      const trees = await prepare(clone(root, origin), { head: executable });
      assert.strictEqual(fs.statSync(path.join(trees.head.dir, 'run.py')).mode & 0o111, 0);
    });
  });

  suite('a blobless clone', () => {
    const missing = (repo: string, oid: string) => sh(repo, ['cat-file', '--batch-check'], `${oid}\n`, { GIT_NO_LAZY_FETCH: '1' }).endsWith('missing');
    const blobless = () => clone(root, origin, '--filter=blob:none', '--no-checkout');

    test('after `fetch`, build needs no remote at all: the origin is gone', async () => {
      const repo = blobless();
      const fetched = await ensureCommits({ repoRoot: repo, head, base: tip, baseRef: 'main', headRef: 'feature' });
      fs.renameSync(origin.bare, `${origin.bare}.gone`);
      const trees = await prepare(repo, { base: fetched.mergeBase, configSha: fetched.targetTip });
      assert.deepStrictEqual(changes(trees), ['added fresh', 'changed edited', 'changed keep']);
    });

    test('REGRESSION: without `fetch`, build fails and fetches nothing, though the origin would answer', async () => {
      const repo = blobless();
      const blob = sh(origin.work, ['rev-parse', `${head}:src/app.py`]);
      await assert.rejects(prepare(repo), /could not be fetched/);
      assert.ok(missing(repo, blob), 'build went to the network for a blob');
    });
  });
});
