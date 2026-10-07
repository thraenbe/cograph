import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vc = require('../../../src/webview/viewCull.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sf = require('../../../src/webview/scopeFit.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

const g = globalThis as any;
const VIEW = { x: 0, y: 0, w: 800, h: 600 };

suite('scopeFit (F26)', () => {
  const saved: Record<string, unknown> = {};
  const GLOBALS = ['viewMissesAll', 'slotRects', 'innerOrigin', 'usesFrames', 'state', 'getVisibleNodeIds',
    'nodeRadius', 'svg', 'd3', 'viewportRect', 'fitToRect', 'window'];

  setup(() => {
    for (const k of GLOBALS) { saved[k] = g[k]; }
    g.viewMissesAll = vc.viewMissesAll;   // a webview global in production (viewCull.js loads first)
  });
  teardown(() => {
    for (const k of GLOBALS) { if (saved[k] === undefined) { delete g[k]; } else { g[k] = saved[k]; } }
  });

  test('slotRects: absolute slot rects of every frame that has slots', () => {
    const frames = { byPath: new Map<string, any>([
      ['/a', { abs: { x: 100, y: 50, w: 300, h: 200 }, contentPos: { x: 4, y: 6 },
        slots: new Map([['f1', { x: 10, y: 20, w: 50, h: 40 }], ['f2', { x: 70, y: 20, w: 30, h: 40 }]]) }],
      ['/empty', { abs: { x: 0, y: 0, w: 10, h: 10 }, contentPos: { x: 0, y: 0 }, slots: new Map() }],
      ['/noabs', { contentPos: { x: 0, y: 0 }, slots: new Map([['x', { x: 0, y: 0, w: 1, h: 1 }]]) }],
    ]) };
    const origin = (f: any) => ({ x: f.abs.x + 1, y: f.abs.y + 2 });
    assert.deepStrictEqual(vc.slotRects(frames, origin), [
      { x: 115, y: 78, w: 50, h: 40 },
      { x: 175, y: 78, w: 30, h: 40 },
    ]);
    assert.deepStrictEqual(vc.slotRects(null, origin), []);
  });

  test('viewMissesAll: only true when there is content and none of it is in view', () => {
    assert.strictEqual(vc.viewMissesAll([], VIEW), false, 'nothing in scope → nothing to fit');
    assert.strictEqual(vc.viewMissesAll([{ x: 900, y: 0, w: 10, h: 10 }], VIEW), true);
    assert.strictEqual(vc.viewMissesAll([{ x: 900, y: 0, w: 10, h: 10 }, { x: 790, y: 590, w: 20, h: 20 }], VIEW), false);
  });

  test('boundsOfRects / visibleNodeRects', () => {
    assert.strictEqual(sf.boundsOfRects([]), null);
    assert.deepStrictEqual(sf.boundsOfRects([{ x: 0, y: 10, w: 5, h: 5 }, { x: -5, y: 0, w: 2, h: 2 }]), { x: -5, y: 0, w: 10, h: 15 });
    const nodes = [{ id: 'a', x: 10, y: 10 }, { id: 'b', x: 50, y: 50 }, { id: 'c', x: null, y: null }, { id: 'd', x: NaN, y: 1 }];
    assert.deepStrictEqual(sf.visibleNodeRects(nodes, new Set(['a', 'c', 'd']), () => 3), [{ x: 7, y: 7, w: 6, h: 6 }]);
  });

  test('scopeFitTarget: a user-zoomed view is kept unless the scope change emptied it', () => {
    const off = [{ x: 2000, y: 2000, w: 100, h: 50 }];
    const on = [{ x: 10, y: 10, w: 100, h: 50 }, ...off];
    // F26: Shelf, zoomed, everything re-packed off-screen → fit to what is left
    assert.deepStrictEqual(sf.scopeFitTarget(off, VIEW, { frames: true, userZoomed: true }), { x: 2000, y: 2000, w: 100, h: 50 });
    // zoomed, something still visible → the user's view wins (F2)
    assert.strictEqual(sf.scopeFitTarget(on, VIEW, { frames: true, userZoomed: true }), null);
    // Shelf, automatic view → a shrinking scope re-fits as before
    assert.deepStrictEqual(sf.scopeFitTarget(on, VIEW, { frames: true, userZoomed: false }), { x: 10, y: 10, w: 2090, h: 2040 });
    // Global never re-fits a view that still shows something …
    assert.strictEqual(sf.scopeFitTarget(on, VIEW, { frames: false, userZoomed: false }), null);
    // … but does when it shows nothing
    assert.ok(sf.scopeFitTarget(off, VIEW, { frames: false, userZoomed: false }));
    // never during a frame drag/resize, never without content
    assert.strictEqual(sf.scopeFitTarget(off, VIEW, { frames: true, userZoomed: true, interacting: true }), null);
    assert.strictEqual(sf.scopeFitTarget([], VIEW, { frames: true, userZoomed: false }), null);
  });

  function stubView(k: number, tx: number, ty: number) {
    g.window = { innerWidth: 800, innerHeight: 600 };
    g.svg = { node: () => ({ clientWidth: 800, clientHeight: 600 }) };
    g.d3 = { zoomTransform: () => ({ x: tx, y: ty, k }) };
    g.viewportRect = vc.viewportRect;
    const calls: number[][] = [];
    g.fitToRect = (...a: number[]) => { calls.push(a); };
    return calls;
  }

  test('refitAfterScope (Shelf): fits the in-scope slots when the zoomed view shows none of them', () => {
    const calls = stubView(4, -8000, -8000);           // zoomed far into the old layout
    g.usesFrames = () => true;
    g.innerOrigin = (f: any) => ({ x: f.abs.x, y: f.abs.y });
    g.slotRects = vc.slotRects;
    g.state = { userZoomed: true, _frameInteracting: false, frames: { byPath: new Map([
      ['/only', { abs: { x: 20, y: 30, w: 200, h: 100 }, contentPos: { x: 0, y: 0 }, slots: new Map([['f', { x: 5, y: 5, w: 60, h: 40 }]]) }],
    ]) } };
    sf.refitAfterScope();
    assert.deepStrictEqual(calls, [[25, 35, 85, 75, 0]]);
    // view already over the slot → untouched
    const calls2 = stubView(1, 0, 0);
    sf.refitAfterScope();
    assert.deepStrictEqual(calls2, []);
  });

  test('refitAfterScope (Global): fits only the visible nodes, not stale out-of-scope positions', () => {
    const calls = stubView(6, -60000, -60000);
    g.usesFrames = () => false;
    g.nodeRadius = () => 5;
    g.getVisibleNodeIds = () => new Set(['in']);
    g.state = { userZoomed: true, currentNodes: [{ id: 'in', x: 100, y: 100 }, { id: 'stale', x: 9000, y: 9000 }] };
    sf.refitAfterScope();
    assert.deepStrictEqual(calls, [[95, 95, 105, 105, 0]]);
  });

  test('scheduleScopeRefit debounces to one check after the re-pack glide', async () => {
    let n = 0;
    stubView(1, 0, 0);
    g.usesFrames = () => false;
    g.nodeRadius = () => 5;
    g.getVisibleNodeIds = () => new Set(['a']);
    g.state = { userZoomed: true, currentNodes: [{ id: 'a', x: 5000, y: 5000 }] };
    g.fitToRect = () => { n++; };
    sf.scheduleScopeRefit();
    sf.scheduleScopeRefit();
    await new Promise(r => setTimeout(r, sf.SCOPE_FIT_DELAY_MS + 50));
    assert.strictEqual(n, 1);
  });
});
