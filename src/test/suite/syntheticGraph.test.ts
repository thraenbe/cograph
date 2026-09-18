import * as assert from 'assert';
import { makeSyntheticRepo, mulberry32 } from '../fixtures/syntheticGraph';

function dirOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.substring(0, idx) : '';
}

suite('synthetic repo fixture', () => {
  test('structure satisfies scanStructure invariants', () => {
    const { structure } = makeSyntheticRepo({ folders: 13, branching: 3, filesPerFolder: 4, fnsPerFile: 5 });
    const rootSegs = structure.root.split('/').filter(Boolean).length;
    assert.strictEqual(structure.totalFiles, structure.files.length);
    for (const [path, folder] of Object.entries(structure.folders)) {
      assert.strictEqual(folder.path, path);
      assert.strictEqual(folder.depth, path.split('/').filter(Boolean).length - rootSegs);
      if (path === structure.root) {
        assert.strictEqual(folder.parent, null);
      } else {
        assert.strictEqual(folder.parent, dirOf(path));
        assert.ok(
          structure.folders[folder.parent as string].childFolders.includes(path),
          `parent of ${path} must list it as a child`,
        );
      }
      // Recursive fileCount = direct files + Σ child fileCounts.
      const childSum = folder.childFolders.reduce(
        (s, c) => s + structure.folders[c].fileCount, 0,
      );
      assert.strictEqual(folder.fileCount, folder.files.length + childSum, `fileCount of ${path}`);
    }
    for (const f of structure.files) {
      assert.ok(structure.folders[dirOf(f.path)], `file dir must exist: ${f.path}`);
      assert.ok(structure.folders[dirOf(f.path)].files.includes(f.path));
    }
  });

  test('graph: unique node ids, resolvable unique edges, files under tree folders', () => {
    const { structure, graph } = makeSyntheticRepo({ folders: 10, edges: 2000 });
    const ids = new Set(graph.nodes.map(n => n.id));
    assert.strictEqual(ids.size, graph.nodes.length, 'node ids unique');
    const edgeKeys = new Set<string>();
    for (const e of graph.edges) {
      assert.ok(ids.has(e.source) && ids.has(e.target), 'edge endpoints resolve');
      const k = `${e.source}|${e.target}`;
      assert.ok(!edgeKeys.has(k), 'edges unique');
      edgeKeys.add(k);
    }
    for (const n of graph.nodes) {
      assert.ok(structure.folders[dirOf(n.file as string)], 'node file lies under a tree folder');
    }
  });

  test('intraRatio approximately honoured', () => {
    const { graph } = makeSyntheticRepo({ folders: 20, filesPerFolder: 5, fnsPerFile: 5, edges: 2000, intraRatio: 0.95 });
    const intra = graph.edges.filter(e => dirOf(e.source.split('::')[0]) === dirOf(e.target.split('::')[0])).length;
    const ratio = intra / graph.edges.length;
    assert.ok(Math.abs(ratio - 0.95) < 0.05, `intra ratio ${ratio.toFixed(3)} not within ±0.05 of 0.95`);
  });

  test('deterministic per seed, different across seeds', () => {
    const a = makeSyntheticRepo({ folders: 8, edges: 500, seed: 7 });
    const b = makeSyntheticRepo({ folders: 8, edges: 500, seed: 7 });
    const c = makeSyntheticRepo({ folders: 8, edges: 500, seed: 8 });
    assert.deepStrictEqual(a.graph, b.graph);
    assert.deepStrictEqual(a.structure, b.structure);
    assert.notDeepStrictEqual(a.graph.edges, c.graph.edges);
  });

  test('mulberry32 is deterministic and in [0,1)', () => {
    const r1 = mulberry32(42);
    const r2 = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const v = r1();
      assert.strictEqual(v, r2());
      assert.ok(v >= 0 && v < 1);
    }
  });
});
