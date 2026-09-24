import * as assert from 'assert';

/* eslint-disable @typescript-eslint/no-require-imports */
const ls = require('../../../src/webview/localSim.js');
const d3 = require('d3-force');
const { createWorkerSimApi, resolveSimBackend } = require('../../../src/webview/localSimWorker.js');
const { createWorkerHost } = require('../../../src/webview/simWorkerCore.js');
/* eslint-enable @typescript-eslint/no-require-imports */

/* eslint-disable @typescript-eslint/no-explicit-any */

function fakePool() {
  const sent: any[] = [];
  const broadcasts: any[] = [];
  return { sent, broadcasts, post: (m: any) => sent.push(m), broadcast: (m: any) => broadcasts.push(m) };
}

const FRAME = { path: '/r/a', inner: { w: 300, h: 200 } };
const MEMBERS = [
  { id: 'n0', r: 5, file: 'x.ts', _ref: { tag: 'ref0' } },
  { id: 'n1', r: 5, file: 'x.ts' }, { id: 'n2', r: 6, file: 'y.ts' }, { id: 'n3', r: 5, file: null },
];
const LINKS = [{ source: 'n0', target: 'n1' }, { source: 'n2', target: 'n0' }, { source: 'n1', target: 'ghost' }];
const SLOTS = () => new Map([['n0', { x: 0, y: 0, w: 100, h: 80 }], ['n2', { x: 120, y: 0, w: 100, h: 80 }]]);
const SETTINGS = { repelForce: 250, linkForce: 1 };

function makeRec(api: any, over: any = {}) {
  return api.createSim(FRAME, MEMBERS, LINKS, SETTINGS, over.deps ?? {}, over.seed, SLOTS());
}

