import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const pc = require('../../../src/webview/pinnedCards.js');
const hc = require('../../../src/webview/hoverCard.js');
const fc = require('../../../src/webview/funcCard.js');
const hi = require('../../../src/webview/hoverIndex.js');
const cl = require('../../../src/webview/crossLinks.js');
const SRC = path.resolve(__dirname, '../../../src/webview');
const SVG = 'http://www.w3.org/2000/svg';
const G = global as any;

// The webview loads these as globals; pinnedCards.js uses them the same way.
const GLOBALS: Record<string, unknown> = {
  hcBuildElement: hc.hcBuildElement, hcFill: hc.hcFill, hcRelPath: hc.hcRelPath,
  fcContent: fc.fcContent, fcCallIndex: fc.fcCallIndex, fcNameOf: fc.fcNameOf, fcHiddenText: fc.fcHiddenText,
  fcIsFunctionNode: fc.fcIsFunctionNode, fcCodeNodes: fc.fcCodeNodes, FN_PEEK_LINES: fc.FN_PEEK_LINES, FC_MORE_PINNED: fc.FC_MORE_PINNED,
};

suite('pinned cards: the pin set (Bela 2026-11-10)', () => {
  test('add / remove / toggle / clear keep pin order and say what changed', () => {
    const s = pc.createPinSet();
    assert.strictEqual(s.add('a'), true);
    assert.strictEqual(s.add('a'), false, 'a second add is no change');
    assert.strictEqual(s.toggle('b'), true, 'toggle pins');
    assert.deepStrictEqual([...s.ids], ['a', 'b'], 'pin order');
    assert.strictEqual(s.toggle('a'), false, 'toggle unpins');
    assert.strictEqual(s.remove('zzz'), false);
    assert.deepStrictEqual([...s.ids], ['b']);
    assert.strictEqual(s.clear(), true);
    assert.strictEqual(s.clear(), false, 'nothing left to clear');
  });

  test('retain keeps the ids that still exist and returns the dropped ones', () => {
    const s = pc.createPinSet();
    ['a', 'b', 'c'].forEach(id => s.add(id));
    assert.deepStrictEqual(s.retain((id: string) => id !== 'b'), ['b']);
    assert.deepStrictEqual([...s.ids], ['a', 'c']);
  });
});

