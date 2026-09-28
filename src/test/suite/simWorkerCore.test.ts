import * as assert from 'assert';

// The worker host runs the REAL localSim.js with the REAL d3-force (both are
// plain Node-loadable), so these tests cover the code that ships in
// dist/webview/simWorker.js minus the three lines of worker wiring.
/* eslint-disable @typescript-eslint/no-require-imports */
const ls = require('../../../src/webview/localSim.js');
const d3 = require('d3-force');
const { createWorkerHost, SW_POST_MS } = require('../../../src/webview/simWorkerCore.js');
/* eslint-enable @typescript-eslint/no-require-imports */

/* eslint-disable @typescript-eslint/no-explicit-any */

function harness(over: any = {}) {
  const posts: any[] = [];
  const tasks: (() => void)[] = [];
  let clock = 0;
  const host = createWorkerHost({
    ls: over.ls ?? ls,
    d3,
    post: (m: any, transfer: any[]) => posts.push({ m, transfer }),
    now: over.now ?? (() => (clock += 0.5)),   // every now() call advances 0.5 ms
    schedule: (fn: () => void) => tasks.push(fn),
    later: (fn: () => void) => tasks.push(fn),
  });
  const drain = (max = 5000) => { let n = 0; while (tasks.length && n++ < max) { (tasks.shift() as () => void)(); } return n; };
  return { host, posts, tasks, drain, advance: (ms: number) => { clock += ms; } };
}

function createMsg(frameId: string, gen: number, n = 6, over: any = {}) {
  const ids = Array.from({ length: n }, (_, i) => `${frameId}#${i}`);
  const xyr = new Float32Array(3 * n);
  ids.forEach((_, i) => xyr.set([40 + i * 3, 40 + (i % 3) * 5, 5], 3 * i));
  const links = new Uint32Array([0, 1, 1, 2, 2, 3]);
  const slots = new Float32Array(4 * n).fill(NaN);
  slots.set([0, 0, 120, 120], 0); // only node 0 has a slot
  return {
    type: 'create', frameId, gen, ids, files: ids.map(() => 'f.ts'), xyr, links, slots,
    inner: { w: 300, h: 200 }, settings: { repelForce: 250, linkForce: 1 }, ...over,
  };
}

