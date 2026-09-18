import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ls = require('../../../src/webview/localSim.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

// Minimal fake d3 simulation: records force objects, decays alpha per tick,
// integrates velocities and honours fx/fy — enough to exercise the module
// without d3 (which is CDN-only in the webview and absent in node_modules).
function makeFakeSim(rec: any) {
  let alpha = 1;
  let target = 0;
  const forces = new Map<string, any>();
  const spy = () => {
    const calls: any[] = [];
    const f: any = { calls };
    f.strength = (v: any) => { calls.push(['strength', v]); return f; };
    f.x = (v: any) => { calls.push(['x', v]); return f; };
    f.y = (v: any) => { calls.push(['y', v]); return f; };
    return f;
  };
  forces.set('charge', spy());
  forces.set('x', spy());
  forces.set('y', spy());
  forces.set('link', spy());
  const sim: any = {
    stopped: false,
    alpha(v?: number) { if (v === undefined) { return alpha; } alpha = v; return sim; },
    alphaMin: () => 0.001,
    alphaTarget(v?: number) { if (v === undefined) { return target; } target = v; return sim; },
    tick() {
      alpha = target + (alpha - target) * 0.6;
      for (const n of rec.nodes) {
        if (n.fx != null) { n.x = n.fx; n.y = n.fy; }
        else { n.x += n.vx; n.y += n.vy; }
      }
      return sim;
    },
    force(name: string, f?: any) {
      if (f === undefined) { return forces.get(name); }
      forces.set(name, f);
      return sim;
    },
    stop() { sim.stopped = true; return sim; },
    nodes: () => rec.nodes,
  };
  return sim;
}

const FRAME = { path: '/p/a', inner: { w: 400, h: 300 } };
const deps = { makeSim: makeFakeSim };

function members(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `n${i}`, r: 10, file: `/p/a/f${i % 2}.ts` }));
}

