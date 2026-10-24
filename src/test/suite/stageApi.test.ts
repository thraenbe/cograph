import * as assert from 'assert';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sa = require('../../../src/webview/stageApi.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

const NS = 'http://www.w3.org/2000/svg';
const ROOT = '/r';

/** A clock the test advances by hand. */
function fakeClock() {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void }> = [];
  return {
    setTimeout: (fn: () => void, ms: number) => { timers.push({ at: now + (ms || 0), fn }); },
    now: () => now,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) { break; }
        timers = timers.slice(1);
        now = next.at;
        next.fn();
        await Promise.resolve();
      }
      now = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

function fn(file: string, name: string, line: number, x: number, y: number, extra: any = {}) {
  return { id: `${ROOT}/${file}::${name}::${line}`, name, file: `${ROOT}/${file}`, line, x, y, ...extra };
}

function makeStage(opts: { nodes?: any[]; all?: any[]; frames?: any; reduced?: boolean; links?: any[] } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><svg id="s"><g id="root"><g id="nodes"></g><g id="links"></g><g class="stage-overlay" id="ov"></g></g></svg></body></html>');
  const doc = dom.window.document;
  const root = doc.getElementById('root') as any;
  const overlay = doc.getElementById('ov') as any;
  const nodes = opts.nodes ?? [fn('src/a.ts', 'main', 1, 0, 0), fn('src/a.ts', 'helper', 9, 1000, 500)];
  const mk = (parent: string, tag: string, d: any) => {
    const el: any = doc.createElementNS(NS, tag);
    el.__data__ = d;
    doc.getElementById(parent)!.appendChild(el);
    return el;
  };
  const nodeEls = nodes.map((n) => mk('nodes', 'circle', n));
  const linkEls = (opts.links ?? []).map((l) => mk('links', 'line', l));
  const sel = (els: any[]) => ({ nodes: () => els });
  const state: any = {
    currentNodes: nodes,
    graphData: { nodes: opts.all ?? nodes },
    structureTree: { root: ROOT, folders: { [ROOT]: { parent: null }, [`${ROOT}/src`]: { parent: ROOT }, [`${ROOT}/src/deep`]: { parent: `${ROOT}/src` } } },
    expandedFolders: new Set([ROOT, `${ROOT}/src`]),
    parsedFolders: new Set([ROOT, `${ROOT}/src`]),
    parsingFolders: new Set(),
    frames: opts.frames ?? null,
    hasFitted: false,
    fileGitStatus: {},
  };
  const clock = fakeClock();
  const transforms: Array<{ t: any; ms: number }> = [];
  const posted: string[] = [];
  const calls: string[] = [];
  const logs: string[] = [];
  const env: any = {
    doc, state, overlay,
    root: () => root,
    selections: () => [sel(nodeEls), sel(linkEls)],
    viewport: () => ({ w: 1000, h: 600 }),
    applyTransform: (t: any, ms: number) => transforms.push({ t, ms }),
    reducedMotion: () => !!opts.reduced,
    nodeRadius: () => 5,
    fitScale: null,
    usesFrames: () => !!state.frames,
    frameBounds: (fs: any) => fs.byPath.get(fs.root).abs,
    innerOrigin: (f: any) => ({ x: f.abs.x + 40, y: f.abs.y + 86 }),
    visibleNodeIdOf: (n: any, expanded: Set<string>) => {
      const dir = n.file.slice(0, n.file.lastIndexOf('/'));
      return expanded.has(dir) ? n.id : 'folder::' + dir;
    },
    requestParseForExpanded: () => { calls.push('parse'); for (const p of state.expandedFolders) { if (!state.parsedFolders.has(p)) { state.parsingFolders.add(p); posted.push(p); } } },
    applyFileClusters: () => calls.push('render'),
    stageRoot: () => null,
    pageTheme: () => null,
    setTimeout: clock.setTimeout,
    now: clock.now,
    log: (m: string) => logs.push(m),
  };
  const stage = sa.createStageApi(env);
  /** The first fit ran and the frames' glide is over. */
  const ready = async () => { state.hasFitted = true; stage.onGraph(); await clock.advance(260); };
  return { dom, doc, root, overlay, state, stage, api: stage.api, transforms, clock, nodeEls, linkEls, posted, calls, logs, ready, env };
}