suite('pinned cards: placement (P2)', () => {
  const canvas = { left: 0, top: 0, right: 1000, bottom: 700 };
  const size = { w: 300, h: 200 };
  const rect = (p: any) => ({ left: p.left, top: p.top, right: p.left + size.w, bottom: p.top + size.h });

  test('right of the node, its name row level with the node', () => {
    const p = pc.pcPlace({ x: 400, y: 300, r: 5 }, size, canvas, []);
    assert.deepStrictEqual(p, { left: 400 + 5 + pc.PC_GAP, top: 300 - 16 });
  });

  test('at the right edge it flips to the left and never covers its node', () => {
    const p = pc.pcPlace({ x: 900, y: 300, r: 5 }, size, canvas, []);
    assert.ok(p.left + size.w <= 900 - 5, `card ends left of the node (left ${p.left})`);
  });

  test('kept inside the canvas near the bottom', () => {
    const p = pc.pcPlace({ x: 400, y: 690, r: 5 }, size, canvas, []);
    assert.ok(p.top + size.h <= canvas.bottom - pc.PC_MARGIN, `bottom ${p.top + size.h}`);
    assert.ok(p.left > 405, 'still beside the node');
  });

  test('a later card moves off an earlier one', () => {
    const first = pc.pcPlace({ x: 400, y: 300, r: 5 }, size, canvas, []);
    const second = pc.pcPlace({ x: 405, y: 320, r: 5 }, size, canvas, [rect(first)]);
    assert.ok(!pc.pcOverlap(rect(first), rect(second)), `${JSON.stringify(first)} vs ${JSON.stringify(second)}`);
  });

  test('a panel over the canvas counts as taken', () => {
    const panel = { left: 0, top: 0, right: 220, bottom: 700 };
    const p = pc.pcPlace({ x: 330, y: 300, r: 5 }, { w: 700, h: 200 }, canvas, [panel]);
    assert.ok(!pc.pcOverlap(panel, { left: p.left, top: p.top, right: p.left + 700, bottom: p.top + 200 }), JSON.stringify(p));
  });

  test("the card keeps clear of the node's own lines when a place allows it", () => {
    const line = { x1: 400, y1: 300, x2: 900, y2: 290 };              // a call going right
    const p = pc.pcPlace({ x: 400, y: 300, r: 5 }, size, canvas, [], 0, [line]);
    assert.ok(!pc.pcSegHitsRect(line, rect(p)), JSON.stringify(p));
    const plain = pc.pcPlace({ x: 400, y: 300, r: 5 }, size, canvas, []);
    assert.ok(pc.pcSegHitsRect(line, rect(plain)), 'sanity: without the line the right side is taken');
    const boxed = pc.pcPlace({ x: 400, y: 300, r: 5 }, size, { left: 0, top: 0, right: 720, bottom: 520 }, [], 0,
      [{ x1: 400, y1: 300, x2: 720, y2: 300 }, { x1: 400, y1: 300, x2: 0, y2: 300 }, { x1: 400, y1: 300, x2: 400, y2: 0 }, { x1: 400, y1: 300, x2: 400, y2: 520 }]);
    const b = rect(boxed);
    assert.ok(b.left >= 8 && b.right <= 712 && b.top >= 8 && b.bottom <= 512, 'lines everywhere: placed anyway, inside the canvas');
    assert.ok(!(400 > b.left && 400 < b.right && 300 > b.top && 300 < b.bottom), 'and still not over its node');
  });

  test('segment / rect test', () => {
    const r = { left: 10, top: 10, right: 20, bottom: 20 };
    assert.strictEqual(pc.pcSegHitsRect({ x1: 0, y1: 15, x2: 30, y2: 15 }, r), true);
    assert.strictEqual(pc.pcSegHitsRect({ x1: 0, y1: 0, x2: 30, y2: 5 }, r), false);
    assert.strictEqual(pc.pcSegHitsRect({ x1: 0, y1: 0, x2: 5, y2: 5 }, r), false, 'ends before the rect');
  });

  test('the leader runs from the rim to the nearest card point, none when they touch', () => {
    const l = pc.pcLeader({ x: 100, y: 100, r: 5 }, { left: 200, top: 50, right: 400, bottom: 150 });
    assert.ok(Math.abs(l.x1 - 107) < 1e-9 && l.y1 === 100 && l.x2 === 200 && l.y2 === 100, JSON.stringify(l));
    assert.strictEqual(pc.pcLeader({ x: 100, y: 100, r: 5 }, { left: 115, top: 50, right: 400, bottom: 150 }), null);
  });
});

/** A jsdom webview with #graph and function circles (d3-style __data__). */
function makeEnv(nodes: any[]) {
  const dom = new JSDOM('<!doctype html><html><body><div id="graph"><svg><g class="nodes"></g></svg></div><div id="top-left-controls"></div></body></html>');
  const doc = dom.window.document;
  const g = doc.querySelector('g.nodes')!;
  const circles = new Map<string, any>();
  const draw = (list: any[]) => {
    g.textContent = '';
    circles.clear();
    for (const n of list) {
      const c = doc.createElementNS(SVG, 'circle') as any;
      c.setAttribute('class', 'regular-node');
      c.__data__ = n;
      g.appendChild(c);
      circles.set(n.id, c);
    }
  };
  draw(nodes);
  const state: any = { currentNodes: nodes, graphData: { nodes, edges: [{ source: 'a', target: 'b' }] }, funcPopups: new Map() };
  const posted: any[] = [], opened: any[] = [], names: any[] = [];
  let focusChanges = 0;
  const win: any = dom.window;
  win.requestAnimationFrame = () => 1;   // layout() is driven by hand
  win.cancelAnimationFrame = () => undefined;
  const api = pc.createPinnedCards({
    doc, win, root: doc.getElementById('graph'), getState: () => state,
    post: (m: any) => posted.push(m), openFunction: (d: any) => opened.push(d),
    focusChanged: () => { focusChanges++; }, nameOn: (id: string, on: boolean) => names.push([id, on]),
  });
  return { dom, doc, win, state, api, posted, opened, names, circles, draw, focus: () => focusChanges };
}

const NODES = () => [
  { id: 'a', name: 'alpha', file: '/ws/src/a.py', line: 10 },
  { id: 'b', name: 'beta', file: '/ws/lib/b.py', line: 20 },
  { id: 'L', name: 'numpy', isLibrary: true },
];

