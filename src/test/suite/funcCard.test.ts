import * as assert from 'assert';
import * as sinon from 'sinon';
import { JSDOM } from 'jsdom';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const fc = require('../../../src/webview/funcCard.js');
const hc = require('../../../src/webview/hoverCard.js');
const g = global as any;
const SVG = 'http://www.w3.org/2000/svg';

const GRAPH = {
  nodes: [
    { id: 'a.py::echo::10', name: 'echo', file: '/ws/a.py', line: 10 },
    { id: 'a.py::secho::40', name: 'secho', file: '/ws/a.py', line: 40 },
    { id: 'b.py::main::1', name: 'main', file: '/ws/b.py', line: 1 },
    { id: 'b.py::run::9', name: 'run', file: '/ws/b.py', line: 9 },
    { id: 'lib::print', name: 'print', isLibrary: true },
  ],
  edges: [
    { source: 'a.py::secho::40', target: 'a.py::echo::10' },
    { source: 'b.py::main::1', target: 'a.py::echo::10' },
    { source: 'b.py::run::9', target: 'a.py::echo::10' },
    { source: 'a.py::echo::10', target: 'b.py::run::9' },
    { source: 'a.py::echo::10', target: 'lib::print', isLibraryEdge: true },
    { source: 'a.py::echo::10', target: 'a.py::echo::10' },   // recursion is not a caller
  ],
};
const BRIEF = {
  type: 'func-source', signature: 'def echo(message=None, file=None)', doc: 'Print a message.\n\nMore.\nEven more.\nAnd more.',
  body: '    if file is None:\n        file = out()\n    return write(file, message)', totalLines: 40, endReason: 'maxLines',
};

suite('funcCard: content of the function hover card (U3 = B2 peek)', () => {
  test('which nodes are functions', () => {
    assert.strictEqual(fc.fcIsFunctionNode({ id: 'x', file: '/a.py', line: 3 }), true);
    for (const d of [null, { file: '/a.py', line: 0 }, { file: '', line: 3 }, { isCluster: true, file: '/a.py', line: 1 },
      { isLibrary: true, file: '/a.py', line: 1 }, { isSynthetic: true, file: '/a.py', line: 1 }, { isFileAnchor: true, file: '/a.py', line: 1 }]) {
      assert.strictEqual(fc.fcIsFunctionNode(d), false, JSON.stringify(d));
    }
  });

  test('callers / callees: counts first, three names, library calls and recursion excluded', () => {
    const idx = fc.fcCallIndex(GRAPH);
    const nameOf = fc.fcNameOf(GRAPH);
    assert.strictEqual(fc.fcCallsText('a.py::echo::10', idx, nameOf), 'called by 3: secho, main, run · calls 1: run');
    assert.strictEqual(fc.fcCallsText('nobody', idx, nameOf), 'called by 0 · calls 0');
    const many = { nodes: [], edges: Array.from({ length: 5 }, (_, i) => ({ source: 'c' + i, target: 't' })) };
    assert.strictEqual(fc.fcCallsText('t', fc.fcCallIndex(many), fc.fcNameOf(many)), 'called by 5: c0, c1, c2 … · calls 0');
  });

  test('content while loading, after the reply, and on an error', () => {
    const d = GRAPH.nodes[0];
    const idx = fc.fcCallIndex(GRAPH), nameOf = fc.fcNameOf(GRAPH);
    const loading = fc.fcContent(d, null, 'a.py', idx, nameOf);
    assert.deepStrictEqual([loading.name, loading.path, loading.sig, loading.code, loading.loading], ['echo', 'a.py:10', 'echo(…)', '', true]);
    const full = fc.fcContent(d, BRIEF, 'a.py', idx, nameOf);
    assert.strictEqual(full.sig, 'def echo(message=None, file=None)');
    assert.strictEqual(full.path, 'a.py:10 · 40 lines');
    assert.strictEqual(full.doc, 'Print a message.\n\nMore.…', 'doc cut to 3 lines');
    assert.strictEqual(full.code.split('\n').length, 3);
    assert.strictEqual(full.more, 'Whole function: 40 lines · click to open and edit');
    const short = fc.fcContent(d, { ...BRIEF, totalLines: 3, endReason: 'detected' }, 'a.py', idx, nameOf);
    assert.strictEqual(short.more, '', 'nothing more to open when the peek is the whole body');
    const err = fc.fcContent(d, { type: 'func-source', error: 'ENOENT' }, 'a.py', idx, nameOf);
    assert.strictEqual(err.error, 'Source not available: ENOENT');
  });

  test('code peek: only text and span colours survive, whatever the highlighter returns', () => {
    const dom = new JSDOM('<body></body>');
    const saved = g.highlightCode;
    g.highlightCode = () => '<span style="color:#569cd6">def</span> f<img src=x onerror="alert(1)"><script>evil()</script>'
      + '<b onclick="x()">bold</b><span style="color:red; background:url(javascript:x)">r</span>';
    try {
      const frag = fc.fcCodeNodes(dom.window.document, 'def f', '/a.py');
      const box = dom.window.document.createElement('pre');
      box.appendChild(frag);
      assert.deepStrictEqual([...box.querySelectorAll('*')].map(e => e.tagName), ['SPAN', 'SPAN'], 'no img, script or b');
      assert.strictEqual(box.textContent, 'def fevil()boldr', 'text kept, as text');
      assert.ok(!/onerror|onclick|javascript|background/.test(box.innerHTML), box.innerHTML);
      assert.strictEqual((box.firstChild as any).style.color, 'rgb(86, 156, 214)');
    } finally { g.highlightCode = saved; }
    const keep = g.highlightCode;
    g.highlightCode = undefined;   // other suites install a stub highlighter globally
    const plain = fc.fcCodeNodes(dom.window.document, 'a < b', '/a.py');
    g.highlightCode = keep;
    const box2 = dom.window.document.createElement('pre');
    box2.appendChild(plain);
    assert.strictEqual(box2.innerHTML, 'a &lt; b', 'no highlighter: plain text');
  });
});

