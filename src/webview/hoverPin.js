// hoverPin.js — X2 (Bela, 2026-10-08): hold a hovered function still in Global + Dynamic.
//
// While a Dynamic simulation settles (13-16 s on click/flask, longer on bigger repos:
// F32), a node drifts out from under a resting pointer and its name/card give way to
// whatever lies beneath. Pinning the hovered node with fx/fy — the standard d3 idiom —
// holds it while it is read. Measured: it CALMS the neighbourhood rather than
// perturbing it (3 s hover: click neighbours 6.7 -> 2.9 px, flask 6.5 -> 1.5 px).
//
// Rules: Global engine with Dynamic motion only (Shelf runs its sims in workers and
// Static never moves). A node the user already pinned (fx/fy set, e.g. by a drag in
// Static or a saved layout) is never touched. A drag that starts on a hover-pinned
// node takes the pin over: the drag's own end decides whether it stays.

function hoverPinApplies() {
  if (typeof usesFrames === 'function' && usesFrames()) { return false; }
  return typeof state !== 'undefined' && state.layoutMode === 'dynamic';
}

function hoverPinOn(d) {
  if (!d || !hoverPinApplies() || d.fx != null || d.fy != null) { return; }
  d.fx = d.x;
  d.fy = d.y;
  d.__hoverPinned = true;
}

function hoverPinOff(d) {
  if (!d || !d.__hoverPinned) { return; }
  d.__hoverPinned = false;
  d.fx = null;
  d.fy = null;
}

/** A drag started on this node: the pin is the drag's now. */
function hoverPinHandOver(d) {
  if (d) { d.__hoverPinned = false; }
}

if (typeof module !== 'undefined') {
  module.exports = { hoverPinOn, hoverPinOff, hoverPinHandOver, hoverPinApplies };
}