suite('pinned cards: pin, buttons, re-render (P3-P5)', () => {
  let saved: Record<string, unknown>;
  setup(() => { saved = {}; for (const k of Object.keys(GLOBALS)) { saved[k] = G[k]; G[k] = GLOBALS[k]; } });
  teardown(() => { for (const k of Object.keys(GLOBALS)) { G[k] = saved[k]; } });

  test('a click pins (state.pinnedFns, ring, name, focus), a second click unpins', () => {
    const e = makeEnv(NODES());
    assert.strictEqual(e.api.toggle(e.state.currentNodes[0]), true, 'handled');
    assert.deepStrictEqual([...e.state.pinnedFns], ['a']);
    assert.strictEqual(e.doc.querySelectorAll('.pinned-card').length, 1);
    assert.ok(e.circles.get('a').classList.contains('cg-pinned'), 'ring on the node');
    assert.deepStrictEqual(e.names.at(-1), ['a', true], 'its name stays shown');
    assert.strictEqual(e.focus(), 1, 'focus redrawn');
    e.api.toggle(e.state.currentNodes[0]);
    assert.strictEqual(e.state.pinnedFns.size, 0);
    assert.strictEqual(e.doc.querySelectorAll('.pinned-card').length, 0);
    assert.ok(!e.circles.get('a').classList.contains('cg-pinned'), 'ring gone');
    assert.strictEqual(e.focus(), 2);
  });

  test('several at once, each with its own card; a library node is not a card target', () => {
    const e = makeEnv(NODES());
    e.api.toggle(e.state.currentNodes[0]);
    e.api.toggle(e.state.currentNodes[1]);
    assert.strictEqual(e.api.toggle(e.state.currentNodes[2]), false, 'falls back to the old click');
    const names = [...e.doc.querySelectorAll('.pinned-card .hc-name')].map(n => n.textContent);
    assert.deepStrictEqual(names, ['alpha', 'beta']);
  });

  test('the card asks the host for the peek once and fills it from the reply', () => {
    const e = makeEnv(NODES());
    e.api.toggle(e.state.currentNodes[0]);
    const req = e.posted.filter(m => m.type === 'get-func-source');
    assert.strictEqual(req.length, 1);
    assert.deepStrictEqual({ file: req[0].file, line: req[0].line, maxLines: req[0].maxLines }, { file: '/ws/src/a.py', line: 10, maxLines: fc.FN_PEEK_LINES });
    e.win.dispatchEvent(new e.win.MessageEvent('message', { data: { type: 'func-source', reqId: req[0].reqId, signature: 'def alpha(x)', body: 'return x', totalLines: 12 } }));
    const card = e.api.cardOf('a');
    assert.strictEqual(card.querySelector('.hc-sig').textContent, 'def alpha(x)');
    assert.strictEqual(card.querySelector('.hc-more').textContent, 'Whole function: 12 lines · Open function to edit');
  });

  test('open file posts navigate at the function line; open function hands over the node', () => {
    const e = makeEnv(NODES());
    e.api.toggle(e.state.currentNodes[1]);
    const card = e.api.cardOf('b');
    card.querySelector('.pc-open-file').click();
    assert.deepStrictEqual(e.posted.at(-1), { type: 'navigate', file: '/ws/lib/b.py', line: 20 });
    card.querySelector('.pc-open-fn').click();
    assert.strictEqual(e.opened.length, 1);
    assert.strictEqual(e.opened[0].id, 'b');
    assert.strictEqual(e.opened[0].line, 20);
    card.querySelector('.pc-close').click();
    assert.strictEqual(e.state.pinnedFns.size, 0, 'close unpins');
  });

  test('buttons are real buttons (Tab), named for screen readers with the function', () => {
    const e = makeEnv(NODES());
    e.api.toggle(e.state.currentNodes[0]);
    const card = e.api.cardOf('a');
    const labels = [...card.querySelectorAll('button')].map((b: any) => [b.tagName, b.type, b.getAttribute('aria-label')]);
    assert.deepStrictEqual(labels, [['BUTTON', 'button', 'Unpin alpha'], ['BUTTON', 'button', 'Open function alpha'], ['BUTTON', 'button', 'Open file alpha']]);
    assert.strictEqual(card.getAttribute('aria-label'), 'Pinned card: alpha');
  });

  test('a re-render keeps pins whose node still exists (new objects, new line) and drops the others silently', () => {
    const e = makeEnv(NODES());
    e.api.toggle(e.state.currentNodes[0]);
    e.api.toggle(e.state.currentNodes[1]);
    const focusBefore = e.focus();
    const next = [{ id: 'a', name: 'alpha', file: '/ws/src/a.py', line: 14 }];   // b deleted, a moved down
    e.state.currentNodes = next;
    e.draw(next);
    e.api.afterRender();
    assert.deepStrictEqual([...e.state.pinnedFns], ['a']);
    assert.strictEqual(e.doc.querySelectorAll('.pinned-card').length, 1);
    assert.ok(e.circles.get('a').classList.contains('cg-pinned'), 'ring on the NEW element');
    assert.strictEqual(e.focus(), focusBefore, 'silent: the render redraws the focus itself');
    e.api.cardOf('a').querySelector('.pc-open-file').click();
    assert.deepStrictEqual(e.posted.at(-1), { type: 'navigate', file: '/ws/src/a.py', line: 14 }, 'the new line');
    assert.strictEqual(e.posted.filter(m => m.type === 'get-func-source' && m.line === 14).length, 1, 'peek fetched again for the moved function');
  });

  test('Escape path: unpinAll clears every card and says whether there was one', () => {
    const e = makeEnv(NODES());
    e.api.toggle(e.state.currentNodes[0]);
    e.api.toggle(e.state.currentNodes[1]);
    assert.strictEqual(e.api.unpinAll(), true);
    assert.strictEqual(e.doc.querySelectorAll('.pinned-card').length, 0);
    assert.strictEqual(e.doc.querySelectorAll('circle.cg-pinned').length, 0);
    assert.strictEqual(e.api.unpinAll(), false, 'nothing pinned: Escape moves on');
    const controls = fs.readFileSync(path.join(SRC, 'controls.js'), 'utf8');
    assert.ok(/closeFuncPopupInstance\(top\);\s*return;\s*\}\s*if \(typeof unpinAllCards === 'function' && unpinAllCards\(\)\) return;[^\n]*\s*if \(clearSearch\(\)\) return;/.test(controls),
      'Escape: topmost popup first, then the pinned cards, then the filter');
  });

  test('layout: each card beside its node, inside the canvas, the two never overlap, hidden while its node is not drawn', () => {
    const e = makeEnv(NODES());
    const at = (id: string, x: number, y: number) => { e.circles.get(id).getBoundingClientRect = () => ({ left: x - 4, top: y - 4, right: x + 4, bottom: y + 4, width: 8, height: 8 }); };
    at('a', 400, 300); at('b', 410, 310);
    (e.doc.getElementById('graph') as any).getBoundingClientRect = () => ({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 });
    e.api.toggle(e.state.currentNodes[0]);
    e.api.toggle(e.state.currentNodes[1]);
    for (const id of ['a', 'b']) { e.api.cardOf(id).getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 180, width: 300, height: 180 }); }
    e.api.layout();
    const pos = (id: string) => { const m = /translate\((-?\d+)px,(-?\d+)px\)/.exec(e.api.cardOf(id).style.transform)!; return { left: +m[1], top: +m[2], right: +m[1] + 300, bottom: +m[2] + 180 }; };
    const a = pos('a'), b = pos('b');
    assert.strictEqual(a.left, 400 + 4 + pc.PC_GAP, 'a: right of its node');
    assert.ok(!pc.pcOverlap(a, b), `cards overlap: ${JSON.stringify([a, b])}`);
    for (const [id, p] of [['a', a], ['b', b]] as const) {
      const n = id === 'a' ? { x: 400, y: 300 } : { x: 410, y: 310 };
      assert.ok(!(n.x > p.left && n.x < p.right && n.y > p.top && n.y < p.bottom), `${id} covers its own node`);
    }
    e.circles.get('b').remove();
    e.api.layout();
    assert.strictEqual(e.api.cardOf('b').style.display, 'none', 'b waits while its node is not drawn');
    assert.strictEqual(e.state.pinnedFns.has('b'), true, 'still pinned');
  });
});

