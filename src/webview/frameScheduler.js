// frameScheduler.js — one rAF loop driving at most `maxActive` frame
// simulations, ranked user-interacted > just-expanded > path. Settled and
// off-viewport records cost nothing; results whose record or generation went
// stale between pick and delivery are dropped (the #50 async-race class,
// handled once). Pure logic — raf/caf/now/tick are injected for tests.

function createScheduler(opts) {
  const raf = opts.raf;
  const caf = opts.caf;
  const now = opts.now || (() => Date.now());
  const maxActive = opts.maxActive ?? 4;
  const onTick = opts.onTick || (() => {});
  const tick = opts.tick;              // (rec) => {path, gen, nodes} | null
  const beforeTick = opts.beforeTick;  // optional per-record pre-step hook
  // Optional instrumentation hooks (perf.js): loop started, one step's
  // main-thread cost, loop ran dry. Absent → zero overhead.
  const onWake = opts.onWake;
  const onStep = opts.onStep;          // (ms, recordsTicked)
  const onIdle = opts.onIdle;

  const recs = new Map();              // path -> SimRecord
  let running = false;
  let paused = false;
  let handle = null;
  let isVisible = () => true;

  function pick() {
    const cand = [];
    for (const r of recs.values()) {
      if (!r.settled && isVisible(r)) { cand.push(r); }
    }
    cand.sort((a, b) =>
      (b.userTs - a.userTs) || (b.expandedTs - a.expandedTs) || (a.path < b.path ? -1 : 1));
    return cand.slice(0, maxActive);
  }

  function step() {
    if (paused) { return []; }
    const out = [];
    for (const rec of pick()) {
      if (beforeTick) { beforeTick(rec); }
      const r = tick(rec);
      // Stale drop: the record was removed/recreated while this step ran.
      if (r && recs.get(r.path) === rec && r.gen === rec.gen) { out.push(r); }
    }
    if (out.length) { onTick(out); }
    return out;
  }

  function loop() {
    const t0 = onStep ? now() : 0;
    const out = step();
    if (onStep && out.length) { onStep(now() - t0, out.length); }
    if (!paused && (out.length || pick().length)) { handle = raf(loop); }
    else {
      running = false;
      if (onIdle && !paused) { onIdle(); }
    }
  }

  function wake() {
    if (running || paused || !raf) { return; }
    running = true;
    if (onWake) { onWake(); }
    handle = raf(loop);
  }

  return {
    add(rec, o) {
      recs.set(rec.path, rec);
      if (o && o.expanded) { rec.expandedTs = now(); }
      wake();
    },
    remove(path) { recs.delete(path); },
    get(path) { return recs.get(path); },
    all() { return [...recs.values()]; },
    has(path) { return recs.has(path); },
    bumpUser(path) {
      const r = recs.get(path);
      if (r) { r.userTs = now(); r.settled = false; }
      wake();
    },
    /** Reheat every record (global restart); `prep` runs per record first. */
    unsettleAll(prep) {
      for (const r of recs.values()) {
        if (prep) { prep(r); }
        r.settled = false;
      }
      wake();
    },
    setVisibility(fn) { isVisible = fn || (() => true); wake(); },
    pauseAll() { paused = true; },
    resumeAll() { paused = false; wake(); },
    isPaused() { return paused; },
    maxAlpha(alphaOfFn) {
      let m = 0;
      for (const r of recs.values()) {
        if (!r.settled) { m = Math.max(m, alphaOfFn ? alphaOfFn(r) : 0); }
      }
      return m;
    },
    pick, step, wake,
    stop() {
      if (handle != null && caf) { caf(handle); }
      handle = null;
      running = false;
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createScheduler };
}
