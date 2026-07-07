import * as assert from 'assert';

// Pure module, guarded CJS export (same pattern as aggregate.js).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tuning = require('../../../src/webview/layoutTuning.js');

suite('layoutTuning', () => {
  suite('computeForceDefaults', () => {
    test('small graphs keep the current defaults', () => {
      for (const n of [0, 10, 250, 499]) {
        assert.deepStrictEqual(tuning.computeForceDefaults(n),
          { centerForce: 0.05, repelForce: 250, linkForce: 1 });
      }
    });
    test('very large graphs get compact params (strong center, weak repel)', () => {
      const d = tuning.computeForceDefaults(3000);
      assert.strictEqual(d.centerForce, 0.15);
      assert.strictEqual(d.repelForce, 80);
      assert.strictEqual(d.linkForce, 1);
      // clamped beyond the scale window
      assert.deepStrictEqual(tuning.computeForceDefaults(50000), d);
    });
    test('scales monotonically between 500 and 3000 nodes', () => {
      let prevCenter = 0;
      let prevRepel = Infinity;
      for (const n of [500, 1000, 1750, 2500, 3000]) {
        const d = tuning.computeForceDefaults(n);
        assert.ok(d.centerForce >= prevCenter, `centerForce non-decreasing at ${n}`);
        assert.ok(d.repelForce <= prevRepel, `repelForce non-increasing at ${n}`);
        prevCenter = d.centerForce;
        prevRepel = d.repelForce;
      }
    });
  });

  suite('size thresholds', () => {
    test('large-graph boundary at 800 nodes', () => {
      assert.strictEqual(tuning.isLargeGraph(799), false);
      assert.strictEqual(tuning.isLargeGraph(800), true);
      assert.strictEqual(tuning.LARGE_GRAPH_NODE_THRESHOLD, 800);
    });
    test('collide and drag-reheat stay on for small graphs, off for large', () => {
      assert.strictEqual(tuning.useCollide(799), true);
      assert.strictEqual(tuning.useCollide(800), false);
      assert.strictEqual(tuning.dragShouldReheat(799), true);
      assert.strictEqual(tuning.dragShouldReheat(800), false);
    });
    test('alphaDecay unchanged for small graphs, faster for large', () => {
      assert.strictEqual(tuning.alphaDecayFor(799), 0.02);
      assert.strictEqual(tuning.alphaDecayFor(800), 0.05);
    });
  });

  suite('shouldFreeze', () => {
    test('never freezes small graphs', () => {
      assert.strictEqual(tuning.shouldFreeze(0.001, 799), false);
    });
    test('freezes large graphs only once alpha settles below 0.05', () => {
      assert.strictEqual(tuning.shouldFreeze(0.06, 800), false);
      assert.strictEqual(tuning.shouldFreeze(0.049, 800), true);
    });
  });
});
