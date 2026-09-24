// ── SVG setup ─────────────────────────────────────────────────────────────────
const svg = d3.select('#graph')
  .append('svg')
  .attr('width', '100%')
  .attr('height', '100%');

const defs = svg.append('defs');

// Arrow marker for plain function edges. Fixed at ~9 graph units
// (userSpaceOnUse): with the default strokeWidth units an aggregated Global
// edge (stroke = linkThickness × edgeWeightScale) grew the head to 30-160px
// on screen (F20). Like #arrow-bundle it scales with the zoom, not the stroke.
defs.append('marker')
  .attr('id', 'arrow')
  .attr('viewBox', '0 -5 10 10')
  .attr('refX', 10)
  .attr('refY', 0)
  .attr('markerWidth', 9)
  .attr('markerHeight', 9)
  .attr('markerUnits', 'userSpaceOnUse')
  .attr('orient', 'auto')
  .append('path')
  .attr('d', 'M0,-5L10,0L0,5')
  .attr('fill', 'context-stroke');

// Fixed-size arrowhead for cross-folder bundles: #arrow scales with the
// stroke width (markerUnits defaults to strokeWidth) and bundle strokes reach
// ~24px, giving ~96px triangles. userSpaceOnUse keeps this head ~9 graph
// units — it scales with the zoom like the graph itself.
defs.append('marker')
  .attr('id', 'arrow-bundle')
  .attr('viewBox', '0 -5 10 10')
  .attr('refX', 10)
  .attr('refY', 0)
  .attr('markerWidth', 9)
  .attr('markerHeight', 9)
  .attr('markerUnits', 'userSpaceOnUse')
  .attr('orient', 'auto')
  .append('path')
  .attr('d', 'M0,-5L10,0L0,5')
  .attr('fill', 'context-stroke');

// Default glow filter
const glowFilter = defs.append('filter')
  .attr('id', 'glow')
  .attr('x', '-50%').attr('y', '-50%')
  .attr('width', '200%').attr('height', '200%');
glowFilter.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '4').attr('result', 'blur');
const fm1 = glowFilter.append('feMerge');
fm1.append('feMergeNode').attr('in', 'blur');
fm1.append('feMergeNode').attr('in', 'SourceGraphic');

// Hover glow filter (larger blur)
const hoverFilter = defs.append('filter')
  .attr('id', 'glow-hover')
  .attr('x', '-100%').attr('y', '-100%')
  .attr('width', '300%').attr('height', '300%');
hoverFilter.append('feGaussianBlur').attr('in', 'SourceGraphic').attr('stdDeviation', '8').attr('result', 'blur');
const fm2 = hoverFilter.append('feMerge');
fm2.append('feMergeNode').attr('in', 'blur');
fm2.append('feMergeNode').attr('in', 'SourceGraphic');

// Book icon symbol for library nodes
defs.append('symbol')
  .attr('id', 'icon-book')
  .attr('viewBox', '0 0 16 16')
  .append('path')
  .attr('d', 'M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zM2.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-11zM3 5.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0 2a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0 2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5z');

// Transform groups
const g = svg.append('g');
const dividerG = g.append('g').attr('class', 'workflow-divider');  // back layer; workflow mode only
const folderG = g.append('g').attr('class', 'folder-bubbles');
const fileG   = g.append('g').attr('class', 'file-circles');
const classG  = g.append('g').attr('class', 'class-bubbles');
const frameG = g.append('g').attr('class', 'frames');   // frames engine layer (empty in global path)
const linkG = g.append('g').attr('class', 'links');
const nodeG = g.append('g').attr('class', 'nodes');
const labelG = g.append('g').attr('class', 'labels');
const libNodeG = g.append('g').attr('class', 'lib-nodes');
const libLabelG = g.append('g').attr('class', 'lib-labels');

// ── Zoom ──────────────────────────────────────────────────────────────────────
const zoomBehavior = d3.zoom()
  .scaleExtent([0.02, 10])
  .on('zoom', (event) => {
    g.attr('transform', event.transform);
    state.currentZoom = event.transform.k;
    // A gesture (wheel/drag/pinch) has a sourceEvent; programmatic fits don't.
    // Once the user takes the viewport, automatic re-fits stop (see F2).
    if (event.sourceEvent) { state.userZoomed = true; }
    updateTextVisibility();
    if (typeof onFramesZoom === 'function') { onFramesZoom(); } // W3: culling + LOD
  });

