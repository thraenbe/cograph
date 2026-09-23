import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const frameRenderSrc = fs.readFileSync(
  path.resolve(__dirname, '../../../src/webview/frameRender.js'), 'utf8');

suite('frame title drag — coordinate container (R1 jump fix)', () => {
  test('the title drag is configured with the stable zoomed-layer container', () => {
    const i = frameRenderSrc.indexOf('createFrameTitleDrag(frameDragDeps())');
    assert.ok(i > 0);
    const chain = frameRenderSrc.slice(i, frameRenderSrc.indexOf('.call(titleDrag)', i));
    assert.ok(/\.container\(function \(\) \{ return g\.node\(\); \}\)/.test(chain),
      'without .container(() => g.node()) d3-drag measures the pointer against ' +
      'the dragged frame’s own moving <g> — the traced 249→209→378 leap');
  });
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const frames = require('../../../src/webview/frames.js');

suite('clampFrameLocal — four-side drag containment (R1)', () => {
  function makeFs() {
    const byPath = new Map<string, any>([
      ['/r', { path: '/r', kind: 'root', parent: null, inner: { w: 5000, h: 5000 }, local: { x: 0, y: 0, w: 5000, h: 5000 } }],
      ['/r/p', { path: '/r/p', kind: 'folder', parent: '/r', inner: { w: 600, h: 400 }, local: { x: 40, y: 40, w: 700, h: 500 } }],
      ['/r/p/c', { path: '/r/p/c', kind: 'folder', parent: '/r/p', inner: { w: 100, h: 80 }, local: { x: 10, y: 10, w: 200, h: 150 } }],
      ['/r/big', { path: '/r/big', kind: 'folder', parent: '/r/p', inner: { w: 100, h: 80 }, local: { x: 0, y: 0, w: 900, h: 700 } }],
    ]);
    return { root: '/r', byPath };
  }

  test('positions inside the parent pass through unchanged', () => {
    const fs2 = makeFs();
    assert.deepStrictEqual(frames.clampFrameLocal(fs2, '/r/p/c', { x: 120, y: 90 }), { x: 120, y: 90 });
  });

  test('clamps on all four sides of the parent inner rect', () => {
    const fs2 = makeFs();
    // parent inner 600x400, child 200x150 -> max local 400x250
    assert.deepStrictEqual(frames.clampFrameLocal(fs2, '/r/p/c', { x: -50, y: -20 }), { x: 0, y: 0 });
    assert.deepStrictEqual(frames.clampFrameLocal(fs2, '/r/p/c', { x: 999, y: 999 }), { x: 400, y: 250 });
    assert.deepStrictEqual(frames.clampFrameLocal(fs2, '/r/p/c', { x: 500, y: 100 }), { x: 400, y: 100 });
  });

  test('a child larger than the parent falls back to the >=0 clamp', () => {
    const fs2 = makeFs();
    assert.deepStrictEqual(frames.clampFrameLocal(fs2, '/r/big', { x: -30, y: 60 }), { x: 0, y: 60 });
  });

  test('children of the root keep the classic >=0 clamp (canvas grows freely)', () => {
    const fs2 = makeFs();
    assert.deepStrictEqual(frames.clampFrameLocal(fs2, '/r/p', { x: 4000, y: -5 }), { x: 4000, y: 0 });
  });

  test('null/unknown inputs are passed through', () => {
    const fs2 = makeFs();
    assert.strictEqual(frames.clampFrameLocal(fs2, '/nope', { x: 1, y: 2 }).x, 1);
    assert.strictEqual(frames.clampFrameLocal(fs2, '/r/p/c', null), null);
  });
});

suite('frame drag wiring (R1, source contracts)', () => {
  test('the drag pin path clamps and keeps the ancestor chain ticked', () => {
    const i = frameRenderSrc.indexOf('function frameDragDeps');
    const deps = frameRenderSrc.slice(i, i + 900);
    assert.ok(deps.includes('clampFrameLocal(fs, path, pos)'), 'containment applied in deps.pin');
    assert.ok(/while \(p\) \{ tickFrame\(p\);/.test(deps), 'ancestors re-ticked during drags');
  });

  test('drop re-packs siblings; bundles hidden while dragging', () => {
    const i = frameRenderSrc.indexOf('createFrameTitleDrag(frameDragDeps())');
    const chain = frameRenderSrc.slice(i, frameRenderSrc.indexOf('.call(titleDrag)', i));
    assert.ok(chain.includes("on('end.repack'"), 'drop triggers a sibling re-pack');
    assert.ok(chain.includes("classed('bundles-hidden', true)"), 'bundles hidden on drag start');
    assert.ok(chain.includes("classed('bundles-hidden', false)"), 'bundles restored on drag end');
    assert.ok(frameRenderSrc.includes("mouseenter.afford"), 'hover affordance wired');
  });
});
