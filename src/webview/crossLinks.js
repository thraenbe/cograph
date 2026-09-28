// crossLinks.js — split weighted edges by owning frame and aggregate the
// cross-frame remainder into one bundle per folder pair (drawn between title
// bar ports). Individual cross links are produced only for a hovered node.
// Pure helpers — no DOM/d3/state.

const CL_SEP = '';

function pairKey(a, b) {
  return a < b ? a + CL_SEP + b : b + CL_SEP + a;
}

/**
 * Partition link objects by frame ownership.
 * `frameOfId(id)` → frame path (or null). Links whose endpoints share a frame
 * go to intra (keyed by frame path); the rest are cross links.
 */
function splitEdgesByFrame(links, frameOfId) {
  const intra = new Map();
  const cross = [];
  for (const l of links) {
    const sId = l.source && l.source.id !== undefined ? l.source.id : l.source;
    const tId = l.target && l.target.id !== undefined ? l.target.id : l.target;
    const a = frameOfId(sId);
    const b = frameOfId(tId);
    if (a != null && a === b) {
      if (!intra.has(a)) { intra.set(a, []); }
      intra.get(a).push(l);
    } else {
      cross.push(l);
    }
  }
  return { intra, cross };
}

/** Nearest point on a rect's border to p (p may be inside or outside). */
function nearestEdgePoint(rect, p) {
  const cx = Math.max(rect.x, Math.min(rect.x + rect.w, p.x));
  const cy = Math.max(rect.y, Math.min(rect.y + rect.h, p.y));
  const dl = cx - rect.x, dr = rect.x + rect.w - cx;
  const dt = cy - rect.y, db = rect.y + rect.h - cy;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) { return { x: rect.x, y: cy }; }
  if (m === dr) { return { x: rect.x + rect.w, y: cy }; }
  if (m === dt) { return { x: cx, y: rect.y }; }
  return { x: cx, y: rect.y + rect.h };
}

/** Port on a title bar: x clamped into the bar, y at the bar's vertical centre. */
function portOn(title, toward) {
  return {
    x: Math.max(title.x + 8, Math.min(title.x + title.w - 8, toward.x)),
    y: title.y + title.h / 2,
  };
}

const clIdOf = (e) => (e && e.id !== undefined ? e.id : e);

/**
 * Aggregate cross links into one record per frame pair, sorted by key.
 * Depends only on link ownership — stable between renders, so callers cache
 * it and re-run only routeBundles when frames move.
 */
function aggregateCrossPairs(cross, frameOfId) {
  const byPair = new Map();
  for (const l of cross) {
    const a = frameOfId(clIdOf(l.source));
    const b = frameOfId(clIdOf(l.target));
    if (a == null || b == null || a === b) { continue; }
    const key = pairKey(a, b);
    let agg = byPair.get(key);
    if (!agg) { agg = { key, a: a < b ? a : b, b: a < b ? b : a, count: 0, pending: false }; byPair.set(key, agg); }
    agg.count += l._count ?? 1;
    if (l.pending) { agg.pending = true; }
  }
  return [...byPair.keys()].sort().map(k => byPair.get(k));
}

const clContains = (p, q) => q !== p && (q.startsWith(p + '/') || q.startsWith(p + '\\'));

/** Port geometry for one aggregated pair, or null when a frame is gone. */
function routeBundle(agg, frameAt) {
  const fa = frameAt(agg.a);
  const fb = frameAt(agg.b);
  if (!fa || !fb) { return null; }
  let p1, p2;
  if (clContains(agg.a, agg.b) || clContains(agg.b, agg.a)) {
    // Ancestor ↔ descendant (a parent's direct files calling into a child):
    // titlebar-to-titlebar would cross the whole parent. Short line instead:
    // from the descendant's titlebar port to the nearest ancestor edge.
    const dIsB = clContains(agg.a, agg.b);
    const desc = dIsB ? fb : fa;
    const anc = dIsB ? fa : fb;
    const ancCentre = { x: anc.abs.x + anc.abs.w / 2, y: anc.abs.y + anc.abs.h / 2 };
    const pd = portOn(desc.titleRect, ancCentre);
    const pa = nearestEdgePoint(anc.abs, pd);
    p1 = dIsB ? pa : pd;
    p2 = dIsB ? pd : pa;
  } else {
    const ca = { x: fa.abs.x + fa.abs.w / 2, y: fa.abs.y + fa.abs.h / 2 };
    const cb = { x: fb.abs.x + fb.abs.w / 2, y: fb.abs.y + fb.abs.h / 2 };
    p1 = portOn(fa.titleRect, cb);
    p2 = portOn(fb.titleRect, ca);
  }
  return { ...agg, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

function routeBundles(aggs, frameAt) {
  const bundles = [];
  for (const agg of aggs) {
    const b = routeBundle(agg, frameAt);
    if (b) { bundles.push(b); }
  }
  return bundles;
}

/** node id → the cross links touching it (hover looks up O(degree)). */
function indexCrossByNode(cross) {
  const byNode = new Map();
  const add = (id, l) => {
    const arr = byNode.get(id);
    if (arr) { arr.push(l); } else { byNode.set(id, [l]); }
  };
  for (const l of cross) {
    const sId = clIdOf(l.source);
    const tId = clIdOf(l.target);
    add(sId, l);
    if (tId !== sId) { add(tId, l); }
  }
  return byNode;
}

/** Individual lines for the hovered node out of `links` (any superset). */
function individualLinksFor(links, hoverId, absPosOf) {
  const individual = [];
  if (hoverId == null || !absPosOf) { return individual; }
  for (const l of links) {
    const sId = clIdOf(l.source);
    const tId = clIdOf(l.target);
    if (sId !== hoverId && tId !== hoverId) { continue; }
    const p1 = absPosOf(sId);
    const p2 = absPosOf(tId);
    if (!p1 || !p2) { continue; }
    individual.push({
      source: sId, target: tId,
      count: l._count ?? 1, pending: !!l.pending,
      x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
    });
  }
  return individual;
}

/**
 * Aggregate cross links per frame pair (one-shot composition of the helpers).
 *   cross: link objects (source/target as ids or node objects)
 *   frameOfId(id) → frame path;  frameAt(path) → {abs, titleRect}
 *   absPosOf(id) → {x,y}|null (for hover-individual links)
 * Returns { bundles: [{key,a,b,count,pending,x1,y1,x2,y2}], individual: [...] }.
 */
function buildCrossLinks(opts) {
  const { cross, frameOfId, frameAt, absPosOf, hoverId } = opts;
  return {
    bundles: routeBundles(aggregateCrossPairs(cross, frameOfId), frameAt),
    individual: individualLinksFor(cross, hoverId, absPosOf),
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    splitEdgesByFrame, buildCrossLinks, portOn, pairKey, nearestEdgePoint, CL_SEP,
    aggregateCrossPairs, routeBundle, routeBundles, indexCrossByNode, individualLinksFor,
  };
}
