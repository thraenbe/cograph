import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { SHAPES_LEGEND_HTML, SHAPES_LEGEND_LABELS } from '../../webviewLegend';

// F1 (1.4 user feedback): "I don't understand what a dashed outline means vs a solid one."
// A dashed stroke meant three things (function with hidden cross-file calls, file without
// functions, the root pseudo-frame). Now dashed = "empty / not there yet" only; the hidden
// calls are a ↗ at the node's rim (the slot label's symbol), the root frame is faint solid,
// and a legend names every mark.

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const cl = require('../../../src/webview/crossLinks.js');
const xg = require('../../../src/webview/xfileGlyph.js');
const fcull = require('../../../src/webview/frameCull.js');
const frames = require('../../../src/webview/frames.js');
const chrome = require('../../../src/webview/frameChrome.js');
const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const g = global as any;
const NS = 'http://www.w3.org/2000/svg';

const NODES = [
  { id: 'a1', file: '/r/a.py' }, { id: 'a2', file: '/r/a.py' }, { id: 'a3', file: '/r/a.py' },
  { id: 'b1', file: '/r/b.py' }, { id: 'c1', file: '/r/c.py' }, { id: 'c2', file: '/r/c.py' },
  { id: 'lib', isLibrary: true, file: '/site/x.py' },
];
const L = (s: string, t: string, n = 1) => ({ source: s, target: t, _count: n });
const LINKS = [
  L('a1', 'a2'),                     // same file: a1 and a2 have a visible line
  L('a1', 'b1', 2),                  // a1 also calls out, but has a visible line: no ↗
  L('a3', 'b1'), L('a3', 'c1', 3),   // a3 only calls other files: ↗
  L('c1', 'lib'),                    // c1: a library call and incoming calls only: no ↗
  L('c2', 'lib'),                    // c2: library calls only: no ↗
  L('b1', 'b1'),                     // recursion ignored
];

suite('F1 outline meaning: who gets the ↗ (crossLinks.xfileCue)', () => {
  const cue = cl.xfileCue(LINKS, cl.fileLookup(NODES));

  test('↗ only with hidden calls into other project files AND no visible call', () => {
    assert.deepStrictEqual([...cue.cueIds].sort(), ['a3']);
  });

  test('a visible same-file call removes the ↗ even with hidden calls out (a1)', () => {
    assert.ok(cue.outByNode.get('a1') === 2 && !cue.cueIds.has('a1'));
  });

  test('library calls and incoming calls give no ↗ (c1, c2, b1)', () => {
    for (const id of ['c1', 'c2', 'b1', 'lib']) { assert.ok(!cue.cueIds.has(id), id); }
    assert.ok(!cue.outByNode.has('c2'));
  });

  test('node counts and the file label ↗N share one base: a file is the sum of its nodes', () => {
    assert.deepStrictEqual(Object.fromEntries(cue.outByNode), { a1: 2, a3: 4 });
    assert.deepStrictEqual(Object.fromEntries(cue.outByFile), { '/r/a.py': 6 });
    const sumA = [...cue.outByNode].filter(([id]) => cl.fileLookup(NODES)(id) === '/r/a.py').reduce((s, [, n]) => s + n, 0);
    assert.strictEqual(sumA, cue.outByFile.get('/r/a.py'));
  });
});

suite('F1 outline meaning: ↗ geometry (xfileGlyph)', () => {
  const dist = (p: number[], cx: number, cy: number) => Math.hypot(p[0] - cx, p[1] - cy);

  test('the arrow sits outside the rim, clear of a 3 px git outline, and points up-right', () => {
    for (const r of [3, 7.5, 20]) {
      const pts = xg.xfileArrowPoints(100, 50, r);
      assert.strictEqual(pts.length, 7);
      for (const p of pts) { assert.ok(dist(p, 100, 50) > r + 1.5, `r=${r}: point inside the outline`); }
      const tip = pts[3];
      assert.ok(tip[0] > 100 && tip[1] < 50, 'tip is up-right of the centre');
      assert.ok(Math.abs((tip[0] - 100) + (tip[1] - 50)) < 1e-9, 'on the 45° diagonal');
    }
  });

  test('the arrow scales with the node', () => {
    const len = (r: number) => { const p = xg.xfileArrowPoints(0, 0, r); return dist(p[3], 0, 0) - dist([(p[0][0] + p[6][0]) / 2, (p[0][1] + p[6][1]) / 2], 0, 0); };
    assert.ok(len(20) > 2 * len(7.5));
  });

  test('one sub-path per visible, positioned node; frame-local coordinates', () => {
    const nodes = [{ id: 'a', x: 110, y: 60 }, { id: 'b', x: 200, y: 60 }, { id: 'c', x: NaN, y: 0 }];
    const d = xg.xfileCueD(nodes, 100, 50, () => 5, new Set(['a', 'c']));
    assert.strictEqual((d.match(/M/g) || []).length, 1, 'b is filtered out, c has no position');
    assert.strictEqual(d, xg.xfileArrowD(10, 10, 5));
    assert.strictEqual((xg.xfileCueD(nodes, 0, 0, () => 5, null).match(/M/g) || []).length, 2);
  });
});

