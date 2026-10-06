import * as assert from 'assert';
import { JSDOM } from 'jsdom';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const frames = require('../../../src/webview/frames.js');
const g = global as any;

const DELETED = '/r/a/gone.ts';
const MODIFIED = '/r/a/changed.ts';
const PLAIN = '/r/a/same.ts';
/** What the theme (or a pull-request view) says "deleted" looks like. */
const THEME_DELETED = 'rgb(229, 83, 75)';

// A file the pull request deletes still exists in a checkout of the base branch. Its
// functions are drawn in the "deleted" colour; the slot (Shelf) and the file circle
// (Global) around them must use the SAME colour, taken from the theme variable the
// nodes read — never a literal of their own.
suite('deleted-but-present file: the container agrees with its nodes, in both engines', () => {
  const GLOBALS = ['document', 'getComputedStyle', 'd3', 'state', 'settings', 'FRAME', 'SLOT', 'vscode', 'nodeColor',
    'gitDeletedColor', 'getLanguageColor', 'slotLabelText', 'getVisibleNodeIds', 'nodeRadius', 'svg'];
  const saved: Record<string, unknown> = {};
  let colors: any;
  let svg: any;

  setup(() => {
    for (const k of GLOBALS) { saved[k] = g[k]; }
    const dom = new JSDOM('<!DOCTYPE html><body><svg id="s"></svg></body>');
    const d3 = require('d3');
    svg = d3.select(dom.window.document.getElementById('s'));
    Object.assign(g, {
      document: dom.window.document,
      // The variable is what styles.css defines per theme and what prView.js overrides.
      getComputedStyle: () => ({ getPropertyValue: (name: string) => (name === '--cograph-git-deleted' ? ` ${THEME_DELETED} ` : '') }),
      d3,
      state: {
        gitMode: true, languageMode: false, classMode: false, hiddenFolders: new Set(), onlyShowFolder: null,
        fileGitStatus: {
          [DELETED]: { unstaged: 'deleted', staged: null },
          [MODIFIED]: { unstaged: 'modified', staged: null },
        },
      },
      settings: { textSize: 1 },
      FRAME: frames.FRAME, SLOT: frames.SLOT,
      vscode: { postMessage: () => undefined },
      nodeColor: () => '#cccccc',
      slotLabelText: (name: string) => name,
      getVisibleNodeIds: () => new Set(['n1', 'n2', 'n3']),
      nodeRadius: () => 5,
      svg,
    });
    delete require.cache[require.resolve('../../../src/webview/colors.js')];
    colors = require('../../../src/webview/colors.js');
    g.gitDeletedColor = colors.gitDeletedColor;
    g.getLanguageColor = colors.getLanguageColor;
  });

  teardown(() => { for (const k of GLOBALS) { g[k] = saved[k]; } });

  const nodeFill = () => colors.resolveNodeFill({ gitStatus: { unstaged: 'deleted', staged: null } });

  test('the function nodes take "deleted" from the theme variable', () => {
    assert.strictEqual(nodeFill(), THEME_DELETED);
    assert.strictEqual(colors.gitDeletedColor(), THEME_DELETED);
  });

  test('Shelf: the file slot of a deleted file is stroked in the nodes\' deleted colour', () => {
    delete require.cache[require.resolve('../../../src/webview/frameRender.js')];
    const fr = require('../../../src/webview/frameRender.js');
    const slot = (file: string, x: number) => ({ file, x, y: 0, w: 100, h: 60, count: 2 });
    const frame = {
      kind: 'root', path: '/r', contentPos: { x: 0, y: 0 },
      slots: new Map([['a', slot(DELETED, 0)], ['b', slot(MODIFIED, 120)], ['c', slot(PLAIN, 240)]]),
    };
    const sub = svg.append('g');
    sub.append('g').attr('class', 'f-slots');
    fr.renderFrameSlots(frame, sub);
    const shapes = sub.selectAll('rect.file-slot-shape').nodes() as Element[];
    const [gone, changed, same] = shapes.map(s => ({ stroke: s.getAttribute('stroke'), width: s.getAttribute('stroke-width') }));
    assert.deepStrictEqual(gone, { stroke: nodeFill(), width: '2' }, 'same colour as the nodes inside, drawn as a changed slot');
    assert.strictEqual(changed.stroke, '#ff9800');
    assert.notStrictEqual(same.stroke, nodeFill());
    assert.strictEqual(same.width, '1.2', 'an untouched file is not marked');
    assert.strictEqual(sub.select('text.file-slot-label').attr('fill'), nodeFill(), 'the label follows the slot');
  });

  test('Global: the file circle of a deleted file is stroked in the nodes\' deleted colour', () => {
    delete require.cache[require.resolve('../../../src/webview/folder.js')];
    const folder = require('../../../src/webview/folder.js');
    const circle = (filePath: string, id: string, x: number) => ({
      filePath, lang: 'typescript', shortName: filePath.split('/').pop(), fnCount: 1, nodes: [{ id, x, y: 50 }],
    });
    const sel = svg.append('g').selectAll('g.file-circle')
      .data([circle(DELETED, 'n1', 50), circle(MODIFIED, 'n2', 250), circle(PLAIN, 'n3', 450)])
      .join((enter: any) => {
        const grp = enter.append('g').attr('class', 'file-circle');
        grp.append('ellipse').attr('class', 'file-circle-shape');
        grp.append('text').attr('class', 'file-circle-label');
        grp.append('text').attr('class', 'file-circle-subtitle');
        return grp;
      });
    g.state.svgFileCircles = sel;
    folder.tickFileCircles();
    const [gone, changed, same] = (sel.select('.file-circle-shape').nodes() as Element[])
      .map(s => ({ stroke: s.getAttribute('stroke'), width: s.getAttribute('stroke-width') }));
    assert.deepStrictEqual(gone, { stroke: nodeFill(), width: '12' }, 'same colour as the nodes inside, drawn as a changed file');
    assert.strictEqual(changed.stroke, '#ff9800');
    assert.notStrictEqual(same.stroke, nodeFill());
    assert.strictEqual(same.width, '1.5');
  });

  test('with git colours off neither engine marks the file', () => {
    g.state.gitMode = false;
    delete require.cache[require.resolve('../../../src/webview/frameRender.js')];
    const fr = require('../../../src/webview/frameRender.js');
    const sub = svg.append('g');
    sub.append('g').attr('class', 'f-slots');
    fr.renderFrameSlots({ kind: 'root', path: '/r', contentPos: { x: 0, y: 0 }, slots: new Map([['a', { file: DELETED, x: 0, y: 0, w: 100, h: 60, count: 1 }]]) }, sub);
    assert.strictEqual(sub.select('rect.file-slot-shape').attr('stroke-width'), '1.2');
  });
});
