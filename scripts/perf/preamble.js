// Perf bench preamble — loaded BEFORE d3 so d3-timer binds the instrumented
// requestAnimationFrame. Records main-thread script time per animation frame,
// frame intervals, long animation frames; stubs acquireVsCodeApi.
// URL params: engine, mode, workers, fx (fixture), max (ms cap per scenario).
(function () {
  const P = new URLSearchParams(location.search);
  window.__benchConfig = {
    defaultEngine: P.get('engine') || 'shelf',
    defaultMode: P.get('mode') || 'static',
    perf: false,
  };
  if (P.get('workers')) { window.__benchConfig.workers = P.get('workers'); }

  const rawRaf = window.requestAnimationFrame.bind(window);
  const rawCaf = window.cancelAnimationFrame.bind(window);
  const pending = new Set();
  const B = window.__bench = {
    rawRaf, pending, acc: 0, lastAppCb: 0, rec: null, posted: [], loaf: [], errors: [],
  };
  window.requestAnimationFrame = function (cb) {
    const id = rawRaf(function (ts) {
      pending.delete(id);
      const t0 = performance.now();
      try { cb(ts); } finally {
        const t1 = performance.now();
        B.acc += t1 - t0;
        B.lastAppCb = t1;
      }
    });
    pending.add(id);
    return id;
  };
  window.cancelAnimationFrame = function (id) { pending.delete(id); rawCaf(id); };

  let lastTs = 0;
  (function monitor(ts) {
    if (B.rec) { B.rec.push({ dt: lastTs ? ts - lastTs : 0, script: B.acc }); }
    B.acc = 0; lastTs = ts;
    rawRaf(monitor);
  })(0);

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        B.loaf.push({ dur: e.duration, render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0 });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch (e) { /* Chrome < 123: no long-animation-frame entries */ }

  window.addEventListener('error', (e) => B.errors.push(String(e.message)));
  document.addEventListener('securitypolicyviolation', (e) => B.errors.push(`CSP ${e.violatedDirective}: ${e.blockedURI}`));
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => { B.posted.push(m && m.type); },
    getState: () => null, setState: () => {},
  });
})();
