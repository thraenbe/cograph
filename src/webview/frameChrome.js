// frameChrome.js — Draft A "index tab" folder chrome, shared by the Shelf
// engine's frames (frameRender.js), the Global drill-down boxes (drilldown.js)
// and the folder overlay bubbles (folder.js). Pure geometry/string helpers —
// no DOM, d3 or state access.

const TAB = {
  H: 22,           // tab height; fits inside the 30px title strip the packer reserves
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

/** Frame outline with the tab bump on the top-left. (x,y) is the frame's
 *  top-left corner; the tab's top edge sits at y, the body's at y+th. */
function tabBodyPath(x, y, w, h, tw, th = TAB.H) {
  const r = Math.min(TAB.R, th / 2, w / 4);
  const sh = Math.min(12, th * 0.55); // horizontal run of the tab's right shoulder
  return `M${x} ${y + r}a${r} ${r} 0 0 1 ${r} ${-r}H${x + tw}` +
    `c${sh / 2} 0 ${sh / 2} ${th} ${sh} ${th}H${x + w - r}` +
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

/** Counts for the free strip right of the tab: long form while it fits,
 *  compact "N · M" when the strip is narrow. */
function countsText(files, fns, freeW) {
  const long = `${files} files · ${fns} fns`;
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

/** Compact closed-folder silhouette for a collapsed folder glyph, centred at
 *  (0,0), sized from the node's collision radius r. */
function closedFolderPath(r) {
  const w = 2.8 * r;
  const h = 1.7 * r;
  const th = h * 0.45;
  return tabBodyPath(-w / 2, -h / 2, w, h, w * 0.48, th);
}

if (typeof module !== 'undefined') {
  module.exports = {
    TAB, FOLDER_GLYPH, tabWidth, tabChars, cutLabel,
    tabBodyPath, tabOnlyPath, rectPath, countsText, memberCounts, closedFolderPath,
  };
}