suite('F1 outline meaning: ↗ paths in the DOM', () => {
  let dom: JSDOM, d3: any, svg: any;
  setup(() => {
    dom = new JSDOM('<!DOCTYPE html><body><svg id="s"></svg></body>');
    d3 = require('d3');
    svg = d3.select(dom.window.document.getElementById('s'));
    xg.resetXfileCues(null);
  });

  test('one path per layer, above the circles, only when a member carries the ↗', () => {
    const cue = cl.xfileCue(LINKS, cl.fileLookup(NODES));
    const holder = svg.append('g').attr('class', 'f-nodes');
    holder.append('circle').attr('class', 'regular-node');
    const pos = NODES.map((n, i) => ({ ...n, x: 10 * i, y: 20 }));
    xg.registerXfileCue('/r', holder, pos, cue, () => ({ x: 0, y: 0 }), () => 4);
    holder.append('circle').attr('class', 'regular-node');   // a re-render's entering circle
    xg.registerXfileCue('/r', holder, pos, cue, () => ({ x: 0, y: 0 }), () => 4);
    const paths = holder.selectAll('path.xfile-cues').nodes();
    assert.strictEqual(paths.length, 1);
    assert.strictEqual(holder.node().lastChild, paths[0], 'raised above every circle');
    assert.strictEqual(paths[0].getAttribute('pointer-events'), 'none');
    assert.strictEqual((paths[0].getAttribute('d').match(/M/g) || []).length, 1, 'only a3');
    const none = svg.append('g');
    xg.registerXfileCue('/q', none, [pos[0], pos[1]], cue, () => null, () => 4);
    assert.strictEqual(none.selectAll('path.xfile-cues').size(), 0, 'no members with ↗: no path');
  });

  test('writes follow node moves and the filter', () => {
    const holder = svg.append('g');
    const n = { id: 'a3', x: 50, y: 50 };
    xg.registerXfileCue('k', holder, [n], { cueIds: new Set(['a3']) }, () => ({ x: 10, y: 0 }), () => 4);
    const el = holder.select('path.xfile-cues').node();
    assert.strictEqual(el.getAttribute('d'), xg.xfileArrowD(40, 50, 4));
    n.x = 90; xg.writeXfileCue('k');
    assert.strictEqual(el.getAttribute('d'), xg.xfileArrowD(80, 50, 4));
    xg.refreshXfileCues(new Set());
    assert.strictEqual(el.getAttribute('d'), '', 'filtered out');
    xg.refreshXfileCues(null);
    assert.strictEqual(el.getAttribute('d'), xg.xfileArrowD(80, 50, 4));
  });

  test('the zoom LOD parks the ↗ path together with the function nodes', () => {
    const doc = dom.window.document;
    const parent = doc.createElementNS(NS, 'g'); doc.getElementById('s')!.appendChild(parent);
    const frame = doc.createElementNS(NS, 'g'); frame.setAttribute('class', 'frame'); parent.appendChild(frame);
    const nodes = doc.createElementNS(NS, 'g'); nodes.setAttribute('class', 'f-nodes'); frame.appendChild(nodes);
    const c = doc.createElementNS(NS, 'circle'); c.setAttribute('class', 'regular-node'); nodes.appendChild(c);
    const p = doc.createElementNS(NS, 'path'); p.setAttribute('class', 'xfile-cues'); nodes.appendChild(p);
    const culler = fcull.createDomCuller();
    culler.reset(parent, [['/r', frame]]);
    culler.applyLod('/r', { nodes: false });
    assert.strictEqual(p.parentNode, null, 'parked');
    culler.applyLod('/r', { nodes: true });
    assert.strictEqual(nodes.lastChild, p, 'back on top of its circles');
  });
});

