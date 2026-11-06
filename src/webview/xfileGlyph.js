// xfileGlyph.js — the ↗ cue on a function node (1.4 feedback F1, replaces the X3 dashed ring).
//
// While "Only calls within a file" is on, a function whose calls all go to other project
// files would look as if it called nothing. It gets a small filled arrow at the upper-right
// rim, the same ↗ the file slot label uses for its hidden outgoing calls (crossLinks.xfileCue
// decides who gets one). Dashed outlines keep a single meaning: empty / not there yet.
//
// Measured on the analyzer output with the rule on: 6 370 of 10 080 functions in the
// synthetic-10k fixture qualify. So the arrows are NOT one element per node: each frame (and
// the Global layer) gets ONE <path class="xfile-cues"> holding every arrow of its members,
// rewritten where that frame's node positions are written. It lives in g.f-nodes, so the
// zoom LOD parks it together with the nodes (frameCull FC_LAYERS.nodes). CSS shows it only
// under g.same-file-only, so the toggle needs no re-render.
//
// Globals used at runtime: none (d3 selections are passed in). Pure geometry is unit-tested.

const XC_SQRT1_2 = Math.SQRT1_2;

const __xc = {
  entries: new Map(),   // key (frame path | 'global') -> { el, nodes, originOf, radiusOf }
  vis: null,            // visible node ids (render / last filter pass); null = all
};

function xcRound(v) { return Math.round(v * 10) / 10; }

/** Arrow geometry for a node of radius r at (cx, cy). Starts just outside the rim (clear
 *  of a 3 px git outline), points up-right, length and width follow r. */
function xfileArrowPoints(cx, cy, r) {
  const gap = 1.5 + 0.12 * r;
  const len = Math.max(3, 0.9 * r);
  const head = 0.45 * len, hw = 0.32 * len, sw = Math.max(0.5, 0.09 * len);
  // a: along the arrow (up-right), b: across it
  const ux = XC_SQRT1_2, uy = -XC_SQRT1_2, px = XC_SQRT1_2, py = XC_SQRT1_2;
  const base = r + gap;
  const local = [[0, -sw], [len - head, -sw], [len - head, -hw], [len, 0],
    [len - head, hw], [len - head, sw], [0, sw]];
  return local.map(([a, b]) => [cx + ux * (base + a) + px * b, cy + uy * (base + a) + py * b]);
}

function xfileArrowD(cx, cy, r) {
  const pts = xfileArrowPoints(cx, cy, r);
  return 'M' + pts.map(([x, y]) => xcRound(x) + ' ' + xcRound(y)).join('L') + 'Z';
}

/** One path string for every visible, positioned node; coordinates relative to (ox, oy). */
function xfileCueD(nodes, ox, oy, radiusOf, vis) {
  let d = '';
  for (const n of nodes) {
    if (vis && !vis.has(n.id)) { continue; }
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) { continue; }
    d += xfileArrowD(n.x - ox, n.y - oy, radiusOf(n));
  }
  return d;
}

/** The members of `nodes` that carry the cue. */
function xfileCueNodes(nodes, cue) {
  if (!cue || !cue.cueIds || !cue.cueIds.size) { return []; }
  return nodes.filter(n => cue.cueIds.has(n.id));
}

/** Start of a render: forget the previous render's paths. */
function resetXfileCues(vis) {
  __xc.entries.clear();
  __xc.vis = vis || null;
}

/**
 * Join the cue path into `parentSel` (a d3 selection of g.f-nodes or the Global node layer),
 * on top of the circles, and write it once. `originOf()` → the layer's coordinate origin.
 */
function registerXfileCue(key, parentSel, nodes, cue, originOf, radiusOf) {
  const list = xfileCueNodes(nodes, cue);
  const sel = parentSel.selectAll('path.xfile-cues').data(list.length ? [key] : []).join('path')
    .attr('class', 'xfile-cues')
    .attr('pointer-events', 'none');
  if (!list.length) { __xc.entries.delete(key); return null; }
  sel.raise();
  __xc.entries.set(key, { el: sel.node(), nodes: list, originOf, radiusOf });
  writeXfileCue(key);
  return sel;
}

/** Rewrite one layer's arrows (called where that layer's node positions are written). */
function writeXfileCue(key) {
  const e = __xc.entries.get(key);
  if (!e) { return; }
  const o = e.originOf() || { x: 0, y: 0 };
  e.el.setAttribute('d', xfileCueD(e.nodes, o.x, o.y, e.radiusOf, __xc.vis));
}

/** A filter pass changed which nodes are visible: rewrite every layer. */
function refreshXfileCues(vis) {
  __xc.vis = vis || null;
  for (const key of __xc.entries.keys()) { writeXfileCue(key); }
}

if (typeof module !== 'undefined') {
  module.exports = {
    xfileArrowPoints, xfileArrowD, xfileCueD, xfileCueNodes,
    resetXfileCues, registerXfileCue, writeXfileCue, refreshXfileCues, __xc,
  };
}
