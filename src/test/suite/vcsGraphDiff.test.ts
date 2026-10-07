import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { diffGraphs } from '../../vcs/engine/graphDiff';
import type { DiffTree, StructuralDiff } from '../../vcs/engine/graphDiff';
import { statusesFromDiff } from '../../vcs/engine/diffStatuses';
import { GitService } from '../../gitService';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Write source files and describe their functions; node ids embed the absolute path like the analyzers' do. */
function tree(root: string, sha: string, files: Record<string, string>, defs: Array<[file: string, name: string, line: number, className?: string]>, calls: Array<[from: string, to: string]>, libs: Array<[from: string, lib: string, fn: string]> = []): DiffTree {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  const abs = (rel: string) => path.join(root, ...rel.split('/'));
  const id = (rel: string, name: string, line: number) => `${abs(rel)}::${name}::${line}`;
  const nodes: any[] = defs.map(([file, name, line, className]) => ({ id: id(file, name, line), name, file: abs(file), line, ...(className ? { className } : {}) }));
  const find = (ref: string) => {
    const [file, name] = ref.split('::');
    const n = nodes.find(x => x.file === abs(file) && x.name === name && !x.isLibrary);
    if (!n) { throw new Error(`no node ${ref}`); }
    return n.id;
  };
  const edges: any[] = calls.map(([from, to]) => ({ source: find(from), target: find(to) }));
  for (const [from, lib, fn] of libs) {
    const libId = `lib::${lib}::${fn}`;
    if (!nodes.some(n => n.id === libId)) { nodes.push({ id: libId, name: fn, file: null, line: 0, isLibrary: true, libraryName: lib }); }
    edges.push({ source: find(from), target: libId, isLibraryEdge: true });
  }
  return { root, sha, graph: { nodes, edges, files: Object.keys(files).map(abs) } };
}

const BASE_UTIL = 'export function helper() {\n  return 1;\n}\n\nexport function old() {\n  return 0;\n}\n';
const HEAD_UTIL = '// a comment moved everything down\n\nexport function helper() {\n  return 1;\n}\n';
const BASE_APP = 'import { helper, old } from "./util";\nexport function main() {\n  helper();\n  old();\n}\nexport function other() {}\n';
const HEAD_APP = 'import { helper } from "./util";\nimport { fresh } from "./fresh";\nexport function main() {\n  helper();\n  fresh();\n}\nexport function other() {}\n';

