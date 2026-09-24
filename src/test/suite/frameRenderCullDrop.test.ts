import * as assert from 'assert';
import { JSDOM } from 'jsdom';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const frames = require('../../../src/webview/frames.js');
const chrome = require('../../../src/webview/frameChrome.js');
const viewCull = require('../../../src/webview/viewCull.js');
const frameCull = require('../../../src/webview/frameCull.js');
const g = global as any;

// W3 culling detaches off-screen frames from the document. A frame MOVE (drag
// release, drop-overlap resolution) can carry a detached frame into the
// viewport; it must come back right then, not at the next zoom/pan.
suite('frameRender: frame moves re-run culling (drop pushes a culled sibling on screen)', () => {
  const GLOBALS = ['document', 'window', 'd3', 'state', 'settings', 'svg', 'g', 'frameG', 'linkG', 'isDrilldown',
    'resolveAbs', 'clampFrameLocal', 'FRAME', 'innerOrigin', 'TAB', 'tabWidth', 'tabChars', 'cutLabel', 'countsText',
    'tabBodyPath', 'tabOnlyPath', 'rectPath', 'ddHue', 'folderFillColor', 'folderStrokeColor', 'folderTitlebarColor',
    'viewportRect', 'createFrameCuller', 'createLod', 'createDomCuller', 'gestureBudget', 'requestAnimationFrame',
    'aggregateCrossPairs', 'routeBundles', 'indexCrossByNode', 'individualLinksFor', 'getCSSVar', 'titleBarRect', 'edgeWeightScale'];
  const saved: Record<string, unknown> = {};
  let fr: any;
  let dom: JSDOM;

  function world() {
    const mk = (path: string, parent: string | null, x: number, y: number, w: number, h: number, kind = 'folder') =>
      [path, { path, parent, kind, local: { x, y, w, h }, abs: { x: 0, y: 0, w, h }, inner: { w: w - 80, h: h - 110 }, children: [] as string[], pinned: false }] as const;
    // viewport = 1024×768 (jsdom) + 240 px pad. `far` sits 4 000 px right → culled.
    const byPath = new Map<string, any>([
      mk('/r', null, 0, 0, 6000, 2000, 'root'),
      mk('/r/p', '/r', 0, 0, 5500, 900),
      mk('/r/p/a', '/r/p', 0, 0, 200, 150),
      mk('/r/p/far', '/r/p', 4000, 0, 200, 150),
    ]);
    byPath.get('/r')!.children = ['/r/p'];
    byPath.get('/r/p')!.children = ['/r/p/a', '/r/p/far'];
    byPath.get('/r/p')!.inner = { w: 5420, h: 760 };
    const fs2 = { root: '/r', byPath };
    frames.resolveAbs(fs2);
    return fs2;
  }

  setup(() => {
    for (const k of GLOBALS) { saved[k] = g[k]; }
    dom = new JSDOM('<!DOCTYPE html><body><svg id="s"></svg></body>');
    g.document = dom.window.document; g.window = dom.window;
    const d3 = require('d3');
    g.d3 = d3;
    g.svg = d3.select(dom.window.document.getElementById('s'));
    g.g = g.svg.append('g');
    g.frameG = g.g.append('g').attr('class', 'frames');
    g.linkG = g.g.append('g').attr('class', 'links');
    Object.assign(g, {
      state: { layoutEngine: 'shelf', layoutMode: 'static', frames: world(), currentNodes: [], structureTree: { folders: {} } },
      settings: { textFadeThreshold: 0.5, linkThickness: 1, arrows: false },
      isDrilldown: () => true,
      resolveAbs: frames.resolveAbs, clampFrameLocal: frames.clampFrameLocal, FRAME: frames.FRAME, innerOrigin: frames.innerOrigin,
      titleBarRect: frames.titleBarRect,
      TAB: chrome.TAB, tabWidth: chrome.tabWidth, tabChars: chrome.tabChars, cutLabel: chrome.cutLabel, countsText: chrome.countsText,
      tabBodyPath: chrome.tabBodyPath, tabOnlyPath: chrome.tabOnlyPath, rectPath: chrome.rectPath,
      ddHue: () => 0, folderFillColor: () => '#111', folderStrokeColor: () => '#222', folderTitlebarColor: () => '#333',
      viewportRect: viewCull.viewportRect, createFrameCuller: viewCull.createFrameCuller, createLod: viewCull.createLod,
      gestureBudget: viewCull.gestureBudget, createDomCuller: frameCull.createDomCuller,
      requestAnimationFrame: undefined,
      aggregateCrossPairs: () => [], routeBundles: () => [], indexCrossByNode: () => new Map(), individualLinksFor: () => [],
      getCSSVar: () => '#888', edgeWeightScale: () => 1,
    });
    delete require.cache[require.resolve('../../../src/webview/frameRender.js')];
    fr = require('../../../src/webview/frameRender.js');
    // one <g.frame> per frame, in paint order, like renderFrameLayout builds them
    fr.__frState.frameSel = new Map();
    for (const path of ['/r', '/r/p', '/r/p/a', '/r/p/far']) {
      const grp = g.frameG.append('g').attr('class', 'frame').attr('data-path', path);
      fr.__frState.frameSel.set(path, grp);
    }
    fr.__frState.members = new Map();
    fr.__frState.cross = [];
  });

  teardown(() => { for (const k of GLOBALS) { g[k] = saved[k]; } });

  const attached = (path: string) => !!dom.window.document.querySelector(`g.frame[data-path="${path}"]`);

  test('a drop that pushes a culled sibling into the viewport re-attaches it immediately', () => {
    const fs2 = g.state.frames;
    const far = fs2.byPath.get('/r/p/far');
    const PAD_RIGHT = 1024 + 240;             // viewport (jsdom) + FR_CULL_PAD_PX
    // Park `far` just beyond the culling pad.
    far.local.x = 1300; frames.resolveAbs(fs2);
    fr.applyFrameCulling();
    assert.ok(far.abs.x > PAD_RIGHT, `precondition: far.abs.x ${far.abs.x} is beyond the pad`);
    assert.strictEqual(attached('/r/p/far'), false, 'far is culled (detached)');
    assert.strictEqual(attached('/r/p/a'), true);

    // Drop `a` deep onto far's right half: R1c's minimal push moves far LEFT
    // (by a's overlap + gap) — into the padded viewport.
    const a = fs2.byPath.get('/r/p/a');
    a.local = { x: far.local.x + 100, y: 0, w: 200, h: 150 };
    a.pinned = true;
    frames.resolveAbs(fs2);
    fr.resolveDropOverlaps({ path: '/r/p/a' });
    assert.ok(far.local.x < 1300, `far was pushed left (${far.local.x})`);
    assert.ok(far.abs.x < PAD_RIGHT, `far.abs.x ${far.abs.x} now inside the pad`);
    assert.strictEqual(attached('/r/p/far'), true, 're-attached by the drop\'s settle hook, not by the next zoom');
    assert.strictEqual(dom.window.document.querySelector('g.frame[data-path="/r/p/far"]')!.getAttribute('transform'),
      `translate(${far.abs.x},${far.abs.y})`, 'and its stale chrome was re-ticked');
  });

  test('a frame carried off screen by a move is detached by the settle hook', () => {
    fr.applyFrameCulling();
    const fs2 = g.state.frames;
    const a = fs2.byPath.get('/r/p/a');
    a.local.x = 4500; frames.resolveAbs(fs2);
    fr.onFrameMoveSettled();
    assert.strictEqual(attached('/r/p/a'), false);
    a.local.x = 0; frames.resolveAbs(fs2);
    fr.onFrameMoveSettled();
    assert.strictEqual(attached('/r/p/a'), true);
  });

  test('DOM-less callers (frameDrag.test world) are still safe', () => {
    g.svg = undefined; g.d3 = undefined; g.linkG = undefined;
    assert.doesNotThrow(() => fr.onFrameMoveSettled());
  });
});
