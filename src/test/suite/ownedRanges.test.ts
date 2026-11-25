/**
 * The engine-n1 assessment (s535, 16.11.2026): C1, C2 (F1) and F3. A line belongs to the innermost
 * definition whose [startLine ?? line, endLine] holds it; without endLine the old rule (to the line
 * before the next definition) stands; graphDiff uses the new fields only when base and head both have them.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { diffGraphs, type DiffTree } from '../../vcs/engine/graphDiff';
import { ownedRanges } from '../../vcs/engine/ownedRanges';
import { GitService } from '../../gitService';

/* eslint-disable @typescript-eslint/no-explicit-any */

// outer 1-7, inner 2-4 nested, outer's tail 5-6, module code 9.
const NESTED = [
  'function outer() {', '  function inner() {', '    return 1;', '  }', '  const x = inner();', '  return x;', '}', '', 'outer();', '',
].join('\n');
const NODES = (dir: string, withEnd: boolean): any[] => [
  { id: `${dir}/a.js::outer::1`, name: 'outer', file: path.join(dir, 'a.js'), line: 1, ...(withEnd ? { endLine: 7 } : {}) },
  { id: `${dir}/a.js::inner::2`, name: 'inner', file: path.join(dir, 'a.js'), line: 2, ...(withEnd ? { endLine: 4 } : {}) },
];

function tree(dir: string, files: Record<string, string>, nodes: any[]): DiffTree {
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
  return { root: dir, sha: 'a'.repeat(40), graph: { nodes, edges: [], files: Object.keys(files).map(f => path.join(dir, f)) } };
}

const changed = (d: ReturnType<typeof diffGraphs>) => d.functions.map(f => `${f.kind}:${f.name}`);

suite('owned ranges: innermost owner, nested tails, decorators (C1, C2, F3)', () => {
  let root: string;
  setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-owned-')); });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test('ownedRanges: the parent owns its lines around the nested one; old rule without endLine', () => {
    const a = { line: 1, endLine: 7 }, b = { line: 2, endLine: 4 }, c = { line: 9, endLine: 9 };
    const r = ownedRanges([a, b, c]);
    assert.deepStrictEqual([r.get(a), r.get(b), r.get(c)], [[[1, 1], [5, 7]], [[2, 4]], [[9, 9]]]);
    const o1 = { line: 1 }, o2 = { line: 2 }, o3 = { line: 9 };
    const old = ownedRanges([o1, o2, o3]);
    assert.deepStrictEqual([old.get(o1), old.get(o2), old.get(o3)], [[[1, 1]], [[2, 8]], [[9, Number.MAX_SAFE_INTEGER]]]);
    const deco = { line: 3, startLine: 1, endLine: 4 };
    assert.deepStrictEqual(ownedRanges([deco]).get(deco), [[1, 4]]);
  });

  test('C2 graphDiff: an edit in the outer function after its nested one changes the outer only', () => {
    const base = tree(path.join(root, 'b'), { 'a.js': NESTED }, NODES(path.join(root, 'b'), true));
    const head = tree(path.join(root, 'h'), { 'a.js': NESTED.replace('  return x;', '  return x + 1;') }, NODES(path.join(root, 'h'), true));
    assert.deepStrictEqual(changed(diffGraphs(base, head)), ['changed:outer']);
  });

  test('C2 graphDiff: an edit inside the nested function changes the inner only; a module line changes none', () => {
    const base = tree(path.join(root, 'b'), { 'a.js': NESTED }, NODES(path.join(root, 'b'), true));
    const inner = tree(path.join(root, 'h1'), { 'a.js': NESTED.replace('return 1;', 'return 2;') }, NODES(path.join(root, 'h1'), true));
    assert.deepStrictEqual(changed(diffGraphs(base, inner)), ['changed:inner']);
    const mod = tree(path.join(root, 'h2'), { 'a.js': NESTED.replace('outer();', 'outer(); outer();') }, NODES(path.join(root, 'h2'), true));
    assert.deepStrictEqual(changed(diffGraphs(base, mod)), []);
  });

  test('C1 graphDiff: an old base without endLine and a new head with it, identical source: nothing changed', () => {
    const base = tree(path.join(root, 'b'), { 'a.js': NESTED }, NODES(path.join(root, 'b'), false));
    const head = tree(path.join(root, 'h'), { 'a.js': NESTED }, NODES(path.join(root, 'h'), true));
    assert.deepStrictEqual(changed(diffGraphs(base, head)), []);
    assert.deepStrictEqual(changed(diffGraphs(head, base)), []);
  });

  test('F3 graphDiff: a decorated Python function whose decorator changed is changed', () => {
    const src = (arg: string) => `import pytest\n\n\n@pytest.mark.parametrize("n", [${arg}])\ndef test_n(n):\n    assert n\n`;
    const node = (dir: string) => [{ id: `${dir}/t.py::test_n::5`, name: 'test_n', file: path.join(dir, 't.py'), line: 5, startLine: 4, endLine: 6 }];
    const base = tree(path.join(root, 'b'), { 't.py': src('1, 2') }, node(path.join(root, 'b')));
    const head = tree(path.join(root, 'h'), { 't.py': src('1, 2, 3') }, node(path.join(root, 'h')));
    assert.deepStrictEqual(changed(diffGraphs(base, head)), ['changed:test_n']);
  });

  test('C2 and F3 GitService: an outer-tail hunk marks the outer, an inner hunk only the inner, a module line none, a decorator hunk its function', () => {
    const file = path.join(root, 'a.js').replace(/\\/g, '/');
    const mark = (start: number, end: number, extra: any[] = []) => {
      const nodes: any[] = [{ id: 'o', name: 'outer', file, line: 1, endLine: 7 }, { id: 'i', name: 'inner', file, line: 2, endLine: 4 }, ...extra];
      const git = new GitService();
      git.setOverride({ files: new Map([[file, { unstaged: 'modified', staged: null }]]), hunks: new Map([[file, [{ start, end, isNew: false }]]]) } as any);
      git.applyGitStatuses(nodes, root);
      return nodes.filter(n => n.gitStatus.unstaged).map(n => n.name);
    };
    assert.deepStrictEqual(mark(6, 6), ['outer']);
    assert.deepStrictEqual(mark(3, 3), ['inner']);
    assert.deepStrictEqual(mark(9, 9), []);
    assert.deepStrictEqual(mark(11, 11, [{ id: 'd', name: 'deco', file, line: 12, startLine: 11, endLine: 13 }]), ['deco']);
  });
});
