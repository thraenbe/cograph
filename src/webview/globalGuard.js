// globalGuard.js — soft two-click guard for the Global engine on big graphs.
// One d3 simulation over every current node costs ~128 ms/tick at 3k nodes in
// the editor, 150-330 ms at 10k, and seconds per frame at guava scale (58k):
// above GLOBAL_GUARD.N the first click on Engine: Global only warns, a second
// click within WINDOW_MS switches anyway. Pure decision logic + hint texts —
// DOM handling lives in main.js.

const GLOBAL_GUARD = {
  // Simulated node count (state.currentNodes): filters only hide DOM, the
  // global simulation still runs every current node. 4 000 sits above every
  // corpus repo that works acceptably today (click 1.8k, express, zod,
  // synthetic-1k) and below the sizes where a reheat drops under ~7 fps.
  N: 4000,
  WINDOW_MS: 6000,
};

/** Two-click gate. `now` is injectable for tests. */
function createGlobalGuard(now) {
  const clock = now || (() => Date.now());
  let armedUntil = 0;
  return {
    /** 'switch' | 'blocked'. opts.force (saved Global views, host config
     *  pushes) always switches — loading a saved view IS the explicit choice. */
    check(nodeCount, opts = {}) {
      if (opts.force || nodeCount <= GLOBAL_GUARD.N) { armedUntil = 0; return 'switch'; }
      const t = clock();
      if (t < armedUntil) { armedUntil = 0; return 'switch'; }
      armedUntil = t + GLOBAL_GUARD.WINDOW_MS;
      return 'blocked';
    },
    armed() { return clock() < armedUntil; },
    reset() { armedUntil = 0; },
  };
}

function globalGuardHintText(kind) {
  const n = GLOBAL_GUARD.N.toLocaleString('en-US');
  if (kind === 'boot') {
    return `Global is slow above ${n} nodes — started in Shelf instead.`;
  }
  if (kind === 'detail') {
    return `Global is slow above ${n} nodes — consider lowering Detail or switching to Shelf.`;
  }
  return `Global is slow above ${n} nodes — lower Detail first, or click Global again to switch anyway.`;
}

if (typeof module !== 'undefined') {
  module.exports = { GLOBAL_GUARD, createGlobalGuard, globalGuardHintText };
}
