import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

// rendering.js cannot be require()d (top-level d3/SVG), so the F4 regression
// tests evaluate the REAL staticBootFreeze source against a fake simulation,
// and assert the call-site ordering (freeze → render → fit) on the source.
const renderingSrc = fs.readFileSync(
  path.resolve(__dirname, '../../../src/webview/rendering.js'), 'utf8');

function extractStaticBootFreeze() {
  const m = renderingSrc.match(/function staticBootFreeze\([\s\S]*?\n\}/);
  assert.ok(m, 'staticBootFreeze found in rendering.js');
  return new Function(`${m![0]}; return staticBootFreeze;`)();
}

function makeFakeSim(nodes: any[]) {
  let alpha = 1;
  return {
    ticks: 0,
    stopped: false,
    alpha: () => alpha,
    stop() { this.stopped = true; return this; },
    tick() {
      this.ticks++;
      alpha *= 0.9;
      for (const n of nodes) { n.x += 1; n.y += 1; }
      return this;
    },
  };
}

suite('global charge — Repel range (source contract)', () => {
  test('startSimulation and rerunLayout both apply settings.repelRange as distanceMax', () => {
    assert.ok(/forceManyBody\(\)\.strength\(chargeStrength\)\.distanceMax\(settings\.repelRange \?\? Infinity\)/.test(renderingSrc),
      'startSimulation charge carries distanceMax(settings.repelRange ?? Infinity)');
    const mainSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../src/webview/main.js'), 'utf8');
    assert.ok(/charge\.distanceMax\?\.\(settings\.repelRange \?\? Infinity\)/.test(mainSrc),
      'rerunLayout re-applies distanceMax on the live simulation');
  });
});

suite('global static boot (F4)', () => {
  test('freezes every node after a bounded synchronous settle', () => {
    const staticBootFreeze = extractStaticBootFreeze();
    const nodes = [{ x: 0, y: 0 }, { x: 5, y: 5 }] as any[];
    const sim = makeFakeSim(nodes);
    staticBootFreeze(sim, nodes, 150);
    assert.ok(sim.stopped, 'simulation stopped before manual ticking');
    assert.ok(sim.ticks > 0, 'settle actually ran');
    for (const n of nodes) {
      assert.strictEqual(n.fx, n.x, 'pinned where it landed (x)');
      assert.strictEqual(n.fy, n.y, 'pinned where it landed (y)');
    }
  });

  test('the tick budget is a hard cap', () => {
    const staticBootFreeze = extractStaticBootFreeze();
    const nodes = [{ x: 0, y: 0 }] as any[];
    const sim = makeFakeSim(nodes);
    sim.alpha = () => 1; // never settles on its own
    staticBootFreeze(sim, nodes, 60);
    assert.strictEqual(sim.ticks, 60);
  });

  test('call site fits AFTER the freeze, gated on userZoomed (source contract)', () => {
    const branch = renderingSrc.match(
      /if \(state\.layoutMode === 'static'\) \{[\s\S]*?\n {2}\}/);
    assert.ok(branch, 'static boot branch found');
    const src = branch![0];
    const freezeAt = src.indexOf('staticBootFreeze(');
    const fitAt = src.indexOf('fitToView()');
    assert.ok(freezeAt >= 0 && fitAt > freezeAt,
      'fitToView must run after staticBootFreeze so the fit sees real positions');
    assert.ok(src.includes('state.hasFitted = true'),
      'the async auto-fit must be disarmed once the boot fit ran');
    assert.ok(/if \(!state\.userZoomed\) \{ fitToView\(\); \}/.test(src),
      'the boot fit must respect a viewport the user already took');
  });
});