suite('hoverCard + funcCard: the live function card', () => {
  const GLOBALS = ['fcIsFunctionNode', 'fcCallIndex', 'fcNameOf', 'fcContent', 'fcCodeNodes', 'HOVER_FN_DELAY_MS', 'HOVER_FN_DWELL_PX', 'FN_PEEK_LINES', 'highlightCode'];
  const saved: Record<string, unknown> = {};
  let dom: JSDOM, card: any, clock: sinon.SinonFakeTimers, posted: any[], node: any, other: any, state: any;

  const fire = (el: Element, type: string, init: Record<string, unknown> = {}) =>
    el.dispatchEvent(new (dom.window as any).MouseEvent(type, { bubbles: true, ...init }));
  const text = (cls: string) => card.element.querySelector('.' + cls).textContent;
  const shown = (cls: string) => card.element.querySelector('.' + cls).style.display !== 'none';

  setup(() => {
    for (const k of GLOBALS) { saved[k] = g[k]; }
    Object.assign(g, {
      fcIsFunctionNode: fc.fcIsFunctionNode, fcCallIndex: fc.fcCallIndex, fcNameOf: fc.fcNameOf, fcContent: fc.fcContent,
      fcCodeNodes: fc.fcCodeNodes, HOVER_FN_DELAY_MS: fc.HOVER_FN_DELAY_MS, HOVER_FN_DWELL_PX: fc.HOVER_FN_DWELL_PX,
      FN_PEEK_LINES: fc.FN_PEEK_LINES, highlightCode: undefined,
    });
    dom = new JSDOM('<div id="graph"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const svg = doc.createElementNS(SVG, 'svg');
    doc.getElementById('graph')!.appendChild(svg);
    const circle = (d: any) => { const c: any = doc.createElementNS(SVG, 'circle'); c.setAttribute('class', 'regular-node'); c.__data__ = d; svg.appendChild(c); return c; };
    node = circle(GRAPH.nodes[0]);
    other = circle(GRAPH.nodes[2]);
    posted = [];
    state = { graphData: GRAPH, structureTree: { files: [] }, funcPopups: new Map() };
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const win = dom.window as any;
    win.setTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms);
    win.clearTimeout = (id: any) => clearTimeout(id);
    card = hc.createHoverCard({ doc, win, root: doc.getElementById('graph'), getState: () => state, post: (m: any) => posted.push(m) });
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'annotations', root: '/ws', aiEnabled: false, files: {}, folders: {}, stale: [] } }));
    posted.length = 0;
  });
  teardown(() => { card.destroy(); clock.restore(); for (const k of GLOBALS) { g[k] = saved[k]; } });

  const rest = (el: Element, x = 100, y = 100) => { fire(el, 'mousemove', { clientX: x, clientY: y }); fire(el, 'mouseover', { clientX: x, clientY: y }); };
  const reply = (extra: object = {}) => (dom.window as any).dispatchEvent(new (dom.window as any).MessageEvent('message',
    { data: { ...BRIEF, reqId: posted[0].reqId, ...extra } }));

  test('opens only after 450 ms of rest; moving more than 4 px restarts the wait', () => {
    rest(node);
    clock.tick(fc.HOVER_FN_DELAY_MS - 100);
    fire(node, 'mousemove', { clientX: 106, clientY: 100 });   // 6 px: restart
    clock.tick(300);
    assert.strictEqual(card.isVisible(), false);
    fire(node, 'mousemove', { clientX: 108, clientY: 101 });   // 3 px: no restart
    clock.tick(150);
    assert.strictEqual(card.isVisible(), true);
    assert.ok(card.element.classList.contains('hc-function'));
  });

  test('one request per function, only when the card opens; the reply fills sig, doc, code and more', () => {
    rest(node);
    assert.strictEqual(posted.length, 0, 'nothing posted on mouseover');
    clock.tick(fc.HOVER_FN_DELAY_MS);
    assert.deepStrictEqual({ ...posted[0], reqId: undefined },
      { type: 'get-func-source', file: '/ws/a.py', line: 10, maxLines: 8, reqId: undefined });
    assert.ok(/^hc-\d+$/.test(posted[0].reqId));
    assert.strictEqual(text('hc-sig'), 'echo(…)', 'graph facts at once');
    assert.strictEqual(text('hc-calls'), 'called by 3: secho, main, run · calls 1: run');
    assert.strictEqual(shown('hc-code'), false);
    reply();
    assert.strictEqual(text('hc-sig'), 'def echo(message=None, file=None)');
    assert.strictEqual(text('hc-path'), 'a.py:10 · 40 lines');
    assert.ok(text('hc-code').startsWith('    if file is None:'));
    assert.strictEqual(text('hc-more'), 'Whole function: 40 lines · click to open and edit');
    assert.strictEqual(shown('hc-facts'), false, 'folder/file parts stay hidden');
    // leave, come back: served from the cache
    fire(node, 'mouseout', { relatedTarget: null });
    clock.tick(200);
    rest(node);
    clock.tick(fc.HOVER_FN_DELAY_MS);
    assert.strictEqual(posted.length, 1, 'no second request');
    assert.strictEqual(text('hc-sig'), 'def echo(message=None, file=None)');
    // a new graph clears the cache
    (dom.window as any).dispatchEvent(new (dom.window as any).MessageEvent('message', { data: { type: 'graph-patch' } }));
    fire(node, 'mouseout', { relatedTarget: null }); clock.tick(200);
    rest(node); clock.tick(fc.HOVER_FN_DELAY_MS);
    assert.strictEqual(posted.length, 2);
  });

  test('a sweep across functions posts nothing and shows nothing', () => {
    for (let i = 0; i < 6; i++) { rest(i % 2 ? other : node, 100 + i * 20); clock.tick(200); }
    assert.strictEqual(posted.length, 0);
    assert.strictEqual(card.isVisible(), false);
  });

  test('a click hides the card and keeps it away while the pointer stays; an open popup suppresses it', () => {
    rest(node); clock.tick(fc.HOVER_FN_DELAY_MS);
    assert.strictEqual(card.isVisible(), true);
    fire(node, 'mousedown');
    assert.strictEqual(card.isVisible(), false);
    rest(node); clock.tick(fc.HOVER_FN_DELAY_MS * 2);
    assert.strictEqual(card.isVisible(), false, 'suppressed until the pointer leaves');
    rest(other); clock.tick(fc.HOVER_FN_DELAY_MS);
    assert.strictEqual(card.isVisible(), true, 'another node shows again');
    state.funcPopups.set(GRAPH.nodes[0].id, {});
    fire(other, 'mouseout', { relatedTarget: null }); clock.tick(200);
    rest(node); clock.tick(fc.HOVER_FN_DELAY_MS);
    assert.strictEqual(card.isVisible(), false, 'its editable popup is open');
  });

  test('host error is shown as text; a foreign func-source reply is ignored', () => {
    rest(node); clock.tick(fc.HOVER_FN_DELAY_MS);
    (dom.window as any).dispatchEvent(new (dom.window as any).MessageEvent('message', { data: { type: 'func-source', reqId: 12345, source: 'x' } }));
    assert.strictEqual(text('hc-sig'), 'echo(…)');
    reply({ error: 'ENOENT: gone', signature: undefined });
    assert.strictEqual(text('hc-summary'), 'Source not available: ENOENT: gone');
  });
});
