// frameChrome.js — Draft A "index tab" folder chrome, shared by the Shelf
// engine's frames (frameRender.js), the Global drill-down boxes (drilldown.js)
// and the folder overlay bubbles (folder.js). Pure geometry/string helpers —
// no DOM, d3 or state access.

const TAB = {
  H: 22,           // flap height; fits inside the 30px title strip the packer reserves
  STEP: 8,         // manila step: the body's top edge right of the flap sits this far below the flap top (~H*0.35)
  R: 7,            // corner radius
  MAX_FRAC: 0.62,  // tab takes at most this fraction of the frame width
  CHAR_W: 6.4,     // ~label glyph width (11-12px UI font)
  EXTRA: 40,       // glyph + padding budget around the label
  TEXT_X: 26,      // label x inside the tab (right of the glyph)
  TEXT_Y: 11,      // label y inside the tab (central baseline)
  CNT_CHAR_W: 5.5, // ~counts glyph width (10px font)
  CNT_PAD: 22,     // clearance between the tab shoulder and the counts text
};

// Small folder silhouette drawn at the tab's left edge (14×11 units, scaled 0.85).
const FOLDER_GLYPH =
  'M0 2a2 2 0 0 1 2-2h3.2l1.6 2H12a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2z';

function tabWidth(name, frameW) {
  return Math.min(frameW * TAB.MAX_FRAC, String(name ?? '').length * TAB.CHAR_W + TAB.EXTRA);
}

/** How many label characters fit in a tab of width tw. */
function tabChars(tw) {
  return Math.max(1, Math.floor((tw - 34) / TAB.CHAR_W));
}

function cutLabel(s, maxChars) {
  s = String(s ?? '');
  return s.length > maxChars ? s.slice(0, Math.max(1, maxChars - 1)) + '…' : s;
}

/** Manila-folder outline: the flap occupies the top-left, and the body's top
 *  edge right of the flap sits only a SHALLOW step below the flap top
 *  (Bela's sketch), not a full flap-height lower. (x,y) is the frame's
 *  top-left corner; the flap's top edge sits at y, the body's at y+step. */
function tabBodyPath(x, y, w, h, tw, th = TAB.H, step = TAB.STEP) {
  const r = Math.min(TAB.R, th / 2, w / 4);
  const st = Math.min(step, th); // the step can never exceed the flap depth
  const sh = Math.min(12, Math.max(4, st * 1.2)); // shoulder run of the flap's right edge
  return `M${x} ${y + r}a${r} ${r} 0 0 1 ${r} ${-r}H${x + tw}` +
    `c${sh / 2} 0 ${sh / 2} ${st} ${sh} ${st}H${x + w - r}` +
    `a${r} ${r} 0 0 1 ${r} ${r}V${y + h - r}a${r} ${r} 0 0 1 ${-r} ${r}` +
    `H${x + r}a${r} ${r} 0 0 1 ${-r} ${-r}Z`;
}

/** Just the filled tab (painted over the body outline's tab bump). */
function tabOnlyPath(x, y, tw, th = TAB.H) {
  const r = Math.min(TAB.R, th / 2);
  const sh = Math.min(12, th * 0.55);
  return `M${x} ${y + th}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}H${x + tw}` +
    `c${sh / 2} 0 ${sh / 2} ${th} ${sh} ${th}Z`;
}

/** Plain rounded-rect path (the root frame keeps a tabless dashed outline). */
function rectPath(x, y, w, h, r = 8) {
  return `M${x + r} ${y}H${x + w - r}a${r} ${r} 0 0 1 ${r} ${r}V${y + h - r}` +
    `a${r} ${r} 0 0 1 ${-r} ${r}H${x + r}a${r} ${r} 0 0 1 ${-r} ${-r}V${y + r}` +
    `a${r} ${r} 0 0 1 ${r} ${-r}Z`;
}

/** Fit-to-view scale: fill the padded viewport, hard cap 4x, and never let
 *  the largest node exceed ~35% of the shorter viewport side — a lone
 *  collapsed-folder glyph (bbox of a single point) must not become a
 *  viewport-filling blob (F6). */
function fitScale(bw, bh, viewW, viewH, maxR, pad = 60) {
  let s = Math.min((viewW - pad * 2) / (bw || 1), (viewH - pad * 2) / (bh || 1), 4);
  if (maxR > 0) { s = Math.min(s, (0.35 * Math.min(viewW, viewH)) / maxR); }
  return s;
}

// Dense-slot labelling (B6): slots holding more than SLOT_N functions hide
// their function labels until the viewer zooms past LABEL_ZOOM.
const DENSE = { SLOT_N: 12, LABEL_ZOOM: 1.5 };

/** Slot label "name · N", name ellipsized so the whole text fits slotW.
 *  charW is the approximate glyph width at the label's font size. */
function slotLabelText(name, count, slotW, charW) {
  const suffix = count ? ` · ${count}` : '';
  const budget = Math.max(2, Math.floor((slotW - 12) / charW) - suffix.length);
  return cutLabel(name, budget) + suffix;
}

/** Counts for the free strip right of the tab: long form while it fits,
 *  compact "N · M" when the strip is narrow. */
function countsText(files, fns, freeW) {
  if (!files && !fns) { return ''; } // an empty folder's "0 files · 0 fns" is noise
  const long = `${files} ${files === 1 ? 'file' : 'files'} · ${fns} ${fns === 1 ? 'fn' : 'fns'}`;
  return long.length * TAB.CNT_CHAR_W < freeW ? long : `${files} · ${fns}`;
}

/** files/fns counts from a member (node) list. Functions carry .file;
 *  collapsed file/folder glyphs are cluster nodes with file::/folder:: ids. */
function memberCounts(members) {
  const files = new Set();
  let fns = 0;
  for (const m of members || []) {
    const id = typeof m.id === 'string' ? m.id : '';
    const fp = m.file || m._filePath || (id.startsWith('file::') ? id.slice(6) : null);
    if (fp) { files.add(fp); }
    if (m.file && !m.isCluster && !m.isSynthetic) { fns++; }
  }
  return { files: files.size, fns };
}

/** Closed-folder glyph dimensions for a collapsed folder with collision
 *  radius r. The WHOLE silhouette must stay inside that radius — the packer,
 *  the collide force and the slot clamp all budget exactly r, so a wider
 *  shape bleeds into neighbouring slots or out of the frame (F8). */
function closedFolderDims(r) {
  const w = 2 * r;
  const h = 1.2 * r;
  const th = h * 0.45;
  return { w, h, tw: w * 0.48, th, step: Math.max(2, th * 0.35) };
}

/** Compact closed-folder silhouette for a collapsed folder glyph, centred at
 *  (0,0), sized from the node's collision radius r. */
function closedFolderPath(r) {
  const d = closedFolderDims(r);
  return tabBodyPath(-d.w / 2, -d.h / 2, d.w, d.h, d.tw, d.th, d.step);
}

if (typeof module !== 'undefined') {
  module.exports = {
    TAB, DENSE, FOLDER_GLYPH, tabWidth, tabChars, cutLabel, slotLabelText, fitScale,
    tabBodyPath, tabOnlyPath, rectPath, countsText, memberCounts, closedFolderPath, closedFolderDims,
  };
}
