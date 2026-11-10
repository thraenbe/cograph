// crossLinks.js — split weighted edges by owning frame and aggregate the
// cross-frame remainder into one bundle per folder pair (drawn between title
// bar ports). Individual cross links are produced only for a hovered node.
// Also the same-file rule (U1). Pure helpers — no DOM/d3/state.

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

// ── Arrow geometry (fb14 D2): the head's tip touches the target's rim, the line stops
// inside the head. Heads are opaque (links fade with stroke-opacity, which a
// context-stroke marker does not inherit), so a translucent line crossing under a head
// no longer shows through it, and a line never pokes out beside the narrow tip.
// #arrow (rendering.js) is ARROW_HEAD graph units long with refX = 10 * ARROW_TUCK.
const ARROW_HEAD = 9;
const ARROW_TUCK = 0.25;                         // share of the head the line runs under
const ARROW_TRIM = ARROW_HEAD * (1 - ARROW_TUCK); // rim -> line end, when arrows are drawn

/**
 * Line ends between two circles, written into `out` (hot path: no allocation).
 * `trim` = ARROW_TRIM with arrows on, 0 without. The end never passes the start rim.
 */
function rimEnds(out, sx, sy, tx, ty, r1, r2, trim) {
  const dx = tx - sx, dy = ty - sy;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / dist, uy = dy / dist;
  const back = Math.min(r2 + trim, Math.max(0, dist - r1));
  out.x1 = sx + ux * r1;
  out.y1 = sy + uy * r1;
  out.x2 = tx - ux * back;
  out.y2 = ty - uy * back;
  return out;
}

/** Where a ray from p (inside rect) along unit (ux, uy) leaves rect; null when p is outside. */
function rayExit(rect, p, ux, uy) {
  if (p.x < rect.x || p.x > rect.x + rect.w || p.y < rect.y || p.y > rect.y + rect.h) { return null; }
  let t = Infinity;
  if (ux > 0) { t = Math.min(t, (rect.x + rect.w - p.x) / ux); }
  if (ux < 0) { t = Math.min(t, (rect.x - p.x) / ux); }
  if (uy > 0) { t = Math.min(t, (rect.y + rect.h - p.y) / uy); }
  if (uy < 0) { t = Math.min(t, (rect.y - p.y) / uy); }
  return Number.isFinite(t) ? t : null;
}

// no view known (DOM-less callers) = everything counts as on screen
const inRect = (r, p) => !r || p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/**
 * fb14 D5: shape the hovered node's individual cross links (from individualLinksFor).
 * The other end on screen (`ctx.view`, graph units) → rim to rim with the arrow trim.
 * Off screen → a STUB: from the hovered node towards the other end, stopping at the
 * hovered node's frame edge and at most ctx.stubMax long; the head sits on the end the
 * call flows into (the edge for an outgoing call, the hovered node's rim for an incoming
 * one). Never a line across the canvas to a node nobody can see.
 *   ctx: { radiusOf(id), view, frameRectOf(id), trim, stubMax }
 */
function shapeHoverLinks(individual, hoverId, ctx) {
  const out = [];
  for (const l of individual) {
    const outgoing = l.source === hoverId;
    const h = outgoing ? { x: l.x1, y: l.y1 } : { x: l.x2, y: l.y2 };
    const o = outgoing ? { x: l.x2, y: l.y2 } : { x: l.x1, y: l.y1 };
    const rh = ctx.radiusOf(hoverId), ro = ctx.radiusOf(outgoing ? l.target : l.source);
    if (inRect(ctx.view, o)) {
      const e = rimEnds({}, l.x1, l.y1, l.x2, l.y2,
        outgoing ? rh : ro, outgoing ? ro : rh, ctx.trim);
      out.push({ ...l, ...e, stub: false });
      continue;
    }
    const dx = o.x - h.x, dy = o.y - h.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const edge = rayExit(ctx.frameRectOf(hoverId), h, ux, uy);
    const len = Math.max(rh + ctx.trim + 2, Math.min(edge ?? ctx.stubMax, ctx.stubMax, dist));
    const far = { x: h.x + ux * len, y: h.y + uy * len };
    // outgoing: hovered rim -> far point (head at the far end, nothing to trim there);
    // incoming: far point -> hovered rim minus the arrow trim.
    const e = outgoing
      ? { x1: h.x + ux * rh, y1: h.y + uy * rh, x2: far.x, y2: far.y }
      : rimEnds({}, far.x, far.y, h.x, h.y, 0, rh, ctx.trim);
    out.push({ ...l, ...e, stub: true });
  }
  return out;
}

