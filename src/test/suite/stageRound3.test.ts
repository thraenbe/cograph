import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const fc = require('../../../src/webview/frameChrome.js');
const sl = require('../../../src/webview/stageLabels.js');
const sa = require('../../../src/webview/stageApi.js');
const frames = require('../../../src/webview/frames.js');

/** Width in ems: 0.6 em a character, the same for every test here. */
const em = (t: string) => t.length * 0.6;
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// Tour review round 3, M3: file names on the overview were cut at a zoom where the whole name fits, and a zoomed-in
// box of 330 px still read "disco…ts.js · 7". The name is now fitted to the zoom, in screen pixels.
suite('slot names fitted to the zoom (tour review round 3, M3)', () => {
  test('a name that fits keeps its usual size and its count', () => {
    assert.deepStrictEqual(fc.slotLabelFit('db.py', 6, 120, 1, em, 1, ''), { text: 'db.py · 6', size: 9, tail: true });
  });

  test('zoomed in, a box of 330 px names discounts.js whole, at most 13 px on screen (the old rule cut it at any zoom)', () => {
    const k = 3.65;
    const fit = fc.slotLabelFit('discounts.js', 7, 89, k, em, 1, '');
    assert.strictEqual(fit.text, 'discounts.js · 7');
    assert.ok(near(fit.size * k, fc.SLOT_NAME.MAX_PX), `13 px on screen, got ${fit.size * k}`);
    assert.strictEqual(fc.slotLabelText('discounts.js', 7, 89, 5), 'disco…ts.js · 7', 'the round-2 rule, zoom-blind');
  });

  test('a name shrinks towards 11 px before anything is cut; then the count goes before the name is cut', () => {
    const fit = fc.slotLabelFit('checkout.py', 2, 90, 1, em, 1.5, '');
    assert.strictEqual(fit.text, 'checkout.py', 'the whole name, without its count (the dots in the box count it)');
    assert.ok(fit.size >= fc.SLOT_NAME.MIN_PX && fit.size <= 13.5, `between 11 px and its usual 13.5, got ${fit.size}`);
    const shrunk = fc.slotLabelFit('catalog.py', 2, 110, 1, em, 1.5, '');
    assert.strictEqual(shrunk.text, 'catalog.py · 2');
    assert.ok(shrunk.size < 13.5 && shrunk.size >= 11, 'smaller than usual, the count kept');
  });

  test('the ↗ cue gives way to the whole name, and the result says so', () => {
    assert.deepStrictEqual(fc.slotLabelFit('orders.py', 1, 70, 1, em, 1.5, ' ↗5').text, 'orders.py');
    assert.strictEqual(fc.slotLabelFit('orders.py', 1, 70, 1, em, 1.5, ' ↗5').tail, false);
    assert.strictEqual(fc.slotLabelFit('orders.py', 1, 200, 1, em, 1.5, ' ↗5').tail, true, 'with room the cue stays');
  });

  test('a name that does not fit at 11 px is cut at 11 px, count kept; a closer zoom shows it whole', () => {
    const fit = fc.slotLabelFit('test_coupons.py', 2, 70, 1, em, 1.5, '');
    assert.deepStrictEqual(fit, { text: 'te…py · 2', size: 11, tail: true });
    assert.strictEqual(fc.slotLabelFit('test_coupons.py', 2, 70, 2, em, 1.5, '').text, 'test_coupons.py · 2');
  });

  test('zoomed out below 11 px, the name stays at its usual graph size (the old look)', () => {
    const fit = fc.slotLabelFit('catalog.py', 2, 70, 0.5, em, 1, '');
    assert.strictEqual(fit.size, 9);
    assert.strictEqual(fit.text, 'catalog.py');
  });
});

