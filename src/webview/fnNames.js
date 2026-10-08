// fnNames.js — F28 (Bela, 2026-10-07): only the hovered function's name is shown.
//
// Function labels keep their elements (search, hover, LOD and dense-slot code all
// address them) but carry class `fn-name`; while no filter is active the zoom root
// has `fn-names-hidden` and CSS hides every `fn-name` that is not `fn-name-on`
// (display:none: no layout, no paint). A name is on while ANY reason holds:
// 'hover' (immediately on mouseover — no dwell; the hover card follows later),
// 'drag' (for the whole drag), 'popup' (while that node's source popup is open).
// With a filter active every function still shown keeps its name: search hides
// non-matches, so the matches must be readable. Unchanged: folder frame titles,
// file slot labels, collapsed folder/file glyph names, and Class overlay names.
//
// Globals used: g (zoom root), state, document. Nothing in a tick path.

const __fnOn = new Map();   // node id -> Set of reasons

/** Labels of plain function nodes (not glyphs, synthetics or anchors). Library labels are tagged at render. */
function isFnLabelDatum(d) {
  return !!d && !d.isCluster && !d.isSynthetic && !d.isFileAnchor;
}

function fnFilterActive() {
  const el = typeof document !== 'undefined' ? document.getElementById('search') : null;
  return !!(el && el.value && el.value.trim());
}

function fnLabelEls(id) {
  const out = [];
  for (const sel of [state.svgLabels, state.svgLibLabels]) {
    if (!sel) { continue; }
    sel.each(function (d) { if (d && d.id === id) { out.push(this); } });
  }
  return out;
}

/** Turn one reason for showing `id`'s name on or off. */
function fnNameOn(id, reason, on) {
  if (id == null) { return; }
  let reasons = __fnOn.get(id);
  if (on) {
    if (!reasons) { reasons = new Set(); __fnOn.set(id, reasons); }
    reasons.add(reason);
  } else if (reasons) {
    reasons.delete(reason);
    if (!reasons.size) { __fnOn.delete(id); }
  }
  const show = __fnOn.has(id);
  for (const el of fnLabelEls(id)) { el.classList.toggle('fn-name-on', show); }
}

/** After a render or a filter change: root class, and re-mark names that are on. */
function applyFnNames() {
  if (typeof g === 'undefined' || !g) { return; }
  g.classed('fn-names-hidden', !fnFilterActive());
  for (const id of __fnOn.keys()) {
    for (const el of fnLabelEls(id)) { el.classList.add('fn-name-on'); }
  }
}

if (typeof module !== 'undefined') {
  module.exports = { isFnLabelDatum, fnNameOn, applyFnNames, fnFilterActive, __fnOn };
}
