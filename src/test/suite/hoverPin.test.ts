import * as assert from 'assert';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const g = global as any;

suite('hoverPin (X2): hold a hovered function still in Global + Dynamic', () => {
  const GLOBALS = ['state', 'usesFrames'];
  const saved: Record<string, unknown> = {};
  let hp: any;
  setup(() => {
    for (const k of GLOBALS) { saved[k] = g[k]; }
    g.state = { layoutMode: 'dynamic' };
    g.usesFrames = () => false;
    delete require.cache[require.resolve('../../../src/webview/hoverPin.js')];
    hp = require('../../../src/webview/hoverPin.js');
  });
  teardown(() => { for (const k of GLOBALS) { if (saved[k] === undefined) { delete g[k]; } else { g[k] = saved[k]; } } });

  test('pins on hover at its current position, releases on mouseout', () => {
    const d: any = { x: 10, y: 20, fx: null, fy: null };
    hp.hoverPinOn(d);
    assert.deepStrictEqual([d.fx, d.fy], [10, 20]);
    hp.hoverPinOff(d);
    assert.deepStrictEqual([d.fx, d.fy], [null, null]);
  });

  test('never touches a node the user pinned (e.g. a drag in Static, a saved layout)', () => {
    const d: any = { x: 10, y: 20, fx: 99, fy: 98 };
    hp.hoverPinOn(d);
    hp.hoverPinOff(d);
    assert.deepStrictEqual([d.fx, d.fy], [99, 98]);
  });

  test('a drag started on a hover-pinned node takes the pin over (mouseout no longer releases it)', () => {
    const d: any = { x: 10, y: 20, fx: undefined, fy: undefined };
    hp.hoverPinOn(d);
    hp.hoverPinHandOver(d);
    d.fx = 50; d.fy = 60;   // the drag moves it
    hp.hoverPinOff(d);
    assert.deepStrictEqual([d.fx, d.fy], [50, 60], 'the drag end decides, not the hover');
  });

  test('only Global + Dynamic: Static and Shelf are left alone', () => {
    for (const setupFn of [
      () => { g.state.layoutMode = 'static'; },
      () => { g.usesFrames = () => true; },
    ]) {
      g.state = { layoutMode: 'dynamic' }; g.usesFrames = () => false;
      setupFn();
      const d: any = { x: 1, y: 2, fx: null, fy: null };
      hp.hoverPinOn(d);
      assert.deepStrictEqual([d.fx, d.fy], [null, null]);
    }
    hp.hoverPinOn(null);
    hp.hoverPinOff(null);
  });
});
