import * as assert from 'assert';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const frames = require('../../../src/webview/frames.js');
const localSim = require('../../../src/webview/localSim.js');
const scheduler = require('../../../src/webview/frameScheduler.js');
const interact = require('../../../src/webview/frameInteract.js');
const { createWorkerSimApi } = require('../../../src/webview/localSimWorker.js');
const g = global as any;

// F13 regression: a re-render (Detail slider, graph patch, filter re-render…)
// replaces every node object. Frames whose member ids did not change REUSE
// their simulation record — which must then write into the new objects.
suite('frameRender.syncFrameSims keeps records wired to the rendered nodes (F13)', () => {
  const GLOBALS = ['state', 'settings', 'slotInteriors', 'innerOrigin', 'createScheduler', 'createFrameSimFacade',
    'syncPins', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'd3',
    ...Object.keys(localSim)];
  const saved: Record<string, unknown> = {};
  let fr: any;
  let rafQueue: (() => void)[];

  const FRAME = { path: '/r/a', kind: 'folder', abs: { x: 100, y: 100, w: 400, h: 300 }, inner: { w: 380, h: 250 } };
  const makeNodes = (): any[] => ['n0', 'n1', 'n2'].map((id, i) => ({ id, x: 150 + i * 20, y: 180, fx: null, fy: null, _frame: '/r/a' }));
  const membersFor = (nodes: any[]) => new Map([['/r/a', nodes.map(n => ({ id: n.id, r: 5, file: 'f.ts', _ref: n }))]]);

  // Minimal deterministic simulation: every tick moves each free node by +1/+2.
  const makeSim = (rec: any) => {
    let alpha = 1;
    return {
      tick() { alpha *= 0.5; for (const n of rec.nodes) { if (n.fx == null) { n.x += 1; n.y += 2; } } },
      alpha(v?: number) { if (v === undefined) { return alpha; } alpha = v; return this; },
      alphaMin: () => 0.001, alphaTarget() { return this; }, force: () => null, stop() { /* noop */ },
    };
  };

  setup(() => {
    for (const k of GLOBALS) { saved[k] = g[k]; }
    rafQueue = [];
    Object.assign(g, localSim, {
      state: { layoutEngine: 'shelf', layoutMode: 'dynamic', frames: { byPath: new Map([['/r/a', FRAME]]) }, currentNodes: [] },
      settings: { repelForce: 250, linkForce: 1 },
      slotInteriors: frames.slotInteriors, innerOrigin: frames.innerOrigin,
      createScheduler: scheduler.createScheduler,
      createFrameSimFacade: interact.createFrameSimFacade, syncPins: interact.syncPins,
      requestAnimationFrame: (cb: () => void) => { rafQueue.push(cb); return rafQueue.length; },
      cancelAnimationFrame: () => undefined,
      d3: undefined,
    });
    // createSim is called with { d3 } by frameRender: route it to the fake sim.
    g.createSim = (f: any, m: any, l: any, s: any, deps: any, seed: any, slots: any) =>
      localSim.createSim(f, m, l, s, { ...deps, makeSim }, seed, slots);
    delete require.cache[require.resolve('../../../src/webview/frameRender.js')];
    fr = require('../../../src/webview/frameRender.js');
    fr.__frState.frameSel = new Map(); // no DOM in this suite: tickFramePositions is a no-op
  });

  teardown(() => {
    if (fr.__frState.sched) { fr.__frState.sched.stop(); }
    for (const k of GLOBALS) { g[k] = saved[k]; }
  });

  const runFrames = (n: number) => { for (let i = 0; i < n && rafQueue.length; i++) { (rafQueue.shift() as () => void)(); } };

  test('sync transport: after a re-render the reused record moves the NEW node objects', () => {
    const first = makeNodes();
    g.state.currentNodes = first;
    fr.syncFrameSims(membersFor(first));
    const rec = fr.__frState.sims.get('/r/a');
    runFrames(2);
    assert.ok(first[0].x !== 150, 'sanity: the first render\'s nodes moved');

    const second = makeNodes().map((n, i) => ({ ...n, x: first[i].x, y: first[i].y })); // positions carried over
    g.state.currentNodes = second;
    fr.syncFrameSims(membersFor(second));
    assert.strictEqual(fr.__frState.sims.get('/r/a'), rec, 'same member ids → record is reused');
    assert.ok(rec.nodes.every((ln: any, i: number) => ln._ref === second[i]), '_ref re-pointed at the rendered objects');

    const before = second.map(n => n.x);
    const stale = first.map(n => n.x);
    g.state.simulation.alpha(0.3).restart(); // what a force slider does
    runFrames(3);
    assert.ok(second.every((n, i) => n.x > before[i]), 'force-slider reheat moves what is on screen');
    assert.deepStrictEqual(first.map(n => n.x), stale, 'discarded objects are no longer written');
  });

  test('sync transport: a drag pin set on a NEW node object reaches the reused record', () => {
    const first = makeNodes();
    g.state.currentNodes = first;
    fr.syncFrameSims(membersFor(first));
    const second = makeNodes();
    g.state.currentNodes = second;
    fr.syncFrameSims(membersFor(second));
    second[1].fx = 300; second[1].fy = 260;
    fr.__frState.sched.bumpUser('/r/a');
    runFrames(1);
    const local = fr.__frState.sims.get('/r/a').byId.get('n1');
    assert.ok(local.fx != null, 'syncPins read the pin from the rendered object');
  });

  test('worker transport: positions from the worker land on the NEW node objects', () => {
    const sent: any[] = [];
    const api = createWorkerSimApi(localSim, { post: (m: any) => sent.push(m), broadcast: () => undefined });
    fr.__frState.backend = { api: () => api };
    const first = makeNodes();
    g.state.currentNodes = first;
    fr.syncFrameSims(membersFor(first));
    const rec = fr.__frState.sims.get('/r/a');
    const second = makeNodes();
    g.state.currentNodes = second;
    fr.syncFrameSims(membersFor(second));
    assert.strictEqual(fr.__frState.sims.get('/r/a'), rec);
    assert.strictEqual(sent.filter(m => m.type === 'create').length, 1, 'no worker-side re-create for a plain re-render');

    api.onMessage({ type: 'positions', frameId: '/r/a', gen: rec.gen, alpha: 0.5, settled: false, buf: new Float32Array([10, 20, 30, 40, 50, 60]) });
    fr.__frState.sched.wake();
    runFrames(1);
    const io = frames.innerOrigin(FRAME);
    assert.deepStrictEqual(second.map(n => [n.x, n.y]), [[io.x + 10, io.y + 20], [io.x + 30, io.y + 40], [io.x + 50, io.y + 60]]);
    assert.deepStrictEqual(first.map(n => n.x), [150, 170, 190], 'old objects untouched');
  });
});
