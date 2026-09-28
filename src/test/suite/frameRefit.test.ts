import * as assert from 'assert';

/* eslint-disable @typescript-eslint/no-explicit-any */

// shouldRefit is pure — no DOM or state needed beyond the arguments.
if ((global as any).state === undefined) { (global as any).state = {}; }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fr = require('../../../src/webview/frameRender.js');

suite('shouldRefit — automatic re-fit gate (F2)', () => {
  // bounds 2000x1600 at k=1 in a 1280x800 view → overflows both dimensions
  const view = { w: 1280, h: 800 };

  test('fires when the layout overflows the current view by >30%', () => {
    assert.strictEqual(fr.shouldRefit({ w: 2000, h: 100 }, 1, view.w, view.h, false, false), true);
    assert.strictEqual(fr.shouldRefit({ w: 100, h: 1100 }, 1, view.w, view.h, false, false), true);
  });

  test('quiet while the layout still roughly fits the view', () => {
    assert.strictEqual(fr.shouldRefit({ w: 1600, h: 1000 }, 1, view.w, view.h, false, false), false);
    // zoomed out far enough, even a huge layout fits
    assert.strictEqual(fr.shouldRefit({ w: 5000, h: 4000 }, 0.2, view.w, view.h, false, false), false);
  });

  test('progressive growth cannot ratchet past the gate (live-zoom compare)', () => {
    // Fitted at k=0.6; each patch grows bounds 20% — the 4th render crosses
    // the threshold against the UNCHANGED zoom even though every single step
    // stayed under 30%.
    let w = 2100; // fits: 2100*0.6=1260 < 1280*1.3
    const k = 0.6;
    const fired: number[] = [];
    for (let i = 1; i <= 4; i++) {
      w *= 1.2;
      if (fr.shouldRefit({ w, h: 100 }, k, view.w, view.h, false, false)) { fired.push(i); }
    }
    assert.deepStrictEqual(fired.length > 0, true, 'cumulative growth must eventually re-fit');
  });

  test('never after a user zoom gesture', () => {
    assert.strictEqual(fr.shouldRefit({ w: 9000, h: 9000 }, 1, view.w, view.h, true, false), false);
  });

  test('never during a frame drag/resize', () => {
    assert.strictEqual(fr.shouldRefit({ w: 9000, h: 9000 }, 1, view.w, view.h, false, true), false);
  });

  test('never without bounds, zoom or viewport', () => {
    assert.strictEqual(fr.shouldRefit(null, 1, view.w, view.h, false, false), false);
    assert.strictEqual(fr.shouldRefit({ w: 9000, h: 9000 }, 0, view.w, view.h, false, false), false);
    assert.strictEqual(fr.shouldRefit({ w: 9000, h: 9000 }, 1, 0, 0, false, false), false);
  });
});
