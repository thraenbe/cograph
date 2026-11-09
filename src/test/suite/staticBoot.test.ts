import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

// rendering.js cannot be require()d (top-level d3/SVG), so the F4 regression
// tests evaluate the REAL staticBootFreeze source against a fake simulation,
// and assert the call-site ordering (freeze → render → fit) on the source.
const renderingSrc = fs.readFileSync(
  path.resolve(__dirname, '../../../src/webview/rendering.js'), 'utf8');

function extractStaticBootFreeze(collideTicks?: number) {
  const m = renderingSrc.match(/function staticBootFreeze\([\s\S]*?\n\}/);
  assert.ok(m, 'staticBootFreeze found in rendering.js');
  const c = renderingSrc.match(/const STATIC_COLLIDE_TICKS = \d+;\nfunction collisionOnlyPass\([\s\S]*?\n\}/);
  assert.ok(c, 'collisionOnlyPass found in rendering.js');
  const pass = collideTicks === undefined ? c![0] : c![0].replace(/STATIC_COLLIDE_TICKS = \d+/, `STATIC_COLLIDE_TICKS = ${collideTicks}`);
  return new Function(`${m![0]}\n${pass}; return staticBootFreeze;`)();
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

suite('graph-loaded restore ordering (F14, source contract)', () => {
  test('Global consumes drill-down state and renders BEFORE positions; repaints after', () => {
    const mainSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../src/webview/main.js'), 'utf8');
    const handler = mainSrc.slice(mainSrc.indexOf("message.type === 'graph-loaded'"));
    const drilldownAt = handler.indexOf('applySavedDrilldownState');
    const renderAt = handler.indexOf('applyComplexity()');
    const positionsAt = handler.indexOf('nodePositions[n.id]');
    assert.ok(drilldownAt > 0 && renderAt > drilldownAt && positionsAt > renderAt,
      'order must be: drill-down state → render → positions');
    assert.ok(/isGlobalRestore\) \{\s+state\.hasFitted = false;[^]*?ticked\(\);/.test(handler),
      'Global repaints + re-fits after positions instead of re-rendering');
    const tail = handler.slice(positionsAt);
    const secondRender = tail.indexOf('applyComplexity()');
    assert.ok(/isGlobalRestore/.test(tail.slice(0, secondRender)) || secondRender < 0,
      'any render after positions must be the non-Global (shelf) branch');
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

  test('a collision-only pass separates what the bounded settle left overlapping (real d3)', () => {
    // The settle stops at alpha 0.05; with strong clustering pulls (here: everything pulled to one point) the
    // collision force has not separated the nodes yet. Measured in uxtest: overlap up to 0.197 of the nodes.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const d3 = require('d3');
    const R = 10;
    const crowd = (collideTicks?: number) => {
      const nodes = Array.from({ length: 60 }, (_, i) => ({ x: (i % 8) * 3, y: Math.floor(i / 8) * 3 })) as any[];
      const sim = d3.forceSimulation(nodes).alphaDecay(0.02)
        .force('x', d3.forceX(0).strength(0.8)).force('y', d3.forceY(0).strength(0.8))
        .force('collision', d3.forceCollide(R));
      extractStaticBootFreeze(collideTicks)(sim, nodes, 150);
      let pairs = 0;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) < 2 * R * 0.9) { pairs++; }
        }
      }
      return { pairs, pinned: nodes.every(n => n.fx === n.x && n.fy === n.y) };
    };
    const without = crowd(0);
    assert.ok(without.pairs > 0, `control: without the pass the crowd overlaps (${without.pairs} pairs)`);
    const withPass = crowd();
    assert.ok(withPass.pairs < without.pairs / 4, `the pass separates the crowd: ${withPass.pairs} pairs (without: ${without.pairs})`);
    assert.ok(withPass.pinned, 'every node is still pinned where it landed');
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

  test('the freeze runs after the overlay forces and elements of the render (source contract)', () => {
    // Inside startSimulation() the settle ran without the file / drill-down clustering forces, and its one paint
    // came before the drill-down boxes existed: they stayed 0×0 (uxtest/unit/globalStaticBoxes.test.ts).
    const startSim = renderingSrc.slice(renderingSrc.indexOf('function startSimulation('), renderingSrc.indexOf('function staticBootFreeze('));
    assert.ok(!startSim.includes('staticBootFreeze('), 'startSimulation must not freeze: the overlay forces are not attached yet');
    const layout = renderingSrc.slice(renderingSrc.indexOf('function renderGlobalLayout('));
    const freezeAt = layout.indexOf('staticBootFreeze(');
    for (const after of ['startSimulation(drawLinks)', 'renderDrilldownBoxes(boxes)', "force('drilldownCluster', createDrilldownClusterForce", "force('fileCluster', createFileClusterForce", 'renderClassBubbles(']) {
      const at = layout.indexOf(after);
      assert.ok(at > 0 && freezeAt > at, `staticBootFreeze must come after ${after}`);
    }
  });
});