suite('pinned cards: the focus is the union (P1)', () => {
  /** rendering.js's focus block, evaluated with the real hoverIndex against a jsdom graph. */
  function focusBlock(pinned: string[]) {
    const src = fs.readFileSync(path.join(SRC, 'rendering.js'), 'utf8');
    const start = src.indexOf('const __hover = ');
    const end = src.indexOf('function hoverLabelSel');
    assert.ok(start > 0 && end > start, 'focus block found in rendering.js');
    const dom = new JSDOM('<!doctype html><svg><g id="root"><g class="links"></g><g class="nodes"></g></g></svg>');
    const doc = dom.window.document;
    const root = doc.getElementById('root')!;
    const mk = (parent: string, tag: string, datum: any) => { const el = doc.createElementNS(SVG, tag) as any; el.__data__ = datum; root.querySelector(parent)!.appendChild(el); return el; };
    // a→b, c→d, e alone
    const lines = [mk('g.links', 'line', { source: 'a', target: 'b' }), mk('g.links', 'line', { source: 'c', target: 'd' })];
    const circles = ['a', 'b', 'c', 'd', 'e'].map(id => mk('g.nodes', 'circle', { id }));
    const sel = (els: any[]) => ({ nodes: () => els });
    const state: any = { svgLinks: sel(lines), svgLabels: sel([]), svgNodes: sel(circles), svgCloudNodes: null, svgLibNodes: null,
      pinnedFns: new Set(pinned), currentNodes: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id })) };
    const g = { node: () => root, classed: (c: string) => root.classList.contains(c) };
    const timers: Array<() => void> = [];
    const fns = new Function('createHoverIndex', 'state', 'settings', 'g', 'getVisibleNodeIds', 'setTimeout', 'clearTimeout', 'linkG', 'hlLinkG',
      src.slice(start, end) + '; return { hoverFocusOn, hoverLinksOff, pinnedFocusChanged, refreshHoverFocus };')(
      hi.createHoverIndex, state, { linkThickness: 1 }, g, () => new Set(['a', 'b', 'c', 'd', 'e']),
      (f: () => void) => { timers.push(f); return timers.length; }, () => undefined, { node: () => null }, { node: () => null });
    const nb = () => circles.filter(c => c.classList.contains('cg-nb')).map(c => c.__data__.id);
    const lit = () => lines.filter(l => l.classList.contains('cg-hl')).length;
    return { fns, state, root, nb, lit, flush: () => { while (timers.length) { timers.shift()!(); } } };
  }

  test('pointer leaves a node: the pinned focus stays (lines, neighbours, dim)', () => {
    const t = focusBlock(['a']);
    t.fns.pinnedFocusChanged();
    t.flush();
    assert.deepStrictEqual(t.nb(), ['a', 'b']);
    t.fns.hoverFocusOn({ id: 'c' }, 1.5);           // hover another node: union
    assert.deepStrictEqual(t.nb(), ['a', 'b', 'c', 'd']);
    assert.strictEqual(t.lit(), 2);
    assert.ok(t.root.classList.contains('cg-focus'), 'dim kept while a pin holds it (no 100 ms gap)');
    t.fns.hoverLinksOff();                           // pointer away
    assert.deepStrictEqual(t.nb(), ['a', 'b'], 'back to the pinned set');
    assert.strictEqual(t.lit(), 1);
    assert.ok(t.root.classList.contains('cg-focus'));
  });

  test('two pins: union of both; without pins the pointer leaving clears everything', () => {
    const t = focusBlock(['a', 'c']);
    t.fns.pinnedFocusChanged();
    t.flush();
    assert.deepStrictEqual(t.nb(), ['a', 'b', 'c', 'd']);
    t.state.pinnedFns.clear();
    t.fns.pinnedFocusChanged();
    assert.deepStrictEqual(t.nb(), []);
    assert.ok(!t.root.classList.contains('cg-focus') && !t.root.classList.contains('cg-hovering'));
  });

  test('a re-render keeps the pinned focus with no node hovered', () => {
    const t = focusBlock(['c']);
    t.fns.refreshHoverFocus();
    t.flush();
    assert.deepStrictEqual(t.nb(), ['c', 'd']);
  });

  test('hoverIndex.focus takes several ids', () => {
    const dom = new JSDOM('<!doctype html><svg><g id="r"></g></svg>');
    const doc = dom.window.document;
    const r = doc.getElementById('r')!;
    const line = (s: string, t: string) => { const el = doc.createElementNS(SVG, 'line') as any; el.__data__ = { source: s, target: t }; r.appendChild(el); return el; };
    const ls = [line('a', 'b'), line('b', 'c'), line('x', 'y')];
    const idx = hi.createHoverIndex();
    idx.sync({ nodes: () => ls }, { nodes: () => [] });
    const ids = idx.focus(r, ['a', 'c'], 2, [], null);
    assert.deepStrictEqual([...ids].sort(), ['a', 'b', 'c']);
    assert.deepStrictEqual(ls.map(l => l.classList.contains('cg-hl')), [true, true, false]);
  });
});