svg.call(zoomBehavior);
svg.on('dblclick.zoom', null); // Remove D3's default dblclick-to-zoom
svg.on('dblclick', (event) => {
  const t = event.target;
  if (t.tagName === 'circle' || t.classList.contains('cloud-node')) return;
  fitToView();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
// Memoised (hotCache.js): it is called from per-element d3 accessors. Dropped
// on theme changes and at every render start. Self-contained on purpose —
// themeVars.test extracts this function by source text.
function getCSSVar(name) {
  // Read from <body>: VS Code puts the theme class there (body.vscode-light),
  // so documentElement never sees the light-theme --cograph-* overrides.
  const read = (n) => getComputedStyle(document.body || document.documentElement).getPropertyValue(n).trim();
  return (typeof cssVarCached === 'function') ? cssVarCached(name, read) : read(name);
}

function nodeRadius(d) {
  return ((d._size ?? 6) / 2) * settings.nodeSize;
}

function nodeColor(d) {
  if (d.isLibrary)       return getCSSVar('--cograph-node-library');
  if (d.isSynthetic)     return 'var(--vscode-button-background, #0e639c)';
  if (d.isCluster)       return getCSSVar('--cograph-node-cluster');
  if (d.isEntryPoint)    return getCSSVar('--cograph-node-entry');
  return getCSSVar('--cograph-node-default');
}

function fileColor(file) {
  if (!file) return 'transparent';
  let hash = 0;
  for (let i = 0; i < file.length; i++) {
    hash = ((hash << 5) - hash) + file.charCodeAt(i);
    hash |= 0;
  }
  return `hsl(${((hash % 360) + 360) % 360}, 70%, 65%)`;
}


function bumpCountFor(d) {
  return Math.max(5, Math.min(12, Math.round(4 + Math.log2((d.memberCount ?? 1) + 1))));
}

// Returns an SVG path string centered at (0,0) with effective radius R.
// Draws bumpCount convex arcs to create a cloud silhouette.
function generateCloudPath(R, bumpCount) {
  const bumpR = R * 0.38;
  const innerR = R - bumpR * 0.45;
  const pts = Array.from({ length: bumpCount }, (_, i) => {
    const a = (i / bumpCount) * 2 * Math.PI - Math.PI / 2;
    return { x: innerR * Math.cos(a), y: innerR * Math.sin(a) };
  });
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < bumpCount; i++) {
    const next = pts[(i + 1) % bumpCount];
    d += ` A ${bumpR} ${bumpR} 0 0 1 ${next.x} ${next.y}`;
  }
  return d + ' Z';
}

// Plain circle path (two arcs), centered at (0,0).
function circlePath(R) {
  return `M ${-R} 0 A ${R} ${R} 0 1 0 ${R} 0 A ${R} ${R} 0 1 0 ${-R} 0 Z`;
}

// Shape selector for the cloud-node layer: files → circle, collapsed folders →
// compact closed-folder silhouette (matches the open frames' tab chrome),
// everything else (structural clusters) → cloud silhouette.
function generateNodeShapePath(d, R) {
  if (d.isFileCluster) { return circlePath(R); }
  if (d.isFolderCluster && typeof closedFolderPath === 'function') { return closedFolderPath(R); }
  return generateCloudPath(R, bumpCountFor(d));
}

function chargeStrength(d) {
  return -settings.repelForce;
}

// ── Large-graph gate (P1 quick wins — issue #52) ──────────────────────────────
// Below the threshold every path behaves exactly as before; above it drags are
// local, ticks coalesce to animation frames and the per-node glow is dropped.
const BIG_GRAPH_N = 500;
function isBigGraph() { return state.currentNodes.length > BIG_GRAPH_N; }

// Shared drag policy for every drag factory (node/file/folder/box/class).
function reheatForDrag(event) {
  if (state.layoutMode !== 'dynamic' || isBigGraph()) { return; }
  if (!event.active && state.simulation) { state.simulation.alphaTarget(0.3).restart(); }
}
// True when the drag handler must write x/y itself (no simulation driving it).
function dragMovesDirectly() { return state.layoutMode === 'static' || isBigGraph(); }
// Returns true when the caller should release fx/fy (small dynamic graphs);
// big graphs keep dragged nodes pinned where dropped instead of re-agitating.
function coolAfterDrag(event) {
  if (state.layoutMode !== 'dynamic' || isBigGraph()) { return false; }
  if (!event.active && state.simulation) { state.simulation.alphaTarget(0); }
  return true;
}
function glowAttr() { return isBigGraph() ? null : 'url(#glow)'; }

// Links sit quieter inside shelf frames (slots already show the grouping).
function linkRestOpacity() {
  return (typeof usesFrames === 'function' && usesFrames()) ? 0.35 : 0.7;
}

// An edge touching a folder/file drill-down cluster node (vs a function↔function edge).
function isFolderLink(d) {
  const s = d.source, t = d.target;
  return !!(s && t && (s.isFolderCluster || s.isFileCluster || t.isFolderCluster || t.isFileCluster));
}

// Creates (or recreates) a per-cluster hard-stop linearGradient in <defs>.
// Returns the fill string e.g. 'url(#cograph-lang-grad-...)'.
function ensureClusterGradient(d) {
  const safeId = 'cograph-lang-grad-' + d.id.replace(/[^a-zA-Z0-9]/g, '_');
  defs.select('#' + safeId).remove();
  const grad = defs.append('linearGradient')
    .attr('id', safeId)
    .attr('x1', '0%').attr('x2', '100%')
    .attr('y1', '0%').attr('y2', '0%');
  let offset = 0;
  for (const { lang, fraction } of d.languageBreakdown) {
    const color = getLanguageColor(lang);
    grad.append('stop').attr('offset', `${(offset * 100).toFixed(1)}%`).attr('stop-color', color);
    grad.append('stop').attr('offset', `${((offset + fraction) * 100).toFixed(1)}%`).attr('stop-color', color);
    offset += fraction;
  }
  return `url(#${safeId})`;
}

// Language colors on clusters are always shown regardless of languageMode toggle.
// Folders & connectivity clusters tint by the mix of languages they contain;
// files (one language) take that language's solid colour.
function resolveClusterFill(d) {
  if (d.isFileCluster) return getLanguageColor(d.language) || getCSSVar('--cograph-node-cluster');
  if (d.languageBreakdown?.length > 1) return ensureClusterGradient(d);
  if (d.languageBreakdown?.length === 1) return getLanguageColor(d.languageBreakdown[0].lang) ?? getCSSVar('--cograph-node-cluster');
  return getCSSVar('--cograph-node-cluster');
}

// Runs on every zoom event: only rewrite label opacity when the fade threshold
// is actually crossed (or a render swapped the label selections).
const __textVis = { opacity: null, denseHidden: null, labels: null, libLabels: null };
function updateTextVisibility() {
  if (!state.svgLabels) return;
  const opacity = state.currentZoom >= settings.textFadeThreshold ? 1 : 0;
  // B6: labels inside dense file slots (frames engine) stay hidden until the
  // viewer zooms close enough to read them — a second threshold for the gate.
  const denseZoom = (typeof DENSE !== 'undefined') ? DENSE.LABEL_ZOOM : Infinity;
  const denseHidden = state.currentZoom < denseZoom;
  if (__textVis.opacity === opacity && __textVis.denseHidden === denseHidden
      && __textVis.labels === state.svgLabels
      && __textVis.libLabels === (state.svgLibLabels ?? null)) { return; }
  __textVis.opacity = opacity;
  __textVis.denseHidden = denseHidden;
  __textVis.labels = state.svgLabels;
  __textVis.libLabels = state.svgLibLabels ?? null;
  state.svgLabels.style('opacity', d => (d && d._denseSlot && denseHidden) ? 0 : opacity);
  state.svgLibLabels?.style('opacity', opacity);
}

function fitToView() {
  if (!state.currentNodes.length) return;
  const xs = state.currentNodes.map(n => n.x).filter(v => v != null && isFinite(v));
  const ys = state.currentNodes.map(n => n.y).filter(v => v != null && isFinite(v));
  if (!xs.length) return;
  const svgEl = svg.node();
  const W = svgEl.clientWidth || window.innerWidth;
  const H = svgEl.clientHeight || window.innerHeight;
  const pad = 60;
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  let maxR = 0;
  for (const n of state.currentNodes) {
    if (n.x != null && isFinite(n.x)) { maxR = Math.max(maxR, nodeRadius(n)); }
  }
  const scale = (typeof fitScale === 'function')
    ? fitScale(maxX - minX, maxY - minY, W, H, maxR, pad)
    : Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxY - minY || 1), 4);
  svg.transition().duration(500).call(
    zoomBehavior.transform,
    d3.zoomIdentity
      .translate(W / 2 - scale * (minX + maxX) / 2, H / 2 - scale * (minY + maxY) / 2)
      .scale(scale)
  );
}

