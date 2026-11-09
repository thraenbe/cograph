import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const cl = require('../../../src/webview/crossLinks.js');
const hi = require('../../../src/webview/hoverIndex.js');
const SRC = path.resolve(__dirname, '../../../src/webview');
const g = global as any;

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(bx - ax, by - ay);

// fb14 D2 (1.4 tester: "the arrows are see-through and so is the head; it looks odd where they overlap").
suite('arrowheads: line ends inside an opaque head whose tip is on the rim (fb14 D2)', () => {
  const refX = (): number => {
    const src = fs.readFileSync(path.join(SRC, 'rendering.js'), 'utf8');
    const m = /\.attr\('id', 'arrow'\)[\s\S]*?\.attr\('refX', ([\d.]+)\)/.exec(src);
    assert.ok(m, '#arrow marker found');
    return Number(m![1]);
  };

  test('with arrows the line stops ARROW_TRIM short of the target rim, and the marker tip lands exactly on the rim', () => {
    const e = cl.rimEnds({}, 0, 0, 100, 0, 5, 8, cl.ARROW_TRIM);
    assert.strictEqual(e.x1, 5, 'starts on the source rim');
    assert.ok(e.x2 < 100 - 8, 'stops before the target rim');
    // #arrow: viewBox 10 wide, ARROW_HEAD graph units long; refX sits on the line end, the tip is at x = 10
    const tip = e.x2 + ((10 - refX()) / 10) * cl.ARROW_HEAD;
    assert.ok(Math.abs(tip - (100 - 8)) < 1e-9, `tip ${tip} on the rim 92`);
    assert.ok(refX() > 0, 'the line runs a little under the head (no seam), never past its tip');
  });

  test('without arrows the line runs rim to rim', () => {
    const e = cl.rimEnds({}, 0, 0, 0, 50, 5, 8, 0);
    assert.deepStrictEqual([e.x1, e.y1, e.x2, e.y2], [0, 5, 0, 42]);
  });

  test('touching circles: the end never passes the start rim', () => {
    const e = cl.rimEnds({}, 0, 0, 12, 0, 5, 5, cl.ARROW_TRIM);
    assert.ok(e.x2 >= e.x1);
  });

  test('links fade by stroke-opacity, so the context-stroke head stays opaque', () => {
    const rendering = fs.readFileSync(path.join(SRC, 'rendering.js'), 'utf8');
    const frame = fs.readFileSync(path.join(SRC, 'frameRender.js'), 'utf8');
    const body = /function renderLinks[\s\S]*?\n}\n/.exec(rendering)![0];
    assert.ok(/\.attr\('stroke-opacity', d => d\.pending/.test(body), 'renderLinks');
    assert.ok(!/\.attr\('opacity'/.test(body), 'no element opacity on links (it would fade the head too)');
    assert.ok(/links\.attr\('stroke-opacity', d => d\.pending \? 0\.25 : linkRestOpacity\(\)\)/.test(frame), 'Shelf frames');
  });
});

// fb14 D5: the "arrow to the parent folder" was the hovered function's caller in the root
// frame, drawn centre to centre across the canvas (1531 px at k 3.2, start off-screen).
suite('hover cross links: real line on screen, short stub otherwise (fb14 D5)', () => {
  const H = 'code/vis.py::animate';
  const frame = { x: 0, y: 0, w: 400, h: 300 };
  const ctx = (view: any) => ({
    view, radiusOf: () => 6, frameRectOf: () => frame, trim: cl.ARROW_TRIM, stubMax: 60,
  });
  const caller = { source: 'main.py::visualize', target: H, count: 1, pending: false, x1: 900, y1: -800, x2: 100, y2: 200 };
  const callee = { source: H, target: 'io.py::load', count: 1, pending: false, x1: 100, y1: 200, x2: 380, y2: 200 };

  test('partner on screen: rim to rim, head trimmed, no stub', () => {
    const [l] = cl.shapeHoverLinks([callee], H, ctx({ x: 0, y: 0, w: 800, h: 600 }));
    assert.strictEqual(l.stub, false);
    assert.strictEqual(l.x1, 106);
    assert.ok(Math.abs(l.x2 - (380 - 6 - cl.ARROW_TRIM)) < 1e-9);
  });

  test('incoming call from off screen: a stub from the frame edge INTO the hovered node, not a line to the caller', () => {
    const [l] = cl.shapeHoverLinks([caller], H, ctx({ x: 0, y: 0, w: 800, h: 600 }));
    assert.strictEqual(l.stub, true);
    assert.ok(dist(l.x1, l.y1, l.x2, l.y2) <= 60, 'short');
    assert.ok(Math.abs(dist(l.x2, l.y2, 100, 200) - (6 + cl.ARROW_TRIM)) < 1e-9, 'ends at the hovered rim (head tip on it)');
    // and it points FROM the caller's direction
    const ux = (900 - 100), uy = (-800 - 200);
    assert.ok((l.x1 - 100) * ux + (l.y1 - 200) * uy > 0, 'starts on the caller side');
  });

  test('outgoing call to an off-screen node: the stub leaves the hovered node and stops at its frame edge', () => {
    const near = { ...callee, x2: 2000, y2: 200 };   // far right, off screen
    const [l] = cl.shapeHoverLinks([near], H, { ...ctx({ x: 0, y: 0, w: 800, h: 600 }), stubMax: 1000 });
    assert.strictEqual(l.stub, true);
    assert.strictEqual(l.x1, 106, 'from the hovered rim');
    assert.strictEqual(l.x2, 400, 'to the frame edge (x = 400), not across the canvas');
  });

  test('no viewport known (DOM-less caller): the real line is kept', () => {
    const [l] = cl.shapeHoverLinks([caller], H, ctx(null));
    assert.strictEqual(l.stub, false);
  });

  test('rayExit: exit distance from inside, null from outside', () => {
    assert.strictEqual(cl.rayExit(frame, { x: 100, y: 100 }, 0, -1), 100);
    assert.strictEqual(cl.rayExit(frame, { x: 500, y: 100 }, 1, 0), null);
  });
});

// fb14 D4: hover focus — lines above the nodes, neighbours full, the rest dimmed, exact restore.
suite('hover focus: lift, neighbours, exact restore (fb14 D4)', () => {
  function world() {
    const dom = new JSDOM('<!DOCTYPE html><body><svg><g id="root"><g class="links"></g><g class="nodes"></g><g id="top"></g></g></svg></body>');
    const doc = dom.window.document;
    const NS = 'http://www.w3.org/2000/svg';
    const root = doc.getElementById('root') as any;
    const linksG = root.querySelector('g.links');
    const nodesG = root.querySelector('g.nodes');
    const top = doc.getElementById('top') as any;
    const mk = (parent: any, tag: string, datum: any) => {
      const el: any = doc.createElementNS(NS, tag);
      el.__data__ = datum;
      parent.appendChild(el);
      return el;
    };
    const L = [
      { source: 'caller', target: 'h' },   // incoming
      { source: 'other', target: 'far' },  // unrelated, between the two lit ones
      { source: 'h', target: 'callee' },   // outgoing
      { source: 'x', target: 'y' },
    ].map(d => mk(linksG, 'line', d));
    const N = ['h', 'caller', 'callee', 'other', 'far', 'x', 'y', 'partner'].map(id => mk(nodesG, 'circle', { id }));
    const sel = (els: any[]) => ({ nodes: () => els });
    const h = hi.createHoverIndex();
    h.sync(sel(L), sel([]));
    h.syncNodes([sel(N), null]);
    const after = (a: any, b: any) => !!(b.compareDocumentPosition(a) & 4 /* a FOLLOWS b */);
    return { root, linksG, nodesG, top, L, N, h, after };
  }

  test('an incoming line is lifted above every node', () => {
    const w = world();
    w.h.focus(w.root, 'h', 2, [], () => w.top);
    assert.ok(w.N.every((n: any) => w.after(w.L[0], n)), 'caller -> h painted after (above) all nodes');
    assert.ok(w.N.every((n: any) => !w.after(w.L[1], n)), 'an unrelated line stays below');
  });

  test('an outgoing line is lifted above every node', () => {
    const w = world();
    w.h.focus(w.root, 'h', 2, [], () => w.top);
    assert.ok(w.N.every((n: any) => w.after(w.L[2], n)), 'h -> callee painted after (above) all nodes');
  });

  test('callers, callees, cross partners and the node itself are marked; nothing else', () => {
    const w = world();
    const ids = w.h.focus(w.root, 'h', 2, ['partner'], () => w.top);
    const nb = w.N.filter((n: any) => n.classList.contains(hi.HI_NB_CLASS)).map((n: any) => n.__data__.id).sort();
    assert.deepStrictEqual(nb, ['callee', 'caller', 'h', 'partner']);
    assert.deepStrictEqual([...ids].sort(), ['callee', 'caller', 'h', 'partner']);
    assert.ok(!w.root.classList.contains(hi.HI_FOCUS_CLASS), 'no dim before the dwell');
    w.h.dim();
    assert.ok(w.root.classList.contains(hi.HI_FOCUS_CLASS) && w.root.classList.contains(hi.HI_ROOT_CLASS));
  });

  test('leave restores exactly: line order, parents and classes', () => {
    const w = world();
    const before = [...w.linksG.children];
    w.h.focus(w.root, 'h', 2, ['partner'], () => w.top);
    w.h.dim();
    assert.strictEqual(w.h.liftedCount(), 2);
    w.h.clear();
    assert.deepStrictEqual([...w.linksG.children], before, 'same lines, same order');
    assert.strictEqual(w.top.children.length, 0);
    assert.ok([...w.L, ...w.N].every((el: any) => el.classList.length === 0), 'no class left behind');
    assert.ok(!w.root.classList.contains(hi.HI_FOCUS_CLASS) && !w.root.classList.contains(hi.HI_ROOT_CLASS));
  });

  test('unlift (before a re-render) puts lines home but keeps the focus classes for the refresh', () => {
    const w = world();
    w.h.focus(w.root, 'h', 2, [], () => w.top);
    w.h.dim();
    w.h.unlift();
    assert.strictEqual(w.linksG.children.length, 4);
    assert.ok(w.root.classList.contains(hi.HI_FOCUS_CLASS));
  });

  test('a plain highlight (glyph / library hover) neither lifts nor marks', () => {
    const w = world();
    w.h.highlight(w.root, 'h', 2);
    w.h.dim();
    assert.strictEqual(w.top.children.length, 0);
    assert.ok(!w.root.classList.contains(hi.HI_FOCUS_CLASS));
    assert.ok(w.N.every((n: any) => !n.classList.contains(hi.HI_NB_CLASS)));
  });

  test('the stylesheet dims non-neighbours to 0.2 only under focus, and lifted lines take no pointer', () => {
    const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
    assert.ok(/#graph g\.cg-focus circle\.regular-node:not\(\.cg-nb\) \{ fill-opacity: 0\.2; stroke-opacity: 0\.2; \}/.test(css));
    assert.ok(/#graph g\.hl-links > line, #graph g\.f-hl > line \{ pointer-events: none; \}/.test(css));
  });
});

suite('Shelf lift layer (fb14 D4)', () => {
  const GLOBALS = ['state', 'document'];
  const saved: Record<string, unknown> = {};
  setup(() => { for (const k of GLOBALS) { saved[k] = g[k]; } if (g.state === undefined) { g.state = {}; } });
  teardown(() => { for (const k of GLOBALS) { g[k] = saved[k]; } });

  test('frameLiftLayer: one g.f-hl per frame, above f-nodes and below f-labels; non-frame lines are left alone', () => {
    const fr = require('../../../src/webview/frameRender.js');
    const dom = new JSDOM('<!DOCTYPE html><body><svg><g class="frame"><g class="f-slots"></g><g class="f-links"><line/></g><g class="f-nodes"></g><g class="f-labels"></g></g><g class="links"><line/></g></svg></body>');
    const doc = dom.window.document;
    const line = doc.querySelector('g.f-links line');
    const hl = fr.frameLiftLayer(line);
    const kids = [...doc.querySelector('g.frame')!.children].map((c: any) => c.getAttribute('class'));
    assert.deepStrictEqual(kids, ['f-slots', 'f-links', 'f-nodes', 'f-hl', 'f-labels']);
    assert.strictEqual(fr.frameLiftLayer(line), hl, 'reused');
    assert.strictEqual(fr.frameLiftLayer(doc.querySelector('g.links line')), null);
  });

  test('frameLiftLayer finds the frame from the line data while the links layer is parked by the zoom LOD', () => {
    const fr = require('../../../src/webview/frameRender.js');
    const d3 = require('d3');
    const dom = new JSDOM('<!DOCTYPE html><body><svg><g class="frame"><g class="f-nodes"></g><g class="f-labels"></g></g></svg></body>');
    const doc = dom.window.document;
    const frameEl = doc.querySelector('g.frame');
    const parked = doc.createElementNS('http://www.w3.org/2000/svg', 'g');   // detached g.f-links
    parked.setAttribute('class', 'f-links');
    const line: any = doc.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.__data__ = { _s: { id: 'a', _frame: '/r/a' }, _t: { id: 'b', _frame: '/r/a' } };
    parked.appendChild(line);
    const savedSel = fr.__frState.frameSel;
    fr.__frState.frameSel = new Map([['/r/a', d3.select(frameEl)]]);
    try {
      const hl = fr.frameLiftLayer(line);
      assert.ok(hl && hl.parentNode === frameEl && hl.getAttribute('class') === 'f-hl');
    } finally { fr.__frState.frameSel = savedSel; }
  });
});

// fb14 D5 through the real Shelf path: updateCrossHover with a viewport.
suite('updateCrossHover: off-screen caller becomes a short stub (fb14 D5)', () => {
  const GLOBALS = ['document', 'state', 'settings', 'linkG', 'getCSSVar', 'isDrilldown', 'svg', 'd3', 'window', 'viewportRect',
    'individualLinksFor', 'indexCrossByNode', 'aggregateCrossPairs', 'routeBundles', 'edgeWeightScale',
    'shapeHoverLinks', 'ARROW_TRIM', 'nodeRadius'];
  const saved: Record<string, unknown> = {};
  let fr: any;
  let root: any;

  setup(() => {
    for (const k of GLOBALS) { saved[k] = g[k]; }
    const dom = new JSDOM('<!DOCTYPE html><body><svg id="s"></svg></body>');
    g.document = dom.window.document;
    const d3 = require('d3');
    root = d3.select(dom.window.document.getElementById('s'));
    const frames = new Map([
      ['/r', { path: '/r', kind: 'root', abs: { x: 0, y: -3000, w: 4000, h: 4000 } }],
      ['/r/code', { path: '/r/code', kind: 'folder', abs: { x: 0, y: 0, w: 600, h: 400 } }],
    ]);
    Object.assign(g, {
      state: { layoutEngine: 'shelf', frames: { byPath: frames }, _frameHoverId: null, currentZoom: 1 },
      settings: { linkThickness: 1, arrows: true },
      linkG: root.append('g').attr('class', 'links'),
      getCSSVar: () => '#5aabff', isDrilldown: () => true, edgeWeightScale: () => 1,
      svg: root, d3, window: { innerWidth: 800, innerHeight: 600 },
      viewportRect: require('../../../src/webview/viewCull.js').viewportRect,
      individualLinksFor: cl.individualLinksFor, indexCrossByNode: cl.indexCrossByNode,
      aggregateCrossPairs: cl.aggregateCrossPairs, routeBundles: cl.routeBundles,
      shapeHoverLinks: cl.shapeHoverLinks, ARROW_TRIM: cl.ARROW_TRIM, nodeRadius: () => 6,
    });
    delete require.cache[require.resolve('../../../src/webview/frameRender.js')];
    fr = require('../../../src/webview/frameRender.js');
    const animate = { id: 'animate', x: 100, y: 300, _frame: '/r/code' };
    const visualize = { id: 'visualize', x: 2500, y: -2500, _frame: '/r' };   // far above, off screen
    const load = { id: 'load', x: 400, y: 300, _frame: '/r' };                // on screen
    fr.__frState.byId = new Map([animate, visualize, load].map(n => [n.id, n]));
    fr.__frState.cross = [{ source: 'visualize', target: 'animate' }, { source: 'animate', target: 'load' }];
  });

  teardown(() => { for (const k of GLOBALS) { g[k] = saved[k]; } });

  test('the off-screen caller gets a stub of at most 120 px; the on-screen callee a full line', () => {
    g.state._frameHoverId = 'animate';
    fr.updateCrossHover();
    const lines = root.selectAll('line.cross-hover').nodes();
    assert.strictEqual(lines.length, 2);
    const len = (l: any) => dist(+l.getAttribute('x1'), +l.getAttribute('y1'), +l.getAttribute('x2'), +l.getAttribute('y2'));
    const stub = lines.find((l: any) => l.classList.contains('cross-stub'));
    const full = lines.find((l: any) => !l.classList.contains('cross-stub'));
    assert.ok(stub && full, 'one of each');
    assert.ok(len(stub) <= 120, `stub ${len(stub)} px`);
    assert.ok(dist(+stub.getAttribute('x1'), +stub.getAttribute('y1'), 2500, -2500) > 3000, 'never reaches the caller');
    assert.strictEqual(full.getAttribute('marker-end'), 'url(#arrow)');
    assert.ok(Math.abs(+full.getAttribute('x2') - (400 - 6 - cl.ARROW_TRIM)) < 1e-9, 'rim to rim, head trimmed');
  });
});
