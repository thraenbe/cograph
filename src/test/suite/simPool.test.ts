import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createSimPool, poolSizeFor, blobUrlFor } = require('../../../src/webview/simPool.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

class FakeWorker {
  sent: any[] = [];
  terminated = false;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  postMessage(msg: any, transfer: any[]) { this.sent.push({ msg, transfer }); }
  terminate() { this.terminated = true; }
  emit(data: any) { if (this.onmessage) { this.onmessage({ data }); } }
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function makePool(size: number, over: any = {}) {
  const workers: FakeWorker[] = [];
  const messages: any[] = [];
  const fails: string[] = [];
  const pool = createSimPool({
    size,
    makeWorker: over.makeWorker ?? (() => { const w = new FakeWorker(); workers.push(w); return w; }),
    onMessage: (m: any) => messages.push(m),
    onFail: (r: string) => fails.push(r),
  });
  return { pool, workers, messages, fails };
}

suite('simPool', () => {
  test('poolSizeFor = min(max, cores − 1), at least 1', () => {
    assert.strictEqual(poolSizeFor(22, 4), 4);
    assert.strictEqual(poolSizeFor(4, 4), 3);
    assert.strictEqual(poolSizeFor(2, 4), 1);
    assert.strictEqual(poolSizeFor(1, 4), 1);
    assert.strictEqual(poolSizeFor(undefined, 4), 1);
    assert.strictEqual(poolSizeFor(NaN), 1);
  });

  test('messages posted before boot are queued and flushed in order', async () => {
    const { pool, workers } = makePool(1);
    const buf = new Float32Array(2);
    pool.post({ type: 'create', frameId: '/a', gen: 1 }, [buf.buffer]);
    pool.post({ type: 'pin', frameId: '/a', gen: 1 });
    assert.strictEqual(workers.length, 0, 'workers boot asynchronously');
    await tick();
    assert.deepStrictEqual(workers[0].sent.map(s => s.msg.type), ['create', 'pin']);
    assert.strictEqual(workers[0].sent[0].transfer[0], buf.buffer);
    pool.post({ type: 'reheat', frameId: '/a', gen: 1 });
    assert.strictEqual(workers[0].sent.length, 3, 'direct once booted');
  });

  test('frames go to the least-loaded worker and stay there; destroy frees the slot', async () => {
    const { pool, workers } = makePool(2);
    await tick();
    pool.post({ type: 'create', frameId: '/a', gen: 1 });
    pool.post({ type: 'create', frameId: '/b', gen: 1 });
    pool.post({ type: 'create', frameId: '/c', gen: 1 });
    assert.deepStrictEqual(pool.loads(), [2, 1]);
    pool.post({ type: 'pin', frameId: '/b', gen: 1 });
    assert.deepStrictEqual(workers[1].sent.map(s => s.msg.type), ['create', 'pin'], '/b stays on its worker');
    pool.post({ type: 'destroy', frameId: '/a', gen: 1 });
    assert.deepStrictEqual(pool.loads(), [1, 1]);
    pool.post({ type: 'create', frameId: '/a', gen: 2 });
    pool.post({ type: 'create', frameId: '/a', gen: 3 }); // re-create keeps the slot
    assert.deepStrictEqual(pool.loads(), [2, 1]);
    pool.post({ type: 'pin', frameId: '/ghost', gen: 1 });
    assert.strictEqual(workers[0].sent.length + workers[1].sent.length, 7, 'unknown frame is dropped');
  });

  test('broadcast reaches every worker; worker messages reach onMessage, ready is swallowed', async () => {
    const { pool, workers, messages } = makePool(3);
    await tick();
    pool.broadcast({ type: 'pauseAll' });
    assert.ok(workers.every(w => w.sent.length === 1 && w.sent[0].msg.type === 'pauseAll'));
    workers[0].emit({ type: 'ready' });
    workers[1].emit({ type: 'positions', frameId: '/a', gen: 1 });
    workers[1].emit(null);
    assert.deepStrictEqual(messages.map(m => m.type), ['positions']);
  });

  test('a worker error fails the pool once, terminates everything, stops posting', async () => {
    const { pool, workers, fails, messages } = makePool(2);
    await tick();
    (workers[0].onerror as any)({ message: 'boom' });
    (workers[1].onerror as any)({ message: 'again' });
    workers[1].emit({ type: 'worker-error', message: 'late' });
    assert.deepStrictEqual(fails, ['boom']);
    assert.ok(pool.isFailed());
    assert.ok(workers.every(w => w.terminated));
    const sent = workers[0].sent.length;
    pool.post({ type: 'create', frameId: '/a', gen: 1 });
    pool.broadcast({ type: 'resumeAll' });
    workers[1].emit({ type: 'positions', frameId: '/a', gen: 1 });
    assert.strictEqual(workers[0].sent.length, sent);
    assert.strictEqual(messages.length, 0);
  });

  test('worker-error message and a rejected boot both fail the pool', async () => {
    const a = makePool(1);
    await tick();
    a.workers[0].emit({ type: 'worker-error', message: 'tick threw' });
    assert.deepStrictEqual(a.fails, ['tick threw']);

    const b = makePool(2, { makeWorker: () => Promise.reject(new Error('CSP says no')) });
    await tick(); await tick();
    assert.deepStrictEqual(b.fails, ['CSP says no'], 'reported once for the whole pool');
  });

  test('dispose terminates workers without reporting a failure', async () => {
    const { pool, workers, fails } = makePool(2);
    await tick();
    pool.dispose();
    assert.ok(workers.every(w => w.terminated));
    (workers[0].onerror as any)({ message: 'after dispose' });
    assert.deepStrictEqual(fails, []);
  });

  test('blobUrlFor fetches the bundle and wraps it in a Blob URL; HTTP errors reject', async () => {
    const blobs: any[] = [];
    class FakeBlob { constructor(public parts: any[], public opts: any) { blobs.push(this); } }
    const env = {
      fetch: async (u: string) => ({ ok: u.endsWith('ok.js'), status: 404, text: async () => 'self.x=1' }),
      Blob: FakeBlob,
      createObjectURL: (b: any) => `blob:fake/${blobs.indexOf(b)}`,
    };
    assert.strictEqual(await blobUrlFor('https://x/ok.js', env), 'blob:fake/0');
    assert.deepStrictEqual(blobs[0].parts, ['self.x=1']);
    assert.strictEqual(blobs[0].opts.type, 'text/javascript');
    await assert.rejects(() => blobUrlFor('https://x/missing.js', env), /HTTP 404/);
  });
});