// ── Drag (swimming effect) ────────────────────────────────────────────────────
const drag = d3.drag()
  .container(function () { return g.node(); }) // absolute coords (identity in global path)
  .on('start', (event, d) => {
    reheatForDrag(event);
    d.fx = d.x;
    d.fy = d.y;
  })
  .on('drag', (event, d) => {
    const __t0 = __pb();
    d.fx = event.x;
    d.fy = event.y;
    if (dragMovesDirectly()) {
      // Simulation not driving this node — sync x/y directly so ticked() renders correctly
      d.x = event.x;
      d.y = event.y;
      ticked(d);
    }
    __pe('drag:move', __t0);
  })
  .on('end', (event, d) => {
    if (coolAfterDrag(event)) {
      d.fx = null;
      d.fy = null; // release — node rejoins simulation
    }
    // static / big graph: keep fx/fy pinned so node stays exactly where dropped
    window.markDirty?.();
  });

// ── Tick ──────────────────────────────────────────────────────────────────────
// Above the big-graph threshold manual tick requests (static drags, filter
// changes) coalesce into one animation frame; d3's own timer already ticks at
// most once per frame, so small graphs keep the synchronous path.
let __tickPending = false;
function ticked(movedNode) {
  if (typeof usesFrames === 'function' && usesFrames()) {
    // A node drag only moves its own frame's members (frameRender fast path).
    if (movedNode && typeof tickFrameOfNode === 'function') { tickFrameOfNode(movedNode); }
    else { tickFrames(); }
    return;
  }
  if (!isBigGraph()) { tickedNow(); return; }
  if (__tickPending) { return; }
  __tickPending = true;
  requestAnimationFrame(() => { __tickPending = false; tickedNow(); });
}

function tickedNow() {
  const __perfT0 = (typeof perfOn === 'function' && perfOn()) ? perfNow() : 0;
  state.svgLinks?.each(function (d) {
    const sx = d.source.x, sy = d.source.y;
    const tx = d.target.x, ty = d.target.y;
    const dx = tx - sx, dy = ty - sy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const r1 = nodeRadius(d.source), r2 = nodeRadius(d.target);
    this.setAttribute('x1', sx + (dx / dist) * r1);
    this.setAttribute('y1', sy + (dy / dist) * r1);
    this.setAttribute('x2', tx - (dx / dist) * r2);
    this.setAttribute('y2', ty - (dy / dist) * r2);
  });
  state.svgNodes?.each(function (d) {
    this.setAttribute('cx', d.x);
    this.setAttribute('cy', d.y);
  });
  state.svgCloudNodes?.each(function (d) {
    this.setAttribute('transform', `translate(${d.x},${d.y})`);
  });
  state.svgLabels?.each(function (d) {
    const below = d.isFolderCluster || d.isFileCluster;
    const y = below ? d.y + nodeRadius(d) + 6
      : (d.isCluster || d.isSynthetic) ? d.y
      : d.y + nodeRadius(d) + 10;
    this.setAttribute('x', d.x);
    this.setAttribute('y', y);
    // Multi-line (name + count) labels: each tspan needs its own x to stay centered.
    for (let i = 0; i < this.children.length; i++) {
      this.children[i].setAttribute('x', d.x);
    }
  });
  state.svgLibNodes?.each(function (d) {
    const r = nodeRadius(d);
    this.setAttribute('transform', `translate(${d.x - r},${d.y - r})`);
  });
  state.svgLibLabels?.each(function (d) {
    this.setAttribute('x', d.x);
    this.setAttribute('y', d.y + nodeRadius(d) + 10);
  });

  // Auto-fit once after initial settling
  if (!state.hasFitted && state.simulation && state.simulation.alpha() < 0.1) {
    state.hasFitted = true;
    fitToView();
  }

  if (state.viewMode === 'workflow') { updateWorkflowDivider(); }
  // One visibility pass per tick, shared by every overlay (was 3× per tick).
  const needsVis = state.svgFileCircles || state.svgDrilldownBoxes
    || (state.classMode && state.svgClassBubbles);
  const vis = needsVis ? getVisibleNodeIds() : null;
  tickFileCircles(vis);     // global from folder.js (file circles — overlay AND drill-down)
  tickFolderOverlay();      // global from folder.js (connect/class folder bubbles)
  tickDrilldownBoxes(vis);  // global from drilldown.js (file-mode folder boxes)
  tickClassOverlay(vis);    // global from class.js
  if (__perfT0) { perfTick(perfNow() - __perfT0); }
}

// perf.js span helpers, safe when perf.js is not loaded (unit tests).
function __pb() { return (typeof perfBegin === 'function') ? perfBegin() : 0; }
function __pe(name, t0) { if (t0) { perfEnd(name, t0); } }

