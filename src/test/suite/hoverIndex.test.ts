import * as assert from 'assert';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const hi = require('../../../src/webview/hoverIndex.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeDom(links: any[], labels: any[]) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>');
  const doc = dom.window.document;
  const root = doc.getElementById('root') as any;
  const mk = (datum: any) => {
    const el: any = doc.createElement('span');
    el.__data__ = datum;
    root.appendChild(el);
    return el;
  };
  const linkEls = links.map(mk);
  const labelEls = labels.map(mk);
  const sel = (els: any[]) => ({ nodes: () => els });
  return { root, linkEls, labelEls, linkSel: sel(linkEls), labelSel: sel(labelEls) };
}

suite('hoverIndex', () => {
  const LINKS = [
    { source: 'a', target: 'b' },
    { source: { id: 'b' }, target: { id: 'c' } }, // d3-force resolved objects
    { source: 'c', target: 'c' },                 // self loop indexed once
    { source: 'd', target: 'a' },
  ];

  test('buildLinkIndex maps node id → its link elements (ids or node objects)', () => {
    const { linkEls } = makeDom(LINKS, []);
    const idx = hi.buildLinkIndex(linkEls);
    assert.deepStrictEqual(idx.get('a'), [linkEls[0], linkEls[3]]);
    assert.deepStrictEqual(idx.get('b'), [linkEls[0], linkEls[1]]);
    assert.deepStrictEqual(idx.get('c'), [linkEls[1], linkEls[2]]);
    assert.strictEqual(idx.get('zzz'), undefined);
  });

  test('highlight marks only the node\'s links and the root; clear undoes it', () => {
    const { root, linkEls, linkSel, labelSel } = makeDom(LINKS, [{ id: 'a' }]);
    const h = hi.createHoverIndex();
    h.sync(linkSel, labelSel);
    assert.strictEqual(h.highlight(root, 'a', 2), 2);
    assert.ok(root.classList.contains(hi.HI_ROOT_CLASS));
    assert.strictEqual(root.style.getPropertyValue('--cg-hl-width'), '2');
    const lit = linkEls.filter((e: any) => e.classList.contains(hi.HI_LINK_CLASS));
    assert.deepStrictEqual(lit, [linkEls[0], linkEls[3]]);
    assert.ok(lit.every((e: any) => e.classList.contains(hi.HI_WIDE_CLASS)));
    h.clear();
    assert.ok(!root.classList.contains(hi.HI_ROOT_CLASS));
    assert.strictEqual(linkEls.filter((e: any) => e.classList.length > 0).length, 0);
  });

  test('null width (library hover) recolours without the wide class', () => {
    const { root, linkEls, linkSel, labelSel } = makeDom(LINKS, []);
    const h = hi.createHoverIndex();
    h.sync(linkSel, labelSel);
    h.highlight(root, 'd', null);
    assert.ok(linkEls[3].classList.contains(hi.HI_LINK_CLASS));
    assert.ok(!linkEls[3].classList.contains(hi.HI_WIDE_CLASS));
    assert.strictEqual(root.style.getPropertyValue('--cg-hl-width'), '');
  });

  test('a second highlight replaces the first (no stale lit links)', () => {
    const { root, linkEls, linkSel, labelSel } = makeDom(LINKS, []);
    const h = hi.createHoverIndex();
    h.sync(linkSel, labelSel);
    h.highlight(root, 'a', 2);
    h.highlight(root, 'c', 2);
    assert.ok(!linkEls[0].classList.contains(hi.HI_LINK_CLASS));
    assert.ok(linkEls[1].classList.contains(hi.HI_LINK_CLASS));
    assert.ok(linkEls[2].classList.contains(hi.HI_LINK_CLASS));
  });

  test('sync re-indexes only when the selection object changed', () => {
    const a = makeDom(LINKS, [{ id: 'a' }, { id: 'b' }]);
    const h = hi.createHoverIndex();
    let calls = 0;
    const counting = { nodes: () => { calls++; return a.linkEls; } };
    h.sync(counting, a.labelSel);
    h.sync(counting, a.labelSel);
    assert.strictEqual(calls, 1);
    assert.strictEqual(h.labelOf('b'), a.labelEls[1]);
    assert.strictEqual(h.labelOf('nope'), null);
    const b = makeDom([{ source: 'x', target: 'y' }], []);
    h.sync(b.linkSel, b.labelSel); // re-render → new selections
    assert.deepStrictEqual(h.linksOf('a'), []);
    assert.deepStrictEqual(h.linksOf('x'), [b.linkEls[0]]);
    h.sync(null, null);
    assert.deepStrictEqual(h.linksOf('x'), []);
  });

  test('highlight without a root element still lights the links', () => {
    const { linkEls, linkSel, labelSel } = makeDom(LINKS, []);
    const h = hi.createHoverIndex();
    h.sync(linkSel, labelSel);
    assert.strictEqual(h.highlight(null, 'd', 2), 1);
    assert.ok(linkEls[3].classList.contains(hi.HI_LINK_CLASS));
    h.clear();
  });
});