suite('vcs engine — graphDiff', () => {
  let root: string;
  let base: DiffTree;
  let head: DiffTree;
  let diff: StructuralDiff;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-diff-'));
    base = tree(path.join(root, 'base'), 'b'.repeat(40),
      { 'src/util.ts': BASE_UTIL, 'src/app.ts': BASE_APP, 'src/gone.ts': 'export function gone() {}\n' },
      [['src/util.ts', 'helper', 1], ['src/util.ts', 'old', 5], ['src/app.ts', 'main', 2], ['src/app.ts', 'other', 6], ['src/gone.ts', 'gone', 1]],
      [['src/app.ts::main', 'src/util.ts::helper'], ['src/app.ts::main', 'src/util.ts::old']],
      [['src/app.ts::other', 'axios', 'get']]);
    head = tree(path.join(root, 'head'), 'h'.repeat(40),
      { 'src/util.ts': HEAD_UTIL, 'src/app.ts': HEAD_APP, 'src/fresh.ts': 'export function fresh() {\n  return 2;\n}\n' },
      [['src/util.ts', 'helper', 3], ['src/app.ts', 'main', 3], ['src/app.ts', 'other', 7], ['src/fresh.ts', 'fresh', 1]],
      [['src/app.ts::main', 'src/util.ts::helper'], ['src/app.ts::main', 'src/fresh.ts::fresh']],
      [['src/app.ts::other', 'axios', 'get']]);
    diff = diffGraphs(base, head);
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test('functions: added, removed, changed by text, moved by line only — keyed by path and name, never by id', () => {
    const byKind = (k: string) => diff.functions.filter(f => f.kind === k).map(f => f.key);
    assert.deepStrictEqual(byKind('added'), ['src/fresh.ts::fresh']);
    assert.deepStrictEqual(byKind('removed'), ['src/gone.ts::gone', 'src/util.ts::old']);
    assert.deepStrictEqual(byKind('changed'), ['src/app.ts::main'], 'main calls fresh instead of old');
    assert.deepStrictEqual([...byKind('moved')].sort(), ['src/app.ts::other', 'src/util.ts::helper'], 'same text, lines shifted: moved, not changed');
    const main = diff.functions.find(f => f.key === 'src/app.ts::main')!;
    assert.deepStrictEqual([main.baseLine, main.headLine, main.file, main.name], [2, 3, 'src/app.ts', 'main']);
    assert.deepStrictEqual(diff.summary, { added: 1, removed: 2, changed: 1, moved: 2, edgesAdded: 1, edgesRemoved: 1, callersAffected: 1 });
  });

  test('edges: appear and vanish by key; a library edge that stays is not a change', () => {
    assert.deepStrictEqual(diff.edges, [
      { source: 'src/app.ts::main', target: 'src/fresh.ts::fresh', kind: 'added' },
      { source: 'src/app.ts::main', target: 'src/util.ts::old', kind: 'removed' },
    ]);
  });

  test('impact: callers of what changed — in the head for added and changed, in the base for removed', () => {
    const byKey = Object.fromEntries(diff.impact.map(i => [i.key, i]));
    assert.deepStrictEqual(byKey['src/fresh.ts::fresh'], { key: 'src/fresh.ts::fresh', kind: 'added', callers: ['src/app.ts::main'] });
    assert.deepStrictEqual(byKey['src/util.ts::old'], { key: 'src/util.ts::old', kind: 'removed', callers: ['src/app.ts::main'] });
    assert.deepStrictEqual(byKey['src/app.ts::main'].callers, []);
    assert.deepStrictEqual(byKey['src/gone.ts::gone'].callers, []);
    assert.strictEqual(diff.impact.some(i => i.key === 'src/util.ts::helper'), false, 'a moved function is not an impact');
  });

  test('files and counts', () => {
    assert.deepStrictEqual(diff.files, { added: ['src/fresh.ts'], removed: ['src/gone.ts'] });
    assert.deepStrictEqual([diff.base.functions, diff.head.functions, diff.base.files, diff.head.files, diff.base.sha, diff.head.sha],
      [5, 4, 3, 3, 'b'.repeat(40), 'h'.repeat(40)]);
  });

  test('the diff is plain data: it survives JSON and names no absolute path', () => {
    const text = JSON.stringify(diff);
    assert.deepStrictEqual(JSON.parse(text), diff);
    assert.ok(!text.includes(root), 'no absolute path anywhere');
  });

  test('class methods key by class; a name defined twice in a file is matched in line order', () => {
    const b = tree(path.join(root, 'b2'), undefined as any,
      { 'a.ts': 'class A {\n  run() { return 1; }\n}\nclass B {\n  run() { return 2; }\n}\nfunction f() {}\nfunction f() {}\n' },
      [['a.ts', 'run', 2, 'A'], ['a.ts', 'run', 5, 'B'], ['a.ts', 'f', 7], ['a.ts', 'f', 8]], []);
    const h = tree(path.join(root, 'h2'), undefined as any,
      { 'a.ts': 'class A {\n  run() { return 1; }\n}\nclass B {\n  run() { return 3; }\n}\nfunction f() {}\nfunction f() { x(); }\n' },
      [['a.ts', 'run', 2, 'A'], ['a.ts', 'run', 5, 'B'], ['a.ts', 'f', 7], ['a.ts', 'f', 8]], []);
    const d = diffGraphs(b, h);
    assert.deepStrictEqual(d.functions.map(f => [f.key, f.kind]), [['a.ts::B.run', 'changed'], ['a.ts::f#2', 'changed']]);
    assert.strictEqual(d.base.sha, undefined);
  });

  test('an unreadable source says nothing rather than guessing', () => {
    const d = diffGraphs(base, head, { readFile: () => null });
    assert.deepStrictEqual(d.functions.map(f => f.kind).filter(k => k === 'changed' || k === 'moved'), []);
    assert.strictEqual(d.summary.added + d.summary.removed, 3, 'presence does not need the text');
  });

  test('trailing whitespace and trailing blank lines do not make a change', () => {
    const b = tree(path.join(root, 'b3'), undefined as any, { 'a.ts': 'function f() {\n  return 1;\n}\n\n\nfunction g() {}\n' }, [['a.ts', 'f', 1], ['a.ts', 'g', 6]], []);
    const h = tree(path.join(root, 'h3'), undefined as any, { 'a.ts': 'function f() {  \n  return 1;\r\n}\nfunction g() {}\n' }, [['a.ts', 'f', 1], ['a.ts', 'g', 4]], []);
    assert.deepStrictEqual(diffGraphs(b, h).functions.map(f => [f.key, f.kind]), [['a.ts::g', 'moved']]);
  });
});