suite('F1 outline meaning: frames renderer', () => {
  const GLOBALS = ['document', 'd3', 'state', 'settings', 'FRAME', 'SLOT', 'slotLabelText', 'cutLabel', 'vscode'];
  const saved: Record<string, unknown> = {};
  let fr: any, d3: any, svg: any;

  setup(() => {
    for (const k of GLOBALS) { saved[k] = g[k]; }
    const dom = new JSDOM('<!DOCTYPE html><body><svg id="s"></svg></body>');
    d3 = require('d3');
    svg = d3.select(dom.window.document.getElementById('s'));
    Object.assign(g, {
      document: dom.window.document, d3,
      state: { gitMode: false, xfileCue: { cueIds: new Set(), outByNode: new Map(), outByFile: new Map([['/r/a.py', 6]]) } },
      settings: { textSize: 1 },
      FRAME: frames.FRAME, SLOT: frames.SLOT, slotLabelText: chrome.slotLabelText, cutLabel: chrome.cutLabel, vscode: { postMessage: () => undefined },
    });
    delete require.cache[require.resolve('../../../src/webview/frameRender.js')];
    fr = require('../../../src/webview/frameRender.js');
  });
  teardown(() => { for (const k of GLOBALS) { g[k] = saved[k]; } });

  function slots() {
    const sub = svg.append('g'); sub.append('g').attr('class', 'f-slots');
    const f = {
      kind: 'folder', contentPos: { x: 0, y: 0 },
      slots: new Map([
        ['a', { file: '/r/a.py', count: 3, x: 0, y: 0, w: 120, h: 60 }],
        ['e', { file: '/r/empty.py', count: 0, x: 130, y: 0, w: 120, h: 30 }],
      ]),
    };
    fr.renderFrameSlots(f, sub);
    const shape = (k: string) => sub.selectAll('g.file-slot').filter((d: any) => d.key === k).select('.file-slot-shape').node();
    const label = (k: string) => sub.selectAll('g.file-slot').filter((d: any) => d.key === k).select('.file-slot-label').node();
    return { shape, label };
  }

  test('a file without functions is dashed', () => {
    assert.ok(slots().shape('e').getAttribute('stroke-dasharray'));
  });

  test('a file with functions is solid', () => {
    assert.strictEqual(slots().shape('a').getAttribute('stroke-dasharray'), null);
  });

  test('the slot label carries ↗N (the same number base as the node ↗)', () => {
    const s = slots();
    assert.strictEqual(s.label('a').querySelector('tspan.slot-xout').textContent, ' ↗6');
    assert.strictEqual(s.label('e').querySelector('tspan.slot-xout'), null);
  });

  test('the root frame is a faint SOLID outline, never dashed', () => {
    const sub = svg.append('g');
    sub.append('path').attr('class', 'folder-bubble-shape').attr('stroke-dasharray', '6 5');   // stale attr from older builds
    sub.append('g').attr('class', 'frame-tab');
    sub.append('rect').attr('class', 'folder-bubble-titlebar');
    sub.append('text').attr('class', 'folder-bubble-label');
    fr.applyRootFrameChrome(sub);
    const shape = sub.select('.folder-bubble-shape').node();
    assert.strictEqual(shape.getAttribute('stroke-dasharray'), null);
    assert.ok(Number(shape.getAttribute('stroke-opacity')) <= 0.25, 'faint');
    assert.strictEqual(sub.select('g.frame-tab').style('display'), 'none');
  });

  test('frame position writes carry the ↗ path along (tickFramePositions)', () => {
    const sub = svg.append('g');
    const nodesG = sub.append('g').attr('class', 'f-nodes');
    const n = { id: 'a3', x: 50, y: 40 };
    g.state.frames = { byPath: new Map([['/r/d', { path: '/r/d', abs: { x: 10, y: 10, w: 200, h: 200 } }]]) };
    fr.__frState.frameSel.set('/r/d', sub);
    fr.__frState.frameDom = new Map([['/r/d', {
      sub, circles: nodesG.selectAll('circle'), clouds: nodesG.selectAll('path.cloud-node'),
      labels: sub.selectAll('text'), links: sub.selectAll('line'),
    }]]);
    xg.resetXfileCues(null);
    xg.registerXfileCue('/r/d', nodesG, [n], { cueIds: new Set(['a3']) }, () => g.state.frames.byPath.get('/r/d').abs, () => 4);
    g.writeXfileCue = xg.writeXfileCue;
    try {
      n.x = 150;
      fr.tickFramePositions('/r/d');
      assert.strictEqual(nodesG.select('path.xfile-cues').attr('d'), xg.xfileArrowD(140, 30, 4));
    } finally { delete g.writeXfileCue; }
  });
});

