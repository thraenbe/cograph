import * as assert from 'assert';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sl = require('../../../src/webview/stageLabels.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sa = require('../../../src/webview/stageApi.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

const NS = 'http://www.w3.org/2000/svg';

function stage(nodes: any[], frames: any = null, k = 2) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><svg><g id="root"><g id="ov"></g></g></svg></body></html>');
  const doc = dom.window.document;
  const timers: Array<() => void> = [];
  const env: any = {
    doc, overlay: doc.getElementById('ov'), root: () => doc.getElementById('root'),
    state: { currentNodes: nodes, graphData: { nodes }, frames, hasFitted: true, structureTree: { root: '/r', folders: {} }, expandedFolders: new Set(), parsedFolders: new Set(), parsingFolders: new Set(), fileGitStatus: {} },
    selections: () => [], viewport: () => ({ w: 1000, h: 600 }), applyTransform: () => undefined, reducedMotion: () => false,
    nodeRadius: () => 5, fitScale: null, usesFrames: () => !!frames, frameBounds: null,
    innerOrigin: (f: any) => ({ x: f.abs.x + 40, y: f.abs.y + 86 }), visibleNodeIdOf: null,
    stageRoot: () => '/r', pageTheme: () => null, setTimeout: (fn: () => void) => { timers.push(fn); }, now: () => 0, log: () => undefined,
    zoomScale: () => k, labelText: sl.stageLabelText, drawLabels: sl.stageDrawLabels,
  };
  const s = sa.createStageApi(env);
  s.onGraph();
  // The settle timer of the first graph: then the stage is ready and calls run at once.
  for (let i = 0; i < 3; i++) { const fns = timers.splice(0); for (const f of fns) f(); }
  return { s, api: s.api, overlay: env.overlay as Element, env, setK: (v: number) => { k = v; }, tick: () => { const fns = timers.splice(0); for (const f of fns) f(); } };
}

const fn = (name: string, x: number, y: number, extra: any = {}) => ({ id: `/r/a.ts::${name}::1`, name, file: '/r/a.ts', line: 1, x, y, ...extra });
const labels = (ov: Element) => [...ov.querySelectorAll('text.stage-label')].map((t) => ({ text: t.textContent, x: Number(t.getAttribute('x')), y: Number(t.getAttribute('y')), size: Number(t.getAttribute('font-size')) }));