suite('simWorkerCore (worker host)', () => {
  test('create → free-running ticks → throttled positions → final settled post', () => {
    const h = harness();
    h.host.onMessage(createMsg('/a', 7));
    assert.strictEqual(h.host.size(), 1);
    h.drain();
    assert.ok(h.posts.length >= 2, 'intermediate + final positions');
    const last = h.posts[h.posts.length - 1].m;
    assert.deepStrictEqual([last.type, last.frameId, last.gen, last.settled], ['positions', '/a', 7, true]);
    assert.ok(last.buf instanceof Float32Array && last.buf.length === 12);
    assert.strictEqual(h.posts[h.posts.length - 1].transfer[0], last.buf.buffer, 'buffer is transferred');
    assert.ok(h.posts.slice(0, -1).every(p => p.m.settled === false));
    assert.ok(h.posts.length < 60, `posts are throttled, not one per tick (${h.posts.length})`);
    for (let i = 0; i < 6; i++) {
      assert.ok(last.buf[2 * i] >= 0 && last.buf[2 * i] <= 300 && last.buf[2 * i + 1] >= 0 && last.buf[2 * i + 1] <= 200);
    }
    assert.strictEqual(h.host.pending(), 0);
    assert.strictEqual(h.tasks.length, 0, 'no busy loop once settled');
  });

  test('slots arrive as Float32Array(4n) with NaN = no slot', () => {
    const seen: any[] = [];
    const spyLs = { ...ls, createSim: (...a: any[]) => { seen.push(a[6]); return ls.createSim(...a); } };
    const h = harness({ ls: spyLs });
    h.host.onMessage(createMsg('/a', 1));
    assert.strictEqual(seen[0].size, 1);
    assert.deepStrictEqual(seen[0].get('/a#0'), { x: 0, y: 0, w: 120, h: 120 });
  });

  test('stale generation and unknown frames are ignored', () => {
    const h = harness();
    h.host.onMessage(createMsg('/a', 3));
    h.drain();
    const n = h.posts.length;
    for (const type of ['pin', 'release', 'settings', 'reheat', 'resize', 'slots', 'pause', 'resume', 'destroy']) {
      h.host.onMessage({ type, frameId: '/a', gen: 2, idx: 0, x: 1, y: 1, patch: {}, alpha: 1, inner: { w: 1, h: 1 } });
      h.host.onMessage({ type, frameId: '/ghost', gen: 3, idx: 0, x: 1, y: 1 });
    }
    h.drain();
    assert.strictEqual(h.posts.length, n, 'nothing re-ticked, nothing posted');
    assert.strictEqual(h.host.size(), 1, 'stale destroy did not remove the frame');
    assert.strictEqual(h.host.onMessage({ type: 'nope' }), false);
    assert.strictEqual(h.host.onMessage(null), false);
  });

  test('re-create with a new generation replaces the record; old stamps go stale', () => {
    const h = harness();
    h.host.onMessage(createMsg('/a', 1));
    h.host.onMessage(createMsg('/a', 2, 4));
    h.drain();
    assert.strictEqual(h.host.size(), 1);
    assert.ok(h.posts.every(p => p.m.gen === 2 && p.m.buf.length === 8));
  });

  test('settings patch is forwarded opaquely (unknown keys reach the record) and reheats', () => {
    const patches: any[] = [];
    const spyLs = { ...ls, applySettings: (rec: any, p: any) => { patches.push([p, rec]); return ls.applySettings(rec, p); } };
    const h = harness({ ls: spyLs });
    h.host.onMessage(createMsg('/a', 1));
    h.drain();
    const before = h.posts.length;
    h.host.onMessage({ type: 'settings', frameId: '/a', gen: 1, patch: { repelForce: 400, someFutureUxKey: 0.7 } });
    assert.strictEqual(patches[0][1].settings.someFutureUxKey, 0.7);
    assert.strictEqual(patches[0][1].settings.repelForce, 400);
    h.drain();
    assert.ok(h.posts.length > before, 'reheated frame posts again');
    assert.strictEqual(h.posts[h.posts.length - 1].m.settled, true);
  });

  test('reheat / resize / slots unsettle and re-run the frame', () => {
    const h = harness();
    h.host.onMessage(createMsg('/a', 1));
    h.drain();
    for (const m of [
      { type: 'reheat', alpha: 0.3 },
      { type: 'resize', inner: { w: 200, h: 150 } },
      { type: 'slots', slots: new Float32Array(24).fill(NaN) },
    ]) {
      const before = h.posts.length;
      h.host.onMessage({ frameId: '/a', gen: 1, ...m });
      h.drain();
      assert.ok(h.posts.length > before, `${m.type} produced positions`);
    }
    const last = h.posts[h.posts.length - 1].m;
    for (let i = 0; i < 6; i++) { assert.ok(last.buf[2 * i] <= 200 && last.buf[2 * i + 1] <= 150, 'clamped into the resized rect'); }
  });

  test('pin holds the node, keeps the frame hot at real-time pace; release lets it settle', () => {
    const h = harness();
    h.host.onMessage(createMsg('/a', 1));
    h.drain();
    h.host.onMessage({ type: 'pin', frameId: '/a', gen: 1, idx: 2, x: 150, y: 100 });
    const before = h.posts.length;
    // Hot frame never settles: bounded number of slices, each ticks ≤ once per POST_MS.
    for (let i = 0; i < 40 && h.tasks.length; i++) { (h.tasks.shift() as () => void)(); h.advance(SW_POST_MS); }
    assert.ok(h.tasks.length > 0, 'still scheduled while pinned');
    const hot = h.posts.slice(before);
    assert.ok(hot.length > 3 && hot.length <= 41, `paced posts (${hot.length})`);
    assert.ok(hot.every(p => p.m.settled === false));
    const p = hot[hot.length - 1].m.buf;
    assert.deepStrictEqual([p[4], p[5]], [150, 100], 'pinned node sits at the pin');
    h.host.onMessage({ type: 'release', frameId: '/a', gen: 1, idx: 2 });
    h.drain();
    assert.strictEqual(h.posts[h.posts.length - 1].m.settled, true);
  });

  test('paused-on-create (Static) holds every frame until resumeAll', () => {
    const h = harness();
    h.host.onMessage(createMsg('/a', 1, 6, { paused: true }));
    h.host.onMessage(createMsg('/b', 1));
    h.drain();
    assert.strictEqual(h.posts.length, 0, 'not a single tick while paused');
    h.host.onMessage({ type: 'resumeAll' });
    h.drain();
    assert.deepStrictEqual([...new Set(h.posts.filter(p => p.m.settled).map(p => p.m.frameId))].sort(), ['/a', '/b']);
    h.host.onMessage({ type: 'pauseAll' });
    h.host.onMessage({ type: 'reheat', frameId: '/a', gen: 1, alpha: 0.5 });
    const n = h.posts.length;
    h.drain();
    assert.strictEqual(h.posts.length, n);
  });

  test('per-frame pause/resume (off-viewport) and destroy', () => {
    const h = harness();
    h.host.onMessage(createMsg('/a', 1));
    h.host.onMessage(createMsg('/b', 1));
    h.host.onMessage({ type: 'pause', frameId: '/a', gen: 1 });
    h.drain();
    assert.ok(h.posts.length > 0 && h.posts.every(p => p.m.frameId === '/b'));
    h.host.onMessage({ type: 'resume', frameId: '/a', gen: 1 });
    h.host.onMessage({ type: 'destroy', frameId: '/b', gen: 1 });
    h.drain();
    assert.strictEqual(h.host.size(), 1);
    assert.strictEqual(h.posts[h.posts.length - 1].m.frameId, '/a');
  });

  test('many frames share the slices round-robin (none starves)', () => {
    const h = harness();
    for (let i = 0; i < 12; i++) { h.host.onMessage(createMsg(`/f${i}`, 1)); }
    (h.tasks.shift() as () => void)(); // ONE slice
    h.drain();
    const settled = new Set(h.posts.filter(p => p.m.settled).map(p => p.m.frameId));
    assert.strictEqual(settled.size, 12);
  });
});
