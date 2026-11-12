import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const ct = require('../../../src/webview/clickTrail.js');
const hi = require('../../../src/webview/hoverIndex.js');
const SRC = path.resolve(__dirname, '../../../src/webview');

function makeLinks(links: any[]) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>');
  const doc = dom.window.document;
  const root = doc.getElementById('root') as any;
  const els = links.map((datum) => {
    const el: any = doc.createElement('span');
    el.__data__ = datum;
    root.appendChild(el);
    return el;
  });
  const idx = hi.buildLinkIndex(els);
  const linksOf = (id: string) => idx.get(id) || [];
  return { root, els, linksOf };
}

const opacityOf = (el: any) => el.style.getPropertyValue('--cg-tr-o');

// Bela, 2026-11-12: "every time I click a new node, the connections from the older
// clicked nodes fade a bit", so each clicked node's connections can be told apart.
suite('click trail: older clicks fade (2026-11-12)', () => {
  const LINKS = [
    { source: 'a', target: 'x' },
    { source: 'b', target: 'y' },
    { source: 'a', target: 'b' },               // shared by two clicked nodes
    { source: { id: 'c' }, target: { id: 'z' } }, // d3-force resolved objects
    { source: 'q', target: 'r' },               // no clicked node
  ];

  test('the newest click is at full strength, each older one a step fainter', () => {
    const { root, els, linksOf } = makeLinks(LINKS);
    const t = ct.createClickTrail();
    t.push('a'); t.push('c');
    t.apply(root, linksOf);
    assert.strictEqual(opacityOf(els[3]), '1', 'c is newest');
    assert.strictEqual(opacityOf(els[0]), String(ct.TR_OPACITY[1]), 'a is one step older');
    assert.ok(Number(opacityOf(els[0])) < 1);
    assert.ok(root.classList.contains(ct.TR_ROOT_CLASS));
    assert.ok(!els[4].classList.contains(ct.TR_LINK_CLASS), 'a link of no clicked node is not in the trail');
  });

  test('a link between two clicked nodes takes the newer one\'s strength', () => {
    const { root, els, linksOf } = makeLinks(LINKS);
    const t = ct.createClickTrail();
    t.push('a'); t.push('b');
    t.apply(root, linksOf);
    assert.strictEqual(opacityOf(els[2]), '1');
  });

  test('clicking an older node again makes it the newest; the same node twice changes nothing', () => {
    const t = ct.createClickTrail();
    t.push('a'); t.push('b');
    assert.strictEqual(t.push('a'), true);
    assert.deepStrictEqual(t.ids(), ['a', 'b']);
    assert.strictEqual(t.push('a'), false);
    assert.deepStrictEqual(t.ids(), ['a', 'b']);
  });

  test('the trail keeps the last TR_MAX clicks, and opacity never rises with age', () => {
    const t = ct.createClickTrail();
    for (let i = 0; i < ct.TR_MAX + 3; i++) { t.push('n' + i); }
    assert.strictEqual(t.size(), ct.TR_MAX);
    assert.strictEqual(t.ids()[0], 'n' + (ct.TR_MAX + 2));
    for (let age = 1; age < ct.TR_MAX + 2; age++) {
      assert.ok(ct.trailOpacity(age) <= ct.trailOpacity(age - 1));
      assert.ok(ct.trailOpacity(age) > 0, 'an old click stays visible');
    }
  });

  test('a repaint after a render moves the trail onto the new elements', () => {
    const first = makeLinks(LINKS);
    const t = ct.createClickTrail();
    t.push('a');
    t.apply(first.root, first.linksOf);
    const second = makeLinks(LINKS);
    t.apply(second.root, second.linksOf);
    assert.ok(!first.els[0].classList.contains(ct.TR_LINK_CLASS), 'old element unpainted');
    assert.ok(!first.root.classList.contains(ct.TR_ROOT_CLASS));
    assert.ok(second.els[0].classList.contains(ct.TR_LINK_CLASS));
  });

  test('reset + unpaint restore every element; reset says whether there was a trail', () => {
    const { root, els, linksOf } = makeLinks(LINKS);
    const t = ct.createClickTrail();
    assert.strictEqual(t.reset(), false);
    t.push('a'); t.push('b');
    t.apply(root, linksOf);
    assert.strictEqual(t.reset(), true);
    t.unpaint();
    for (const el of els) {
      assert.ok(!el.classList.contains(ct.TR_LINK_CLASS));
      assert.strictEqual(opacityOf(el), '');
    }
    assert.ok(!root.classList.contains(ct.TR_ROOT_CLASS));
  });

  test('wiring: node click pushes, every link render repaints, canvas click and Escape clear', () => {
    const rendering = fs.readFileSync(path.join(SRC, 'rendering.js'), 'utf8');
    const frame = fs.readFileSync(path.join(SRC, 'frameRender.js'), 'utf8');
    const controls = fs.readFileSync(path.join(SRC, 'controls.js'), 'utf8');
    const builder = fs.readFileSync(path.join(SRC, '..', 'webviewHtmlBuilder.ts'), 'utf8');
    const nodes = /function renderNodes[\s\S]*?\n}\n/.exec(rendering)![0];
    assert.ok(/\.on\('click', \(event, d\) => \{\s*event\.stopPropagation\(\);\s*clickTrailPush\(d\);/.test(nodes), 'function node click');
    assert.ok(/state\.svgLinks = renderLinks\(drawLinks, visibleSet\);\s*applyClickTrail\(\);/.test(rendering), 'global render');
    assert.ok(/state\.svgLinks = frameG\.selectAll\('g\.f-links line'\);\s*if \(typeof applyClickTrail === 'function'\) \{ applyClickTrail\(\); \}/.test(frame), 'frames render');
    assert.ok(/svg\.on\('click\.trail'[\s\S]{0,120}clickTrailClear\(\)/.test(rendering), 'canvas click');
    assert.ok(/closeFuncPopupInstance\(top\);\s*return;\s*\}\s*if \(typeof clickTrailClear === 'function' && clickTrailClear\(\)\) return;/.test(controls), 'Escape after popups');
    // Shelf draws calls between files only on hover: the trail keeps its own cross lines.
    assert.ok(/function applyClickTrail[\s\S]*?updateCrossTrail\(\)/.test(rendering), 'push and render repaint the cross lines');
    assert.ok(/function clickTrailClear[\s\S]*?updateCrossTrail\(\)/.test(rendering), 'clear removes them');
    const crossLinks = /function updateCrossLinks[\s\S]*?\n}\n/.exec(frame)![0];
    assert.ok(/line\.cross-trail'\)\.remove\(\)/.test(crossLinks) && /updateCrossTrail\(\);/.test(crossLinks), 'leaving frames drops them, a frames render redraws them');
    assert.strictEqual((frame.match(/\n {2}updateCrossTrail\(\);\n/g) || []).length, 4, 'settle, drag flush, cull pass and render follow positions');
    const teardown = /function teardownFrames[\s\S]*?\n}\n/.exec(frame)![0];
    assert.ok(/line\.cross-trail'\)\.remove\(\)/.test(teardown), 'teardown');
    const cross = /function updateCrossTrail[\s\S]*?\n}\n/.exec(frame)![0];
    assert.ok(/attr\('class', 'cross-trail cg-tr'\)/.test(cross) && /\.style\('--cg-tr-o'/.test(cross), 'cross lines take the trail strength');
    assert.ok(/attr\('pointer-events', 'none'\)/.test(cross), 'they never steal the hover (F10)');
    const tagAt = (name: string) => builder.indexOf('src="${' + name + '}');
    assert.ok(tagAt('clickTrailUri') > 0 && tagAt('clickTrailUri') < tagAt('renderingUri'), 'loaded before rendering.js');
  });

  test('the stylesheet fades by stroke-opacity (arrowheads stay opaque) and hover rules come after', () => {
    const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8');
    const rule = /#graph g\.cg-trail line\.cg-tr \{([^}]*)\}/.exec(css);
    assert.ok(rule, 'trail link rule');
    assert.ok(/stroke-opacity: var\(--cg-tr-o, 1\)/.test(rule![1]));
    assert.ok(!/(^|[^-])opacity:/.test(rule![1].replace(/stroke-opacity/g, '')), 'no element opacity');
    assert.ok(css.indexOf('g.cg-trail') < css.indexOf('#graph g.cg-hovering line.cg-hl'), 'hover wins on equal specificity');
  });
});