// ── Node event handlers ───────────────────────────────────────────────────────
// Link highlighting is O(degree): hoverIndex.js toggles one class on the root
// <g> (dims every link via CSS) plus a class on the hovered node's own links.
const __hover = (typeof createHoverIndex === 'function') ? createHoverIndex() : null;

function hoverLinksOn(d, hlWidth) {
  if (!__hover) { return; }
  __hover.sync(state.svgLinks, state.svgLabels);
  __hover.highlight(g.node(), d.id, hlWidth);
}

function hoverLinksOff() {
  if (__hover) { __hover.clear(); }
}

function hoverLabelSel(d, on) {
  const el = __hover ? __hover.labelOf(d.id) : null;
  // Labels layer parked by the zoom LOD (frameRender W3): lend the label to its frame.
  if (el && on !== undefined && typeof borrowHoverLabel === 'function') { borrowHoverLabel(el, d._frame, on); }
  return el ? d3.select(el) : null;
}

function hoverCrossLinks(id) {
  if (id != null && !(typeof usesFrames === 'function' && usesFrames())) { return; }
  if (id == null && !state._frameHoverId) { return; }
  state._frameHoverId = id;
  if (typeof updateCrossHover === 'function') { updateCrossHover(); }
}

function onNodeMouseOver(event, d) {
  const __t0 = __pb();
  hoverCrossLinks(d.id);
  d3.select(event.currentTarget)
    .style('fill', getCSSVar('--cograph-node-hover'))
    .attr('r', nodeRadius(d) * 1.15)
    .attr('filter', 'url(#glow-hover)');
  hoverLinksOn(d, Math.max(1.5, settings.linkThickness));
  hoverLabelSel(d, true)
    ?.style('opacity', 1)
    .attr('font-size', `${11.5 * settings.textSize}px`)
    .attr('fill', getCSSVar('--cograph-label-hover'));
  __pe('hover:over', __t0);
}

function onNodeMouseOut(event, d) {
  const __t0 = __pb();
  hoverCrossLinks(null);
  d3.select(event.currentTarget)
    .style('fill', resolveNodeFill(d))
    .attr('r', nodeRadius(d))
    .attr('filter', glowAttr());
  hoverLinksOff();
  hoverLabelSel(d, false)
    ?.style('opacity', state.currentZoom >= settings.textFadeThreshold ? 1 : 0)
    .attr('font-size', `${(d.isSynthetic ? 12 : 9) * settings.textSize}px`)
    .attr('fill', (d.isCluster || d.isSynthetic) ? getCSSVar('--cograph-label-cluster') : getCSSVar('--cograph-label-default'));
  __pe('hover:out', __t0);
}

function onCloudMouseOver(event, d) {
  const __t0 = __pb();
  hoverCrossLinks(d.id);
  d3.select(event.currentTarget)
    .style('fill', getCSSVar('--cograph-node-hover'))
    .attr('filter', 'url(#glow-hover)')
    .transition().duration(120)
    .attr('d', generateNodeShapePath(d, nodeRadius(d) * 1.15));
  hoverLinksOn(d, Math.max(1.5, settings.linkThickness));
  hoverLabelSel(d, true)
    ?.style('opacity', 1)
    .attr('font-size', `${11.5 * settings.textSize}px`)
    .attr('fill', getCSSVar('--cograph-label-hover'));
  __pe('hover:over', __t0);
}

function onCloudMouseOut(event, d) {
  const __t0 = __pb();
  hoverCrossLinks(null);
  d3.select(event.currentTarget)
    .style('fill', resolveClusterFill(d))
    .attr('filter', glowAttr())
    .transition().duration(120)
    .attr('d', generateNodeShapePath(d, nodeRadius(d)));
  hoverLinksOff();
  hoverLabelSel(d, false)
    ?.style('opacity', state.currentZoom >= settings.textFadeThreshold ? 1 : 0)
    .attr('font-size', `${(d.isSynthetic ? 12 : 9) * settings.textSize}px`)
    .attr('fill', getCSSVar('--cograph-label-cluster'));
  __pe('hover:out', __t0);
}

// ── Render sub-functions ──────────────────────────────────────────────────────
function prepareRenderData(elements, positionHints = new Map()) {
  const nodeData = elements.filter(e => e.data.source === undefined);
  const edgeData = elements.filter(e => e.data.source !== undefined);

  state.connectedNodeIds = new Set();
  edgeData.forEach(e => {
    state.connectedNodeIds.add(e.data.source);
    state.connectedNodeIds.add(e.data.target);
  });

  const oldPositions = new Map(state.currentNodes.map(n => [n.id, { x: n.x, y: n.y }]));
  const svgEl = svg.node();
  const W = svgEl.clientWidth || window.innerWidth;
  const H = svgEl.clientHeight || window.innerHeight;

  state.currentNodes = nodeData.map(e => ({
    ...e.data,
    x: oldPositions.get(e.data.id)?.x ?? positionHints.get(e.data.id)?.x ?? W / 2 + (Math.random() - 0.5) * 200,
    y: oldPositions.get(e.data.id)?.y ?? positionHints.get(e.data.id)?.y ?? H / 2 + (Math.random() - 0.5) * 200,
  }));

  const allLinks = edgeData.map(e => ({
    source: e.data.source,
    target: e.data.target,
    isLibraryEdge: e.data.isLibraryEdge ?? false,
    _count: e.data._count ?? 1,
    pending: e.data.pending ?? false,
  }));
  const visibleSet = getVisibleNodeIds();
  return { allLinks, visibleSet };
}

// Aggregated-edge thickness: grows sub-linearly with the number of underlying calls.
function edgeWeightScale(count) {
  return 1 + Math.log2(Math.max(1, count || 1)) * 0.6;
}