suite('localSimWorker (localSim API over a worker transport)', () => {
  test('createSim: same record shape + seeding as the sync localSim, no main-thread sim', () => {
    const pool = fakePool();
    const api = createWorkerSimApi(ls, pool);
    const rec = makeRec(api);
    const ref = ls.createSim(FRAME, MEMBERS, LINKS, SETTINGS, { makeSim: () => null }, undefined, SLOTS());
    assert.strictEqual(rec.sim, null);
    assert.deepStrictEqual(rec.nodes.map((n: any) => [n.id, n.x, n.y, n.r, n.file]), ref.nodes.map((n: any) => [n.id, n.x, n.y, n.r, n.file]));
    assert.strictEqual(rec.nodes[0]._ref, MEMBERS[0]._ref);
    assert.strictEqual(rec.byId.size, 4);
    assert.strictEqual(rec.settled, false);
    assert.strictEqual(api.kind, 'worker');
    assert.strictEqual(api.liveCount(), 1);
  });

  test('create message: typed arrays, index-based links (dangling dropped), slots, settings copy', () => {
    const pool = fakePool();
    const api = createWorkerSimApi(ls, pool);
    const rec = makeRec(api, { deps: { paused: true } });
    const m = pool.sent[0];
    assert.deepStrictEqual([m.type, m.frameId, m.gen, m.paused], ['create', '/r/a', rec.gen, true]);
    assert.deepStrictEqual(m.ids, ['n0', 'n1', 'n2', 'n3']);
    assert.deepStrictEqual(m.files, ['x.ts', 'x.ts', 'y.ts', null]);
    assert.ok(m.xyr instanceof Float32Array && m.xyr.length === 12);
    assert.strictEqual(m.xyr[2], 5);
    assert.deepStrictEqual([...m.links], [0, 1, 2, 0], 'link to a non-member is not sent');
    assert.deepStrictEqual([...m.slots.slice(0, 4)], [0, 0, 100, 80]);
    assert.ok(Number.isNaN(m.slots[4]) && Number.isNaN(m.slots[12]));
    assert.deepStrictEqual(m.inner, { w: 300, h: 200 });
    assert.deepStrictEqual(m.settings, SETTINGS);
    assert.notStrictEqual(m.settings, rec.settings);
  });

  test('tickSim = "newest positions received": null when idle, applies the inbox once', () => {
    const pool = fakePool();
    const api = createWorkerSimApi(ls, pool);
    const rec = makeRec(api);
    assert.strictEqual(api.tickSim(rec), null);
    const buf = new Float32Array([10, 11, 20, 21, 30, 31, 40, 41]);
    assert.strictEqual(api.onMessage({ type: 'positions', frameId: '/r/a', gen: rec.gen, alpha: 0.5, settled: false, buf }), true);
    const newer = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    api.onMessage({ type: 'positions', frameId: '/r/a', gen: rec.gen, alpha: 0.2, settled: true, buf: newer });
    const out = api.tickSim(rec);
    assert.deepStrictEqual([out.path, out.gen], ['/r/a', rec.gen]);
    assert.deepStrictEqual(rec.nodes.map((n: any) => [n.x, n.y]), [[1, 2], [3, 4], [5, 6], [7, 8]], 'newest wins');
    assert.strictEqual(rec.settled, true);
    assert.strictEqual(api.alphaOf(rec), 0, 'settled → no heat');
    assert.strictEqual(api.tickSim(rec), null, 'inbox consumed');
  });

  test('stale results never land: old generation, destroyed frame, re-created frame, wrong length', () => {
    const pool = fakePool();
    const api = createWorkerSimApi(ls, pool);
    const rec = makeRec(api);
    const buf = new Float32Array(8).fill(99);
    const msg = (over: any) => ({ type: 'positions', frameId: '/r/a', gen: rec.gen, alpha: 1, settled: false, buf, ...over });
    assert.strictEqual(api.onMessage(msg({ gen: rec.gen - 1 })), false);
    assert.strictEqual(api.onMessage(msg({ frameId: '/other' })), false);
    assert.strictEqual(api.onMessage(msg({ buf: new Float32Array(6) })), false);
    assert.strictEqual(api.onMessage({ type: 'ready' }), false);
    const oldGen = rec.gen;
    const rec2 = makeRec(api);                      // re-created (new gen) under the same path
    assert.strictEqual(api.onMessage(msg({ gen: oldGen })), false);
    assert.strictEqual(api.tickSim(rec2), null);
    api.destroySim(rec2);
    assert.strictEqual(api.onMessage(msg({ gen: rec2.gen })), false, 'destroyed → dropped');
    assert.strictEqual(api.liveCount(), 0);
  });

  test('pin is optimistic (local write, paints without the worker) and de-duplicated', () => {
    const pool = fakePool();
    const api = createWorkerSimApi(ls, pool);
    const rec = makeRec(api);
    rec.settled = true;
    pool.sent.length = 0;
    api.pin(rec, 'n2', 170, 40);
    api.pin(rec, 'n2', 170, 40);                     // beforeTick re-syncs the same pin every frame
    assert.deepStrictEqual(pool.sent, [{ type: 'pin', frameId: '/r/a', gen: rec.gen, idx: 2, x: 170, y: 40 }]);
    assert.strictEqual(rec.settled, false);
    assert.ok(api.tickSim(rec), 'local move paints this frame');
    assert.strictEqual(api.tickSim(rec), null);
    api.pin(rec, 'n2', 9999, 40);                    // clamped into the slot like localSim
    assert.strictEqual(pool.sent[1].x, rec.byId.get('n2').fx);
    assert.ok(pool.sent[1].x <= 220);
    // worker positions do not move a pinned node
    api.onMessage({ type: 'positions', frameId: '/r/a', gen: rec.gen, alpha: 0.3, settled: false, buf: new Float32Array(8).fill(1) });
    api.tickSim(rec);
    assert.strictEqual(rec.byId.get('n2').x, rec.byId.get('n2').fx);
    assert.strictEqual(rec.byId.get('n1').x, 1);
    api.release(rec, 'n2', { hold: true });
    assert.deepStrictEqual(pool.sent[2], { type: 'release', frameId: '/r/a', gen: rec.gen, idx: 2, hold: true });
    api.pin(rec, 'ghost', 1, 1); api.release(rec, 'ghost');
    assert.strictEqual(pool.sent.length, 3);
  });

  test('settings / reheat / resize / slots / destroy are forwarded with the generation stamp', () => {
    const pool = fakePool();
    const api = createWorkerSimApi(ls, pool);
    const rec = makeRec(api);
    rec.settled = true; rec.alpha = 0;
    pool.sent.length = 0;
    api.applySettings(rec, { linkForce: 2, someFutureUxKey: 'x' });
    assert.deepStrictEqual(pool.sent[0], { type: 'settings', frameId: '/r/a', gen: rec.gen, patch: { linkForce: 2, someFutureUxKey: 'x' } });
    assert.strictEqual(rec.settings.someFutureUxKey, 'x');
    assert.ok(!rec.settled && api.alphaOf(rec) >= 0.3);
    api.unsettle(rec, 0.1);
    assert.deepStrictEqual(pool.sent[1], { type: 'reheat', frameId: '/r/a', gen: rec.gen, alpha: 0.1 });
    api.unsettle(rec);
    assert.strictEqual(pool.sent[2].alpha, 0.3);
    api.resizeSim(rec, { w: 50, h: 50 });
    assert.deepStrictEqual(pool.sent[3].inner, { w: 50, h: 50 });
    assert.ok(['n1', 'n3'].every(id => rec.byId.get(id).x <= 50 && rec.byId.get(id).y <= 50),
      'slot-less nodes are clamped locally for the next paint');
    api.updateSlots(rec, new Map([['n1', { x: 5, y: 5, w: 30, h: 30 }]]));
    assert.deepStrictEqual([...pool.sent[4].slots.slice(4, 8)], [5, 5, 30, 30]);
    const gen = rec.gen;
    api.destroySim(rec);
    assert.deepStrictEqual(pool.sent[5], { type: 'destroy', frameId: '/r/a', gen });
    assert.strictEqual(rec.gen, -1);
    api.destroySim(rec);
    assert.strictEqual(pool.sent.length, 6, 'destroy is sent once');
  });

  test('setPaused / setFramePaused map to pool messages', () => {
    const pool = fakePool();
    const api = createWorkerSimApi(ls, pool);
    const rec = makeRec(api);
    api.setPaused(true); api.setPaused(false);
    assert.deepStrictEqual(pool.broadcasts.map((m: any) => m.type), ['pauseAll', 'resumeAll']);
    api.setFramePaused(rec, true); api.setFramePaused(rec, false);
    assert.deepStrictEqual(pool.sent.slice(-2).map((m: any) => m.type), ['pause', 'resume']);
  });

  test('end to end over an in-process transport: a frame settles inside its rect', () => {
    const tasks: (() => void)[] = [];
    let clock = 0;
    let api: any = null;
    const host = createWorkerHost({
      ls, d3, now: () => (clock += 0.5),
      schedule: (fn: () => void) => tasks.push(fn), later: (fn: () => void) => tasks.push(fn),
      post: (m: any) => api.onMessage(structuredClone(m)),
    });
    api = createWorkerSimApi(ls, { post: (m: any) => host.onMessage(structuredClone(m)), broadcast: (m: any) => host.onMessage(m) });
    const rec = makeRec(api);
    const start = rec.nodes.map((n: any) => [n.x, n.y]);
    let guard = 0;
    while (tasks.length && guard++ < 5000) { (tasks.shift() as () => void)(); api.tickSim(rec); }
    assert.strictEqual(rec.settled, true);
    assert.notDeepStrictEqual(rec.nodes.map((n: any) => [n.x, n.y]), start, 'the simulation moved the nodes');
    const n0 = rec.byId.get('n0');
    assert.ok(n0.x >= 0 && n0.x <= 100 && n0.y >= 0 && n0.y <= 80, 'slot clamp honoured by the worker');
    assert.ok(rec.nodes.every((n: any) => n.x >= 0 && n.x <= 300 && n.y >= 0 && n.y <= 200));
  });

  test('resolveSimBackend: off → sync; auto/on → worker only when the host can start one', () => {
    const ok = { hasWorker: true, workerUri: 'https://x/simWorker.js', hasFetch: true, hasBlobUrl: true };
    assert.strictEqual(resolveSimBackend('off', ok), 'sync');
    assert.strictEqual(resolveSimBackend('auto', ok), 'worker');
    assert.strictEqual(resolveSimBackend('on', ok), 'worker');
    assert.strictEqual(resolveSimBackend(undefined, ok), 'worker');
    for (const k of Object.keys(ok)) {
      assert.strictEqual(resolveSimBackend('auto', { ...ok, [k]: k === 'workerUri' ? null : false }), 'sync', k);
    }
    assert.strictEqual(resolveSimBackend('on', undefined), 'sync');
  });
});