suite('stageApi — the tour\'s hooks into the graph view', () => {
  test('version 1, and the fit transform centres the box in the part of the viewport the overlays leave', () => {
    assert.strictEqual(sa.STAGE_API_VERSION, 1);
    const box = { minX: 0, minY: 0, maxX: 1010, maxY: 510, maxR: 5 };
    const plain = sa.stageFitTransform(box, { w: 1000, h: 600 }, { padding: 80 }, null);
    const k = Math.min(840 / 1010, 440 / 510);
    assert.ok(Math.abs(plain.k - k) < 1e-9);
    assert.ok(Math.abs(plain.x - (500 - k * 505)) < 1e-9 && Math.abs(plain.y - (300 - k * 255)) < 1e-9);
    const inset = sa.stageFitTransform(box, { w: 1000, h: 600 }, { padding: 80, inset: { left: 180, right: 300, top: 44, bottom: 40 } }, null);
    const ki = Math.min((520 - 160) / 1010, (516 - 160) / 510);
    assert.ok(Math.abs(inset.k - ki) < 1e-9);
    assert.ok(Math.abs(inset.x - (440 - ki * 505)) < 1e-9, 'centred between the rail and the card');
    assert.ok(Math.abs(inset.y - (302 - ki * 255)) < 1e-9, 'centred between the top bar and the progress line');
    const one = sa.stageFitTransform({ minX: 10, minY: 10, maxX: 20, maxY: 20, maxR: 5 }, { w: 1000, h: 600 }, {}, null);
    assert.strictEqual(one.k, 2.5, 'a single node is not blown up past the cap');
    const odd = sa.stageFitTransform(box, { w: 1000, h: 600 }, { inset: { left: -5, top: 'x', zzz: 1 } }, null);
    assert.ok(Math.abs(odd.k - plain.k) < 1e-9, 'bad and unknown inset values are ignored');
  });

  test('calls before the first graph are queued and run once it is laid out; fit resolves after its glide', async () => {
    const s = makeStage();
    let readyEvents = 0;
    const off = s.api.on('ready', () => readyEvents++);
    s.api.spotlight([s.state.currentNodes[0].id]);
    let fitted = false;
    void s.api.fit([s.state.currentNodes[0].id, s.state.currentNodes[1].id]).then(() => { fitted = true; });
    assert.deepStrictEqual([s.transforms.length, s.root.classList.contains('stage-spot')], [0, false], 'nothing yet');
    s.stage.onGraph(); // a graph arrived but nothing is laid out yet
    assert.strictEqual(s.transforms.length, 0);
    s.state.hasFitted = true;
    s.stage.onGraph();
    await s.clock.advance(200);
    assert.strictEqual(s.transforms.length, 0, 'the frames are still gliding into place');
    s.stage.refresh(); // a patch re-rendered the stage: the quiet period starts again
    await s.clock.advance(200);
    assert.strictEqual(s.transforms.length, 0, 'not quiet yet');
    await s.clock.advance(60);
    await s.api.ready();
    assert.strictEqual(readyEvents, 1);
    assert.strictEqual(s.root.classList.contains('stage-spot'), true);
    assert.strictEqual(s.transforms.length, 1);
    assert.strictEqual(s.transforms[0].ms, 600);
    assert.strictEqual(s.state.userZoomed, true, 'the stage\'s auto re-fit no longer takes the camera back');
    assert.strictEqual(fitted, false, 'still gliding');
    await s.clock.advance(700);
    assert.strictEqual(fitted, true);
    off();
    s.stage.onGraph();
    assert.strictEqual(readyEvents, 1, 'ready fires once; unsubscribe works');
  });

  test('a stage that never stops re-rendering is ready after 3 s all the same', async () => {
    const s = makeStage();
    s.state.hasFitted = true;
    let ready = false;
    void s.api.ready().then(() => { ready = true; });
    for (let t = 0; t < 2900; t += 100) { s.stage.refresh(); await s.clock.advance(100); }
    assert.strictEqual(ready, false);
    s.stage.refresh();
    await s.clock.advance(150);
    assert.strictEqual(ready, true);
  });

  test('fit: unknown ids are ignored, a folder fits its frame, a collapsed function fits whatever shows it; reduced motion cuts', async () => {
    const frames = { root: ROOT, byPath: new Map([[ROOT, { abs: { x: 0, y: 0, w: 3000, h: 2000 } }], [`${ROOT}/src`, { abs: { x: 100, y: 200, w: 400, h: 300 } }]]) };
    const hidden = fn('src/deep/x.ts', 'x', 3, 0, 0);
    const folder = { id: `folder::${ROOT}/src/deep`, isFolderCluster: true, _folderPath: `${ROOT}/src/deep`, name: 'deep', x: 700, y: 700 };
    const s = makeStage({ frames, reduced: true, nodes: [fn('src/a.ts', 'main', 1, 0, 0), folder], all: [fn('src/a.ts', 'main', 1, 0, 0), hidden] });
    await s.ready();
    await s.api.fit(['nope', 'folder::/elsewhere']);
    assert.strictEqual(s.transforms.length, 0, 'nothing known: no move');
    await s.api.fit([`folder::${ROOT}/src`], { padding: 0 });
    const t = s.transforms[0];
    assert.strictEqual(t.ms, 0, 'reduced motion: a cut');
    assert.ok(Math.abs(t.t.k - Math.min(1000 / 400, 600 / 300)) < 1e-9 && Math.abs(t.t.x - (500 - t.t.k * 300)) < 1e-9);
    await s.api.fit([hidden.id], { padding: 0 });
    const k = s.transforms[1].t;
    assert.ok(Math.abs(k.x - (500 - k.k * 700)) < 1e-9, 'the collapsed folder that holds it');
    await s.api.fitAll({ ms: 0 });
    const all = s.transforms[2].t;
    assert.ok(Math.abs(all.x - (500 - all.k * 1500)) < 1e-9, 'fitAll fits the root frame');
  });

  test('spotlight: lit nodes and, unless edges is false, their edges; everything else dims; null clears', async () => {
    const a = fn('src/a.ts', 'main', 1, 0, 0), b = fn('src/a.ts', 'helper', 9, 10, 10), c = fn('src/b.ts', 'other', 1, 50, 50);
    const s = makeStage({ nodes: [a, b, c], links: [{ source: { id: a.id }, target: { id: b.id } }, { source: b.id, target: c.id }, { source: c.id, target: c.id }] });
    await s.ready();
    s.api.spotlight([a.id, 'unknown']);
    const lit = (els: any[]) => els.map((e) => e.classList.contains('stage-lit'));
    assert.strictEqual(s.root.classList.contains('stage-spot'), true);
    assert.deepStrictEqual(lit(s.nodeEls), [true, false, false]);
    assert.deepStrictEqual(lit(s.linkEls), [true, false, false], 'the lit node\'s own edge');
    s.api.spotlight([a.id], { edges: false });
    assert.deepStrictEqual(lit(s.linkEls), [false, false, false]);
    s.api.spotlight(null);
    assert.strictEqual(s.root.classList.contains('stage-spot'), false);
    assert.deepStrictEqual(lit(s.nodeEls), [false, false, false]);
    assert.match(sa.STAGE_CSS, /\.stage-spot > g:not\(\.stage-overlay\)[^{]*:not\(\.stage-lit\) \{ opacity: 0\.25/);
  });

  test('pulse: one ring on the node that removes itself; null stops it; none under reduced motion', async () => {
    const s = makeStage();
    await s.ready();
    s.api.pulse(s.state.currentNodes[1].id);
    const ring = s.overlay.querySelector('circle.stage-pulse');
    assert.deepStrictEqual([ring.getAttribute('cx'), ring.getAttribute('cy')], ['1000', '500']);
    s.state.currentNodes[1].x = 1100; // the layout moves the node: the ring follows
    await s.clock.advance(260);
    assert.strictEqual(s.overlay.querySelector('circle.stage-pulse').getAttribute('cx'), '1100');
    await s.clock.advance(1100);
    assert.strictEqual(s.overlay.querySelector('circle.stage-pulse'), null, 'gone after one ring');
    s.api.pulse(s.state.currentNodes[0].id);
    s.api.pulse(null);
    assert.strictEqual(s.overlay.querySelector('circle.stage-pulse'), null);
    const r = makeStage({ reduced: true });
    await r.ready();
    r.api.pulse(r.state.currentNodes[0].id);
    assert.strictEqual(r.overlay.querySelector('circle.stage-pulse'), null);
    r.api.pulse('unknown');
    assert.strictEqual(r.logs.length, 0, 'an unknown id is not an error');
  });

  test('ghost: in its file\'s slot, in the folder\'s margin when the file is gone, beside the callers without frames', async () => {
    const slot = { x: 10, y: 20, w: 200, h: 100 };
    const frames = {
      root: ROOT,
      byPath: new Map<string, any>([
        [ROOT, { abs: { x: 0, y: 0, w: 3000, h: 2000 } }],
        [`${ROOT}/src`, { abs: { x: 100, y: 200, w: 600, h: 400 }, contentPos: { x: 5, y: 6 }, slots: new Map([[`file:${ROOT}/src/a.ts`, slot]]) }],
      ]),
    };
    const s = makeStage({ frames });
    await s.ready();
    const main = s.state.currentNodes[0];
    s.api.ghost([
      { id: 'g1', file: 'src/a.ts', name: 'oldParser', line: 40, callers: [main.id, 'gone'] },
      { id: 'g2', file: `${ROOT}/src/removed.ts`, name: 'dropped', line: 1, callers: [] },
      { id: 'g3', file: 'elsewhere/x.ts', name: 'nowhere', line: 1, callers: [] },
    ]);
    const ghosts = [...s.overlay.querySelectorAll('g.stage-ghost')] as any[];
    assert.deepStrictEqual(ghosts.map((g) => g.getAttribute('data-id')), ['g1', 'g2', 'g3']);
    const at = (g: any) => [Number(g.querySelector('circle').getAttribute('cx')), Number(g.querySelector('circle').getAttribute('cy'))];
    // slot origin = innerOrigin (140, 286) + contentPos (5, 6) + slot (10, 20) = (155, 312); bottom row inside it.
    assert.deepStrictEqual(at(ghosts[0]), [155 + 14, 312 + 100 - 12]);
    assert.strictEqual(ghosts[0].querySelector('text').textContent, 'oldParser');
    assert.deepStrictEqual(at(ghosts[1]), [100 + 20 + 22, 200 + 400 - 14], 'the src frame\'s bottom margin, second slot');
    assert.deepStrictEqual(at(ghosts[2]), [0 + 20 + 44, 2000 - 14], 'the root frame when no folder of it is open');
    const callerLines = [...s.overlay.querySelectorAll('line.stage-edge.removed')] as any[];
    assert.strictEqual(callerLines.length, 1, 'one line to the caller that still exists');
    assert.deepStrictEqual([callerLines[0].getAttribute('x1'), callerLines[0].getAttribute('x2')], ['0', String(169)]);
    void s.api.fit(['g1']);
    assert.strictEqual(s.transforms.length, 1, 'a ghost can be fitted like a node');
    s.api.ghost(null);
    assert.strictEqual(s.overlay.querySelectorAll('g.stage-ghost').length, 0);

    const global = makeStage();
    await global.ready();
    global.api.ghost([{ id: 'g', file: 'src/a.ts', name: 'old', line: 1, callers: [global.state.currentNodes[0].id] }]);
    const g = global.overlay.querySelector('g.stage-ghost circle');
    assert.deepStrictEqual([g.getAttribute('cx'), g.getAttribute('cy')], ['35', '0'], 'Global engine: right of its callers');
  });

  test('edges: an overlay line per pair with its kind, unknown ends skipped, ghosts as ends; null clears', async () => {
    const s = makeStage();
    await s.ready();
    const [a, b] = s.state.currentNodes;
    s.api.ghost([{ id: 'g', file: 'src/a.ts', name: 'old', line: 1, callers: [] }]);
    s.api.edges([
      { source: a.id, target: b.id, kind: 'added' }, { source: b.id, target: 'g', kind: 'removed' },
      { source: a.id, target: b.id, kind: 'weird' }, { source: a.id, target: 'nope', kind: 'path' }, null,
    ]);
    const lines = [...s.overlay.querySelectorAll('line.stage-edge')] as any[];
    assert.deepStrictEqual(lines.map((l) => l.getAttribute('class')), ['stage-edge added', 'stage-edge removed', 'stage-edge path']);
    assert.deepStrictEqual(['x1', 'y1', 'x2', 'y2'].map((k) => lines[0].getAttribute(k)), ['0', '0', '1000', '500']);
    s.api.edges(null);
    assert.strictEqual(s.overlay.querySelectorAll('line.stage-edge').length, 0);
    assert.strictEqual(s.overlay.querySelectorAll('g.stage-ghost').length, 1, 'ghosts stay');
  });

  test('expand opens the folder and its ancestors, asks the host to parse what is unparsed, resolves when parsed', async () => {
    const s = makeStage();
    await s.ready();
    let done = false;
    const p = s.api.expand([`${ROOT}/src/deep`, '/not/in/tree']).then(() => { done = true; });
    assert.ok(s.state.expandedFolders.has(`${ROOT}/src/deep`));
    assert.deepStrictEqual(s.calls, ['parse', 'render']);
    assert.deepStrictEqual(s.posted, [`${ROOT}/src/deep`], 'expand-folder for the unparsed folder only');
    await s.clock.advance(300);
    assert.strictEqual(done, false, 'waiting for the parse');
    s.state.parsingFolders.delete(`${ROOT}/src/deep`);
    await s.clock.advance(150);
    await p;
    assert.strictEqual(done, true);
    s.calls.length = 0;
    await s.api.expand([`${ROOT}/src`]);
    assert.deepStrictEqual(s.calls, [], 'already open: nothing to do');
    s.state.expandedFolders.delete(`${ROOT}/src/deep`);
    s.state.parsingFolders.add(`${ROOT}/src/deep`);
    let late = false;
    void s.api.expand([`${ROOT}/src/deep`]).then(() => { late = true; });
    await s.clock.advance(15_100);
    assert.strictEqual(late, true, 'a parse that never ends does not hang the tour');
  });

  test('chrome hides and shows the toolbar, forces box, PR banner and panel actions by one body class', () => {
    const s = makeStage();
    s.api.chrome(false);
    assert.strictEqual(s.doc.body.classList.contains('stage-chrome-off'), true, 'works before ready too');
    s.api.chrome(true);
    assert.strictEqual(s.doc.body.classList.contains('stage-chrome-off'), false);
    for (const id of ['#top-left-controls', '#pr-view-banner', '#settings-btn']) { assert.ok(sa.STAGE_CSS.includes(`body.stage-chrome-off ${id}`), id); }
  });

  test('resolve maps repo-relative or absolute files, names and nearest lines to ids; theme and nodes', () => {
    const all = [
      fn('src/a.ts', 'main', 1, 0, 0), fn('src/a.ts', 'run', 10, 0, 0, { className: 'Svc' }), fn('src/a.ts', 'run', 40, 0, 0, { className: 'Svc' }),
    ];
    const fileNode = { id: `file::${ROOT}/src/b.ts`, isFileCluster: true, _filePath: `${ROOT}/src/b.ts`, name: 'b.ts', x: 1, y: 1 };
    const rendered = { ...all[0], name: undefined, label: 'main' }; // render nodes carry `label`
    const s = makeStage({ nodes: [rendered, fileNode, { id: 'lib', isLibrary: true, name: 'lodash' }], all });
    assert.strictEqual(s.api.resolve({ file: 'src/a.ts', name: 'main' }), all[0].id);
    assert.strictEqual(s.api.resolve({ file: `${ROOT}/src/a.ts`, name: 'Svc.run', line: 35 }), all[2].id, 'nearest line wins');
    assert.strictEqual(s.api.resolve({ file: './src/a.ts', name: 'run', line: 12 }), all[1].id);
    assert.strictEqual(s.api.resolve({ file: 'src/b.ts' }), `file::${ROOT}/src/b.ts`);
    assert.strictEqual(s.api.resolve({ file: 'src/a.ts', name: 'nope' }), null);
    assert.strictEqual(s.api.resolve({ file: 'src/zzz.ts' }), null);
    assert.strictEqual(s.api.resolve(null), null);
    s.env.stageRoot = () => '/other';
    assert.strictEqual(s.api.resolve({ file: 'src/a.ts', name: 'main' }), null, 'the page\'s stageRoot wins over the tree root');
    assert.deepStrictEqual(s.api.nodes().map((n: any) => [n.kind, n.name]), [['function', 'main'], ['file', 'b.ts']], 'no library nodes');
    assert.strictEqual(s.api.theme(), 'dark');
    s.doc.body.classList.add('vscode-light');
    assert.strictEqual(s.api.theme(), 'light');
    s.env.pageTheme = () => 'dark';
    assert.strictEqual(s.api.theme(), 'dark', 'the tour page says which theme it opened in');
  });

  test('node-click and graph events; listener errors and bad calls never throw', async () => {
    const s = makeStage();
    await s.ready();
    const clicks: any[] = [];
    let graphs = 0;
    s.api.on('node-click', (e: any) => clicks.push(e));
    s.api.on('graph', () => { graphs++; throw new Error('listener bug'); });
    assert.strictEqual(typeof s.api.on('nonsense', () => undefined), 'function');
    const child = s.doc.createElementNS(NS, 'title');
    s.nodeEls[0].appendChild(child);
    s.stage.onClick({ target: child });
    s.stage.onClick({ target: s.root });
    assert.deepStrictEqual(clicks, [{ id: s.state.currentNodes[0].id }]);
    s.stage.onGraph();
    assert.strictEqual(graphs, 1);
    assert.ok(s.logs.some((l) => /graph listener: listener bug/.test(l)));
    s.state.frames = { byPath: 'not a map' };
    assert.doesNotThrow(() => s.api.ghost([{ id: 'x', file: 'src/a.ts', name: 'x', line: 1, callers: [] }]));
    assert.ok(s.logs.some((l) => /stageApi\.ghost/.test(l)));
    assert.doesNotThrow(() => s.api.spotlight('not an array' as any));
  });
});