suite('stageLabels — full names for the step\'s subject (tour review M3)', () => {
  test('label text: Class.method, a plain function, a file or folder cluster by its name', () => {
    assert.strictEqual(sl.stageLabelText({ name: 'apply', className: 'PercentOff' }), 'PercentOff.apply');
    assert.strictEqual(sl.stageLabelText({ name: 'total' }), 'total');
    assert.strictEqual(sl.stageLabelText({ label: 'audit', className: null }), 'audit', 'a render node carries its name as label');
    assert.strictEqual(sl.stageLabelText({ isFileCluster: true, file: '/r/shop/checkout.py' }), 'checkout.py');
    assert.strictEqual(sl.stageLabelText({ isFolderCluster: true, _folderPath: '/r/shop/' }), 'shop');
    assert.strictEqual(sl.stageLabelText({ isFileCluster: true, shortName: 'x.py', file: '/r/y.py' }), 'x.py');
    assert.strictEqual(sl.stageLabelText(null), '');
  });

  test('a spot right of a node or above a slot, with gaps that stay 5 px on screen', () => {
    const box = { minX: 10, minY: 20, maxX: 30, maxY: 40 };
    assert.deepStrictEqual(sl.stageLabelSpot(box, 2, false), { x: 32.5, y: 30, anchor: 'start', baseline: 'middle' });
    assert.deepStrictEqual(sl.stageLabelSpot(box, 0.5, true), { x: 10, y: 10, anchor: 'start', baseline: 'auto' });
    assert.deepStrictEqual(sl.stageLabelSpot(box, 0, false).x, 35, 'a zero zoom counts as 1');
  });

  test('labels() draws the whole name beside each node, 12 px on screen at any zoom; null clears', () => {
    const nodes = [fn('total', 100, 50), fn('apply', 300, 50, { className: 'PercentOff' })];
    const st = stage(nodes);
    st.api.labels([nodes[0].id, nodes[1].id, '/r/a.ts::missing::9', 42]);
    let drawn = labels(st.overlay);
    assert.deepStrictEqual(drawn.map((l) => l.text), ['total', 'PercentOff.apply'], 'unknown ids and non-strings are skipped');
    assert.deepStrictEqual(drawn.map((l) => l.size), [6, 6], '12 px at zoom 2');
    assert.ok(Math.abs(drawn[0].x - 100) < 1e-9 && drawn[0].y > 50, 'below the node, centred');
    st.setK(0.5);
    st.tick();
    drawn = labels(st.overlay);
    assert.deepStrictEqual(drawn.map((l) => l.size), [24, 24], 'redrawn for the new zoom while labels show');
    st.api.labels(null);
    assert.strictEqual(labels(st.overlay).length, 0);
    st.api.labels([nodes[0].id]);
    st.api.labels([]);
    assert.strictEqual(labels(st.overlay).length, 0);
  });

  test('a file id is named whole above its slot; a folder id above its frame', () => {
    const frame = { abs: { x: 0, y: 0, w: 400, h: 300 }, contentPos: { x: 10, y: 20 }, slots: new Map([['file:/r/shop/checkout.py', { x: 5, y: 7, w: 30, h: 40 }]]) };
    const frames = { root: '/r/shop', byPath: new Map([['/r/shop', frame]]) };
    const st = stage([fn('total', 100, 50)], frames, 1);
    st.api.labels(['file::/r/shop/checkout.py', 'folder::/r/shop', 'file::/r/nowhere.py']);
    const drawn = labels(st.overlay);
    assert.deepStrictEqual(drawn.map((l) => l.text), ['checkout.py', 'shop']);
    assert.deepStrictEqual([drawn[0].x, drawn[0].y], [55, 108], 'slot at innerOrigin + contentPos + slot, label 5 px above');
    assert.deepStrictEqual([drawn[1].x, drawn[1].y], [0, -5]);
  });

  test('a row of close nodes gets labels that cover no other label and no other node (seen in the browser)', () => {
    const z = 2.5;
    const box = (x: number) => ({ minX: x - 20, minY: 182, maxX: x + 20, maxY: 222 });
    const items = [{ text: 'handleRequest', box: box(96) }, { text: 'runCommand', box: box(124) }, { text: 'audit', box: box(152) }];
    const laid = sl.stageLayoutLabels(items, z);
    const boxes = laid.map((l: any) => sl.stageLabelBox(l.text, l.p, z));
    const hit = (a: any, b: any) => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = 0; j < boxes.length; j++) if (i !== j) assert.ok(!hit(boxes[i], boxes[j]), `${laid[i].text} and ${laid[j].text}`);
      for (let j = 0; j < items.length; j++) if (i !== j) assert.ok(!hit(boxes[i], items[j].box), `${laid[i].text} on node ${items[j].text}`);
    }
    assert.deepStrictEqual(sl.stageLayoutLabels(items, z), laid, 'the same input places the same way');
    const crowded = Array.from({ length: 12 }, (_, i) => ({ text: `fn${i}`, box: box(96) }));
    assert.strictEqual(sl.stageLayoutLabels(crowded, z).length, 12, 'no free place: the label still shows, on its last row');
  });

  test('without the helpers (an older page) labels() draws nothing and throws nothing', () => {
    const st = stage([fn('total', 100, 50)]);
    st.env.drawLabels = null;
    st.api.labels(['/r/a.ts::total::1']);
    assert.strictEqual(labels(st.overlay).length, 0);
  });
});
