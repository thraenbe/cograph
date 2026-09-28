// frameScheduler.js — one rAF loop driving at most `maxActive` frame
// simulations per animation frame. Ranking: user-interacted first, then the
// frames in the viewport (`prefer`), then the frame that waited longest (round-robin — after a global reheat every frame
// starts moving at once instead of queueing behind the first four for their
// whole settle, F7), then just-expanded, then path. Frames with nothing to
// simulate (`isInert`) settle immediately and never occupy a slot. Settled and
// off-viewport records cost nothing; results whose record or generation went
// stale between pick and delivery are dropped (the #50 async-race class,
// handled once). Pure logic — raf/caf/now/tick are injected for tests.

function createScheduler(opts) {
  const raf = opts.raf;
  const caf = opts.caf;
  const now = opts.now || (() => Date.now());
  // Number, or a function (worker transport: every frame with fresh positions
  // may be drained each animation frame → Infinity; sync path → 4).
  const maxActiveOf = (typeof opts.maxActive === 'function')
    ? opts.maxActive : () => (opts.maxActive ?? 4);
  const onTick = opts.onTick || (() => {});
  const onResult = opts.onResult;      // optional: per result, inside the budget clock
  const tick = opts.tick;              // (rec) => {path, gen, nodes} | null
  const beforeTick = opts.beforeTick;  // optional per-record pre-step hook
  // Optional instrumentation hooks (perf.js): loop started, one step's
  // main-thread cost, loop ran dry. Absent → zero overhead.
  const onWake = opts.onWake;
  const onStep = opts.onStep;          // (ms, recordsTicked)
  const onIdle = opts.onIdle;
  const onPauseChange = opts.onPauseChange; // (paused) — worker transport mirrors it
  // Optional main-thread budget per step in ms (number or function). Worker
  // transport: applying positions is pure DOM work, so a step stops once the
  // budget is spent (after at least one result); the rest — whose inboxes keep
  // only the newest positions — are drained on the following frames.
  const budgetOf = (typeof opts.budgetMs === 'function')
    ? opts.budgetMs : () => (opts.budgetMs ?? Infinity);

  const isInert = opts.isInert;        // optional (rec) => true when no free member exists
  const prefer = opts.prefer;          // optional (rec) => true: rank first (in the viewport)
  const recs = new Map();              // path -> SimRecord
  let turn = 0;                        // monotonic stamp for the round-robin
  let running = false;
  let paused = false;
  let handle = null;
  let isVisible = () => true;

  function pick() {
    const cand = [];
    for (const r of recs.values()) {
      if (r.settled) { continue; }
      if (isInert && isInert(r)) { r.settled = true; continue; }
      if (isVisible(r)) { cand.push(r); }
    }
    const pref = prefer ? new Map(cand.map(r => [r, prefer(r) ? 1 : 0])) : null;
    cand.sort((a, b) =>
      (b.userTs - a.userTs) || (pref ? pref.get(b) - pref.get(a) : 0)
      || ((a._turn || 0) - (b._turn || 0))
      || (b.expandedTs - a.expandedTs) || (a.path < b.path ? -1 : 1));
    return cand.slice(0, maxActiveOf());
  }

  function step() {
    if (paused) { return []; }
    const out = [];
    const budget = budgetOf();
    const t0 = budget < Infinity ? now() : 0;
    for (const rec of pick()) {
      if (beforeTick) { beforeTick(rec); }
      rec._turn = ++turn;
      const r = tick(rec);
      // Stale drop: the record was removed/recreated while this step ran.
      if (r && recs.get(r.path) === rec && r.gen === rec.gen) {
        out.push(r);
        if (onResult) { onResult(r); }
        if (now() - t0 >= budget) { break; }
      }
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
    pauseAll() {
      if (!paused && onPauseChange) { onPauseChange(true); }
      paused = true;
    },
    resumeAll() {
      if (paused && onPauseChange) { onPauseChange(false); }
      paused = false;
      wake();
    },
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
