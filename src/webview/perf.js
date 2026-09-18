// perf.js — opt-in webview performance instrumentation (cograph.debug.perfLog).
//
// Every function is a cheap no-op unless state.perfEnabled is true, so the
// instrumentation calls sprinkled through the render/tick paths cost one
// boolean check in normal use. Loaded right after state.js; all globals.
//
// Numbers are local only (output channel / DevTools) — no telemetry.

const PERF_TICK_RING = 120; // last N tick durations → p50/p95

const __perf = {
  marks: new Map(),    // name -> last timestamp (perfMark)
  stats: new Map(),    // name -> { count, total, max, last } (perfMeasure)
  counts: new Map(),   // name -> count (perfCount)
  ticks: [],           // ring buffer of tick durations in ms
  frames: [],          // ring buffer: main-thread ms per animation frame (perfFrame)
  simStartMs: null,    // set on 'sim:start', read by perfSettled
  reportTimer: null,
};

function perfOn() {
  return typeof state !== 'undefined' && !!state.perfEnabled;
}

function perfNow() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function perfMark(name) {
  if (!perfOn()) { return; }
  __perf.marks.set(name, perfNow());
  if (name === 'sim:start') { __perf.simStartMs = __perf.marks.get(name); }
}

function perfMeasure(name, sinceMark) {
  if (!perfOn()) { return; }
  const t0 = __perf.marks.get(sinceMark);
  if (t0 === undefined) { return; }
  __perfAdd(name, perfNow() - t0);
}

function perfCount(name) {
  if (!perfOn()) { return; }
  __perf.counts.set(name, (__perf.counts.get(name) || 0) + 1);
}

function perfTick(ms) {
  if (!perfOn()) { return; }
  __perf.ticks.push(ms);
  if (__perf.ticks.length > PERF_TICK_RING) { __perf.ticks.shift(); }
}

/** Main-thread milliseconds spent in one animation frame (frames engine). */
function perfFrame(ms) {
  if (!perfOn()) { return; }
  __perf.frames.push(ms);
  if (__perf.frames.length > PERF_TICK_RING) { __perf.frames.shift(); }
}

/** Span timing without a closure: `const t0 = perfBegin(); …; perfEnd(name, t0)`.
 *  perfBegin returns 0 when disabled, which makes perfEnd a no-op. */
function perfBegin() {
  return perfOn() ? perfNow() : 0;
}

function perfEnd(name, t0) {
  if (!t0 || !perfOn()) { return; }
  __perfAdd(name, perfNow() - t0);
}

function perfSpan(name, fn) {
  const t0 = perfBegin();
  try { return fn(); } finally { perfEnd(name, t0); }
}

function __perfAdd(name, ms) {
  let s = __perf.stats.get(name);
  if (!s) { s = { count: 0, total: 0, max: 0, last: 0 }; __perf.stats.set(name, s); }
  s.count++; s.total += ms; s.last = ms; if (ms > s.max) { s.max = ms; }
}

/** Simulation reached alphaMin: record settle time, auto-report shortly after. */
function perfSettled() {
  if (!perfOn()) { return; }
  if (__perf.simStartMs != null) {
    __perfAdd('sim:settle', perfNow() - __perf.simStartMs);
    __perf.simStartMs = null;
  }
  if (__perf.reportTimer) { clearTimeout(__perf.reportTimer); }
  __perf.reportTimer = setTimeout(postPerfReport, 1500);
}

function __percentile(sorted, p) {
  if (!sorted.length) { return 0; }
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function __ringSummary(ring) {
  const sorted = [...ring].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50Ms: +__percentile(sorted, 50).toFixed(2),
    p95Ms: +__percentile(sorted, 95).toFixed(2),
    maxMs: sorted.length ? +sorted[sorted.length - 1].toFixed(2) : 0,
  };
}

function perfReport() {
  const stats = {};
  for (const [name, s] of __perf.stats) {
    stats[name] = {
      count: s.count,
      avgMs: +(s.total / s.count).toFixed(2),
      lastMs: +s.last.toFixed(2),
      maxMs: +s.max.toFixed(2),
    };
  }
  const counts = {};
  for (const [name, c] of __perf.counts) { counts[name] = c; }
  const report = {
    nodes: (typeof state !== 'undefined' && state.currentNodes) ? state.currentNodes.length : 0,
    // engine/motion, e.g. 'shelf/static'; bare engine when a test stub sets
    // only layoutEngine, 'global' when state is absent entirely.
    engine: (typeof state !== 'undefined' && state.layoutEngine)
      ? (state.layoutMode ? `${state.layoutEngine}/${state.layoutMode}` : state.layoutEngine)
      : ((typeof state !== 'undefined' && state.layoutMode) || 'global'),
    tick: __ringSummary(__perf.ticks),
    frame: __ringSummary(__perf.frames),
    stats,
    counts,
  };
  if (typeof console !== 'undefined' && console.table) {
    console.log('[cograph perf]', report.nodes, 'nodes,', report.engine, 'engine');
    console.table(stats);
  }
  return report;
}

function postPerfReport() {
  if (!perfOn()) { return; }
  const report = perfReport();
  if (typeof vscode !== 'undefined' && vscode.postMessage) {
    vscode.postMessage({ type: 'perf-report', report });
  }
}

function perfReset() {
  __perf.marks.clear(); __perf.stats.clear(); __perf.counts.clear();
  __perf.ticks.length = 0; __perf.frames.length = 0; __perf.simStartMs = null;
  if (__perf.reportTimer) { clearTimeout(__perf.reportTimer); __perf.reportTimer = null; }
}

if (typeof window !== 'undefined') {
  window.perfReport = perfReport; // DevTools convenience
}

if (typeof module !== 'undefined') {
  module.exports = {
    perfOn, perfNow, perfMark, perfMeasure, perfCount, perfTick,
    perfFrame, perfBegin, perfEnd, perfSpan,
    perfSettled, perfReport, postPerfReport, perfReset, PERF_TICK_RING,
  };
}
