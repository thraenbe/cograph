// slotDrag.js — drag a file slot by its LABEL BAND inside its frame (R2b).
// The slot pins where it is dropped (content-local, persisted with the
// layout); other slots re-pack around it as fixed obstacles. Pure glue: all
// DOM/state specifics arrive through `deps` so the flow is unit-testable.

/** Clamp a slot's desired frame-local position into the frame's inner area. */
function clampSlotPos(bounds, w, h, nx, ny) {
  return {
    x: Math.max(bounds.x0, Math.min(Math.max(bounds.x0, bounds.x1 - w), nx)),
    y: Math.max(bounds.y0, Math.min(Math.max(bounds.y0, bounds.y1 - h), ny)),
  };
}

/**
 * deps: {
 *   container(): Element      — the stable zoomed layer (never the moving g!),
 *   frame(): Frame|null       — the slot's frame,
 *   bounds(frame): {x0,y0,x1,y1} — draggable area in frame-local coords,
 *   move(el, d, dx, dy)       — shift the slot chrome + its member nodes,
 *   commit(frame, d)          — write the pin and re-render,
 * }
 */
function createSlotDrag(deps) {
  return d3.drag()
    .container(deps.container)
    .on('start', function (event, d) {
      if (!deps.frame()) { return; }
      d._sd = { x0: d.x, y0: d.y, ex: event.x, ey: event.y };
    })
    .on('drag', function (event, d) {
      const f = deps.frame();
      if (!f || !d._sd) { return; }
      const want = clampSlotPos(deps.bounds(f), d.w, d.h,
        d._sd.x0 + (event.x - d._sd.ex), d._sd.y0 + (event.y - d._sd.ey));
      const dx = want.x - d.x, dy = want.y - d.y;
      if (!dx && !dy) { return; }
      d.x = want.x; d.y = want.y;
      deps.move(this, d, dx, dy);
    })
    .on('end', function (event, d) {
      const f = deps.frame();
      if (!f || !d._sd) { return; }
      delete d._sd;
      deps.commit(f, d);
    });
}

if (typeof module !== 'undefined') {
  module.exports = { createSlotDrag, clampSlotPos };
}
