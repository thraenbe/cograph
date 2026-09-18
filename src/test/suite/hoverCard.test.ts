import * as assert from 'assert';
import * as sinon from 'sinon';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const hc = require('../../../src/webview/hoverCard.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

const ROOT = '/ws';
const SVG = 'http://www.w3.org/2000/svg';

const STATE = {
  structureTree: {
    files: [
      { path: '/ws/src/a.ts', language: 'typescript' },
      { path: '/ws/src/util/b.ts', language: 'typescript' },
      { path: '/ws/src/util/c.js', language: 'javascript' },
      { path: '/ws/srcx/d.py', language: 'python' },
    ],
  },
  graphData: {
    nodes: [
      { id: '1', file: '/ws/src/a.ts' }, { id: '2', file: '/ws/src/a.ts' },
      { id: '3', file: '/ws/src/util/b.ts' },
      { id: 'lib', file: null, isLibrary: true },
    ],
  },
};

const ANNOTATIONS = {
  type: 'annotations', root: ROOT, aiEnabled: true,
  files: { 'src/a.ts': { summary: 'Parses the command line.', role: 'cli entry' } },
  folders: { 'src/util': { summary: 'Holds shared helpers.' } },
  stale: ['src/a.ts'],
};

/** Build the SVG shapes the two engines render, with d3-style `__data__`. */
function buildGraph(doc: Document): Record<string, any> {
  const root = doc.getElementById('graph')!;
  const svg = doc.createElementNS(SVG, 'svg');
  root.appendChild(svg);
  const el = (parent: Element, tag: string, cls: string, datum?: unknown) => {
    const n = doc.createElementNS(SVG, tag) as any;
    n.setAttribute('class', cls);
    if (datum !== undefined) { n.__data__ = datum; }
    parent.appendChild(n);
    return n;
  };
  const frame = el(svg, 'g', 'frame', { path: '/ws/src/util' });
  const slot = el(el(frame, 'g', 'f-slots'), 'g', 'file-slot', { key: 'k', file: '/ws/src/util/b.ts' });
  const tab = el(frame, 'g', 'frame-tab');
  const bubble = el(svg, 'g', 'folder-bubble', { folderPath: '/ws/src' });
  const fileBubble = el(svg, 'g', 'file-bubble', { filePath: '/ws/src/a.ts' });
  return {
    root, svg,
    frameBody: el(frame, 'rect', 'folder-bubble-shape'),
    frameTitle: el(frame, 'rect', 'folder-bubble-titlebar'),
    frameTabText: el(tab, 'text', 'frame-tab-text'),
    slotShape: el(slot, 'rect', 'file-slot-shape'),
    slotLabel: el(slot, 'text', 'file-slot-label'),
    bubbleBody: el(bubble, 'rect', 'folder-bubble-shape'),
    bubbleTitle: el(bubble, 'rect', 'folder-bubble-titlebar'),
    bubbleLabel: el(bubble, 'text', 'folder-bubble-label'),
    circleShape: el(fileBubble, 'ellipse', 'file-circle-shape'),
    circleLabel: el(fileBubble, 'text', 'file-circle-label'),
    folderGlyph: el(svg, 'path', 'node', { id: 'f', isFolderCluster: true, _folderPath: '/ws/src/util' }),
    fileGlyph: el(svg, 'circle', 'node', { id: 'g', isFileCluster: true, _filePath: '/ws/src/a.ts' }),
    fnNode: el(svg, 'circle', 'node', { id: 'fn', file: '/ws/src/a.ts' }),
  };
}

suite('hoverCard — pure helpers', () => {
  test('relative keys: POSIX, root is ".", Windows separators, no false prefix match', () => {
    assert.strictEqual(hc.hcRelPath('/ws', '/ws/src/a.ts'), 'src/a.ts');
    assert.strictEqual(hc.hcRelPath('/ws', '/ws'), '.');
    assert.strictEqual(hc.hcRelPath('C:\\ws', 'C:\\ws\\src\\a.ts'), 'src/a.ts');
    assert.strictEqual(hc.hcRelPath('/ws', '/wsx/a.ts'), '/wsx/a.ts');
  });

  test('every row of the target table resolves to the right path', () => {
    const dom = new JSDOM('<div id="graph"></div>');
    const g = buildGraph(dom.window.document);
    const at = (el: Element) => hc.hcResolveTarget(el);
    assert.deepStrictEqual(at(g.frameTitle), { kind: 'folder', path: '/ws/src/util', background: false });
    assert.deepStrictEqual(at(g.frameTabText), { kind: 'folder', path: '/ws/src/util', background: false }, 'child of the ux .frame-tab');
    assert.deepStrictEqual(at(g.slotLabel), { kind: 'file', path: '/ws/src/util/b.ts', background: false });
    assert.deepStrictEqual(at(g.slotShape), { kind: 'file', path: '/ws/src/util/b.ts', background: true });
    assert.deepStrictEqual(at(g.bubbleTitle), { kind: 'folder', path: '/ws/src', background: false });
    assert.deepStrictEqual(at(g.bubbleLabel), { kind: 'folder', path: '/ws/src', background: false });
    assert.deepStrictEqual(at(g.circleLabel), { kind: 'file', path: '/ws/src/a.ts', background: false });
    assert.deepStrictEqual(at(g.circleShape), { kind: 'file', path: '/ws/src/a.ts', background: true });
    assert.deepStrictEqual(at(g.folderGlyph), { kind: 'folder', path: '/ws/src/util', background: false });
    assert.deepStrictEqual(at(g.fileGlyph), { kind: 'file', path: '/ws/src/a.ts', background: false });
  });

  test('frame bodies, folder-box bodies, function nodes and the bare svg give no card', () => {
    const dom = new JSDOM('<div id="graph"></div>');
    const g = buildGraph(dom.window.document);
    for (const el of [g.frameBody, g.bubbleBody, g.fnNode, g.svg, null]) {
      assert.strictEqual(hc.hcResolveTarget(el), null);
    }
  });

  test('facts: folder counts are recursive and prefix-safe; files skip an unknown count', () => {
    const counts = hc.hcFunctionCounts(STATE.graphData);
    assert.strictEqual(counts.get('/ws/src/a.ts'), 2);
    assert.strictEqual(hc.hcFacts({ kind: 'folder', path: '/ws/src' }, STATE, counts), '3 files · 3 functions · typescript, javascript');
    assert.strictEqual(hc.hcFacts({ kind: 'folder', path: '/ws/src/util' }, STATE, counts), '2 files · 1 function · typescript, javascript');
    assert.strictEqual(hc.hcFacts({ kind: 'file', path: '/ws/src/a.ts' }, STATE, counts), '2 functions · typescript');
    assert.strictEqual(hc.hcFacts({ kind: 'file', path: '/ws/src/util/c.js' }, STATE, counts), 'javascript');
    assert.strictEqual(hc.hcFacts({ kind: 'folder', path: '/ws/none' }, null, new Map()), '0 files · 0 functions');
  });

  test('content: summary, role and outdated badge; hint only when AI is on and nothing exists', () => {
    const ann = { ...ANNOTATIONS, stale: new Set(ANNOTATIONS.stale) };
    const counts = hc.hcFunctionCounts(STATE.graphData);
    const file = hc.hcContent({ kind: 'file', path: '/ws/src/a.ts' }, ann, STATE, counts);
    assert.deepStrictEqual(file, {
      name: 'a.ts', path: 'src/a.ts', summary: 'Parses the command line.', role: 'cli entry',
      outdated: true, facts: '2 functions · typescript', hint: '',
    });
    const folder = hc.hcContent({ kind: 'folder', path: '/ws/src/util' }, ann, STATE, counts);
    assert.strictEqual(folder.name, 'util/');
    assert.strictEqual(folder.outdated, false);
    const none = hc.hcContent({ kind: 'file', path: '/ws/src/util/b.ts' }, ann, STATE, counts);
    assert.strictEqual(none.summary, '');
    assert.match(none.hint, /Annotate graph/);
    const aiOff = hc.hcContent({ kind: 'file', path: '/ws/src/util/b.ts' }, { ...ann, aiEnabled: false }, STATE, counts);
    assert.strictEqual(aiOff.hint, '', 'with AI off the card shows facts only');
    assert.ok(aiOff.facts.length > 0);
  });

  test('placement flips at the right and bottom edges and never leaves the viewport', () => {
    assert.deepStrictEqual(hc.hcPlace(100, 100, 200, 80, 1000, 800), { left: 114, top: 114 });
    assert.deepStrictEqual(hc.hcPlace(950, 100, 200, 80, 1000, 800), { left: 736, top: 114 });
    assert.deepStrictEqual(hc.hcPlace(100, 780, 200, 80, 1000, 800), { left: 114, top: 686 });
    assert.deepStrictEqual(hc.hcPlace(5, 5, 400, 900, 300, 200), { left: 8, top: 8 }, 'an oversized card is pinned to the margin');
    assert.deepStrictEqual(hc.hcPlace(100, 30, 200, 80, 150, 60), { left: 8, top: 8 });
  });
});

suite('hoverCard — behaviour in a DOM', () => {
  let dom: JSDOM;
  let g: Record<string, any>;
  let card: any;
  let clock: sinon.SinonFakeTimers;
  let posted: any[];

  function fire(el: Element | Window, type: string, init: Record<string, unknown> = {}): void {
    const w = dom.window as any;
    const Ctor = type === 'wheel' ? w.WheelEvent : type.startsWith('key') ? w.KeyboardEvent : w.MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, ...init }));
  }

  function hover(el: Element, from: Element | null = null): void {
    fire(el, 'mousemove', { clientX: 100, clientY: 100 });
    fire(el, 'mouseover', { relatedTarget: from });
  }

  setup(() => {
    dom = new JSDOM('<div id="graph"></div>', { pretendToBeVisual: true });
    g = buildGraph(dom.window.document);
    posted = [];
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const win = dom.window as any;
    // Route the card's timers through sinon so delays are deterministic.
    win.setTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms);
    win.clearTimeout = (id: any) => clearTimeout(id);
    card = hc.createHoverCard({ doc: win.document, win, root: g.root, getState: () => STATE, post: (m: any) => posted.push(m) });
    win.dispatchEvent(new win.MessageEvent('message', { data: ANNOTATIONS }));
  });

  teardown(() => { card.destroy(); clock.restore(); });

  const text = (cls: string) => card.element.querySelector('.' + cls).textContent;

  test('asks the host for annotations once it can listen', () => {
    assert.deepStrictEqual(posted, [{ type: 'get-annotations' }]);
  });

  test('opens after 300 ms on a header, not before', () => {
    hover(g.frameTitle);
    clock.tick(hc.HOVER_DELAY_MS - 1);
    assert.strictEqual(card.isVisible(), false);
    clock.tick(1);
    assert.strictEqual(card.isVisible(), true);
    assert.strictEqual(text('hc-name'), 'util/');
    assert.strictEqual(text('hc-summary'), 'Holds shared helpers.');
    assert.strictEqual(text('hc-facts'), '2 files · 1 function · typescript, javascript');
    assert.match(card.element.style.transform, /translate\(114px,114px\)/);
  });

  test('an empty file background needs 600 ms', () => {
    hover(g.circleShape);
    clock.tick(hc.HOVER_DELAY_MS);
    assert.strictEqual(card.isVisible(), false);
    clock.tick(hc.HOVER_BG_DELAY_MS - hc.HOVER_DELAY_MS);
    assert.strictEqual(card.isVisible(), true);
    assert.strictEqual(text('hc-role'), 'cli entry');
    assert.notStrictEqual(card.element.querySelector('.hc-badge').style.display, 'none', 'stale → outdated badge');
  });

  test('moving within the same target does not restart or close the card', () => {
    hover(g.bubbleTitle);
    clock.tick(200);
    fire(g.bubbleTitle, 'mouseout', { relatedTarget: g.bubbleLabel });
    hover(g.bubbleLabel, g.bubbleTitle);
    clock.tick(100);
    assert.strictEqual(card.isVisible(), true, 'the 300 ms kept counting across title → label');
  });

  test('leaving the target before the delay cancels it; leaving afterwards hides it', () => {
    hover(g.frameTitle);
    fire(g.frameTitle, 'mouseout', { relatedTarget: g.frameBody });
    clock.tick(1000);
    assert.strictEqual(card.isVisible(), false);
    hover(g.frameTitle);
    clock.tick(hc.HOVER_DELAY_MS);
    fire(g.frameTitle, 'mouseout', { relatedTarget: g.svg });
    assert.strictEqual(card.isVisible(), false);
  });

  for (const [name, act] of [
    ['mousedown (drag or pan)', (el: Element) => fire(el, 'mousedown')],
    ['wheel (zoom)', (el: Element) => fire(el, 'wheel')],
    ['Escape', () => fire(dom.window.document.body, 'keydown', { key: 'Escape' })],
    ['window blur', () => fire(dom.window as unknown as Window, 'blur')],
  ] as Array<[string, (el: Element) => void]>) {
    test(`${name} hides the card and cancels a pending one`, () => {
      hover(g.frameTitle);
      clock.tick(hc.HOVER_DELAY_MS);
      act(g.frameTitle);
      assert.strictEqual(card.isVisible(), false);
      hover(g.folderGlyph);
      act(g.folderGlyph);
      clock.tick(1000);
      assert.strictEqual(card.isVisible(), false);
    });
  }

  test('no card while a mouse button is held (drag in progress)', () => {
    fire(g.frameTitle, 'mouseover', { buttons: 1 });
    clock.tick(1000);
    assert.strictEqual(card.isVisible(), false);
  });

  test('a summary containing HTML is rendered as text', () => {
    const win = dom.window as any;
    win.dispatchEvent(new win.MessageEvent('message', {
      data: { ...ANNOTATIONS, folders: { 'src/util': { summary: '<img src=x onerror=alert(1)><b>bold</b>' } } },
    }));
    hover(g.frameTitle);
    clock.tick(hc.HOVER_DELAY_MS);
    assert.strictEqual(card.element.querySelector('img'), null);
    assert.strictEqual(text('hc-summary'), '<img src=x onerror=alert(1)><b>bold</b>');
  });

  test('without annotations: facts plus a hint with AI on, facts only with AI off', () => {
    const win = dom.window as any;
    hover(g.slotShape);
    clock.tick(hc.HOVER_BG_DELAY_MS);
    assert.match(text('hc-hint'), /Annotate graph/);
    assert.strictEqual(text('hc-facts'), '1 function · typescript');
    card.hide();
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'annotations', root: ROOT, aiEnabled: false, files: {}, folders: {}, stale: [] } }));
    hover(g.slotShape);
    clock.tick(hc.HOVER_BG_DELAY_MS);
    assert.strictEqual(text('hc-hint'), '');
    assert.strictEqual(card.element.querySelector('.hc-hint').style.display, 'none');
    assert.strictEqual(text('hc-facts'), '1 function · typescript');
  });

  test('function counts are rebuilt after a graph-patch', () => {
    const win = dom.window as any;
    hover(g.fileGlyph);
    clock.tick(hc.HOVER_DELAY_MS);
    assert.strictEqual(text('hc-facts'), '2 functions · typescript');
    card.hide();
    STATE.graphData.nodes.push({ id: '9', file: '/ws/src/a.ts' });
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'graph-patch' } }));
    hover(g.fileGlyph);
    clock.tick(hc.HOVER_DELAY_MS);
    assert.strictEqual(text('hc-facts'), '3 functions · typescript');
    STATE.graphData.nodes.pop();
  });

  test('the card can never intercept the pointer and is removed on destroy', () => {
    assert.strictEqual(card.element.getAttribute('role'), 'tooltip');
    assert.strictEqual(card.element.className, 'hover-card');
    card.destroy();
    assert.strictEqual(dom.window.document.querySelector('.hover-card'), null);
    hover(g.frameTitle);
    clock.tick(1000);
    assert.strictEqual(card.isVisible(), false, 'listeners are gone');
  });
});