// ── Pinned cards (P1): the focus is the hovered function plus every pinned one ──
/** True while a function is hovered or pinned, i.e. updateCrossHover has lines to keep current. */
function crossFocusActive(st) {
  return st._frameHoverId != null || !!(st.pinnedFns && st.pinnedFns.size);
}

/** The ids whose own cross links are drawn: the hovered one first, then the pinned ones. */
function crossFocusIds(st) {
  const ids = st._frameHoverId != null ? [st._frameHoverId] : [];
  for (const id of st.pinnedFns || []) { if (!ids.includes(id)) { ids.push(id); } }
  return ids;
}

/**
 * Individual cross links of several focused ids: linksOf(id) = individualLinksFor of that
 * id, each shaped from its own end by shape(raw, id). A link between two focused ids is
 * drawn once (for the first of them).
 */
function focusCrossLinks(ids, linksOf, shape) {
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const raw = linksOf(id).filter(l => {
      const k = l.source + '\u0000' + l.target;
      if (seen.has(k)) { return false; }
      seen.add(k);
      return true;
    });
    if (raw.length) { out.push(...shape(raw, id)); }
  }
  return out;
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

// ── Same-file rule (U1, setting cograph.display.sameFileEdgesOnly) ─────────────
// With the setting on only calls whose caller and callee live in the same file
// are drawn. A node belongs to one file when it is a function (its `file`) or a
// collapsed file glyph; a folder glyph spans many files and a library has
// none, so every edge touching one of those counts as cross-file.

/** The single file a node stands for, or null. */
function fileOfNode(n) {
  if (!n || n.isLibrary || n.isFolderCluster) { return null; }
  if (n.isFileCluster) { return n._filePath || n.file || null; }
  return n.file || null;
}

/** True when both ends resolve to the same file (recursion included). */
function isSameFileLink(l, fileOfId) {
  const a = fileOfId(clIdOf(l.source));
  return a != null && a === fileOfId(clIdOf(l.target));
}

/** { same, cross } — order inside each list follows `links`. */
function partitionByFile(links, fileOfId) {
  const same = [], cross = [];
  for (const l of links) { (isSameFileLink(l, fileOfId) ? same : cross).push(l); }
  return { same, cross };
}

/** fileOfId over a node list (one Map per render, not per link). */
function fileLookup(nodes) {
  const byId = new Map();
  for (const n of nodes || []) { byId.set(n.id, fileOfNode(n)); }
  return (id) => (byId.has(id) ? byId.get(id) : null);
}

/**
 * X3 cue (Bela, 2026-10-08; one symbol per meaning since the 1.4 feedback F1): what the
 * same-file rule hides. A call "leaves" when caller and callee resolve to two different
 * PROJECT files (a library or a folder glyph has no file and does not count); counts are
 * weighted by _count. The node and file numbers share that base, so a file's ↗N is the
 * sum of its functions' ↗ counts.
 *   outByNode: node id -> calls it makes into other project files;
 *   outByFile: file    -> calls leaving that file (= sum of outByNode over its nodes);
 *   cueIds:    ids with outByNode > 0 and NO same-file call: without the ↗ they would
 *              look as if they called nothing at all.
 */
function xfileCue(links, fileOfId) {
  const same = new Set(), outByNode = new Map(), outByFile = new Map();
  for (const l of links) {
    const s = clIdOf(l.source), t = clIdOf(l.target);
    if (s === t) { continue; }
    const fs = fileOfId(s), ft = fileOfId(t);
    if (fs != null && fs === ft) { same.add(s); same.add(t); continue; }
    if (fs == null || ft == null) { continue; }
    const n = l._count ?? 1;
    outByNode.set(s, (outByNode.get(s) || 0) + n);
    outByFile.set(fs, (outByFile.get(fs) || 0) + n);
  }
  const cueIds = new Set();
  for (const id of outByNode.keys()) { if (!same.has(id)) { cueIds.add(id); } }
  return { cueIds, outByNode, outByFile };
}

if (typeof module !== 'undefined') {
  module.exports = {
    xfileCue,
    splitEdgesByFrame, buildCrossLinks, portOn, pairKey, nearestEdgePoint, CL_SEP,
    aggregateCrossPairs, routeBundle, routeBundles, indexCrossByNode, individualLinksFor,
    ARROW_HEAD, ARROW_TUCK, ARROW_TRIM, rimEnds, rayExit, shapeHoverLinks,
    crossFocusActive, crossFocusIds, focusCrossLinks,
    fileOfNode, isSameFileLink, partitionByFile, fileLookup,
  };
}
