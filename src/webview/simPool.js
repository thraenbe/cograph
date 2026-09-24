// simPool.js — a small pool of simulation workers (P6). Frames are assigned
// to the least-loaded worker and stay there; messages posted before the
// workers finished booting are queued and flushed in order. Any failure
// (fetch, Worker constructor, worker error) marks the pool failed exactly once
// and reports it — the caller falls back to the main-thread simulation.
//
// VS Code webviews only allow blob:/data: workers, so the bundle is fetched
// from the webview's own origin and booted from a Blob URL.
// Everything environment-specific is injected (unit tests use fakes).

function poolSizeFor(hardwareConcurrency, max) {
  const cores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 ? hardwareConcurrency : 2;
  return Math.max(1, Math.min(max ?? 4, cores - 1));
}

/** Fetch the worker bundle and wrap it in a Blob URL. */
async function blobUrlFor(workerUri, env) {
  const res = await env.fetch(workerUri);
  if (!res.ok) { throw new Error(`simWorker fetch failed: HTTP ${res.status}`); }
  const blob = new env.Blob([await res.text()], { type: 'text/javascript' });
  return env.createObjectURL(blob);
}

/**
 * opts: { size, makeWorker(): Promise<WorkerLike>|WorkerLike, onMessage(msg), onFail(reason) }
 * WorkerLike: { postMessage(msg, transfer), onmessage, onerror, terminate() }
 */
function createSimPool(opts) {
  const size = Math.max(1, opts.size || 1);
  const slots = [];                 // { worker, load, queue[] }
  const slotOf = new Map();         // frameId -> slot
  let failed = false;
  let disposed = false;

  function fail(reason) {
    if (failed || disposed) { return; }
    failed = true;
    for (const s of slots) { try { s.worker && s.worker.terminate(); } catch (e) { /* already gone */ } }
    opts.onFail(String(reason && reason.message || reason));
  }

  function wire(slot, worker) {
    slot.worker = worker;
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (!m || failed || disposed) { return; }
      if (m.type === 'worker-error') { fail(m.message); return; }
      if (m.type === 'ready') { return; }
      opts.onMessage(m);
    };
    worker.onerror = (ev) => fail((ev && ev.message) || 'worker error');
    for (const [msg, transfer] of slot.queue) { worker.postMessage(msg, transfer); }
    slot.queue = [];
  }

  for (let i = 0; i < size; i++) {
    const slot = { worker: null, load: 0, queue: [] };
    slots.push(slot);
    Promise.resolve()
      .then(() => opts.makeWorker())
      .then((w) => { if (failed || disposed) { w.terminate(); } else { wire(slot, w); } })
      .catch(fail);
  }

  function send(slot, msg, transfer) {
    if (failed || disposed) { return; }
    if (slot.worker) { slot.worker.postMessage(msg, transfer || []); }
    else { slot.queue.push([msg, transfer || []]); }
  }

  return {
    size,
    isFailed: () => failed,
    /** Post a frame-scoped message; `create` assigns the frame, `destroy` frees it. */
    post(msg, transfer) {
      let slot = slotOf.get(msg.frameId);
      if (!slot) {
        if (msg.type !== 'create') { return; }   // frame unknown (already destroyed)
        slot = slots.reduce((a, b) => (b.load < a.load ? b : a));
        slot.load++;
        slotOf.set(msg.frameId, slot);
      }
      send(slot, msg, transfer);
      if (msg.type === 'destroy') { slot.load--; slotOf.delete(msg.frameId); }
    },
    broadcast(msg) { for (const s of slots) { send(s, msg); } },
    loads: () => slots.map(s => s.load),
    dispose() {
      disposed = true;
      for (const s of slots) { try { s.worker && s.worker.terminate(); } catch (e) { /* already gone */ } }
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createSimPool, poolSizeFor, blobUrlFor };
}
