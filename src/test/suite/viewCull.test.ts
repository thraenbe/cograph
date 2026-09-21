import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vc = require('../../../src/webview/viewCull.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

const F = (path: string, x: number, y: number, w = 100, h = 100) => ({ path, abs: { x, y, w, h } });

suite('viewCull', () => {
  test('viewportRect inverts the zoom transform and pads in screen pixels', () => {
    assert.deepStrictEqual(vc.viewportRect({ x: 0, y: 0, k: 1 }, 800, 600), { x: 0, y: 0, w: 800, h: 600 });
    // zoomed in 2×, panned so graph point (100, 50) sits at the top-left corner
    assert.deepStrictEqual(vc.viewportRect({ x: -200, y: -100, k: 2 }, 800, 600), { x: 100, y: 50, w: 400, h: 300 });
    // 40 px padding on screen = 80 graph units at k = 0.5
    assert.deepStrictEqual(vc.viewportRect({ x: 0, y: 0, k: 0.5 }, 800, 600, 40), { x: -80, y: -80, w: 1760, h: 1360 });
  });

  test('culler: first update hides what is outside; later updates report only flips', () => {
    const c = vc.createFrameCuller();
    const frames = [F('/in', 10, 10), F('/edge', 750, 10), F('/out', 2000, 10)];
    const view = { x: 0, y: 0, w: 800, h: 600 };
    assert.strictEqual(c.isVisible('/out'), true, 'everything counts as visible before the first update');
    assert.deepStrictEqual(c.update(frames, view), { shown: [], hidden: ['/out'] });
    assert.deepStrictEqual(c.update(frames, view), { shown: [], hidden: [] }, 'no change → no DOM writes');
    assert.strictEqual(c.visibleCount(), 2);
    // pan right: /in leaves, /out enters
    assert.deepStrictEqual(c.update(frames, { x: 1500, y: 0, w: 800, h: 600 }), { shown: ['/out'], hidden: ['/in', '/edge'] });
    assert.ok(c.isVisible('/out') && !c.isVisible('/in'));
  });

  test('culler: touching edges do not count as visible; nested frames are judged independently', () => {
    const c = vc.createFrameCuller();
    const parent = F('/p', 0, 0, 3000, 3000);
    const child = F('/p/c', 2500, 2500, 200, 200);
    const r = c.update([parent, child, F('/touch', 800, 0)], { x: 0, y: 0, w: 800, h: 600 });
    assert.deepStrictEqual(r.hidden.sort(), ['/p/c', '/touch']);
    assert.ok(c.isVisible('/p'), 'the huge parent intersects the viewport');
  });

  test('culler: reset (after a re-render) makes everything visible again', () => {
    const c = vc.createFrameCuller();
    c.update([F('/out', 5000, 0)], { x: 0, y: 0, w: 800, h: 600 });
    c.reset();
    assert.strictEqual(c.isVisible('/out'), true);
    assert.strictEqual(c.visibleCount(), -1);
    assert.deepStrictEqual(c.update([F('/out', 5000, 0)], { x: 0, y: 0, w: 800, h: 600 }).hidden, ['/out']);
  });

  test('a frame added between updates starts visible in the DOM → reported hidden when off-screen', () => {
    const c = vc.createFrameCuller();
    c.update([F('/a', 0, 0)], { x: 0, y: 0, w: 800, h: 600 });
    // new off-screen frame: its <g> was just created visible → must be reported hidden
    assert.deepStrictEqual(c.update([F('/a', 0, 0), F('/new', 9000, 0)], { x: 0, y: 0, w: 800, h: 600 }),
      { shown: [], hidden: ['/new'] });
  });

  test('LOD: three layers with hysteresis (labels → links → function nodes)', () => {
    const lod = vc.createLod({ band: 0.1 });
    const at = { labels: 0.5, links: 0.4, nodes: 0.3 };
    assert.deepStrictEqual(lod.update(1, at), { labels: true, links: true, nodes: true, changed: false });
    assert.deepStrictEqual(lod.update(0.47, at), { labels: true, links: true, nodes: true, changed: false }, 'inside the band: keep');
    assert.deepStrictEqual(lod.update(0.44, at), { labels: false, links: true, nodes: true, changed: true });
    assert.deepStrictEqual(lod.update(0.47, at), { labels: false, links: true, nodes: true, changed: false }, 'must reach the threshold to re-appear');
    assert.deepStrictEqual(lod.update(0.31, at), { labels: false, links: false, nodes: true, changed: true });
    assert.deepStrictEqual(lod.update(0.1, at), { labels: false, links: false, nodes: false, changed: true });
    assert.deepStrictEqual(lod.update(0.35, at), { labels: false, links: false, nodes: true, changed: true });
    assert.deepStrictEqual(lod.update(0.6, at), { labels: true, links: true, nodes: true, changed: true });
    assert.deepStrictEqual(lod.current(), { labels: true, links: true, nodes: true });
    assert.deepStrictEqual(vc.createLod().update(0.01, {}), { labels: true, links: true, nodes: true, changed: false }, 'no thresholds → everything drawn');
  });
});
