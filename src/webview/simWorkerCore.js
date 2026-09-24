// simWorkerCore.js — the worker-side host of the frame simulations (P6).
// It owns a Map<frameId, entry> of ordinary localSim records and ticks them in
// short slices, free-running: a frame settles as fast as the CPU allows instead
// of one tick per animation frame. Positions go back as one transferable
// Float32Array(2n) per frame, at most once per POST_MS, plus a final one when
// the frame settles. Every message carries the main thread's generation stamp;
// the main thread drops anything whose (frameId, gen) is no longer current.
//
// Pure: localSim functions, d3-force, post(), now() and schedule() are injected
// (simWorker.js wires the real ones; unit tests run it in-process).

const SW_SLICE_MS = 8;   // work per slice before yielding to incoming messages
const SW_POST_MS = 16;   // min interval between positions posts per frame

function createWorkerHost(deps) {
  const { ls, d3, post } = deps;
  const now = deps.now || (() => Date.now());
  const schedule = deps.schedule;       // (fn) => run fn in a later macrotask
  const later = deps.later || ((fn) => schedule(fn)); // (fn, ms) => delayed run
  const entries = new Map();            // frameId -> entry
  let queue = [];                       // unsettled entries, round-robin
  let pausedAll = false;
  let scheduled = false;

  function slotsFrom(ids, buf) {
    const slots = new Map();
    if (!buf) { return slots; }
    for (let i = 0; i < ids.length; i++) {
      const x = buf[4 * i];
      if (Number.isNaN(x)) { continue; }
      slots.set(ids[i], { x, y: buf[4 * i + 1], w: buf[4 * i + 2], h: buf[4 * i + 3] });
    }
    return slots;
  }

  function create(m) {
    drop(m.frameId);
    const members = m.ids.map((id, i) => ({ id, r: m.xyr[3 * i + 2], file: m.files ? m.files[i] : null }));
    const seed = new Map(m.ids.map((id, i) => [id, { x: m.xyr[3 * i], y: m.xyr[3 * i + 1] }]));
    const links = [];
    for (let i = 0; i + 1 < m.links.length; i += 2) {
      links.push({ source: m.ids[m.links[i]], target: m.ids[m.links[i + 1]] });
    }
    const rec = ls.createSim({ path: m.frameId, inner: m.inner }, members, links,
      m.settings || {}, { d3 }, seed, slotsFrom(m.ids, m.slots));
    // `paused` on create = the main scheduler is paused (Static motion): hold
    // every frame until resumeAll, so not a single stray tick moves the grid.
    if (m.paused) { pausedAll = true; }
    const e = {
      frameId: m.frameId, gen: m.gen, rec, ids: m.ids,
      paused: false, queued: false, dirty: false, lastPost: 0,
      hot: false, lastTick: 0,   // hot = a drag holds alphaTarget up → real-time pace
    };
    entries.set(m.frameId, e);
    enqueue(e);
  }

  function drop(frameId) {
    const e = entries.get(frameId);
    if (!e) { return; }
    ls.destroySim(e.rec);
    entries.delete(frameId);
    unqueue(e);
  }

  function unqueue(e) {
    if (!e.queued) { return; }
    e.queued = false;
    queue = queue.filter(q => q !== e);
  }

  function enqueue(e, front) {
    if (e.rec.settled || e.paused || !entries.has(e.frameId)) { return; }
    if (e.queued && front) { queue = queue.filter(q => q !== e); e.queued = false; }
    if (!e.queued) {
      e.queued = true;
      if (front) { queue.unshift(e); } else { queue.push(e); }
    }
    kick();
  }

  function kick(delayMs) {
    if (scheduled || pausedAll || !queue.length) { return; }
    scheduled = true;
    if (delayMs) { later(pump, delayMs); } else { schedule(pump); }
  }

  /** One slice: round-robin over the unsettled frames until the budget is spent.
   *  Frames held hot by a drag never settle, so they tick in real time (once per
   *  POST_MS) instead of free-running; everything else runs flat out. */
  function pump() {
    scheduled = false;
    if (pausedAll) { return; }
    const t0 = now();
    let idleRound = 0;
    while (queue.length && idleRound < queue.length && now() - t0 < SW_SLICE_MS) {
      const e = queue.shift();
      const t = now();
      if (e.hot && t - e.lastTick < SW_POST_MS) { queue.push(e); idleRound++; continue; }
      idleRound = 0;
      ls.tickSim(e.rec);
      e.lastTick = t;
      e.dirty = true;
      if (e.rec.settled) { e.queued = false; } else { queue.push(e); }
    }
    flush(now());
    kick(idleRound ? SW_POST_MS / 4 : 0);   // only paced frames left → sleep a little
  }

  function flush(t) {
    for (const e of entries.values()) {
      if (!e.dirty) { continue; }
      if (!e.rec.settled && t - e.lastPost < SW_POST_MS) { continue; }
      postPositions(e, t);
    }
  }

  function postPositions(e, t) {
    const nodes = e.rec.nodes;
    const buf = new Float32Array(2 * nodes.length);
    for (let i = 0; i < nodes.length; i++) { buf[2 * i] = nodes[i].x; buf[2 * i + 1] = nodes[i].y; }
    e.dirty = false;
    e.lastPost = t;
    post({
      type: 'positions', frameId: e.frameId, gen: e.gen,
      alpha: ls.alphaOf(e.rec), settled: !!e.rec.settled, buf,
    }, [buf.buffer]);
  }

  /** Entry for a message, or null when the frame is gone / the stamp is stale. */
  function current(m) {
    const e = entries.get(m.frameId);
    return (e && e.gen === m.gen) ? e : null;
  }

  const handlers = {
    create,
    destroy: (m) => { if (current(m)) { drop(m.frameId); } },
    pin: (m) => {
      const e = current(m); if (!e) { return; }
      ls.pin(e.rec, e.ids[m.idx], m.x, m.y);
      e.hot = true;
      enqueue(e, true);             // user-interacted frames tick first
    },
    release: (m) => {
      const e = current(m); if (!e) { return; }
      ls.release(e.rec, e.ids[m.idx], { hold: !!m.hold });
      e.hot = false;
      enqueue(e, true);
    },
    settings: (m) => {
      const e = current(m); if (!e) { return; }
      ls.applySettings(e.rec, m.patch || {});   // opaque: unknown keys pass through
      enqueue(e);
    },
    reheat: (m) => {
      const e = current(m); if (!e) { return; }
      ls.unsettle(e.rec, m.alpha);
      enqueue(e);
    },
    resize: (m) => {
      const e = current(m); if (!e) { return; }
      ls.resizeSim(e.rec, m.inner);
      enqueue(e);
    },
    slots: (m) => {
      const e = current(m); if (!e) { return; }
      ls.updateSlots(e.rec, slotsFrom(e.ids, m.slots));
      enqueue(e);
    },
    pause: (m) => { const e = current(m); if (e) { e.paused = true; unqueue(e); } },
    resume: (m) => { const e = current(m); if (e) { e.paused = false; enqueue(e); } },
    pauseAll: () => { pausedAll = true; },
    resumeAll: () => { pausedAll = false; kick(); },
  };

  return {
    onMessage(m) {
      const h = m && handlers[m.type];
      if (!h) { return false; }
      h(m);
      return true;
    },
    pump,
    size: () => entries.size,
    pending: () => queue.length,
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createWorkerHost, SW_SLICE_MS, SW_POST_MS };
}
