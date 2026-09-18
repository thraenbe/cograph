// localSim.js — per-frame force simulations. THE worker seam (P6): the only
// module that constructs or advances a d3 simulation. Plain data in (members,
// intra-folder links, inner rect, settings), positions out; simulations are
// built stopped and ticked manually by the scheduler, so "settled" is simply
// alpha < alphaMin and the ≤N-active limit is exact.
//
// d3 is injected (deps.d3, or deps.makeSim for tests) — no global d3 at load.

/** Deterministic phyllotaxis seed around a rect's centre ({x,y} optional). */
function initialPosition(i, rect) {
  const a = i * 2.3999632297; // golden angle in radians
  const rr = 6 * Math.sqrt(i + 1);
  const cx = (rect.x ?? 0) + rect.w / 2;
  const cy = (rect.y ?? 0) + rect.h / 2;
  return { x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) };
}

/** Clamp every free node inside its slot (or the inner rect when it has no
 *  slot), killing outward velocity at the walls. */
function hardClamp(rec) {
  const pad = (rec.settings && rec.settings.slotPad) || 0;
  for (const n of rec.nodes) {
    if (n.fx != null) { continue; }
    const b = (rec.slotById && rec.slotById.get(n.id)) || { x: 0, y: 0, w: rec.inner.w, h: rec.inner.h };
    const r = Math.min(n.r + pad, Math.min(b.w, b.h) / 2);
    if (n.x < b.x + r) { n.x = b.x + r; if (n.vx < 0) { n.vx = 0; } }
    else if (n.x > b.x + b.w - r) { n.x = b.x + b.w - r; if (n.vx > 0) { n.vx = 0; } }
    if (n.y < b.y + r) { n.y = b.y + r; if (n.vy < 0) { n.vy = 0; } }
    else if (n.y > b.y + b.h - r) { n.y = b.y + b.h - r; if (n.vy > 0) { n.vy = 0; } }
  }
}

function lsGroupByFile(nodes) {
  const map = new Map();
  for (const n of nodes) {
    if (!n.file) { continue; }
    if (!map.has(n.file)) { map.set(n.file, []); }
    map.get(n.file).push(n);
  }
  return map;
}

/** Pull every node toward its slot centre (frame centre without a slot).
 *  Driven by the File Cluster Force slider — the slot is the file. */
function lsSlotPull(rec) {
  return function (alpha) {
    const s = (rec.settings.fileClusterForce ?? 0.2) * alpha;
    for (const n of rec.nodes) {
      if (n.fx != null) { continue; }
      const b = (rec.slotById && rec.slotById.get(n.id)) || { x: 0, y: 0, w: rec.inner.w, h: rec.inner.h };
      n.vx += (b.x + b.w / 2 - n.x) * s;
      n.vy += (b.y + b.h / 2 - n.y) * s;
    }
  };
}

function lsClampForce(rec) {
  return function () { hardClamp(rec); };
}

function lsLinkDistance(s) {
  return (s.linkDistance ?? 40) * 0.75;
}

/** The ONLY function that touches d3. */
function buildD3Sim(rec, d3lib) {
  const s = rec.settings;
  // Charge is scaled down and range-limited: inside a slot a full-strength
  // repel just pins everything to the walls (the "picture frame" artefact).
  return d3lib.forceSimulation(rec.nodes)
    .force('link', d3lib.forceLink(rec.links).id(d => d.id)
      // linkDistance is a shared setting; slots are tighter than the global
      // canvas, so the shelf runs at 0.75x (30 at the default of 40).
      .distance(lsLinkDistance(s)).strength((s.linkForce ?? 1) * 0.1))
    .force('charge', d3lib.forceManyBody()
      .strength(-(s.repelForce ?? 250) * 0.15).distanceMax(140))
    .force('collide', d3lib.forceCollide(d => d.r + (s.collidePad ?? 1.5)))
    .force('slotPull', lsSlotPull(rec))
    .force('clamp', lsClampForce(rec))
    .velocityDecay(s.velocityDecay ?? 0.3)
    .alphaDecay(0.04)   // local graphs are small — settle fast
    .stop();            // ticked manually by the scheduler
}

let __lsGen = 0;

/**
 * Create a simulation record for one frame. `members`: [{id, r, file, _ref?}]
 * (local coordinates relative to the frame's inner origin). `seed`: optional
 * Map<id, {x,y}> of local start positions (continuity across re-creates).
 */