suite('slot names follow the zoom in the Shelf engine (tour review round 3, M3)', () => {
  const g = global as any;
  const GLOBALS = ['document', 'getComputedStyle', 'd3', 'state', 'settings', 'FRAME', 'SLOT', 'vscode', 'nodeColor',
    'gitDeletedColor', 'getLanguageColor', 'slotLabelText', 'slotLabelFit', 'slotLabelRoom', 'SLOT_NAME', 'nodeRadius', 'svg'];
  const saved: Record<string, unknown> = {};
  let svg: any;
  setup(() => {
    for (const k of GLOBALS) { saved[k] = g[k]; }
    const dom = new JSDOM('<!DOCTYPE html><body><svg id="s"></svg></body>');
    const d3 = require('d3');
    svg = d3.select(dom.window.document.getElementById('s'));
    Object.assign(g, {
      document: dom.window.document, getComputedStyle: () => ({ getPropertyValue: () => '' }), d3,
      state: { gitMode: false, hiddenFolders: new Set(), currentZoom: 1 }, settings: { textSize: 1 },
      FRAME: frames.FRAME, SLOT: frames.SLOT, vscode: { postMessage: () => undefined }, nodeColor: () => '#ccc',
      gitDeletedColor: () => '#e5534b', getLanguageColor: () => '#888',
      slotLabelText: fc.slotLabelText, slotLabelFit: fc.slotLabelFit, slotLabelRoom: fc.slotLabelRoom, SLOT_NAME: fc.SLOT_NAME,
      nodeRadius: () => 5, svg,
    });
  });
  teardown(() => { for (const k of GLOBALS) { g[k] = saved[k]; } });

  function render(file: string, w: number, k: number, extra: any = {}) {
    g.state.currentZoom = k;
    delete require.cache[require.resolve('../../../src/webview/frameRender.js')];
    const fr = require('../../../src/webview/frameRender.js');
    const frame = { kind: 'root', path: '/r', abs: { x: 0, y: 0, w: w + 8, h: 200 }, contentPos: { x: 0, y: 0 }, slots: new Map([['a', { file, x: 0, y: 0, w, h: 60, count: 2 }]]) };
    const sub = svg.append('g').attr('class', extra.cls || null);
    sub.append('g').attr('class', 'f-slots');
    fr.renderFrameSlots(frame, sub);
    fr.__frState.frameSel = new Map([['/r', sub]]);
    const label = () => sub.select('text.file-slot-label').node() as Element;
    return { fr, label, name: () => label().firstChild!.textContent, size: () => parseFloat(label().getAttribute('font-size')!) };
  }

  test('drawn for the zoom of the moment: a wide box at zoom 3.65 names its file whole, 13 px on screen', () => {
    const r = render('/r/web/discounts.js', 89, 3.65);
    assert.strictEqual(r.name(), 'discounts.js · 2');
    assert.ok(near(r.size() * 3.65, 13), `${r.size() * 3.65} px`);
  });

  test('a zoom fits the names again: cut at zoom 1, whole at zoom 3, small moves (< 2 %) are skipped', () => {
    const r = render('/r/tests/test_coupons.py', 70, 1);
    assert.ok(r.name()!.includes('…'), r.name()!);
    r.fr.refitSlotNames(3, false);
    assert.strictEqual(r.name(), 'test_coupons.py · 2');
    r.fr.refitSlotNames(1, false);
    assert.ok(r.name()!.includes('…'));
    r.fr.refitSlotNames(1.01, false);
    assert.ok(r.name()!.includes('…'), 'skipped');
  });

  test('in the same-file mode the ↗ cue shows after the name, and gives way when the name needs its room', () => {
    g.settings.textSize = 1.5;
    g.state.xfileCue = { outByFile: new Map([['/r/shop/orders.py', 5]]) };
    const r = render('/r/shop/orders.py', 70, 1, { cls: 'same-file-only' });
    const cue = r.label().querySelector('tspan.slot-xout')!;
    assert.strictEqual(r.name(), 'orders.py');
    assert.ok(cue.classList.contains('slot-xout-cut'), 'the cue is hidden by styles.css');
    const css = fs.readFileSync(path.join(__dirname, '../../../src/webview/styles.css'), 'utf8');
    assert.ok(css.includes('#graph g.same-file-only tspan.slot-xout.slot-xout-cut { display: none; }'));
    const wide = render('/r/shop/orders.py', 300, 1, { cls: 'same-file-only' });
    assert.ok(!wide.label().querySelector('tspan.slot-xout')!.classList.contains('slot-xout-cut'));
    assert.strictEqual(wide.label().textContent, 'orders.py · 2 ↗5', 'name, count, then the cue');
  });
});

