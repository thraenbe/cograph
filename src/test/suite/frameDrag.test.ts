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

  test('cross links are not rebuilt per move while bundles are hidden', () => {
    const i = frameRenderSrc.indexOf('onMoved: (path) =>');
    const body = frameRenderSrc.slice(i, i + 400);
    assert.ok(body.includes("classed('bundles-hidden')"),
      'onMoved must skip updateCrossLinks during a frame drag');
    const end = frameRenderSrc.slice(frameRenderSrc.indexOf("on('end.fitguard'"), frameRenderSrc.indexOf("on('end.repack'"));
    assert.ok(end.includes('updateCrossLinks()') || end.includes('onFrameMoveSettled()'),
      'release re-routes bundles once (develop routes it through onFrameMoveSettled)');
  });

  test('drop re-packs siblings; bundles hidden while dragging', () => {
    const i = frameRenderSrc.indexOf('createFrameTitleDrag(frameDragDeps())');
    const chain = frameRenderSrc.slice(i, frameRenderSrc.indexOf('.call(titleDrag)', i));
    assert.ok(chain.includes("on('end.repack'"), 'drop resolves overlaps');
    assert.ok(chain.includes('resolveDropOverlaps'), 'incremental resolver, not a full re-render');
    assert.ok(!chain.includes('applyFileClusters'), 'a full re-render would re-shelve the whole parent');
    assert.ok(chain.includes("classed('bundles-hidden', true)"), 'bundles hidden on drag start');
    assert.ok(chain.includes("classed('bundles-hidden', false)"), 'bundles restored on drag end');
    assert.ok(frameRenderSrc.includes("mouseenter.afford"), 'hover affordance wired');
  });
});

suite('resolveDropOverlaps — incremental drop resolution (R1)', () => {
  // frameRender globals: state/__fr plus frames.js helpers it calls.
  function world() {
    const mk = (path: string, parent: string | null, x: number, y: number, w: number, h: number, kind = 'folder') =>
      [path, { path, parent, kind, local: { x, y, w, h }, abs: { x: 0, y: 0, w, h }, inner: { w: w - 80, h: h - 110 }, children: [] as string[], pinned: false }] as const;
    const byPath = new Map<string, any>([
      mk('/r', null, 0, 0, 2000, 2000, 'root'),
      mk('/r/p', '/r', 0, 0, 1000, 900),
      mk('/r/p/a', '/r/p', 0, 0, 200, 150),
      mk('/r/p/b', '/r/p', 300, 0, 200, 150),
      mk('/r/p/c', '/r/p', 640, 0, 200, 150),
      mk('/r/p/far', '/r/p', 0, 500, 200, 150),
    ]);
    byPath.get('/r')!.children = ['/r/p'];
    byPath.get('/r/p')!.children = ['/r/p/a', '/r/p/b', '/r/p/c', '/r/p/far'];
    byPath.get('/r/p')!.inner = { w: 920, h: 760 };
    const fs2 = { root: '/r', byPath };
    (global as any).state = { frames: fs2, layoutMode: 'static', currentNodes: [] };
    (global as any).resolveAbs = frames.resolveAbs;
    (global as any).clampFrameLocal = frames.clampFrameLocal;
    (global as any).FRAME = frames.FRAME;
    (global as any).updateCrossLinks = () => {};
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const frModule = require('../../../src/webview/frameRender.js');
    return { fs2, fr: frModule };
  }

  test('only intersecting siblings move, minimally, with the gap; others stay', () => {
    const { fs2, fr: frr } = world();
    // dragged frame a dropped onto b's spot
    const a = fs2.byPath.get('/r/p/a');
    a.local = { x: 290, y: 0, w: 200, h: 150 };
    a.pinned = true;
    frr.resolveDropOverlaps({ path: '/r/p/a' });
    const b = fs2.byPath.get('/r/p/b');
    const c = fs2.byPath.get('/r/p/c');
    const far = fs2.byPath.get('/r/p/far');
    assert.ok(b.local.x >= 290 + 200 + frames.FRAME.GAP - 1, `b pushed right of a, got ${b.local.x}`);
    assert.deepStrictEqual({ x: far.local.x, y: far.local.y }, { x: 0, y: 500 }, 'non-intersecting sibling untouched');
    assert.deepStrictEqual({ x: a.local.x, y: a.local.y }, { x: 290, y: 0 }, 'the dropped frame itself stays');
    // NO cascade: c did not intersect the DROPPED rect, so it must not move
    assert.deepStrictEqual({ x: c.local.x, y: c.local.y }, { x: 640, y: 0 },
      'second-ring sibling stays even if b now overlaps it');
  });

  test('pinned siblings are never displaced', () => {
    const { fs2, fr: frr } = world();
    const a = fs2.byPath.get('/r/p/a');
    a.local = { x: 290, y: 0, w: 200, h: 150 };
    const b = fs2.byPath.get('/r/p/b');
    b.pinned = true;
    frr.resolveDropOverlaps({ path: '/r/p/a' });
    assert.deepStrictEqual({ x: b.local.x, y: b.local.y }, { x: 300, y: 0 }, 'user-pinned sibling stays');
  });

  test('no room in the parent → clamped, residual overlap accepted (capped)', () => {
    const { fs2, fr: frr } = world();
    const p2 = fs2.byPath.get('/r/p');
    p2.inner = { w: 520, h: 200 }; // barely fits a+b side by side
    const a = fs2.byPath.get('/r/p/a');
    a.local = { x: 290, y: 0, w: 200, h: 150 };
    frr.resolveDropOverlaps({ path: '/r/p/a' });
    const b = fs2.byPath.get('/r/p/b');
    assert.ok(b.local.x + b.local.w <= p2.inner.w + 1, `b stays inside the parent, got ${b.local.x + b.local.w}`);
  });
});