function renderLinks(allLinks, visibleSet, parent = linkG) {
  return parent.selectAll('line')
    .data(allLinks)
    .join('line')
    .attr('stroke', d => d.isLibraryEdge ? getCSSVar('--cograph-link-library') : getCSSVar('--cograph-link-default'))
    .attr('stroke-dasharray', d => d.isLibraryEdge ? '6,3' : (d.pending ? '4,3' : null))
    .attr('stroke-width', d => settings.linkThickness * edgeWeightScale(d._count))
    .attr('opacity', d => d.pending ? 0.4 : 0.7)
    .attr('marker-end', settings.arrows ? 'url(#arrow)' : null)
    .each(function(d) {
      // Tooltip for aggregated edges (folder/file clusters); skipped for plain 1-call edges.
      let t = this.querySelector('title');
      if (d._count > 1 || d.pending) {
        if (!t) { t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); this.appendChild(t); }
        t.textContent = d.pending ? `${d._count}+ calls (parsing…)` : `${d._count} calls`;
      } else if (t) {
        t.remove();
      }
    })
    .style('display', d => (visibleSet.has(d.source) && visibleSet.has(d.target)) ? null : 'none');
}

function renderNodes(visibleSet, nodes = state.currentNodes, parent = nodeG) {
  return parent.selectAll('circle.regular-node')
    .data(nodes.filter(n => !n.isLibrary && !n.isCluster && !n.isSynthetic && !n.isFileAnchor), d => d.id)
    .join(
      enter => enter.append('circle').attr('class', 'regular-node'),
      update => update,
      exit => exit.remove()
    )
    .attr('r', d => nodeRadius(d))
    .style('fill', d => resolveNodeFill(d))
    .attr('stroke', d => resolveNodeStroke(d))
    .attr('stroke-width', d => resolveNodeStrokeWidth(d))
    .attr('filter', glowAttr())
    .attr('cursor', 'pointer')
    .style('display', d => visibleSet.has(d.id) ? null : 'none')
    .call(drag)
    .on('click', (event, d) => {
      event.stopPropagation();
      if (settings.openFunctionPopup) {
        showFuncPopup(d);
      } else if (d.file && d.line > 0) {
        vscode.postMessage({ type: 'navigate', file: d.file, line: d.line });
      }
    })
    .on('mouseover', onNodeMouseOver)
    .on('mouseout', onNodeMouseOut);
}

function renderCloudNodes(visibleSet, nodes = state.currentNodes, parent = nodeG) {
  const currentIds = new Set(state.currentNodes.map(n => n.id));
  return parent.selectAll('path.cloud-node')
    .data(nodes.filter(n => (n.isCluster || n.isSynthetic) && !n.isLibrary), d => d.id)
    .join(
      // No fade/morph transitions: a folder click triggers several rapid re-renders
      // (expand → parse spinner → graph-patch) that interrupt them, leaving cloud
      // nodes stuck at partial/zero opacity (a folder vanishing or dimming). Set
      // opacity and shape directly so a node is always fully drawn.
      enter => enter.append('path').attr('class', 'cloud-node')
        .attr('d', d => generateNodeShapePath(d, nodeRadius(d)))
        .style('fill', d => resolveClusterFill(d))
        .attr('filter', glowAttr())
        .attr('cursor', 'pointer')
        .style('display', d => visibleSet.has(d.id) ? null : 'none')
        .style('opacity', 1),
      update => update
        .attr('filter', glowAttr())
        .style('display', d => visibleSet.has(d.id) ? null : 'none')
        .style('fill', d => resolveClusterFill(d))
        .style('opacity', 1)
        .attr('d', d => generateNodeShapePath(d, nodeRadius(d))),
      exit => exit
        .each(function(d) {
          // Only drop the gradient if no surviving node still uses this id — a
          // duplicate DOM element exiting must not delete the real node's fill.
          if (!currentIds.has(d.id)) {
            defs.select('#cograph-lang-grad-' + d.id.replace(/[^a-zA-Z0-9]/g, '_')).remove();
          }
        })
        // Remove immediately. A fade-out transition here gets interrupted by the
        // rapid re-renders that follow a folder click (expand → parse spinner →
        // graph-patch), so its `.remove()` never fires and the exited folder node
        // lingers as a frozen, disconnected duplicate.
        .interrupt()
        .remove()
    )
    .call(drag)
    .on('click', (event, d) => {
      event.stopPropagation();
      if (d.isFolderCluster || d.isFileCluster) {
        if (typeof toggleFileClusterExpand === 'function') { toggleFileClusterExpand(d); }
        return;
      }
      // Collapsed cluster (incl. the detail-0 synthetic root) → expand on click.
      state.expandedClusters.add(d.id);
      applyComplexity();
    })
    .on('contextmenu', (event, d) => {
      if (!d.isFolderCluster || typeof showContextMenu !== 'function') { return; }
      event.preventDefault();
      event.stopPropagation();
      const fp = d._folderPath;
      const items = [
        { label: `${d.label} (Folder)`, isHeader: true },
        { label: 'Elapse folder',         action: () => { if (typeof elapseFolder === 'function') { elapseFolder(fp); } } },
        { label: 'Only show this folder', action: () => { state.onlyShowFolder = fp; applyStructuralFilters(); ticked(); updateFolderPanel(); } },
        { label: 'Hide folder',           action: () => { state.hiddenFolders.add(fp); applyStructuralFilters(); ticked(); updateFolderPanel(); } },
        { label: 'Go to folder',          action: () => vscode.postMessage({ type: 'navigate', file: fp, line: 1 }) },
      ];
      if (state.hiddenFolders.size > 0 || state.onlyShowFolder) {
        items.push({ label: 'Show all', action: () => { state.hiddenFolders.clear(); state.onlyShowFolder = null; applyStructuralFilters(); ticked(); updateFolderPanel(); } });
      }
      showContextMenu(event, items);
    })
    .on('mouseover', onCloudMouseOver)
    .on('mouseout', onCloudMouseOut);
}

