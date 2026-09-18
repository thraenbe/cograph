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
  const ms = perfNow() - t0;
  let s = __perf.stats.get(name);
  if (!s) { s = { count: 0, total: 0, max: 0, last: 0 }; __perf.stats.set(name, s); }
  s.count++; s.total += ms; s.last = ms; if (ms > s.max) { s.max = ms; }
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

/** Simulation reached alphaMin: record settle time, auto-report shortly after. */
function perfSettled() {
  if (!perfOn()) { return; }
  if (__perf.simStartMs != null) {
    let s = __perf.stats.get('sim:settle');
    if (!s) { s = { count: 0, total: 0, max: 0, last: 0 }; __perf.stats.set('sim:settle', s); }
    const ms = perfNow() - __perf.simStartMs;
    s.count++; s.total += ms; s.last = ms; if (ms > s.max) { s.max = ms; }
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

function perfReport() {
  const ticks = [...__perf.ticks].sort((a, b) => a - b);
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
    tick: {
      samples: ticks.length,
      p50Ms: +__percentile(ticks, 50).toFixed(2),
      p95Ms: +__percentile(ticks, 95).toFixed(2),
      maxMs: ticks.length ? +ticks[ticks.length - 1].toFixed(2) : 0,
    },
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
  __perf.ticks.length = 0; __perf.simStartMs = null;
  if (__perf.reportTimer) { clearTimeout(__perf.reportTimer); __perf.reportTimer = null; }
}

if (typeof window !== 'undefined') {
  window.perfReport = perfReport; // DevTools convenience
}

if (typeof module !== 'undefined') {
  module.exports = {
    perfOn, perfNow, perfMark, perfMeasure, perfCount, perfTick,
    perfSettled, perfReport, postPerfReport, perfReset, PERF_TICK_RING,
  };
}