suite('drop position is sacred (R1c)', () => {
  test('with 12 siblings the dropped frame stays exactly at release (±1px); only intersecting siblings move', () => {
    const byPath = new Map<string, any>();
    byPath.set('/r', { path: '/r', parent: null, kind: 'root', local: { x: 0, y: 0, w: 8000, h: 8000 }, abs: { x: 0, y: 0, w: 8000, h: 8000 }, inner: { w: 8000, h: 8000 }, children: ['/r/p'], pinned: false });
    const kids: string[] = [];
    // 12 siblings in two shelf rows of 6 (220px pitch), plus the dragged d6
    for (let i = 0; i < 12; i++) {
      const p2 = `/r/p/s${i}`;
      kids.push(p2);
      byPath.set(p2, { path: p2, parent: '/r/p', kind: 'folder',
        local: { x: (i % 6) * 220, y: Math.floor(i / 6) * 180, w: 200, h: 160 },
        abs: { x: 0, y: 0, w: 200, h: 160 }, inner: { w: 120, h: 50 }, children: [], pinned: false });
    }
    const dragged = '/r/p/d6';
    kids.push(dragged);
    byPath.set(dragged, { path: dragged, parent: '/r/p', kind: 'folder',
      local: { x: 70, y: 50, w: 200, h: 160 }, // released overlapping s0 and s1's band
      abs: { x: 0, y: 0, w: 200, h: 160 }, inner: { w: 120, h: 50 }, children: [], pinned: true });
    byPath.set('/r/p', { path: '/r/p', parent: '/r', kind: 'folder',
      local: { x: 0, y: 0, w: 2000, h: 700 }, abs: { x: 0, y: 0, w: 2000, h: 700 },
      inner: { w: 1920, h: 560 }, children: kids, pinned: false });
    const fs2 = { root: '/r', byPath };
    (global as any).state = { frames: fs2, layoutMode: 'static', currentNodes: [] };
    (global as any).resolveAbs = frames.resolveAbs;
    (global as any).clampFrameLocal = frames.clampFrameLocal;
    (global as any).FRAME = frames.FRAME;
    const before = new Map(kids.map(k => [k, { ...byPath.get(k).local }]));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const frr = require('../../../src/webview/frameRender.js');
    frr.resolveDropOverlaps({ path: dragged });

    const d = byPath.get(dragged);
    assert.ok(Math.abs(d.local.x - 70) <= 1 && Math.abs(d.local.y - 50) <= 1,
      `dropped frame must stay at release, got ${d.local.x},${d.local.y}`);
    let movedCount = 0;
    for (const k of kids) {
      if (k === dragged) { continue; }
      const b4 = before.get(k)!;
      const now = byPath.get(k).local;
      const moved = Math.abs(now.x - b4.x) > 0.5 || Math.abs(now.y - b4.y) > 0.5;
      const intersectedDrop = b4.x < 70 + 200 + frames.FRAME.GAP && 70 < b4.x + 200 + frames.FRAME.GAP
        && b4.y < 50 + 160 + frames.FRAME.GAP && 50 < b4.y + 160 + frames.FRAME.GAP;
      if (moved) { movedCount++; }
      assert.ok(!moved || intersectedDrop,
        `${k} did not intersect the dropped rect and must keep its rect`);
    }
    assert.ok(movedCount >= 1 && movedCount <= 3,
      `only the intersecting siblings move, got ${movedCount}`);
  });
});

