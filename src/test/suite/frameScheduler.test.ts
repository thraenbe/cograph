import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createScheduler } = require('../../../src/webview/frameScheduler.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

function rec(path: string, over: any = {}) {
  return { path, gen: 1, settled: false, userTs: 0, expandedTs: 0, alpha: 1, ...over };
}

function makeSched(over: any = {}) {
  const rafQueue: (() => void)[] = [];
  const ticked: string[] = [];
  const results: any[][] = [];
  let clock = 100;
  const sched = createScheduler({
    raf: (cb: () => void) => { rafQueue.push(cb); return rafQueue.length; },
    caf: () => {},
    now: () => clock++,
    maxActive: over.maxActive ?? 4,
    tick: over.tick ?? ((r: any) => {
      ticked.push(r.path);
      r.alpha *= 0.5;
      if (r.alpha < 0.01) { r.settled = true; }
      return { path: r.path, gen: r.gen, nodes: [] };
    }),
    beforeTick: over.beforeTick,
    onTick: (out: any[]) => results.push(out),
  });
  return { sched, rafQueue, ticked, results, tickClock: () => clock };
}

suite('frameScheduler', () => {
  test('pick ranks userTs > expandedTs > path and caps at maxActive', () => {
    const { sched } = makeSched({ maxActive: 2 });
    const a = rec('/a'); const b = rec('/b'); const c = rec('/c'); const d = rec('/d');
    sched.add(a); sched.add(b, { expanded: true }); sched.add(c); sched.add(d);
    sched.bumpUser('/d');
    const picked = sched.pick().map((r: any) => r.path);
    assert.deepStrictEqual(picked, ['/d', '/b'], 'user first, then expanded');
  });

  test('step ticks picked records, runs beforeTick, delivers via onTick', () => {
    const pre: string[] = [];
    const { sched, ticked, results } = makeSched({ beforeTick: (r: any) => pre.push(r.path) });
    sched.add(rec('/a'));
    sched.add(rec('/b', { settled: true }));
    const out = sched.step();
    assert.deepStrictEqual(ticked, ['/a'], 'settled record not ticked');
    assert.deepStrictEqual(pre, ['/a']);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(results.length, 1);
  });

  test('stale results are dropped (record replaced or generation bumped)', () => {
    const staleTick = (r: any) => { r.settled = true; return { path: r.path, gen: r.gen - 1, nodes: [] }; };
    const { sched, results } = makeSched({ tick: staleTick });
    sched.add(rec('/a'));
    const out = sched.step();
    assert.strictEqual(out.length, 0, 'gen mismatch dropped');
    assert.strictEqual(results.length, 0);
  });

  test('visibility pauses off-screen records without touching their alpha', () => {
    const { sched, ticked } = makeSched();
    const a = rec('/a');
    sched.add(a);
    sched.setVisibility(() => false);
    sched.step();
    assert.strictEqual(ticked.length, 0);
    assert.strictEqual(a.alpha, 1, 'alpha untouched while hidden');
    sched.setVisibility(() => true);
    sched.step();
    assert.deepStrictEqual(ticked, ['/a']);
  });

  test('pauseAll stops stepping; resumeAll wakes', () => {
    const { sched, ticked } = makeSched();
    sched.add(rec('/a'));
    sched.pauseAll();
    assert.deepStrictEqual(sched.step(), []);
    assert.strictEqual(ticked.length, 0);
    sched.resumeAll();
    sched.step();
    assert.strictEqual(ticked.length, 1);
  });

  test('unsettleAll reheats every record and runs the prep hook', () => {
    const prepped: string[] = [];
    const { sched } = makeSched();
    const a = rec('/a', { settled: true });
    const b = rec('/b', { settled: true });
    sched.add(a); sched.add(b);
    sched.unsettleAll((r: any) => prepped.push(r.path));
    assert.strictEqual(a.settled, false);
    assert.strictEqual(b.settled, false);
    assert.deepStrictEqual(prepped.sort(), ['/a', '/b']);
  });

  test('rAF loop drains until everything settles, then stops rescheduling', () => {
    const { sched, rafQueue, ticked } = makeSched();
    sched.add(rec('/a'));
    // add() called wake() → one rAF queued
    let guard = 0;
    while (rafQueue.length && guard++ < 50) {
      (rafQueue.shift() as () => void)();
    }
    assert.ok(ticked.length >= 7, `ticked to settle (${ticked.length})`);
    assert.strictEqual(rafQueue.length, 0, 'no further frames scheduled once settled');
  });

  test('maxAlpha reports the hottest unsettled record', () => {
    const { sched } = makeSched();
    sched.add(rec('/a', { alpha: 0.4 }));
    sched.add(rec('/b', { alpha: 0.9, settled: true }));
    assert.strictEqual(sched.maxAlpha((r: any) => r.alpha), 0.4);
  });
});