suite('localSim', () => {
  test('createSim: seeded positions kept, others start inside the frame', () => {
    const seed = new Map([['n0', { x: 50, y: 60 }]]);
    const rec = ls.createSim(FRAME, members(5), [], {}, deps, seed);
    assert.strictEqual(rec.nodes[0].x, 50);
    assert.strictEqual(rec.nodes[0].y, 60);
    for (const n of rec.nodes) {
      assert.ok(n.x >= 0 && n.x <= 400 && n.y >= 0 && n.y <= 300, `inside: ${n.id}`);
    }
  });

  test('createSim throws without d3 or makeSim', () => {
    assert.throws(() => ls.createSim(FRAME, members(1), [], {}, {}), /inject deps\.d3/);
  });

  test('hardClamp pulls an outside node in and kills outward velocity', () => {
    const rec = ls.createSim(FRAME, members(1), [], {}, deps, new Map([['n0', { x: -50, y: 500 }]]));
    const n = rec.nodes[0];
    assert.strictEqual(n.x, 10, 'clamped to r');
    assert.strictEqual(n.y, 300 - 10, 'clamped to h - r');
    n.x = -20; n.vx = -5;
    ls.hardClamp(rec);
    assert.strictEqual(n.x, 10);
    assert.strictEqual(n.vx, 0);
  });

  test('intra links filtered to member ids', () => {
    const rec = ls.createSim(FRAME, members(2), [
      { source: 'n0', target: 'n1' },
      { source: 'n0', target: 'ELSEWHERE' },
    ], {}, deps);
    assert.strictEqual(rec.links.length, 1);
  });

  test('tickSim returns {path,gen,nodes}, settles below alphaMin, then null', () => {
    const rec = ls.createSim(FRAME, members(3), [], {}, deps);
    const r = ls.tickSim(rec);
    assert.strictEqual(r.path, '/p/a');
    assert.strictEqual(r.gen, rec.gen);
    let guard = 0;
    while (!rec.settled && guard++ < 100) { ls.tickSim(rec); }
    assert.ok(rec.settled, 'settled');
    assert.strictEqual(ls.tickSim(rec), null);
  });

  test('pin clamps into the frame, sets alphaTarget(0.3), unsettles; release clears', () => {
    const rec = ls.createSim(FRAME, members(2), [], {}, deps);
    rec.settled = true;
    ls.pin(rec, 'n0', -100, 150);
    const n = rec.byId.get('n0');
    assert.strictEqual(n.fx, 10, 'pin clamped');
    assert.strictEqual(rec.sim.alphaTarget(), 0.3);
    assert.strictEqual(rec.settled, false);
    ls.release(rec, 'n0');
    assert.strictEqual(n.fx, null);
    assert.strictEqual(rec.sim.alphaTarget(), 0);
    ls.pin(rec, 'n0', 20, 20);
    ls.release(rec, 'n0', { hold: true });
    assert.strictEqual(n.fx, 20, 'hold keeps the pin');
  });

  test('applySettings maps patches onto forces and reheats', () => {
    const rec = ls.createSim(FRAME, members(2), [], { repelForce: 250 }, deps);
    rec.settled = true;
    rec.sim.alpha(0.0005);
    ls.applySettings(rec, { repelForce: 100, centerForce: 0.5, linkForce: 2 });
    assert.deepStrictEqual(rec.sim.force('charge').calls.pop(), ['strength', -15]); // repel × 0.15 (slot-scale charge)
    assert.deepStrictEqual(rec.sim.force('x').calls.pop(), ['strength', 0.5]);
    assert.deepStrictEqual(rec.sim.force('link').calls.pop(), ['strength', 0.2]);
    assert.strictEqual(rec.settled, false);
    assert.ok(rec.sim.alpha() >= 0.3, 'reheated');
  });

  test('resizeSim clamps nodes into the new rect and reheats', () => {
    const rec = ls.createSim(FRAME, members(1), [], {}, deps, new Map([['n0', { x: 390, y: 290 }]]));
    ls.resizeSim(rec, { w: 100, h: 100 });
    assert.deepStrictEqual(rec.inner, { w: 100, h: 100 });
    const n = rec.nodes[0];
    assert.ok(n.x <= 90 && n.y <= 90, 'clamped into the new rect');
    assert.strictEqual(rec.settled, false);
  });

  test('slots: nodes seed, clamp and pin inside their own slot', () => {
    const slots = new Map([
      ['n0', { x: 20, y: 30, w: 60, h: 50 }],
      ['n1', { x: 200, y: 100, w: 60, h: 50 }],
    ]);
    const rec = ls.createSim(FRAME, members(2), [], {}, deps, null, slots);
    const inSlot = (n: any, b: any) =>
      n.x >= b.x && n.x <= b.x + b.w && n.y >= b.y && n.y <= b.y + b.h;
    assert.ok(inSlot(rec.byId.get('n0'), slots.get('n0')), 'n0 seeds inside its slot');
    assert.ok(inSlot(rec.byId.get('n1'), slots.get('n1')), 'n1 seeds inside its slot');
    // push a node out; hardClamp pulls it back into ITS slot
    const n0 = rec.byId.get('n0');
    n0.x = 300; n0.y = 200; n0.vx = 5;
    ls.hardClamp(rec);
    assert.ok(inSlot(n0, slots.get('n0')), 'clamped back into its own slot');
    // pin clamps to the slot too
    ls.pin(rec, 'n1', 0, 0);
    const n1 = rec.byId.get('n1');
    assert.ok(n1.fx >= 200 && n1.fy >= 100, 'pin clamped into slot');
  });

  test('slotPull accelerates a node toward its slot centre', () => {
    const slots = new Map([['n0', { x: 100, y: 100, w: 40, h: 40 }]]);
    const rec = ls.createSim(FRAME, members(1), [], { fileClusterForce: 0.5 }, deps, null, slots);
    const n = rec.byId.get('n0');
    n.x = 105; n.y = 135; n.vx = 0; n.vy = 0; // inside slot, off-centre
    ls.lsSlotPull(rec)(1);
    assert.ok(n.vx > 0, 'pulled right toward centre x=120');
    assert.ok(n.vy < 0, 'pulled up toward centre y=120');
  });

  test('updateSlots swaps rects, clamps and reheats', () => {
    const rec = ls.createSim(FRAME, members(1), [], {}, deps);
    rec.settled = true;
    ls.updateSlots(rec, new Map([['n0', { x: 10, y: 10, w: 30, h: 30 }]]));
    const n = rec.byId.get('n0');
    assert.ok(n.x >= 10 && n.x <= 40, 'clamped into the new slot');
    assert.strictEqual(rec.settled, false);
  });

  test('destroySim stops the sim and marks the record stale (gen −1)', () => {
    const rec = ls.createSim(FRAME, members(2), [], {}, deps);
    const sim = rec.sim;
    ls.destroySim(rec);
    assert.strictEqual(sim.stopped, true);
    assert.strictEqual(rec.gen, -1);
    assert.strictEqual(rec.settled, true);
    assert.strictEqual(rec.nodes.length, 0);
  });
});
