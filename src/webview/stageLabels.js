// stageLabels.js — full names beside the nodes a tour step is about (stageApi.labels, an optional
// addition to docs/tour-protocol.md section 5). The stage cuts file and function names to fit their
// slots; a step's own subject is shown whole, on the stage overlay, at one size on screen whatever
// the zoom. Pure helpers: stageApi.js draws with them, tests call them directly.

/** On-screen size of a label, in CSS pixels; divided by the zoom so it stays this size. */
const STAGE_LABEL_PX = 12;
/** Gap between a node and its label, on screen. */
const STAGE_LABEL_GAP_PX = 5;

/** What a node is called on its label: Class.method for a method, the file or folder name for a cluster. */
function stageLabelText(n) {
  if (!n) { return ''; }
  const base = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '';
  if (n.isFileCluster || n.isFolderCluster) { return String(n.shortName || n.label || base(n.file || n._filePath || n._folderPath)); }
  // Render nodes carry the display name as `label`, graph nodes as `name` (as stageApi.nodes reads them).
  const name = String(n.name || n.label || '');
  return n.className ? `${n.className}.${name}` : name;
}

/**
 * Where a label goes, in graph space: right of a node's box, on its middle line; above a file slot or
 * folder frame (`above`), at its left edge. `k` is the current zoom, so gaps stay the same on screen.
 */
function stageLabelSpot(box, k, above) {
  const z = k > 0 ? k : 1;
  if (above) { return { x: box.minX, y: box.minY - STAGE_LABEL_GAP_PX / z, anchor: 'start', baseline: 'auto' }; }
  return { x: box.maxX + STAGE_LABEL_GAP_PX / z, y: (box.minY + box.maxY) / 2, anchor: 'start', baseline: 'middle' };
}

/** Average glyph width of a 12 px label, as a share of the font size (system-ui, semibold). */
const STAGE_LABEL_CHAR_EM = 0.62;
/** How many rows further down a label may go when every side of its node is taken. */
const STAGE_LABEL_MAX_ROWS = 4;

const overlaps = (a, b) => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

/** The box a label of `text` covers when its anchor spot is `p`, in graph space at zoom z. */
function stageLabelBox(text, p, z) {
  const w = (String(text).length * STAGE_LABEL_CHAR_EM * STAGE_LABEL_PX) / z, h = (STAGE_LABEL_PX * 1.25) / z;
  const minX = p.anchor === 'middle' ? p.x - w / 2 : p.anchor === 'end' ? p.x - w : p.x;
  const minY = p.baseline === 'middle' ? p.y - h / 2 : p.baseline === 'hanging' ? p.y : p.y - h;
  return { minX, minY, maxX: minX + w, maxY: minY + h };
}

/** Where a node's label may go, in order: below, right, above, left; then further rows below. */
function stageLabelCandidates(box, z) {
  const g = STAGE_LABEL_GAP_PX / z, cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2, row = (STAGE_LABEL_PX * 1.3) / z;
  const out = [
    { x: cx, y: box.maxY + g, anchor: 'middle', baseline: 'hanging' },
    { x: box.maxX + g, y: cy, anchor: 'start', baseline: 'middle' },
    { x: cx, y: box.minY - g, anchor: 'middle', baseline: 'auto' },
    { x: box.minX - g, y: cy, anchor: 'end', baseline: 'middle' },
  ];
  for (let i = 1; i <= STAGE_LABEL_MAX_ROWS; i++) { out.push({ x: cx, y: box.maxY + g + i * row, anchor: 'middle', baseline: 'hanging' }); }
  return out;
}

/**
 * Places every label so none covers another label or another of the step's nodes. Deterministic:
 * items in order, the first free candidate wins; a label with no free place takes its last row.
 */
function stageLayoutLabels(items, k) {
  const z = k > 0 ? k : 1;
  const nodes = items.filter((it) => !it.above).map((it) => it.box);
  const placed = [];
  return items.map((it) => {
    const options = it.above ? [stageLabelSpot(it.box, z, true)] : stageLabelCandidates(it.box, z);
    const free = options.find((p) => {
      const b = stageLabelBox(it.text, p, z);
      return !placed.some((q) => overlaps(b, q)) && !nodes.some((n) => n !== it.box && overlaps(b, n));
    }) || options[options.length - 1];
    placed.push(stageLabelBox(it.text, free, z));
    return { text: it.text, p: free };
  });
}

/** Draws each `{ text, box, above }` as one text element on the overlay, sized for zoom `k`. */
function stageDrawLabels(svgEl, overlay, items, k) {
  const z = k > 0 ? k : 1;
  for (const { text, p } of stageLayoutLabels(items.filter((it) => it && it.text && it.box), z)) {
    const t = svgEl('text', {
      class: 'stage-label', x: p.x, y: p.y, 'text-anchor': p.anchor, 'dominant-baseline': p.baseline,
      'font-size': STAGE_LABEL_PX / z, 'stroke-width': 3 / z,
    }, overlay);
    t.textContent = text;
  }
}

if (typeof module !== 'undefined') {
  module.exports = { stageLabelText, stageLabelSpot, stageLabelBox, stageLayoutLabels, stageDrawLabels, STAGE_LABEL_PX, STAGE_LABEL_GAP_PX };
}
