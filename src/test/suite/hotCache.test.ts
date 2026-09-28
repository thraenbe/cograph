import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const hc = require('../../../src/webview/hotCache.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

suite('hotCache (css var memo)', () => {
  setup(() => { hc.invalidateCssVars(); hc.stopWatchingTheme(); });
  teardown(() => { hc.invalidateCssVars(); hc.stopWatchingTheme(); });

  test('reads once per name until invalidated', () => {
    const reads: string[] = [];
    const read = (n: string) => { reads.push(n); return `v:${n}:${reads.length}`; };
    assert.strictEqual(hc.cssVarCached('--a', read), 'v:--a:1');
    assert.strictEqual(hc.cssVarCached('--a', read), 'v:--a:1');
    assert.strictEqual(hc.cssVarCached('--b', read), 'v:--b:2');
    assert.deepStrictEqual(reads, ['--a', '--b']);
    hc.invalidateCssVars();
    assert.strictEqual(hc.cssVarCached('--a', read), 'v:--a:3');
  });

  test('an empty value is cached too (no re-read storm for unset vars)', () => {
    let n = 0;
    const read = () => { n++; return ''; };
    hc.cssVarCached('--unset', read);
    hc.cssVarCached('--unset', read);
    assert.strictEqual(n, 1);
  });

  test('watchThemeChanges observes html + body and invalidates on mutation', () => {
    const observed: any[] = [];
    let fire: () => void = () => { throw new Error('observer not constructed'); };
    class FakeObserver {
      constructor(cb: () => void) { fire = cb; }
      observe(target: any, opts: any) { observed.push([target, opts]); }
      disconnect() { observed.length = 0; }
    }
    const doc = { documentElement: { tag: 'html' }, body: { tag: 'body' } };
    assert.strictEqual(hc.watchThemeChanges(doc, FakeObserver), true);
    assert.strictEqual(hc.watchThemeChanges(doc, FakeObserver), false, 'installed once');
    assert.strictEqual(observed.length, 2);
    assert.deepStrictEqual(observed[0][1].attributeFilter, ['class', 'style']);

    let reads = 0;
    const read = () => { reads++; return 'x'; };
    hc.cssVarCached('--t', read);
    fire(); // theme switched
    hc.cssVarCached('--t', read);
    assert.strictEqual(reads, 2);
  });

  test('watchThemeChanges is a no-op without a document or observer', () => {
    class FakeCtor { observe() { return undefined; } }
    assert.strictEqual(hc.watchThemeChanges(null, FakeCtor), false);
    assert.strictEqual(hc.watchThemeChanges({}, undefined), false);
  });
});