function renderLabels(visibleSet, nodes = state.currentNodes, parent = labelG) {
  return parent.selectAll('text')
    .data(nodes.filter(n => !n.isLibrary && !n.isFileAnchor), d => d.id)
    .join('text')
    .each(function (d) {
      // Folder/file glyphs carry a dim second line with the count (e.g. "23 files").
      // Rebuilt only when the text changed — not on every re-render.
      const sig = `${d.label}\n${d._sub || ''}`;
      if (this.__labelSig === sig) { return; }
      this.__labelSig = sig;
      const t = d3.select(this);
      t.selectAll('tspan').remove();
      t.append('tspan').text(d.label);
      if (d._sub) {
        t.append('tspan').attr('dy', '1.15em').attr('font-size', '0.78em').attr('opacity', 0.6).text(d._sub);
      }
    })
    .attr('font-size', d => `${(d.isSynthetic ? 12 : 9) * settings.textSize}px`)
    .attr('fill', d => (d.isCluster || d.isSynthetic) ? getCSSVar('--cograph-label-cluster') : getCSSVar('--cograph-label-default'))
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', d => (d.isFolderCluster || d.isFileCluster) ? 'hanging' : (d.isCluster || d.isSynthetic) ? 'middle' : 'auto')
    .attr('pointer-events', 'none')
    .style('display', d => visibleSet.has(d.id) ? null : 'none')
    .style('opacity', state.currentZoom >= settings.textFadeThreshold ? 1 : 0)
    .style('text-decoration', d =>
      state.gitMode && (d.gitStatus?.unstaged === 'deleted' || d.gitStatus?.staged === 'deleted') ? 'line-through' : null
    );
}

function startSimulation(allLinks) {
  if (typeof perfMark === 'function') { perfMark('sim:start'); }
  // Workflow mode rebuilds with a fixed-column layout regardless of pendingReheat.
  if (state.viewMode === 'workflow') {
    startWorkflowSimulation(allLinks);
    return;
  }
  // Reuse the existing global simulation on a reanalysis reheat and, above the
  // big-graph threshold, on every re-render (a folder-parse patch otherwise
  // constructs a fresh simulation and re-settles the world).
  const reusable = state.simulation && !state.simulation.isFrameFacade
    && state.simulation._kind === 'global' && state.layoutMode !== 'static';
  if (reusable && (state.pendingReheat || isBigGraph())) {
    const alpha = state.pendingReheat ? 0.1 : 0.3;
    state.pendingReheat = false;
    state.simulation.nodes(state.currentNodes);
    state.simulation.force('link').links(allLinks);
    state.simulation.alpha(alpha).restart();
    return;
  }
  state.pendingReheat = false;
  if (state.simulation) state.simulation.stop();
  const svgEl = svg.node();
  const W = svgEl.clientWidth || window.innerWidth;
  const H = svgEl.clientHeight || window.innerHeight;
  state.simulation = d3.forceSimulation(state.currentNodes)
    .force('link', d3.forceLink(allLinks).id(d => d.id)
      // Folder/file aggregated edges pull weakly and rest farther apart, so folders
      // separate instead of clumping; function-level edges keep full strength.
      .distance(d => isFolderLink(d) ? 120 : (settings.linkDistance ?? 40))
      .strength(d => {
        if (d.isLibraryEdge) { return settings.linkForce * 0.1 * 0.3; }
        return isFolderLink(d) ? settings.linkForce * 0.1 * 0.25 : settings.linkForce * 0.1;
      }))
    .force('charge', d3.forceManyBody().strength(chargeStrength).distanceMax(settings.repelRange ?? Infinity))
    .force('center', d3.forceCenter(W / 2, H / 2).strength(0.001))
    .force('x', d3.forceX(W / 2).strength(settings.centerForce))
    .force('y', d3.forceY(H / 2).strength(settings.centerForce))
    .force('collision', d3.forceCollide(d => nodeRadius(d) + (settings.collidePad ?? 1.5)))
    .velocityDecay(settings.velocityDecay ?? 0.3)
    .alphaDecay(isBigGraph() ? 0.04 : 0.02)
    .on('tick', ticked)
    .on('end', () => { if (typeof perfSettled === 'function') { perfSettled(); } });
  state.simulation._kind = 'global';
  if (state.layoutMode === 'static') {
    staticBootFreeze(state.simulation, state.currentNodes, isBigGraph() ? 60 : 150);
    ticked();
    // Fit AFTER the frozen positions exist (F4): the async auto-fit in
    // tickedNow can run against a pre-settle bbox, and a static simulation
    // never ticks again to correct it.
    state.hasFitted = true;
    if (!state.userZoomed) { fitToView(); }
  }
}

/** Static boot on the global engine: the classic Static toggle assumed a
 *  prior dynamic settle — do a bounded synchronous settle, then freeze
 *  every node where it landed. */
function staticBootFreeze(sim, nodes, maxTicks) {
  sim.stop();
  for (let i = 0; i < maxTicks && sim.alpha() > 0.05; i++) {
    sim.tick();
  }
  nodes.forEach(d => { d.fx = d.x; d.fy = d.y; });
}

const WORKFLOW_MARGIN_X = 90;

// Left→right layered layout: each node's x is pinned to its pipeline column; the
// simulation only spreads nodes vertically (charge + collision) within a column.
function startWorkflowSimulation(allLinks) {
  state.pendingReheat = false;
  if (state.simulation) state.simulation.stop();
  const svgEl = svg.node();
  const W = svgEl.clientWidth || window.innerWidth;
  const H = svgEl.clientHeight || window.innerHeight;
  const stageCount = state.workflowStageCount || 1;
  state.currentNodes.forEach(d => {
    d.fx = computeColumnX(d._stage ?? 0, stageCount, W, WORKFLOW_MARGIN_X);
    d.fy = null;
    if (!Number.isFinite(d.y)) { d.y = H / 2 + (Math.random() - 0.5) * 200; }
  });
  state.simulation = d3.forceSimulation(state.currentNodes)
    .force('link', d3.forceLink(allLinks).id(d => d.id).distance(40).strength(0.02))
    .force('charge', d3.forceManyBody().strength(-40))
    .force('y', d3.forceY(H / 2).strength(0.06))
    .force('collision', d3.forceCollide(d => nodeRadius(d) + 4))
    .velocityDecay(0.4)
    .alphaDecay(0.03)
    .on('tick', ticked)
    .on('end', () => { if (typeof perfSettled === 'function') { perfSettled(); } });
  state.simulation._kind = 'workflow';
}

