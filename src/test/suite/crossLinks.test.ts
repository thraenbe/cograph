import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cl = require('../../../src/webview/crossLinks.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

const FRAME_OF: Record<string, string> = {
  a1: '/a', a2: '/a', b1: '/b', b2: '/b', c1: '/c',
};
const frameOfId = (id: string) => FRAME_OF[id] ?? null;

suite('crossLinks', () => {
  test('pairKey is symmetric and deterministic', () => {
    assert.strictEqual(cl.pairKey('/a', '/b'), cl.pairKey('/b', '/a'));
    assert.notStrictEqual(cl.pairKey('/a', '/b'), cl.pairKey('/a', '/c'));
  });

  test('splitEdgesByFrame partitions intra vs cross (ids or node objects)', () => {
    const links = [
      { source: 'a1', target: 'a2' },
      { source: { id: 'b1' }, target: { id: 'b2' } },
      { source: 'a1', target: 'b1' },
      { source: 'c1', target: 'a2' },
    ];
    const { intra, cross } = cl.splitEdgesByFrame(links, frameOfId);
    assert.strictEqual(intra.get('/a').length, 1);
    assert.strictEqual(intra.get('/b').length, 1);
    assert.strictEqual(cross.length, 2);
  });

  test('buildCrossLinks aggregates counts and pending per folder pair', () => {
    const cross = [
      { source: 'a1', target: 'b1', _count: 3 },
      { source: 'b2', target: 'a2', _count: 2, pending: true },
      { source: 'a1', target: 'c1' },
    ];
    const frames: Record<string, any> = {
      '/a': { abs: { x: 0, y: 0, w: 200, h: 100 }, titleRect: { x: 0, y: 0, w: 200, h: 30 } },
      '/b': { abs: { x: 400, y: 0, w: 200, h: 100 }, titleRect: { x: 400, y: 0, w: 200, h: 30 } },
      '/c': { abs: { x: 0, y: 300, w: 200, h: 100 }, titleRect: { x: 0, y: 300, w: 200, h: 30 } },
    };
    const { bundles, individual } = cl.buildCrossLinks({
      cross, frameOfId, frameAt: (p: string) => frames[p] ?? null,
    });
    assert.strictEqual(bundles.length, 2);
    const ab = bundles.find((b: any) => b.key === cl.pairKey('/a', '/b'));
    assert.strictEqual(ab.count, 5, 'counts summed both directions');
    assert.strictEqual(ab.pending, true, 'pending propagates');
    // ports on the title bars: y at the bar centre, x clamped into the bar
    assert.strictEqual(ab.y1, 15);
    assert.ok(ab.x1 >= 8 && ab.x1 <= 192);
    assert.strictEqual(ab.y2, 15);
    assert.ok(ab.x2 >= 408 && ab.x2 <= 592);
    assert.strictEqual(individual.length, 0, 'no hover → no individual links');
  });

  test('hover produces individual links with node-centre endpoints', () => {
    const cross = [
      { source: 'a1', target: 'b1', _count: 2 },
      { source: 'b2', target: 'a2' },
    ];
    const pos: Record<string, any> = {
      a1: { x: 10, y: 20 }, b1: { x: 500, y: 40 }, b2: { x: 520, y: 60 }, a2: { x: 30, y: 80 },
    };
    const { individual } = cl.buildCrossLinks({
      cross, frameOfId,
      frameAt: () => ({ abs: { x: 0, y: 0, w: 10, h: 10 }, titleRect: { x: 0, y: 0, w: 10, h: 10 } }),
      absPosOf: (id: string) => pos[id] ?? null,
      hoverId: 'a1',
    });
    assert.strictEqual(individual.length, 1);
    assert.strictEqual(individual[0].x1, 10);
    assert.strictEqual(individual[0].x2, 500);
    assert.strictEqual(individual[0].count, 2);
  });

  test('portOn clamps toward-point into the bar with an 8px margin', () => {
    const title = { x: 100, y: 50, w: 80, h: 30 };
    assert.deepStrictEqual(cl.portOn(title, { x: 0, y: 0 }), { x: 108, y: 65 });
    assert.deepStrictEqual(cl.portOn(title, { x: 500, y: 0 }), { x: 172, y: 65 });
    assert.deepStrictEqual(cl.portOn(title, { x: 140, y: 0 }), { x: 140, y: 65 });
  });
});

suite('crossLinks — ancestor/descendant routing', () => {
  test('bundle between a folder and its child stays short (child titlebar → nearest ancestor edge)', () => {
    const frameOf = (id: string) => (id === 'p1' ? '/p' : '/p/a');
    const frames: Record<string, any> = {
      '/p':   { abs: { x: 0, y: 0, w: 600, h: 400 }, titleRect: { x: 0, y: 0, w: 600, h: 30 } },
      '/p/a': { abs: { x: 100, y: 200, w: 200, h: 120 }, titleRect: { x: 100, y: 200, w: 200, h: 30 } },
    };
    const { bundles } = cl.buildCrossLinks({
      cross: [{ source: 'p1', target: 'a1', _count: 2 }],
      frameOfId: frameOf, frameAt: (p: string) => frames[p],
    });
    assert.strictEqual(bundles.length, 1);
    const b = bundles[0];
    const len = Math.hypot(b.x2 - b.x1, b.y2 - b.y1);
    assert.ok(len < 250, `short route expected, got ${len}`);
    // one endpoint on the child's titlebar
    const onChildBar = (b.y1 === 215 || b.y2 === 215);
    assert.ok(onChildBar, 'one endpoint at the child titlebar centre-line');
  });

  test('nearestEdgePoint snaps to the closest border', () => {
    const r = { x: 0, y: 0, w: 100, h: 100 };
    assert.deepStrictEqual(cl.nearestEdgePoint(r, { x: 5, y: 40 }), { x: 0, y: 40 });
    assert.deepStrictEqual(cl.nearestEdgePoint(r, { x: 200, y: 50 }), { x: 100, y: 50 });
    assert.deepStrictEqual(cl.nearestEdgePoint(r, { x: 50, y: 98 }), { x: 50, y: 100 });
  });

  // ── cacheable helpers (perf W1): aggregation is per render, routing per move ──
  const FRAMES: Record<string, any> = {
    '/a': { abs: { x: 0, y: 0, w: 100, h: 100 }, titleRect: { x: 0, y: 0, w: 100, h: 30 } },
    '/b': { abs: { x: 300, y: 0, w: 100, h: 100 }, titleRect: { x: 300, y: 0, w: 100, h: 30 } },
    '/c': { abs: { x: 0, y: 300, w: 100, h: 100 }, titleRect: { x: 0, y: 300, w: 100, h: 30 } },
  };
  const CROSS = [
    { source: 'a1', target: 'b1' },
    { source: { id: 'b2' }, target: { id: 'a2' }, _count: 3, pending: true },
    { source: 'c1', target: 'a2' },
    { source: 'a1', target: 'a2' },      // same frame → ignored by the aggregation
    { source: 'a1', target: 'ghost' },   // unknown owner → ignored
  ];

  test('aggregateCrossPairs + routeBundles equals buildCrossLinks().bundles', () => {
    const aggs = cl.aggregateCrossPairs(CROSS, frameOfId);
    assert.deepStrictEqual(aggs.map((a: any) => [a.a, a.b, a.count, a.pending]),
      [['/a', '/b', 4, true], ['/a', '/c', 1, false]]);
    const routed = cl.routeBundles(aggs, (p: string) => FRAMES[p] ?? null);
    const oneShot = cl.buildCrossLinks({ cross: CROSS, frameOfId, frameAt: (p: string) => FRAMES[p] ?? null });
    assert.deepStrictEqual(routed, oneShot.bundles);
  });

  test('routeBundles re-routes cached aggregates after a frame moved, skips vanished frames', () => {
    const aggs = cl.aggregateCrossPairs(CROSS, frameOfId);
    const before = cl.routeBundles(aggs, (p: string) => FRAMES[p] ?? null);
    const moved: Record<string, any> = { ...FRAMES, '/b': { abs: { x: 300, y: 500, w: 100, h: 100 }, titleRect: { x: 300, y: 500, w: 100, h: 30 } } };
    const after = cl.routeBundles(aggs, (p: string) => moved[p] ?? null);
    assert.notStrictEqual(after[0].y2, before[0].y2);
    assert.deepStrictEqual(after[1], before[1], 'untouched pair keeps its geometry');
    const gone = cl.routeBundles(aggs, (p: string) => (p === '/c' ? null : FRAMES[p]));
    assert.deepStrictEqual(gone.map((b: any) => b.key), [aggs[0].key]);
  });

  test('indexCrossByNode + individualLinksFor give the hovered node\'s links in O(degree)', () => {
    const idx = cl.indexCrossByNode(CROSS);
    assert.strictEqual(idx.get('a1').length, 3);
    assert.strictEqual(idx.get('b2').length, 1);
    const pos: Record<string, any> = { a2: { x: 1, y: 2 }, b2: { x: 3, y: 4 }, c1: { x: 5, y: 6 } };
    const viaIndex = cl.individualLinksFor(idx.get('a2'), 'a2', (id: string) => pos[id] ?? null);
    const viaAll = cl.buildCrossLinks({
      cross: CROSS, frameOfId, frameAt: () => null, hoverId: 'a2', absPosOf: (id: string) => pos[id] ?? null,
    }).individual;
    assert.deepStrictEqual(viaIndex, viaAll);
    assert.strictEqual(viaIndex.length, 2, 'a1→a2 has no position for a1 and is skipped');
    assert.deepStrictEqual(cl.individualLinksFor(CROSS, null, () => ({ x: 0, y: 0 })), []);
  });
});