suite('vcs engine — diff → colours', () => {
  let root: string;
  setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-diffcol-')); });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test('a new file is added as a whole; a touched file is modified with one hunk per touched function; the nodes agree', () => {
    const base = tree(path.join(root, 'base'), undefined as any,
      { 'src/a.ts': 'function one() { return 1; }\nfunction two() { return 2; }\nfunction three() { return 3; }\n' },
      [['src/a.ts', 'one', 1], ['src/a.ts', 'two', 2], ['src/a.ts', 'three', 3]], []);
    const headRoot = path.join(root, 'head');
    const head = tree(headRoot, undefined as any,
      { 'src/a.ts': 'function one() { return 1; }\nfunction two() { return 22; }\nfunction three() { return 3; }\nfunction four() {}\n', 'src/n.ts': 'function n() {}\n' },
      [['src/a.ts', 'one', 1], ['src/a.ts', 'two', 2], ['src/a.ts', 'three', 3], ['src/a.ts', 'four', 4], ['src/n.ts', 'n', 1]], []);
    const override = statusesFromDiff(diffGraphs(base, head), headRoot);
    const fwd = (rel: string) => path.join(headRoot, ...rel.split('/')).replace(/\\/g, '/');
    assert.deepStrictEqual(Object.fromEntries(override.files), {
      [fwd('src/a.ts')]: { unstaged: 'modified', staged: null },
      [fwd('src/n.ts')]: { unstaged: 'added', staged: null },
    });
    assert.deepStrictEqual(override.hunks.get(fwd('src/a.ts')), [{ start: 2, end: 2, isNew: false }, { start: 4, end: 4, isNew: true }]);
    assert.strictEqual(override.hunks.has(fwd('src/n.ts')), false);

    const git = new GitService();
    git.setOverride(override);
    const nodes = head.graph.nodes.map(n => ({ ...n }));
    git.applyGitStatuses(nodes as any, headRoot);
    const status = (name: string) => (nodes.find(n => n.name === name) as any).gitStatus.unstaged;
    assert.deepStrictEqual([status('one'), status('two'), status('three'), status('four'), status('n')], [null, 'modified', null, 'added', 'added']);
  });

  test('a diff with nothing in it colours nothing', () => {
    const t = tree(path.join(root, 'same'), undefined as any, { 'a.ts': 'function f() {}\n' }, [['a.ts', 'f', 1]], []);
    const override = statusesFromDiff(diffGraphs(t, t), t.root);
    assert.deepStrictEqual([override.files.size, override.hunks.size], [0, 0]);
  });
});