// Vertical dotted line dividing backend (left) from frontend (right), with captions.
function updateWorkflowDivider() {
  if (state.viewMode !== 'workflow') { dividerG.selectAll('*').remove(); return; }
  const svgEl = svg.node();
  const W = svgEl.clientWidth || window.innerWidth;
  const stageCount = state.workflowStageCount || 1;
  const x = computeColumnX((state.workflowDividerStage ?? stageCount) - 0.5, stageCount, W, WORKFLOW_MARGIN_X);
  const stroke = getCSSVar('--cograph-label-cluster') || '#888';

  dividerG.selectAll('line.wf-divider-line')
    .data([x])
    .join('line')
    .attr('class', 'wf-divider-line')
    .attr('x1', d => d).attr('x2', d => d)
    .attr('y1', -100000).attr('y2', 100000)
    .attr('stroke', stroke)
    .attr('stroke-width', 1.5)
    .attr('stroke-dasharray', '8,6')
    .attr('opacity', 0.5)
    .attr('pointer-events', 'none');

  let minY = Infinity;
  state.currentNodes.forEach(n => { if (Number.isFinite(n.y)) { minY = Math.min(minY, n.y); } });
  const capY = (Number.isFinite(minY) ? minY : 0) - 30;
  dividerG.selectAll('text.wf-divider-cap')
    .data([{ t: 'Backend', dx: -10, a: 'end' }, { t: 'Frontend', dx: 10, a: 'start' }])
    .join('text')
    .attr('class', 'wf-divider-cap')
    .attr('x', d => x + d.dx)
    .attr('y', capY)
    .attr('text-anchor', d => d.a)
    .attr('fill', stroke)
    .attr('font-size', `${11 * settings.textSize}px`)
    .attr('opacity', 0.7)
    .attr('pointer-events', 'none')
    .text(d => d.t);
}

function renderLibraryNodes(libNodeData, visibleSet) {
  return libNodeG.selectAll('use')
    .data(libNodeData, d => d.id)
    .join(
      enter => enter.append('use')
        .attr('href', '#icon-book')
        .attr('x', 0)
        .attr('y', 0)
        .each(function(d) {
          d3.select(this).append('title').text(
            d.isLibCluster
              ? `${d.libraryName} — ${d._count} function${d._count === 1 ? '' : 's'} — click to expand`
              : `${d.libraryName}::${d.name}`
          );
        }),
      update => update,
      exit => exit.remove()
    )
    .attr('width', d => nodeRadius(d) * 2)
    .attr('height', d => nodeRadius(d) * 2)
    .attr('fill', () => getCSSVar('--cograph-node-library'))
    .attr('cursor', 'pointer')
    .style('display', d => visibleSet.has(d.id) ? null : 'none')
    .on('click', (event, d) => {
      event.stopPropagation();
      if (d.isLibCluster) {
        state.expandedLibClusters.add(d.libraryName);
        applyComplexity();
      } else {
        showLibDocPopup(d);
      }
    })
    .on('mouseover', (event, d) => {
      d3.select(event.currentTarget).attr('fill', getCSSVar('--cograph-node-hover'));
      hoverLinksOn(d, null); // library hover recolours + dims, widths stay
    })
    .on('mouseout', (event) => {
      d3.select(event.currentTarget).attr('fill', getCSSVar('--cograph-node-library'));
      hoverLinksOff();
    });
}

