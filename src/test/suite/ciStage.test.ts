import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createHeadlessApi } from '../../ci/headlessApi';
import type { HeadlessRun } from '../../ci/headlessApi';
import { STAGE_ROOT, stageData } from '../../ci/stageData';
import type { StageData } from '../../ci/stageData';
import { toolEnv } from '../../ci/toolEnv';
import type { CiContext } from '../../ci/trees';
import type { TourPrepared } from '../../tour/tourApi';
import { clone, commit, makeOrigin, push, sh, tempDir } from '../ciRepo';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
const PYTHON = cp.spawnSync('python3', ['--version']).status === 0 ? 'python3' : 'python';
const CONTEXT: CiContext = {
  platform: 'github', repoWebUrl: 'https://github.com/o/r', fileLinkTemplate: 'https://github.com/o/r/blob/{sha}/{path}#L{line}',
  change: { id: 7, title: 'A change', url: 'https://github.com/o/r/pull/7', author: 'a', headRef: 'feature', baseRef: 'main' },
};
const FOUR = 'def untouched():\n    return 1\n\n\ndef edited():\n    return 1\n';
const FIVE = 'def untouched():\n    return 1\n\n\ndef edited():\n    return 2\n\n\ndef fresh():\n    return untouched()\n';

suite('ci stage data', function () {
  this.timeout(60_000);
  let root: string;
  let workDir: string;
  let repo: string;
  let run: HeadlessRun;
  let prepared: TourPrepared;
  let stage: StageData;
  let text: string;

  /** What the private host hands over, for a head whose app.py changed: statuses keyed by absolute path, as `buildStatuses` keys them. */
  function preparedFrom(headDir: string, quoted: string): TourPrepared {
    const abs = `${headDir.split(path.sep).join('/')}/src/app.py`;
    return {
      tourId: 'pr-7', headDir,
      script: { version: 1, trees: { headSha: 'h', baseSha: 'b', repoRoot: run.api.repoRoot }, chapters: [{ steps: [{ card: { hunk: [quoted] } }] }] },
      statuses: { files: [[abs, { unstaged: 'modified', staged: null }]], hunks: [[abs, [{ start: 6, end: 6, isNew: false }, { start: 9, end: 10, isNew: true }]]] },
      view: { name: 'PR #7', title: 'PR #7 · A change', headRef: 'feature', baseRef: 'main', expand: ['src'], counts: { total: 1, inGraph: 1, other: 0 } },
    };
  }

  suiteSetup(async () => {
    root = tempDir('cg-ci-stage-');
    const origin = makeOrigin(root);
    const forkPoint = commit(origin.work, { 'src/app.py': FOUR, 'web/page.ts': 'export function page() {\n  return 1;\n}\n', 'web/deep/a.ts': 'export function deep() {}\n' }, 'base');
    sh(origin.work, ['switch', '--quiet', '-c', 'feature']);
    const head = commit(origin.work, { 'src/app.py': FIVE }, 'change');
    push(origin, 'main', 'feature');
    repo = clone(root, origin);
    workDir = path.join(root, 'work');
    run = createHeadlessApi({
      repoRoot: repo, workDir, head, base: forkPoint, configSha: forkPoint, context: CONTEXT, scriptsDir: SCRIPTS, pythonBin: PYTHON,
      sourceMode: 'slices', log: () => undefined, env: { ...toolEnv(), ELECTRON_RUN_AS_NODE: '1' },
    });
    const trees = await run.api.prepareTrees(run.target, () => undefined, new AbortController().signal);
    prepared = preparedFrom(trees.head.dir, `path = "${trees.head.dir}/kept"`);
    stage = stageData(prepared, run.trees(), run.target);
    text = JSON.stringify(stage);
  });
  suiteTeardown(() => fs.rmSync(root, { recursive: true, force: true }));

  const nodeNamed = (name: string) => (stage.graph as any).data.nodes.find((n: any) => n.name === name);

  test('REGRESSION: no runner path survives in any stage file, the statuses or the script\'s root', () => {
    const { script, ...files } = stage;
    const all = JSON.stringify(files);
    for (const runner of [workDir, repo, prepared.headDir]) { assert.ok(!all.includes(runner), `${runner} in the stage data`); }
    assert.strictEqual((script.trees as any).repoRoot, STAGE_ROOT);
    assert.ok(!JSON.stringify(script.trees).includes(repo));
  });

  test('a stage path is the file\'s path under the virtual root', () => {
    assert.strictEqual(nodeNamed('edited').file, `${STAGE_ROOT}/src/app.py`);
    assert.ok((stage.graph as any).data.files.includes(`${STAGE_ROOT}/web/page.ts`));
    assert.deepStrictEqual(stage.statuses.files.map(([p]) => p), [`${STAGE_ROOT}/src/app.py`]);
    assert.deepStrictEqual(stage.statuses.hunks.map(([p]) => p), [`${STAGE_ROOT}/src/app.py`]);
  });

  test('text that quotes the path is the repository\'s, and stays: the paths move, the text does not', () => {
    const quoted = (stage.script as any).chapters[0].steps[0].card.hunk[0];
    assert.strictEqual(quoted, `path = "${prepared.headDir}/kept"`);
  });

  test('every edge still ends on a node: ids moved with their nodes', () => {
    const { nodes, edges } = (stage.graph as any).data;
    const ids = new Set(nodes.map((n: any) => n.id));
    assert.ok(edges.length > 0);
    for (const e of edges) { assert.ok(ids.has(e.source) && ids.has(e.target), JSON.stringify(e)); }
    assert.strictEqual(nodeNamed('fresh').id, `${STAGE_ROOT}/src/app.py::fresh::${nodeNamed('fresh').line}`);
  });

  test('library nodes and the entry node are left as they are', () => {
    const nodes = (stage.graph as any).data.nodes;
    assert.ok(nodes.every((n: any) => n.file === null || n.file === '' || n.file.startsWith(`${STAGE_ROOT}/`)));
  });

  test('functions are coloured from the hunks, not the file: one changed, one added, one untouched', () => {
    assert.strictEqual(nodeNamed('edited').gitStatus.unstaged, 'modified');
    assert.strictEqual(nodeNamed('fresh').gitStatus.unstaged, 'added');
    assert.strictEqual(nodeNamed('untouched').gitStatus.unstaged, null);
    assert.strictEqual(nodeNamed('page').gitStatus.unstaged, null);
  });

  test('colouring leaves the trees alone: the graph a tour reads is not repainted', () => {
    assert.ok(run.trees().head.graph.nodes.every(n => !(n as any).gitStatus));
    assert.ok(run.trees().head.graph.nodes.every(n => !n.file || n.file.startsWith(prepared.headDir)));
  });

  test('stage/view.json is the two messages verbatim', () => {
    const { subgraph, prView } = stage.view as any;
    assert.deepStrictEqual(Object.keys(stage.view), ['subgraph', 'prView']);
    assert.deepStrictEqual(subgraph, { type: 'subgraph', name: 'PR #7', root: STAGE_ROOT, include: ['.'], exclude: [] });
    assert.strictEqual(prView.type, 'pr-view');
    assert.strictEqual(prView.number, 7);
    assert.strictEqual(prView.readOnly, true);
    assert.deepStrictEqual(prView.tree, { kind: 'head', sha: run.trees().head.sha });
    assert.deepStrictEqual(prView.expand, [STAGE_ROOT, `${STAGE_ROOT}/src`]);
    assert.deepStrictEqual(prView.fileGitStatus, { [`${STAGE_ROOT}/src/app.py`]: { unstaged: 'modified', staged: null } });
    assert.deepStrictEqual(prView.counts, { total: 1, inGraph: 1, exact: 1, fileLevel: 0, missing: 0, other: 0 });
  });

  test('structure and graph are the messages the panel sends', () => {
    const structure = stage.structure as any;
    assert.strictEqual(structure.type, 'structure');
    assert.strictEqual(structure.autoEngage, true);
    const graph = stage.graph as any;
    assert.deepStrictEqual([graph.type, graph.gitAvailable, graph.isReanalysis], ['graph', true, false]);
    assert.deepStrictEqual(graph.fileGitStatus, (stage.view as any).prView.fileGitStatus);
  });

  test('the structure tree holds together under the virtual root', () => {
    const { tree } = stage.structure as any;
    assert.strictEqual(tree.root, STAGE_ROOT);
    assert.strictEqual(tree.folders[STAGE_ROOT].parent, null);
    for (const [key, folder] of Object.entries<any>(tree.folders)) {
      assert.strictEqual(folder.path, key);
      assert.ok(folder.parent === null || tree.folders[folder.parent], key);
      for (const child of folder.childFolders) { assert.ok(tree.folders[child], child); }
    }
    assert.ok(tree.files.every((f: any) => f.path.startsWith(`${STAGE_ROOT}/`)));
    assert.deepStrictEqual(tree.folders[`${STAGE_ROOT}/web`].files, [`${STAGE_ROOT}/web/page.ts`]);
  });

  test('a tree holding nothing analysable has an empty structure, and no path to move', () => {
    assert.ok(text.length > 0);
    const empty = stageData({ ...prepared, statuses: { files: [], hunks: [] } }, { ...run.trees(), structure: { root: '', folders: {}, files: [], totalFiles: 0 } }, run.target);
    assert.strictEqual((empty.structure as any).tree.root, '');
  });
});