// Tour review round 3, N14: the tour's call edges had no direction; a reviewer read applyCoupon → render backwards.
suite('arrowheads on the tour\'s call edges (tour review round 3, N14)', () => {
  const nodeAt = (x: number, y: number, r = 5) => ({ minX: x - r, minY: y - r, maxX: x + r, maxY: y + r, maxR: r });

  test('the tip touches the callee\'s rim, 2 px off; the line stops at the base; 10 px long, 10 px wide on screen', () => {
    const a = sl.stageArrow({ x: 0, y: 0 }, nodeAt(100, 0), 1);
    assert.deepStrictEqual([a.tip, a.end], [{ x: 93, y: 0 }, { x: 83, y: 0 }]);
    assert.strictEqual(a.d, 'M93,0L83,5L83,-5Z');
    const z = sl.stageArrow({ x: 0, y: 0 }, nodeAt(100, 0), 2);
    assert.deepStrictEqual([z.tip.x, z.end.x], [94, 89], 'half the graph size at zoom 2');
  });

  test('a folder end stops at its frame; a diagonal one at the frame\'s corner side; too close draws no head', () => {
    const f = sl.stageArrow({ x: 0, y: 0 }, { minX: 100, minY: -50, maxX: 200, maxY: 50, maxR: 0 }, 1);
    assert.ok(near(f.tip.x, 98) && near(f.tip.y, 0));
    const d = sl.stageArrow({ x: 0, y: 0 }, { minX: 80, minY: 80, maxX: 120, maxY: 120, maxR: 0 }, 1);
    assert.ok(near(d.tip.x, 80 - Math.SQRT1_2 * 2) && near(d.tip.y, d.tip.x), 'on the box corner, 2 px off');
    assert.strictEqual(sl.stageArrow({ x: 0, y: 0 }, nodeAt(10, 0), 1), null);
    assert.strictEqual(sl.stageArrow({ x: 5, y: 5 }, nodeAt(5, 5), 1), null);
  });

  function stage(nodes: any[], k = 1) {
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><svg><g id="root"><g id="ov"></g></g></svg></body></html>');
    const doc = dom.window.document;
    const timers: Array<() => void> = [];
    const env: any = {
      doc, overlay: doc.getElementById('ov'), root: () => doc.getElementById('root'),
      state: { currentNodes: nodes, graphData: { nodes }, frames: null, hasFitted: true, structureTree: { root: '/r', folders: {} }, expandedFolders: new Set(), parsedFolders: new Set(), parsingFolders: new Set(), fileGitStatus: {} },
      selections: () => [], viewport: () => ({ w: 1000, h: 600 }), applyTransform: () => undefined, reducedMotion: () => false,
      nodeRadius: () => 5, fitScale: null, usesFrames: () => false, frameBounds: null, innerOrigin: null, visibleNodeIdOf: null,
      stageRoot: () => '/r', pageTheme: () => null, setTimeout: (fn: () => void) => { timers.push(fn); }, now: () => 0, log: () => undefined,
      zoomScale: () => k, labelText: sl.stageLabelText, drawLabels: sl.stageDrawLabels, arrow: sl.stageArrow,
    };
    const s = sa.createStageApi(env);
    s.onGraph();
    for (let i = 0; i < 3; i++) { const fns = timers.splice(0); for (const f of fns) f(); }
    return { s, api: s.api, ov: env.overlay as Element, env, setK: (v: number) => { k = v; } };
  }
  const fn = (name: string, x: number, y: number) => ({ id: `/r/a.ts::${name}::1`, name, file: '/r/a.ts', line: 1, x, y });

  test('edges(): every edge gets a head of its kind at the callee; the line ends at the head\'s base', () => {
    const [a, b] = [fn('applyCoupon', 0, 0), fn('render', 100, 0)];
    const st = stage([a, b]);
    st.api.edges([{ source: a.id, target: b.id, kind: 'added' }, { source: b.id, target: a.id, kind: 'bogus' }]);
    const heads = [...st.ov.querySelectorAll('path.stage-arrow')].map((p) => p.getAttribute('class'));
    assert.deepStrictEqual(heads, ['stage-arrow added', 'stage-arrow path']);
    const line = st.ov.querySelector('line.stage-edge.added')!;
    assert.deepStrictEqual([line.getAttribute('x1'), line.getAttribute('x2')], ['0', '83'], 'from the caller\'s centre to the base, not into the callee');
    assert.strictEqual(st.ov.querySelector('path.stage-arrow.added')!.getAttribute('d'), 'M93,0L83,5L83,-5Z');
    for (const kind of ['added', 'removed', 'path']) assert.ok(sa.STAGE_CSS.includes(`.stage-overlay .stage-arrow.${kind} { fill:`), kind);
  });

  test('a removed function\'s callers point at its ghost', () => {
    const c = fn('caller', 0, 0);
    const st = stage([c]);
    st.api.ghost([{ id: 'gone', name: 'gone', file: '/r/a.ts', callers: [c.id] }]);
    assert.strictEqual(st.ov.querySelectorAll('path.stage-arrow.removed').length, 1);
  });

  test('onZoom draws labels and heads again for the new zoom at once (they were 7 px on folder steps until the next poll)', () => {
    const [a, b] = [fn('applyCoupon', 0, 0), fn('render', 100, 0)];
    const st = stage([a, b], 2.5);
    st.api.labels([a.id]);
    st.api.edges([{ source: a.id, target: b.id, kind: 'added' }]);
    const size = () => Number(st.ov.querySelector('text.stage-label')!.getAttribute('font-size'));
    assert.ok(near(size(), 12 / 2.5));
    st.setK(1.45);
    st.s.onZoom();
    assert.ok(near(size() * 1.45, 12), `12 px on screen right after the zoom, got ${size() * 1.45}`);
    assert.strictEqual(st.ov.querySelector('path.stage-arrow')!.getAttribute('d'), sl.stageArrow({ x: 0, y: 0 }, nodeAt(100, 0), 1.45).d, 'the head too');
    const quiet = stage([a]);
    assert.doesNotThrow(() => quiet.s.onZoom(), 'nothing drawn, nothing to do');
  });

  test('the page wires onZoom to the zoom behaviour, beside rendering.js\'s own listener', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/webview/stageApi.js'), 'utf8');
    assert.ok(src.includes("zoomBehavior.on('zoom.stageApi', stage.onZoom);"));
    assert.ok(src.includes("arrow: typeof stageArrow === 'function' ? stageArrow : null,"));
  });
});