suite('pinned cards: Shelf cross links for every pinned function (P1)', () => {
  test('crossFocusIds: hovered first, then the pins; crossFocusActive with only a pin', () => {
    assert.deepStrictEqual(cl.crossFocusIds({ _frameHoverId: 'h', pinnedFns: new Set(['p', 'h']) }), ['h', 'p']);
    assert.strictEqual(cl.crossFocusActive({ _frameHoverId: null, pinnedFns: new Set(['p']) }), true);
    assert.strictEqual(cl.crossFocusActive({ _frameHoverId: null, pinnedFns: new Set() }), false);
  });

  test('focusCrossLinks: each id shapes its own links, a link between two focused ids is drawn once', () => {
    const links = [{ source: 'p', target: 'q' }, { source: 'p', target: 'z' }];
    const byNode = cl.indexCrossByNode(links);
    const pos = (id: string) => ({ x: id.charCodeAt(0), y: 0 });
    const shapedBy: string[] = [];
    const out = cl.focusCrossLinks(['p', 'q'], (id: string) => cl.individualLinksFor(byNode.get(id) || [], id, pos),
      (raw: any[], id: string) => { shapedBy.push(id + ':' + raw.length); return raw; });
    assert.strictEqual(out.length, 2, 'p→q once, p→z');
    assert.deepStrictEqual(shapedBy, ['p:2'], 'q has nothing left of its own');
  });

  test('frameRender draws the cross-hover lines through focusCrossLinks', () => {
    const src = fs.readFileSync(path.join(SRC, 'frameRender.js'), 'utf8');
    const body = /function updateCrossHover\(\) \{[\s\S]*?\n\}/.exec(src)![0];
    assert.ok(body.includes('crossFocusIds(state)') && body.includes('focusCrossLinks('));
    assert.ok(!src.includes('state._frameHoverId != null'), 'tick paths keep the lines current while only a pin holds them');
  });
});

