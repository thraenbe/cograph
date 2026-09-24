// localSimWorker.js — the localSim API over a worker transport (P6).
// Callers (frameRender, frameScheduler, frameInteract) keep the exact API and
// SimRecord shape of localSim.js. The record here is a real localSim record
// WITHOUT a simulation (seeded + clamped locally for the first paint); the
// simulation lives in a worker and `tickSim` becomes "apply the newest
// positions that arrived". Drags stay optimistic: pins are written locally
// first and the worker's value for a pinned node is ignored.
//
// `ls` = the synchronous localSim function set, `pool` = simPool-like
// { post(msg, transfer), broadcast(msg) }. No DOM, no d3.

function createWorkerSimApi(ls, pool) {
  const recs = new Map();   // frameId (= frame path) -> proxy record

  function slotsBuffer(rec) {
    const buf = new Float32Array(4 * rec.nodes.length).fill(NaN);
    rec.nodes.forEach((n, i) => {
      const s = rec.slotById && rec.slotById.get(n.id);
      if (s) { buf.set([s.x, s.y, s.w, s.h], 4 * i); }
    });
    return buf;
  }

  function createMessage(rec, paused) {
    const n = rec.nodes.length;
    const idx = new Map(rec.nodes.map((node, i) => [node.id, i]));
    const xyr = new Float32Array(3 * n);
    rec.nodes.forEach((node, i) => { xyr.set([node.x, node.y, node.r], 3 * i); });
    const links = new Uint32Array(2 * rec.links.length);
    rec.links.forEach((l, i) => { links[2 * i] = idx.get(l.source); links[2 * i + 1] = idx.get(l.target); });
    return {
      type: 'create', frameId: rec.path, gen: rec.gen, paused: !!paused,
      ids: rec.nodes.map(node => node.id), files: rec.nodes.map(node => node.file),
      xyr, links, slots: slotsBuffer(rec), inner: { w: rec.inner.w, h: rec.inner.h },
      settings: { ...rec.settings },
    };
  }

  const send = (rec, type, extra) => pool.post({ type, frameId: rec.path, gen: rec.gen, ...extra });

  const api = {
    kind: 'worker',

    createSim(frame, members, links, settings, deps, seed, slots) {
      // makeSim → null: identical seeding/clamping, no main-thread simulation.
      const rec = ls.createSim(frame, members, links, settings, { makeSim: () => null }, seed, slots);
      rec.alpha = 1;
      rec._idx = new Map(rec.nodes.map((n, i) => [n.id, i]));
      rec._inbox = null;
      rec._localDirty = false;
      recs.set(rec.path, rec);
      pool.post(createMessage(rec, deps && deps.paused));
      return rec;
    },

    /** Apply the newest worker positions (or a local pin move). Null when idle. */
    tickSim(rec) {
      const m = rec._inbox;
      if (!m && !rec._localDirty) { return null; }
      rec._localDirty = false;
      if (m) {
        rec._inbox = null;
        const buf = m.buf;
        for (let i = 0; i < rec.nodes.length; i++) {
          const n = rec.nodes[i];
          if (n.fx != null) { continue; }       // optimistic drag wins while pinned
          n.x = buf[2 * i]; n.y = buf[2 * i + 1];
        }
        rec.alpha = m.alpha;
        rec.settled = !!m.settled;
      }
      return { path: rec.path, gen: rec.gen, nodes: rec.nodes };
    },

    pin(rec, id, lx, ly) {
      const n = rec.byId.get(id);
      if (!n) { return; }
      ls.pin(rec, id, lx, ly);                  // clamp + local write (sim is null)
      if (n._sentFx === n.fx && n._sentFy === n.fy) { return; }
      n._sentFx = n.fx; n._sentFy = n.fy;
      rec._localDirty = true;
      send(rec, 'pin', { idx: rec._idx.get(id), x: n.fx, y: n.fy });
    },

    release(rec, id, opts) {
      const n = rec.byId.get(id);
      if (!n) { return; }
      ls.release(rec, id, opts);
      n._sentFx = undefined; n._sentFy = undefined;
      rec.settled = false;
      send(rec, 'release', { idx: rec._idx.get(id), hold: !!(opts && opts.hold) });
    },

    /** Opaque: whatever keys the settings patch carries reach the worker's localSim. */
    applySettings(rec, patch) {
      Object.assign(rec.settings, patch);
      rec.settled = false;
      rec.alpha = Math.max(rec.alpha || 0, 0.3);
      send(rec, 'settings', { patch: { ...patch } });
    },

    unsettle(rec, floor) {
      const a = floor ?? 0.3;
      rec.alpha = Math.max(rec.alpha || 0, a);
      rec.settled = false;
      send(rec, 'reheat', { alpha: a });
    },

    resizeSim(rec, inner) {
      ls.resizeSim(rec, inner);
      send(rec, 'resize', { inner: { w: inner.w, h: inner.h } });
    },

    updateSlots(rec, slots) {
      ls.updateSlots(rec, slots);
      send(rec, 'slots', { slots: slotsBuffer(rec) });
    },

    destroySim(rec) {
      if (recs.get(rec.path) === rec) { recs.delete(rec.path); }
      if (rec.gen !== -1) { send(rec, 'destroy'); }
      ls.destroySim(rec);
    },

    alphaOf(rec) { return rec.settled ? 0 : (rec.alpha || 0); },

    setPaused(paused) { pool.broadcast({ type: paused ? 'pauseAll' : 'resumeAll' }); },
    setFramePaused(rec, paused) { send(rec, paused ? 'pause' : 'resume'); },

    /**
     * Worker → main. Stale results (frame gone, re-created, or destroyed) are
     * dropped here — they never reach the DOM. Returns true when accepted.
     */
    onMessage(m) {
      if (!m || m.type !== 'positions') { return false; }
      const rec = recs.get(m.frameId);
      if (!rec || rec.gen !== m.gen || m.buf.length !== 2 * rec.nodes.length) { return false; }
      rec._inbox = m;                           // newest wins; older unpainted posts are skipped
      return true;
    },
    liveCount: () => recs.size,
  };
  return api;
}

/** 'auto' | 'on' | 'off' + environment → 'worker' | 'sync'. */
function resolveSimBackend(mode, env) {
  if (mode === 'off') { return 'sync'; }
  const capable = !!(env && env.hasWorker && env.workerUri && env.hasFetch && env.hasBlobUrl);
  return capable ? 'worker' : 'sync';
}

if (typeof module !== 'undefined') {
  module.exports = { createWorkerSimApi, resolveSimBackend };
}