function renderLibraryLabels(libNodeData, visibleSet) {
  return libLabelG.selectAll('text')
    .data(libNodeData, d => d.id)
    .join('text')
    .text(d => d.isLibCluster ? d.label : `${d.libraryName}.${d.name}`)
    .attr('font-size', d => `${9 * settings.textSize}px`)
    .attr('text-anchor', 'middle')
    .attr('pointer-events', 'none')
    .style('display', d => visibleSet.has(d.id) ? null : 'none')
    .style('opacity', state.currentZoom >= settings.textFadeThreshold ? 1 : 0);
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderElements(elements, positionHints = new Map()) {
  if (typeof perfMark === 'function') { perfMark('render:start'); }
  if (typeof invalidateCssVars === 'function') { invalidateCssVars(); }
  // W3: culled frames / parked LOD layers go back into the document first —
  // the d3 joins below only see attached elements.
  if (typeof restoreFrameDom === 'function') { restoreFrameDom(); }
  const { allLinks, visibleSet } = prepareRenderData(elements, positionHints);
  if (typeof usesFrames === 'function' && usesFrames()) {
    renderFrameLayout(allLinks, visibleSet);
  } else {
    if (typeof teardownFrames === 'function') { teardownFrames(); }
    renderGlobalLayout(allLinks, visibleSet);
  }
  if (state.gitMode) applyGitColors();
  updateWorkflowDivider();
  if (typeof perfMeasure === 'function') { perfMeasure('renderElements', 'render:start'); }
}

// The pre-frames render path, verbatim (single global simulation + overlays).
function renderGlobalLayout(allLinks, visibleSet) {
  state.svgLinks = renderLinks(allLinks, visibleSet);
  state.svgNodes = renderNodes(visibleSet);
  state.svgCloudNodes = renderCloudNodes(visibleSet);
  state.svgLabels = renderLabels(visibleSet);
  const libNodeData = state.currentNodes.filter(n => n.isLibrary);
  state.svgLibNodes = renderLibraryNodes(libNodeData, visibleSet);
  state.svgLibLabels = renderLibraryLabels(libNodeData, visibleSet);
  startSimulation(allLinks);
  if (typeof isDrilldown === 'function' && isDrilldown()) {
    // File (drill-down) mode: boxes around each opened folder's contents.
    // Boxes/circles/forces are the drill-down's structure, not an overlay —
    // state.folderMode only governs the legacy folder-bubble overlay below.
    folderG.selectAll('*').remove();   // drop any stale function-overlay bubbles + their drag handlers
    const boxes = buildDrilldownBoxData();
    state.svgDrilldownBoxes = renderDrilldownBoxes(boxes);
    state.simulation?.force('drilldownCluster', createDrilldownClusterForce(boxes));
    state.simulation?.force('drilldownSeparation', createDrilldownSeparationForce());
    // File circles around the visible function nodes (same look + options as the
    // legacy overlay: filename, fn count, drag, dbl-click & right-click menu).
    const ddNodesByFile = groupByFile(state.currentNodes);
    state.svgFileCircles = renderFileCircles(fileG, ddNodesByFile);
    state.svgFileCircles.each(function() {
      d3.select(this).select('.file-circle-shape')
        .attr('stroke-width', 1.5).attr('stroke-dasharray', '6,3')
        .attr('pointer-events', 'all').attr('cursor', 'grab');
      d3.select(this).select('.file-circle-label')
        .attr('font-size', `${11 * settings.textSize}px`).attr('text-anchor', 'middle')
        .attr('font-weight', '600').attr('pointer-events', 'none');
    });
    state.svgFileCircles.call(createFileDrag()).on('mousemove', onFileHoverMove);
    state.svgFolderBubbles = null;
    state.simulation?.force('fileCluster', createFileClusterForce(ddNodesByFile));
    state.simulation?.force('fileSeparation', createFileSeparationForce(ddNodesByFile));
    state.simulation?.force('folderSeparation', null);
  } else if (state.folderMode && state.viewMode !== 'workflow') {
    state.svgDrilldownBoxes = null;
    state.simulation?.force('drilldownCluster', null);
    state.simulation?.force('drilldownSeparation', null);
    const nodesByFile    = groupByFile(state.currentNodes);
    const folderTree     = buildFolderTree(nodesByFile);
    computeFolderHues(folderTree);

    state.svgFileCircles   = renderFileCircles(fileG, nodesByFile);
    state.svgFolderBubbles = renderFolderBubbles(folderG, folderTree, nodesByFile);

    // One-time static attrs — colors set each tick via tickFolderOverlay
    state.svgFileCircles.each(function() {
      d3.select(this).select('.file-circle-shape')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '6,3')
        .attr('pointer-events', 'all')
        .attr('cursor', 'grab');
      d3.select(this).select('.file-circle-label')
        .attr('font-size', `${11 * settings.textSize}px`).attr('text-anchor', 'middle')
        .attr('font-weight', '600').attr('pointer-events', 'none');
    });
    state.svgFolderBubbles.each(function(d) {
      d3.select(this).select('.folder-bubble-shape')
        .attr('stroke-width', 1.5).attr('pointer-events', 'all');
      d3.select(this).select('.folder-bubble-titlebar')
        .attr('pointer-events', 'all').attr('cursor', 'grab');
      d3.select(this).select('.frame-tab-glyph')
        .attr('fill', isLightTheme() ? '#333333' : '#cccccc');
      d3.select(this).select('.frame-tab-counts')
        .attr('fill', isLightTheme() ? '#333333' : '#cccccc');
      d3.select(this).select('.folder-bubble-label')
        .attr('font-size', `${12 * settings.textSize}px`)
        .attr('text-anchor', 'start').attr('font-weight', '600')
        .attr('dominant-baseline', 'central')
        .attr('fill', isLightTheme() ? '#333333' : '#cccccc').attr('pointer-events', 'none');
    });

    state.svgFileCircles.call(createFileDrag()).on('mousemove', onFileHoverMove);
    state.svgFolderBubbles.select('.folder-bubble-titlebar').call(createFolderDrag());
    state.svgFolderBubbles.select('.folder-bubble-shape').call(createFolderResizeDrag());
    state.svgFolderBubbles.on('mousemove', onFolderHoverMove);

    state.simulation.force('fileCluster', createFileClusterForce(nodesByFile));
    state.simulation.force('fileSeparation', createFileSeparationForce(nodesByFile));
    state.simulation.force('folderSeparation', createFolderSeparationForce(folderTree, nodesByFile));
  } else {
    fileG.selectAll('*').remove();
    folderG.selectAll('*').remove();
    state.svgFileCircles   = null;
    state.svgFolderBubbles = null;
    state.svgDrilldownBoxes = null;
    state.simulation?.force('fileCluster', null);
    state.simulation?.force('fileSeparation', null);
    state.simulation?.force('folderSeparation', null);
    state.simulation?.force('drilldownCluster', null);
    state.simulation?.force('drilldownSeparation', null);
  }
  if (state.classMode && state.viewMode !== 'workflow') {
    const classByKey = groupByClass(state.currentNodes);  // global from class.js
    state.svgClassBubbles = renderClassBubbles(classG, classByKey);

    state.svgClassBubbles.each(function(d) {
      d3.select(this).select('.class-bubble-shape')
        .attr('rx', 8).attr('stroke-width', 1.5).attr('pointer-events', 'all');
      d3.select(this).select('.class-bubble-titlebar')
        .attr('pointer-events', 'all').attr('cursor', 'grab');
      d3.select(this).select('.class-bubble-label')
        .attr('font-size', `${11 * settings.textSize}px`)
        .attr('text-anchor', 'middle').attr('font-weight', '600')
        .attr('fill', '#cccccc').attr('pointer-events', 'none');
    });

    state.svgClassBubbles.select('.class-bubble-titlebar').call(createClassDrag());
    state.svgClassBubbles.select('.class-bubble-shape').call(createClassResizeDrag());

    state.simulation?.force('classCluster', createClassClusterForce(classByKey));
  } else {
    classG.selectAll('*').remove();
    state.svgClassBubbles = null;
    state.simulation?.force('classCluster', null);
  }

}