suite('pinned cards: wiring', () => {
  test('a function click pins (popup only as the fallback), the render prunes pins before the focus refresh', () => {
    const src = fs.readFileSync(path.join(SRC, 'rendering.js'), 'utf8');
    assert.ok(/if \(typeof togglePinnedCard === 'function' && togglePinnedCard\(d\)\) \{ return; \}\s*showFuncPopup\(d\);/.test(src));
    const render = /function renderElements[\s\S]*?\n\}/.exec(src)![0];
    assert.ok(render.indexOf('pinnedCardsAfterRender()') > 0 && render.indexOf('pinnedCardsAfterRender()') < render.indexOf('refreshHoverFocus()'));
  });

  test('loaded after its dependencies; the legend explains the ring in one line', () => {
    const html = fs.readFileSync(path.resolve(SRC, '../webviewHtmlBuilder.ts'), 'utf8');
    const at = (name: string) => html.indexOf(`src="\${${name}}?v=`);
    assert.ok(at('pinnedCardsUri') > at('hoverCardUri') && at('pinnedCardsUri') > at('funcCardUri') && at('pinnedCardsUri') > at('fnNamesUri'));
    const legend = fs.readFileSync(path.resolve(SRC, '../webviewLegend.ts'), 'utf8');
    assert.ok(legend.includes("label: 'Pinned function (its card stays open)'"));
  });

  test('every pinned colour comes from a theme variable', () => {
    const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
    const block = css.slice(css.indexOf('/* ── Pinned function cards'));
    assert.ok(block.length > 100);
    const colours = block.match(/(?<![\w-])(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/g) || [];
    const bare = block.split('\n').filter(l => /(#[0-9a-fA-F]{3,8}|rgba?\()/.test(l) && !/var\(--vscode-[\w-]+, (#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\)/.test(l));
    assert.ok(colours.length > 0);
    assert.deepStrictEqual(bare, [], 'colours only as fallbacks of --vscode-* variables');
  });
});
