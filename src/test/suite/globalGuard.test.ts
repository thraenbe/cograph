import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gg = require('../../../src/webview/globalGuard.js');

suite('globalGuard — two-click gate', () => {
  function makeGuard(startMs = 1000) {
    let t = startMs;
    const guard = gg.createGlobalGuard(() => t);
    return { guard, tick: (ms: number) => { t += ms; } };
  }
  const N = gg.GLOBAL_GUARD.N;

  test('below or at the threshold: switches immediately', () => {
    const { guard } = makeGuard();
    assert.strictEqual(guard.check(N), 'switch');
    assert.strictEqual(guard.check(100), 'switch');
    assert.strictEqual(guard.armed(), false);
  });

  test('above the threshold: first click blocks and arms the window', () => {
    const { guard } = makeGuard();
    assert.strictEqual(guard.check(N + 1), 'blocked');
    assert.strictEqual(guard.armed(), true);
  });

  test('second click within the window switches', () => {
    const { guard, tick } = makeGuard();
    guard.check(N + 1);
    tick(gg.GLOBAL_GUARD.WINDOW_MS - 1);
    assert.strictEqual(guard.check(N + 1), 'switch');
    assert.strictEqual(guard.armed(), false, 'consumed');
  });

  test('an expired window blocks again', () => {
    const { guard, tick } = makeGuard();
    guard.check(N + 1);
    tick(gg.GLOBAL_GUARD.WINDOW_MS + 1);
    assert.strictEqual(guard.check(N + 1), 'blocked', 'timeout resets the gate');
  });

  test('force bypasses the guard (saved Global views, host config pushes)', () => {
    const { guard } = makeGuard();
    assert.strictEqual(guard.check(N * 20, { force: true }), 'switch');
    assert.strictEqual(guard.armed(), false);
  });

  test('a small graph disarms a stale window', () => {
    const { guard } = makeGuard();
    guard.check(N + 1);
    assert.strictEqual(guard.check(100), 'switch');
    assert.strictEqual(guard.armed(), false);
  });

  test('hint texts carry the formatted threshold', () => {
    const n = gg.GLOBAL_GUARD.N.toLocaleString('en-US');
    for (const kind of ['switch', 'boot', 'detail']) {
      assert.ok(gg.globalGuardHintText(kind).includes(n), kind);
    }
    assert.ok(gg.globalGuardHintText('switch').includes('click Global again'));
    assert.ok(gg.globalGuardHintText('boot').includes('started in Shelf'));
  });
});

suite('globalGuard — main.js wiring (source contract)', () => {
  const mainSrc = fs.readFileSync(
    path.resolve(__dirname, '../../../src/webview/main.js'), 'utf8');

  test('setLayoutEngine consults the guard only when switching TO Global', () => {
    const fn = mainSrc.slice(mainSrc.indexOf('function setLayoutEngine'));
    const head = fn.slice(0, fn.indexOf('state.layoutEngine = engine'));
    assert.ok(head.includes("engine === 'global' && state.layoutEngine !== 'global'"));
    assert.ok(head.includes("=== 'blocked'"), 'blocked verdict stops the switch');
    assert.ok(head.includes("showGlobalGuardHint('switch')"));
  });

  test('saved views and host config pushes bypass the guard', () => {
    assert.ok(/setLayoutEngine\(savedEngine, \{ force: true \}\)/.test(mainSrc),
      'a saved Global view is the explicit choice');
    assert.ok(/setLayoutEngine\(message\.defaultEngine, \{ force: true \}\)/.test(mainSrc),
      'changing the setting is the explicit choice');
  });

  test('boot case: a Global boot config with a big first graph starts in Shelf', () => {
    const i = mainSrc.indexOf('_globalBootGuarded');
    assert.ok(i > 0);
    const branch = mainSrc.slice(i, i + 600);
    assert.ok(branch.includes("state.layoutEngine = 'shelf'"));
    assert.ok(branch.includes("showGlobalGuardHint('boot')"));
  });

  test('raising Detail past the threshold hints without blocking', () => {
    assert.ok(mainSrc.includes('function maybeWarnGlobalSize'));
    const fn = mainSrc.slice(mainSrc.indexOf('function maybeWarnGlobalSize'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(body.includes("showGlobalGuardHint('detail')"));
    assert.ok(!body.includes('return; //'), 'hint only — nothing is blocked here');
  });
});
