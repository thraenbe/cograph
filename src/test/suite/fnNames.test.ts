import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const g0 = global as any;

suite('fnNames (F28): only the hovered function\'s name is shown', () => {
  const GLOBALS = ['document', 'state', 'g'];
  const saved: Record<string, unknown> = {};
  let fn: any, dom: JSDOM, labels: any[], libLabels: any[], rootClasses: Set<string>;

  const sel = (els: any[]) => ({ each(f: (d: any) => void) { for (const el of els) { f.call(el, el.__data__); } } });
  const label = (d: any) => { const el: any = dom.window.document.createElement('span'); el.__data__ = d; return el; };
  const on = (els: any[]) => els.filter(e => e.classList.contains('fn-name-on')).map(e => e.__data__.id);

  setup(() => {
    for (const k of GLOBALS) { saved[k] = g0[k]; }
    dom = new JSDOM('<body><input id="search" value=""></body>');
    g0.document = dom.window.document;
    labels = [label({ id: 'f1', file: '/a.py', line: 1 }), label({ id: 'f2', file: '/a.py', line: 5 })];
    libLabels = [label({ id: 'lib::np.sum' })];
    g0.state = { svgLabels: sel(labels), svgLibLabels: sel(libLabels) };
    rootClasses = new Set();
    g0.g = { classed: (c: string, v: boolean) => { if (v) { rootClasses.add(c); } else { rootClasses.delete(c); } } };
    delete require.cache[require.resolve('../../../src/webview/fnNames.js')];
    fn = require('../../../src/webview/fnNames.js');
  });
  teardown(() => { for (const k of GLOBALS) { if (saved[k] === undefined) { delete g0[k]; } else { g0[k] = saved[k]; } } });

  test('which labels are function names: plain functions only (glyphs, synthetics, anchors keep their labels)', () => {
    assert.strictEqual(fn.isFnLabelDatum({ id: 'x', file: '/a.py', line: 3 }), true);
    for (const d of [{ isCluster: true, isFolderCluster: true }, { isCluster: true, isFileCluster: true }, { isSynthetic: true }, { isFileAnchor: true }, null]) {
      assert.strictEqual(fn.isFnLabelDatum(d), false, JSON.stringify(d));
    }
  });

  test('names hidden at rest; a filter shows all', () => {
    fn.applyFnNames();
    assert.ok(rootClasses.has('fn-names-hidden'));
    (dom.window.document.getElementById('search') as HTMLInputElement).value = 'login';
    fn.applyFnNames();
    assert.ok(!rootClasses.has('fn-names-hidden'), 'filter active: every visible match keeps its name');
    (dom.window.document.getElementById('search') as HTMLInputElement).value = '   ';
    fn.applyFnNames();
    assert.ok(rootClasses.has('fn-names-hidden'), 'blank query counts as no filter');
  });

  test('hover, drag and an open popup each keep a name on; it goes when the last reason ends', () => {
    fn.fnNameOn('f1', 'hover', true);
    assert.deepStrictEqual(on(labels), ['f1'], 'exactly the hovered one');
    fn.fnNameOn('f1', 'drag', true);
    fn.fnNameOn('f1', 'hover', false);
    assert.deepStrictEqual(on(labels), ['f1'], 'still dragged');
    fn.fnNameOn('f1', 'popup', true);
    fn.fnNameOn('f1', 'drag', false);
    assert.deepStrictEqual(on(labels), ['f1'], 'its popup is open');
    fn.fnNameOn('f1', 'popup', false);
    assert.deepStrictEqual(on(labels), [], 'nothing left');
    fn.fnNameOn('lib::np.sum', 'hover', true);
    assert.deepStrictEqual(on(libLabels), ['lib::np.sum'], 'library function names follow the rule');
    fn.fnNameOn(null, 'hover', true);   // no node: no-op
  });

  test('a re-render keeps names that are on (fresh elements get the class back)', () => {
    fn.fnNameOn('f2', 'popup', true);
    labels = [label({ id: 'f1', file: '/a.py', line: 1 }), label({ id: 'f2', file: '/a.py', line: 5 })];
    g0.state.svgLabels = sel(labels);
    fn.applyFnNames();
    assert.deepStrictEqual(on(labels), ['f2']);
  });

  test('wiring contract: classes at render, CSS rule, hooks in hover / drag / popup / filter, library clusters keep labels', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');
    const r = read('src/webview/rendering.js');
    assert.ok(r.includes(".classed('fn-name', d => typeof isFnLabelDatum === 'function' && isFnLabelDatum(d))"));
    assert.ok(r.includes(".classed('fn-name', d => !d.isLibCluster)"), 'a library CLUSTER label is a grouping and stays');
    for (const hook of ["fnNameOn(d.id, 'hover', true)", "fnNameOn(d.id, 'hover', false)", "fnNameOn(d.id, 'drag', true)", "fnNameOn(d.id, 'drag', false)"]) {
      assert.ok(r.includes(hook), hook);
    }
    assert.ok(read('src/webview/popups.js').includes("fnNameOn(d.id, 'popup', true)"));
    assert.ok(read('src/webview/popups.js').includes("fnNameOn(inst.node.id, 'popup', false)"));
    assert.ok(read('src/webview/main.js').includes('applyFnNames(); }   // F28'));
    assert.ok(/#graph g\.fn-names-hidden text\.fn-name:not\(\.fn-name-on\) \{ display: none; \}/.test(read('src/webview/styles.css')));
  });
});
