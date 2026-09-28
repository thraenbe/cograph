// scopeFit.js — the view after a scope change (Hide / Only show / Show all /
// subgraph). Both engines.
//
// F26: "Show only this file" while zoomed in re-packed the slot somewhere
// off-screen and the re-fit was skipped because the user owned the viewport
// (userZoomed, F2), so the canvas looked blank. The rule now: a user-owned
// viewport is kept as long as ANY in-scope content is still in it; when the
// scope change left it empty, fit to what is in scope.
//
// Shelf: content = the in-scope file slots (a file without parsed functions
// still has a slot). Global: content = the visible nodes. Fitting the whole
// node list (fitToView) is wrong here — out-of-scope nodes keep their stale
// positions and would stretch the fit far past what is shown.

const SCOPE_FIT_DELAY_MS = 230;   // after the re-pack glide (frameRender uses the same 230 ms)
let __scopeFitTimer = 0;

/** Union of rects, or null for none. */
function boundsOfRects(rects) {
  if (!rects.length) { return null; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Visible nodes as small rects (Global engine). `radiusOf` = rendering.js nodeRadius. */
function visibleNodeRects(nodes, visibleIds, radiusOf) {
  const out = [];
  for (const n of nodes) {
    if (!visibleIds.has(n.id) || n.x == null || !isFinite(n.x) || !isFinite(n.y)) { continue; }
    const r = radiusOf(n);
    out.push({ x: n.x - r, y: n.y - r, w: 2 * r, h: 2 * r });
  }
  return out;
}

/**
 * Pure decision: where to fit, or null to leave the view alone.
 *   frames: Shelf (a SHRINKING scope re-fits unless the user owns the view)
 *   userZoomed: the user zoomed/panned (F2)
 */
function scopeFitTarget(rects, view, opts) {
  if (!rects.length || opts.interacting) { return null; }
  const empty = viewMissesAll(rects, view);
  const wanted = empty || (opts.frames && !opts.userZoomed);
  return wanted ? boundsOfRects(rects) : null;
}

function scopeContentRects() {
  if (typeof usesFrames === 'function' && usesFrames()) {
    return slotRects(state.frames, innerOrigin);
  }
  return visibleNodeRects(state.currentNodes || [], getVisibleNodeIds(), nodeRadius);
}

function currentViewRect() {
  const svgEl = svg.node();
  return viewportRect(d3.zoomTransform(svgEl), svgEl.clientWidth || window.innerWidth, svgEl.clientHeight || window.innerHeight, 0);
}

/** Run the decision against the live view and fit if it says so. */
function refitAfterScope() {
  const frames = typeof usesFrames === 'function' && usesFrames();
  const target = scopeFitTarget(scopeContentRects(), currentViewRect(),
    { frames, userZoomed: !!state.userZoomed, interacting: !!state._frameInteracting });
  if (target) { fitToRect(target.x, target.y, target.x + target.w, target.y + target.h, 0); }
}

/** Global engine: filters toggle display only, so no re-render schedules the check. */
function scheduleScopeRefit() {
  if (typeof setTimeout !== 'function') { return; }
  if (__scopeFitTimer) { clearTimeout(__scopeFitTimer); }
  __scopeFitTimer = setTimeout(() => { __scopeFitTimer = 0; refitAfterScope(); }, SCOPE_FIT_DELAY_MS);
}

if (typeof module !== 'undefined') {
  module.exports = { boundsOfRects, visibleNodeRects, scopeFitTarget, refitAfterScope, scheduleScopeRefit, SCOPE_FIT_DELAY_MS };
}