suite('F1 outline meaning: CSS and wiring', () => {
  const css = read('src/webview/styles.css');

  test('the ↗ path shows only while the same-file rule is on', () => {
    assert.ok(css.includes('path.xfile-cues { display: none; }'));
    assert.ok(/#graph g\.same-file-only path\.xfile-cues \{\s*display: inline;/.test(css));
    assert.ok(css.includes('tspan.slot-xout { display: none; }') && css.includes('#graph g.same-file-only tspan.slot-xout { display: inline;'));
  });

  test('no dashed ring on function nodes any more', () => {
    assert.ok(!/circle\.regular-node[^{]*\{[^}]*stroke-dasharray/.test(css));
    assert.ok(!read('src/webview/rendering.js').includes("has-xfile"));
  });

  test('both engines and the filter write the ↗ paths; the page loads the module', () => {
    const fr = read('src/webview/frameRender.js'), rd = read('src/webview/rendering.js');
    assert.ok(fr.includes("registerXfileCue(f.path, sub.select('g.f-nodes')"));
    assert.ok(fr.includes('writeXfileCue(path)'));
    assert.ok(rd.includes("registerXfileCue('global', nodeG") && rd.includes("writeXfileCue('global')"));
    assert.ok(rd.includes('resetXfileCues(visibleSet)'));
    assert.ok(read('src/webview/main.js').includes('refreshXfileCues(visibleSet)'));
    const html = read('src/webviewHtmlBuilder.ts');
    assert.ok(html.includes("'xfileGlyph.js'") && html.includes('${xfileGlyphUri}'));
    assert.ok(html.indexOf('${xfileGlyphUri}') < html.indexOf('${frameRenderUri}?v'), 'loaded before the renderers call it at run time');
  });
});

suite('F1 outline meaning: every dashed stroke in the webview means "empty / not there yet"', () => {
  // [file, the dash expression, meaning]. A new dash must be added here WITH its meaning,
  // and that meaning must be "empty" or "not there yet", or the 1.4 confusion is back.
  const ALLOWED: Array<[string, string, string]> = [
    ['src/webview/frameRender.js', "d.count ? null : '4 3'", 'file slot without functions'],
    ['src/webview/frameRender.js', "d => d.pending ? '4,3' : null", 'cross-folder bundle still parsing'],
    ['src/webview/rendering.js', "d => d.pending ? '4,3' : null", 'call edge still parsing'],
    ['src/webview/folder.js', "'4 3'", 'Global file circle without functions'],
    ['src/webview/rendering.js', "'6,3'", 'Global file circle before its first tick (folder.js then sets empty-only)'],
  ];

  test('inventory matches', () => {
    const found: string[] = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'src/webview')).filter(n => n.endsWith('.js'))) {
      const src = read('src/webview/' + f);
      for (const m of src.matchAll(/\.attr\('stroke-dasharray',\s*(.*?)\)\s*;?\s*$/gm)) {
        const expr = m[1].trim();
        if (expr === 'null') { continue; }
        found.push('src/webview/' + f + ' :: ' + expr);
      }
    }
    assert.ok(found.length >= ALLOWED.length, 'the scan sees every listed dash: ' + found.join(' | '));
    const allowed = new Set(ALLOWED.map(([f, e]) => f + ' :: ' + e));
    for (const f of found) { assert.ok(allowed.has(f), 'unlisted dash: ' + f); }
    assert.ok(!/isLibraryEdge \? '6,3'/.test(read('src/webview/rendering.js')), 'library calls are solid (colour tells them apart)');
  });
});

suite('F1 outline meaning: legend', () => {
  test('names every remaining outline and glyph', () => {
    assert.deepStrictEqual([...SHAPES_LEGEND_LABELS], [
      'File', 'File with no functions found', 'Folder', 'Files at the top level of the repository',
      'Calls still being parsed', 'Only calls other files (hidden)', 'Calls leaving the file (hidden)', 'File changed (Git)',
      'Pinned function (its card stays open)',
    ]);
  });

  test('only the "empty" and "parsing" samples are dashed', () => {
    const rows = SHAPES_LEGEND_HTML.split('<div class="tl-legend-row"').slice(1);
    const dashed = rows.filter(r => r.includes('stroke-dasharray')).map(r => /tl-legend-label">([^<]*)</.exec(r)![1]);
    assert.deepStrictEqual(dashed, ['File with no functions found', 'Calls still being parsed']);
  });

  test('the ↗ sample is the canvas geometry, and the legend is in the Folder panel with a toggle', () => {
    assert.ok(SHAPES_LEGEND_HTML.includes(xg.xfileArrowD(6, 16, 10)));
    const html = read('src/webviewHtmlBuilder.ts');
    const folder = html.slice(html.indexOf('id="panel-folder"'), html.indexOf('id="panel-forces"'));
    assert.ok(folder.includes('${SHAPES_LEGEND_HTML}'));
    assert.ok(read('src/webview/controls.js').includes("wireLegendToggle('toggle-shapes-legend', 'shapes-legend-body')"));
    assert.ok(SHAPES_LEGEND_HTML.includes('id="shapes-legend-body" style="display:none"'), 'collapsed by default: it would cover the canvas');
  });
});
