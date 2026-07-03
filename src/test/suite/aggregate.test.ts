import * as assert from 'assert';

// aggregate.js is a browser-global module with a module.exports guard; the pure
// helper is require()-able directly (no DOM/D3 needed).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { aggregateEdges } = require('../../../src/webview/aggregate.js');

const ids = (edges: any[]) => edges.map(e => `${e.data.source}->${e.data.target}`);

suite('aggregate.aggregateEdges', () => {
  test('plain mode: dedupes, drops self-edges, carries no weight', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'b' }, // duplicate → one edge
      { source: 'c', target: 'c' }, // self-edge → dropped
    ];
    const out = aggregateEdges(edges, (id: string) => id);
    assert.deepStrictEqual(ids(out), ['a->b']);
    assert.strictEqual(out[0].data._count, undefined, 'plain mode carries no _count');
    assert.strictEqual(out[0].data.weight, undefined);
  });

  test('endpoints roll up via mapId; edges that map together collapse', () => {
    // x and y both belong to cluster C; z to cluster D.
    const map = (id: string) => ({ x: 'C', y: 'C', z: 'D' } as Record<string, string>)[id];
    const edges = [
      { source: 'x', target: 'z' },
      { source: 'y', target: 'z' }, // same rolled-up endpoints → merges with the above
      { source: 'x', target: 'y' }, // both → C → self-edge after roll-up, dropped
    ];
    const out = aggregateEdges(edges, map, { weighted: true });
    assert.deepStrictEqual(ids(out), ['C->D']);
    assert.strictEqual(out[0].data._count, 2, 'two underlying calls aggregated');
    assert.strictEqual(out[0].data.weight, 2);
  });

  test('library and ::MAIN:: entry edges are ignored', () => {
    const edges = [
      { source: '::MAIN::0', target: 'a' },
      { source: 'a', target: 'b', isLibraryEdge: true },
      { source: 'a', target: 'b' },
    ];
    const out = aggregateEdges(edges, (id: string) => id, { weighted: true });
    assert.deepStrictEqual(ids(out), ['a->b']);
    assert.strictEqual(out[0].data._count, 1);
  });

  test('weighted mode: pending reflects pendingFor over the underlying edges', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'b' },
      { source: 'c', target: 'd' },
    ];
    // a->b touches an un-parsed subtree; c->d does not.
    const pendingFor = (s: string) => s === 'a';
    const out = aggregateEdges(edges, (id: string) => id, { weighted: true, pendingFor });
    const ab = out.find((e: any) => e.data.source === 'a');
    const cd = out.find((e: any) => e.data.source === 'c');
    assert.strictEqual(ab.data.pending, true);
    assert.strictEqual(cd.data.pending, false);
  });

  test('mixed-pending duplicates OR-accumulate: pending wins regardless of edge order', () => {
    // x1 and x2 both roll up to A; only x2 sits in an un-parsed subtree.
    const map = (id: string) => ({ x1: 'A', x2: 'A', y1: 'B' } as Record<string, string>)[id];
    const pendingFor = (s: string) => s === 'x2';
    for (const edges of [
      [{ source: 'x1', target: 'y1' }, { source: 'x2', target: 'y1' }], // parsed edge first
      [{ source: 'x2', target: 'y1' }, { source: 'x1', target: 'y1' }], // un-parsed edge first
    ]) {
      const out = aggregateEdges(edges, map, { weighted: true, pendingFor });
      assert.strictEqual(out.length, 1);
      assert.strictEqual(out[0].data._count, 2);
      assert.strictEqual(out[0].data.pending, true,
        'any un-parsed underlying call makes the visible edge provisional');
    }
  });

  test('endpoints that map to falsy are dropped (unknown nodes)', () => {
    const map = (id: string) => (id === 'a' ? 'a' : null);
    const out = aggregateEdges([{ source: 'a', target: 'gone' }], map);
    assert.strictEqual(out.length, 0);
  });

  test('empty / missing input → no edges (no throw)', () => {
    assert.deepStrictEqual(aggregateEdges([], (id: string) => id), []);
    assert.deepStrictEqual(aggregateEdges(null as any, (id: string) => id), []);
  });
});
