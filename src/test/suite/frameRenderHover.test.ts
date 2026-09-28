import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const crossLinks = require('../../../src/webview/crossLinks.js');
const g = global as any;

// F10 regression: the hovered node's individual cross links are drawn from the
// glyph centre — directly under the cursor. They must never be event targets,
// or the glyph gets mouseout(relatedTarget = its own hover line) → the links are
// removed → mouseover → redrawn … ~30×/s. jsdom has no hit-testing, so the
// contract is asserted at both layers that enforce it (attribute + stylesheet).
suite('frameRender hover links (F10)', () => {
  const GLOBALS = ['document', 'state', 'settings', 'linkG', 'getCSSVar', 'isDrilldown',
    'individualLinksFor', 'indexCrossByNode', 'aggregateCrossPairs', 'routeBundles', 'titleBarRect', 'edgeWeightScale'];
  const saved: Record<string, unknown> = {};
  let fr: any;
  let svg: any;

  setup(() => {
    for (const k of GLOBALS) { saved[k] = g[k]; }
    const dom = new JSDOM('<!DOCTYPE html><body><svg id="s"></svg></body>');
    g.document = dom.window.document;
    const d3 = require('d3');
    svg = d3.select(dom.window.document.getElementById('s'));
    const frames = new Map([
      ['/r/a', { path: '/r/a', kind: 'folder', abs: { x: 0, y: 0, w: 200, h: 200 } }],
      ['/r/b', { path: '/r/b', kind: 'folder', abs: { x: 400, y: 0, w: 200, h: 200 } }],
    ]);
    Object.assign(g, {
      state: { layoutEngine: 'shelf', frames: { byPath: frames }, _frameHoverId: null },
      settings: { linkThickness: 1, arrows: false },
      linkG: svg.append('g').attr('class', 'links'),
      getCSSVar: () => '#5aabff',
      isDrilldown: () => true,
      titleBarRect: (f: any) => ({ x: f.abs.x, y: f.abs.y, w: f.abs.w, h: 30 }),
      edgeWeightScale: () => 1,
      individualLinksFor: crossLinks.individualLinksFor, indexCrossByNode: crossLinks.indexCrossByNode,
      aggregateCrossPairs: crossLinks.aggregateCrossPairs, routeBundles: crossLinks.routeBundles,
    });
    delete require.cache[require.resolve('../../../src/webview/frameRender.js')];
    fr = require('../../../src/webview/frameRender.js');
    const glyph = { id: 'folder::/r/a/x', x: 100, y: 100, _frame: '/r/a' };
    const others = Array.from({ length: 60 }, (_, i) => ({ id: `fn${i}`, x: 450 + i, y: 50, _frame: '/r/b' }));
    fr.__frState.byId = new Map([glyph, ...others].map(n => [n.id, n]));
    fr.__frState.cross = others.map(o => ({ source: glyph.id, target: o.id }));
  });

  teardown(() => { for (const k of GLOBALS) { g[k] = saved[k]; } });

  test('hover lines are drawn for the hovered glyph and none of them can take pointer events', () => {
    g.state._frameHoverId = 'folder::/r/a/x';
    fr.updateCrossHover();
    const lines = svg.selectAll('line.cross-hover').nodes();
    assert.strictEqual(lines.length, 60);
    assert.ok(lines.every((l: any) => l.getAttribute('pointer-events') === 'none'));
    assert.ok(lines.every((l: any) => l.getAttribute('x1') === '100' && l.getAttribute('y1') === '100'),
      'they do start under the cursor — hence the rule');
  });

  test('resting on the glyph does not churn the DOM: a repeated update reuses the same elements', () => {
    g.state._frameHoverId = 'folder::/r/a/x';
    fr.updateCrossHover();
    const first = svg.selectAll('line.cross-hover').nodes();
    fr.updateCrossHover();
    const second = svg.selectAll('line.cross-hover').nodes();
    assert.strictEqual(second.length, 60);
    assert.ok(second.every((el: any, i: number) => el === first[i]), 'no remove + re-append');
  });

  test('mouseout clears them once; a second clear is a no-op (no empty re-joins per tick)', () => {
    g.state._frameHoverId = 'folder::/r/a/x';
    fr.updateCrossHover();
    g.state._frameHoverId = null;
    fr.updateCrossHover();
    assert.strictEqual(svg.selectAll('line.cross-hover').size(), 0);
    let joins = 0;
    const orig = g.linkG.selectAll.bind(g.linkG);
    g.linkG.selectAll = (...a: any[]) => { joins++; return orig(...a); };
    fr.updateCrossHover();
    assert.strictEqual(joins, 0);
  });

  test('the stylesheet enforces the same rule for the hover-only link layer', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../../src/webview/styles.css'), 'utf8');
    assert.ok(/#graph line\.cross-hover\s*\{\s*pointer-events:\s*none;\s*\}/.test(css));
  });
});
