import * as assert from 'assert';

/* eslint-disable @typescript-eslint/no-require-imports */
const simPool = require('../../../src/webview/simPool.js');
const lsw = require('../../../src/webview/localSimWorker.js');
const ls = require('../../../src/webview/localSim.js');
const { createSimBackend } = require('../../../src/webview/simBackend.js');
/* eslint-enable @typescript-eslint/no-require-imports */

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = global as any;
const GLOBALS = ['createSimPool', 'poolSizeFor', 'blobUrlFor', 'createWorkerSimApi', 'resolveSimBackend'];

const tick = () => new Promise(resolve => setImmediate(resolve));

function makeEnv(over: any = {}) {
  const workers: any[] = [];
  class FakeWorker {
    onmessage: any = null; onerror: any = null; sent: any[] = []; terminated = false;
    constructor(public url: string) { workers.push(this); }
    postMessage(m: any) { this.sent.push(m); }
    terminate() { this.terminated = true; }
  }
  class FakeBlob { constructor(public parts: any[]) {} }
  let fetches = 0;
  const env = {
    Worker: FakeWorker,
    fetch: async () => { fetches++; return { ok: true, status: 200, text: async () => 'self.postMessage(1)' }; },
    Blob: FakeBlob,
    createObjectURL: () => 'blob:fake/1',
    hardwareConcurrency: 8,
    ...over,
  };
  return { env, workers, fetches: () => fetches };
}

function make(mode: string | undefined, envOver: any = {}, workerUri: string | null = 'https://host/dist/webview/simWorker.js') {
  const e = makeEnv(envOver);
  const logs: any[] = [];
  const events: string[] = [];
  const syncApi = { kind: 'sync', ...ls };
  const backend = createSimBackend({
    mode, workerUri, syncApi, env: e.env,
    onPositions: () => events.push('positions'),
    onFallback: (r: string) => events.push(`fallback:${r}`),
    log: (entry: any) => logs.push(entry),
  });
  return { backend, syncApi, logs, events, ...e };
}

suite('simBackend (transport selection + fallback)', () => {
  const saved: Record<string, unknown> = {};
  setup(() => {
    for (const k of GLOBALS) { saved[k] = g[k]; }
    Object.assign(g, {
      createSimPool: simPool.createSimPool, poolSizeFor: simPool.poolSizeFor, blobUrlFor: simPool.blobUrlFor,
      createWorkerSimApi: lsw.createWorkerSimApi, resolveSimBackend: lsw.resolveSimBackend,
    });
  });
  teardown(() => { for (const k of GLOBALS) { g[k] = saved[k]; } });

  test('workers "off" is today\'s path: the very same localSim functions, no worker, no fetch', async () => {
    const t = make('off');
    await tick();
    assert.strictEqual(t.backend.api(), t.syncApi);
    for (const fn of ['createSim', 'tickSim', 'pin', 'release', 'applySettings', 'resizeSim', 'updateSlots', 'destroySim', 'alphaOf', 'unsettle']) {
      assert.strictEqual(t.backend.api()[fn], ls[fn], `${fn} is the untouched localSim export`);
    }
    assert.strictEqual(t.backend.kind(), 'sync');
    assert.strictEqual(t.workers.length, 0);
    assert.strictEqual(t.fetches(), 0);
    assert.strictEqual(t.backend.poolSize(), 0);
  });

  test('auto without Worker / without a bundled worker URI stays sync, silently', () => {
    assert.strictEqual(make('auto', { Worker: undefined }).backend.kind(), 'sync');
    const noUri = make('auto', {}, null);
    assert.strictEqual(noUri.backend.kind(), 'sync');
    assert.deepStrictEqual(noUri.logs, []);
  });

  test('"on" without worker support logs one structured warning', () => {
    const t = make('on', { Worker: undefined });
    assert.strictEqual(t.backend.kind(), 'sync');
    assert.deepStrictEqual(t.logs.map((l: any) => [l.level, l.event]), [['warn', 'sim-workers-unavailable']]);
  });

  test('auto with a capable host: pool of min(4, cores−1) blob workers, ONE fetch', async () => {
    const t = make('auto');
    assert.strictEqual(t.backend.kind(), 'worker');
    assert.strictEqual(t.backend.poolSize(), 4);
    await tick(); await tick();
    assert.strictEqual(t.workers.length, 4);
    assert.ok(t.workers.every((w: any) => w.url === 'blob:fake/1'));
    assert.strictEqual(t.fetches(), 1);
  });

  test('accepted positions wake the caller; stale ones do not', async () => {
    const t = make('auto', { hardwareConcurrency: 2 });
    await tick(); await tick();
    const api = t.backend.api();
    const rec = api.createSim({ path: '/a', inner: { w: 100, h: 100 } }, [{ id: 'n', r: 4 }], [], {}, {});
    const w = t.workers[0];
    w.onmessage({ data: { type: 'positions', frameId: '/a', gen: rec.gen + 5, alpha: 1, settled: false, buf: new Float32Array(2) } });
    assert.deepStrictEqual(t.events, []);
    w.onmessage({ data: { type: 'positions', frameId: '/a', gen: rec.gen, alpha: 1, settled: false, buf: new Float32Array(2) } });
    assert.deepStrictEqual(t.events, ['positions']);
  });

  test('a pool failure swaps back to the sync API, logs once and tells the caller to rebuild', async () => {
    const t = make('auto');
    await tick(); await tick();
    t.workers[1].onerror({ message: 'worker crashed' });
    assert.strictEqual(t.backend.api(), t.syncApi);
    assert.deepStrictEqual(t.events, ['fallback:worker crashed']);
    assert.deepStrictEqual(t.logs.map((l: any) => [l.event, l.detail]), [['sim-workers-fallback', 'worker crashed']]);
    assert.ok(t.workers.every((w: any) => w.terminated));
  });

  test('a blocked bootstrap (fetch/CSP) falls back the same way', async () => {
    const t = make('auto', { fetch: async () => ({ ok: false, status: 403, text: async () => '' }) });
    await tick(); await tick(); await tick();
    assert.strictEqual(t.backend.kind(), 'sync');
    assert.strictEqual(t.events.length, 1);
    assert.ok(/HTTP 403/.test(t.events[0]));
  });

  test('dispose terminates the pool and returns to sync', async () => {
    const t = make('auto');
    await tick(); await tick();
    t.backend.dispose();
    assert.ok(t.workers.every((w: any) => w.terminated));
    assert.strictEqual(t.backend.kind(), 'sync');
  });
});
