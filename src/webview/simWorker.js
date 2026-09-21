// simWorker.js — Web Worker entry (esbuild → dist/webview/simWorker.js, iife).
// Runs the SAME localSim.js as the main thread, with d3-force bundled in (the
// CDN/global d3 does not exist in a worker). All logic lives in
// simWorkerCore.js; this file only wires the real worker primitives.
//
// VS Code webviews can only start workers from blob:/data: URLs, so simPool.js
// fetches this bundle and boots it from a Blob (CSP: worker-src blob:).
/* global self */
const d3 = require('d3-force');
const ls = require('./localSim.js');
const { createWorkerHost } = require('./simWorkerCore.js');

// Zero-delay macrotask: nested setTimeout(0) is clamped to 4 ms, a
// MessageChannel is not — and incoming pin/destroy messages still interleave.
const channel = new MessageChannel();
let nextRun = null;
channel.port1.onmessage = () => {
  const fn = nextRun;
  nextRun = null;
  if (fn) { fn(); }
};

const host = createWorkerHost({
  ls,
  d3,
  post: (msg, transfer) => self.postMessage(msg, transfer || []),
  now: () => performance.now(),
  schedule: (fn) => { nextRun = fn; channel.port2.postMessage(0); },
  later: (fn, ms) => setTimeout(fn, ms),
});

self.onmessage = (event) => {
  try {
    host.onMessage(event.data);
  } catch (err) {
    // Surface the failure; the pool falls back to the main-thread simulation.
    self.postMessage({ type: 'worker-error', message: String(err && err.message || err) });
  }
};
self.postMessage({ type: 'ready' });