suite('node snap-back to its slot (W5)', () => {
  const g = global as any;
  const KEYS = ['state', 'isDrilldown', 'slotInteriorFor', 'innerOrigin', 'FRAME', 'resolveAbs', 'clampFrameLocal', 'updateCrossLinks'];
  let saved: Record<string, any>;
  let simCalls: string[];

  function world(layoutMode: string, fx: number, fy: number) {
    // Frame at abs (0,0), non-root: inner origin = PAD/PAD+TITLE+NAME_H; one
    // slot for a.ts whose interior is at content (0,0), 100x84 below the label.
    const f: any = {
      path: '/p/a', kind: 'folder', parent: '/p', abs: { x: 0, y: 0, w: 300, h: 260 },
      contentPos: { x: 0, y: 0 },
      slots: new Map([['file:a.ts', { x: 0, y: 0, w: 104, h: 100, file: 'a.ts', count: 2 }]]),
      slotOf: new Map([['n1', 'file:a.ts']]),
    };
    g.state = {
      layoutMode, layoutEngine: 'shelf',
      frames: { root: '/p', byPath: new Map([['/p/a', f]]) },
      simulation: {
        alphaTarget: (v: number) => { simCalls.push(`alphaTarget(${v})`); return g.state.simulation; },
        restart: () => { simCalls.push('restart'); return g.state.simulation; },
      },
    };
    g.isDrilldown = () => true; // frameRender's own usesFrames() needs it
    g.slotInteriorFor = frames.slotInteriorFor;
    g.innerOrigin = frames.innerOrigin;
    return { id: 'n1', _frame: '/p/a', fx, fy, x: fx, y: fy };
  }

  setup(() => { saved = {}; for (const k of KEYS) { saved[k] = g[k]; } simCalls = []; });
  teardown(() => { for (const k of KEYS) { g[k] = saved[k]; } });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const frr = require('../../../src/webview/frameRender.js');
  const io = { x: frames.FRAME.PAD, y: frames.FRAME.PAD + frames.FRAME.TITLE + frames.FRAME.NAME_H };

  test('a drop outside the slot interior reheats first, releases a microtask later', async () => {
    const d = world('dynamic', io.x + 500, io.y + 500);
    assert.strictEqual(frr.snapBackToSlot(d), true);
    assert.deepStrictEqual(simCalls, ['alphaTarget(0.3)', 'restart'],
      'the facade reheat happens WHILE the pin is set (its scan bumps this frame)');
    assert.ok(d.fx != null, 'still pinned synchronously');
    await Promise.resolve();
    assert.strictEqual(d.fx, null, 'released after the facade scan');
    assert.strictEqual(d.fy, null);
    assert.ok(simCalls.includes('alphaTarget(0)'), 'cooled after the release');
  });

  test('a drop inside the slot interior keeps the normal release path', () => {
    const d = world('dynamic', io.x + 10, io.y + frames.SLOT.LABEL_H + 10);
    assert.strictEqual(frr.snapBackToSlot(d), false);
    assert.deepStrictEqual(simCalls, [], 'no reheat when nothing snaps');
  });

  test('Static never snaps back (drops stay pinned where released)', () => {
    const d = world('static', io.x + 500, io.y + 500);
    assert.strictEqual(frr.snapBackToSlot(d), false);
  });

  test('the drag end handler consults the snap-back before the classic release', () => {
    const renderingSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../src/webview/rendering.js'), 'utf8');
    const end = renderingSrc.slice(renderingSrc.indexOf(".on('end', (event, d) => {"),
      renderingSrc.indexOf('// ── Tick'));
    assert.ok(end.indexOf('snapBackToSlot(d)') < end.indexOf('coolAfterDrag(event)'),
      'snap-back takes the release over before coolAfterDrag');
  });
});
