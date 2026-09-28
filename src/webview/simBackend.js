// simBackend.js — picks the simulation transport for the frames engine:
// the synchronous localSim API (today's behaviour, `cograph.layout.workers:
// off`, tests, hosts without Worker) or the worker pool (P6). A pool failure
// at any time swaps the API back to the synchronous one and tells the caller
// to rebuild its records — no user-visible breakage, one structured warning.
// Environment (Worker, fetch, Blob, URL, navigator) is injected.

function createSimBackend(opts) {
  const { syncApi, env } = opts;
  const mode = opts.mode || 'auto';
  let api = syncApi;
  let pool = null;

  const kind = resolveSimBackend(mode, {
    hasWorker: typeof env.Worker === 'function', workerUri: opts.workerUri,
    hasFetch: typeof env.fetch === 'function',
    hasBlobUrl: typeof env.Blob === 'function' && typeof env.createObjectURL === 'function',
  });
  if (mode === 'on' && kind !== 'worker') {
    opts.log({ level: 'warn', event: 'sim-workers-unavailable', detail: 'cograph.layout.workers is "on" but this host cannot start workers' });
  }

  if (kind === 'worker') {
    let blobUrl = null; // one fetch, shared by every worker of the pool
    const workerApiRef = { current: null };
    pool = createSimPool({
      size: poolSizeFor(env.hardwareConcurrency, 4),
      makeWorker: async () => {
        if (!blobUrl) { blobUrl = blobUrlFor(opts.workerUri, env); }
        return new env.Worker(await blobUrl);
      },
      onMessage: (m) => { if (workerApiRef.current.onMessage(m)) { opts.onPositions(); } },
      onFail: (reason) => {
        api = syncApi;
        opts.log({ level: 'warn', event: 'sim-workers-fallback', detail: reason });
        opts.onFallback(reason);
      },
    });
    workerApiRef.current = createWorkerSimApi(syncApi, pool);
    api = workerApiRef.current;
  }

  return {
    api: () => api,
    kind: () => api.kind,
    poolSize: () => (pool ? pool.size : 0),
    dispose() { if (pool) { pool.dispose(); } api = syncApi; },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createSimBackend };
}