function createSim(frame, members, links, settings, deps, seed, slots) {
  deps = deps || {};
  const inner = { w: frame.inner.w, h: frame.inner.h };
  const slotById = slots || new Map();
  const nodes = members.map((m, i) => {
    const s = seed && seed.get ? seed.get(m.id) : null;
    const p = s || initialPosition(i, slotById.get(m.id) || inner);
    return {
      id: m.id, r: m.r, file: m.file || null,
      x: p.x, y: p.y, vx: 0, vy: 0, fx: null, fy: null,
      _ref: m._ref ?? null,
    };
  });
  const idSet = new Set(nodes.map(n => n.id));
  const intraLinks = (links || [])
    .filter(l => idSet.has(l.source) && idSet.has(l.target))
    .map(l => ({ source: l.source, target: l.target }));
  const rec = {
    path: frame.path, gen: ++__lsGen, sim: null,
    nodes, links: intraLinks, inner,
    slotById,
    settings: { ...settings },
    settled: false, userTs: 0, expandedTs: 0,
    byId: new Map(nodes.map(n => [n.id, n])),
    _byFile: lsGroupByFile(nodes),
  };
  if (deps.makeSim) { rec.sim = deps.makeSim(rec); }
  else if (deps.d3) { rec.sim = buildD3Sim(rec, deps.d3); }
  else { throw new Error('localSim.createSim: inject deps.d3 or deps.makeSim'); }
  hardClamp(rec);
  return rec;
}

/** One synchronous step. Returns {path, gen, nodes} or null when settled. */
function tickSim(rec) {
  if (rec.settled || !rec.sim) { return null; }
  rec.sim.tick();
  hardClamp(rec);
  const min = rec.sim.alphaMin ? rec.sim.alphaMin() : 0.001;
  if (rec.sim.alpha() < min) { rec.settled = true; }
  return { path: rec.path, gen: rec.gen, nodes: rec.nodes };
}

function unsettle(rec, floor) {
  if (rec.sim && rec.sim.alpha) {
    rec.sim.alpha(Math.max(rec.sim.alpha(), floor ?? 0.3));
  }
  rec.settled = false;
}

/** Pin a member at a local position (clamped inside the frame). */
function pin(rec, id, lx, ly) {
  const n = rec.byId.get(id);
  if (!n) { return; }
  const b = (rec.slotById && rec.slotById.get(id)) || { x: 0, y: 0, w: rec.inner.w, h: rec.inner.h };
  const r = Math.min(n.r, Math.min(b.w, b.h) / 2);
  n.fx = Math.max(b.x + r, Math.min(b.x + b.w - r, lx));
  n.fy = Math.max(b.y + r, Math.min(b.y + b.h - r, ly));
  n.x = n.fx; n.y = n.fy;
  if (rec.sim && rec.sim.alphaTarget) { rec.sim.alphaTarget(0.3); }
  rec.settled = false;
}

function release(rec, id, opts) {
  const n = rec.byId.get(id);
  if (!n) { return; }
  if (!(opts && opts.hold)) { n.fx = null; n.fy = null; }
  if (rec.sim && rec.sim.alphaTarget) { rec.sim.alphaTarget(0); }
}

/** Apply a settings patch to the live forces and reheat. */
function applySettings(rec, patch) {
  Object.assign(rec.settings, patch);
  const sim = rec.sim;
  const s = rec.settings;
  if (sim && sim.force) {
    // No centerForce mapping: the shelf has no x/y force — slots anchor nodes.
    if (patch.repelForce !== undefined) { sim.force('charge')?.strength?.(-s.repelForce * 0.15); }
    if (patch.linkForce !== undefined) { sim.force('link')?.strength?.(s.linkForce * 0.1); }
    if (patch.linkDistance !== undefined) { sim.force('link')?.distance?.(lsLinkDistance(s)); }
    if (patch.collidePad !== undefined) { sim.force('collide')?.radius?.((d) => d.r + s.collidePad); }
    if (patch.velocityDecay !== undefined) { sim.velocityDecay?.(s.velocityDecay); }
    if (patch.slotPad !== undefined) { hardClamp(rec); }
  }
  unsettle(rec);
}

/** The frame grew or shrank: recentre pulls and clamp into the new rect. */
function resizeSim(rec, inner) {
  rec.inner = { w: inner.w, h: inner.h };
  hardClamp(rec);
  unsettle(rec, 0.1);
}

/** Slot layout changed (content grew / files parsed): swap the rects in and
 *  let the pull/clamp walk nodes into their new homes. */
function updateSlots(rec, slots) {
  rec.slotById = slots || new Map();
  hardClamp(rec);
  unsettle(rec, 0.1);
}

function destroySim(rec) {
  if (rec.sim && rec.sim.stop) { rec.sim.stop(); }
  rec.gen = -1;          // stale marker: in-flight results are dropped
  rec.settled = true;
  rec.nodes = [];
  rec.byId = new Map();
  rec._byFile = new Map();
}

function alphaOf(rec) {
  return rec.sim && rec.sim.alpha ? rec.sim.alpha() : 0;
}

if (typeof module !== 'undefined') {
  module.exports = {
    createSim, buildD3Sim, initialPosition, hardClamp, lsSlotPull,
    tickSim, pin, release, applySettings, resizeSim, updateSlots, destroySim,
    alphaOf, unsettle,
  };
}
