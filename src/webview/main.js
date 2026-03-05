const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────────────────────
const settings = {
  existingFilesOnly: false,
  showOrphans: true,
  groupByFile: false,
  arrows: true,
  textFadeThreshold: 0.5,
  nodeSize: 1.0,
  linkThickness: 1,
  centerForce: 0.1,
  repelForce: 2048,
  linkForce: 1,
  linkDistance: 40,
};

let graphData = null;
let complexityLevel = 1.0;
let _importanceScores = null;
let _clusterTimer = null;
let _expandedClusters = new Set();
let _connectedNodeIds = new Set();

let simulation = null;
let svgNodes = null;
let svgLinks = null;
let svgLabels = null;
let currentNodes = [];
let currentZoom = 1;
let _hasFitted = false;
let layoutMode = 'dynamic'; // 'dynamic' | 'static'

// ── SVG setup ─────────────────────────────────────────────────────────────────
const svg = d3.select('#graph')
  .append('svg')
  .attr('width', '100%')
  .attr('height', '100%');

const defs = svg.append('defs');

// Arrow marker
defs.append('marker')
  .attr('id', 'arrow')
  .attr('viewBox', '0 -5 10 10')
  .attr('refX', 10)
  .attr('refY', 0)
  .attr('markerWidth', 4)
  .attr('markerHeight', 4)
  .attr('orient', 'auto')
  .append('path')
  .attr('d', 'M0,-5L10,0L0,5')
  .attr('fill', 'rgba(160,160,160,0.6)');

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

// Transform groups
const g = svg.append('g');
const linkG = g.append('g').attr('class', 'links');
const nodeG = g.append('g').attr('class', 'nodes');
const labelG = g.append('g').attr('class', 'labels');

// ── Zoom ──────────────────────────────────────────────────────────────────────
const zoomBehavior = d3.zoom()
  .scaleExtent([0.02, 10])
  .on('zoom', (event) => {
    g.attr('transform', event.transform);
    currentZoom = event.transform.k;
    updateTextVisibility();
  });

svg.call(zoomBehavior);
svg.on('dblclick.zoom', null); // Remove D3's default dblclick-to-zoom
svg.on('dblclick', (event) => {
  if (event.target.tagName !== 'circle') fitToView();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function nodeRadius(d) {
  return ((d._size ?? 6) / 2) * settings.nodeSize;
}

function nodeColor(d) {
  if (d.isSynthetic) return 'var(--vscode-button-background, #0e639c)';
  if (d.isOrphanCluster) return '#555';
  if (d.isCluster) return '#7c4dbb';
  if (d.isEntryPoint) return '#e8734a';
  return '#d4d4d4';
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

function updateTextVisibility() {
  if (!svgLabels) return;
  svgLabels.style('opacity', currentZoom >= settings.textFadeThreshold ? 1 : 0);
}

function fitToView() {
  if (!currentNodes.length) return;
  const xs = currentNodes.map(n => n.x).filter(v => v != null && isFinite(v));
  const ys = currentNodes.map(n => n.y).filter(v => v != null && isFinite(v));
  if (!xs.length) return;
  const svgEl = svg.node();
  const W = svgEl.clientWidth || window.innerWidth;
  const H = svgEl.clientHeight || window.innerHeight;
  const pad = 60;
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const scale = Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxY - minY || 1), 4);
  svg.transition().duration(500).call(
    zoomBehavior.transform,
    d3.zoomIdentity
      .translate(W / 2 - scale * (minX + maxX) / 2, H / 2 - scale * (minY + maxY) / 2)
      .scale(scale)
  );
}

// ── Layout mode toggle ────────────────────────────────────────────────────────
function setLayoutMode(mode) {
  layoutMode = mode;
  document.getElementById('btn-layout-dynamic')?.classList.toggle('active', mode === 'dynamic');
  document.getElementById('btn-layout-static')?.classList.toggle('active', mode === 'static');
  const forcesSection = document.getElementById('forces-section');
  if (forcesSection) forcesSection.style.opacity = mode === 'dynamic' ? '1' : '0.4';

  if (mode === 'static') {
    if (simulation) {
      simulation.stop();
      currentNodes.forEach(d => { d.fx = d.x; d.fy = d.y; });
    }
  } else {
    currentNodes.forEach(d => { d.fx = null; d.fy = null; });
    if (simulation) simulation.alpha(0.3).restart();
  }
}

// ── Drag (swimming effect) ────────────────────────────────────────────────────
const drag = d3.drag()
  .on('start', (event, d) => {
    if (layoutMode === 'dynamic' && !event.active && simulation)
      simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  })
  .on('drag', (event, d) => {
    d.fx = event.x;
    d.fy = event.y;
    if (layoutMode === 'static') {
      // Simulation stopped — sync x/y directly so ticked() renders correctly
      d.x = event.x;
      d.y = event.y;
      ticked();
    }
  })
  .on('end', (event, d) => {
    if (layoutMode === 'dynamic') {
      if (!event.active && simulation) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null; // release — node rejoins simulation
    }
    // static: keep fx/fy pinned so node stays exactly where dropped
  });

// ── Tick ──────────────────────────────────────────────────────────────────────
function ticked() {
  svgLinks?.each(function (d) {
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
  svgNodes?.each(function (d) {
    this.setAttribute('cx', d.x);
    this.setAttribute('cy', d.y);
  });
  svgLabels?.each(function (d) {
    this.setAttribute('x', d.x);
    this.setAttribute('y', (d.isCluster || d.isSynthetic) ? d.y : d.y + nodeRadius(d) + 10);
  });

  // Auto-fit once after initial settling
  if (!_hasFitted && simulation && simulation.alpha() < 0.1) {
    _hasFitted = true;
    fitToView();
  }
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderElements(elements) {
  const nodeData = elements.filter(e => e.data.source === undefined);
  const edgeData = elements.filter(e => e.data.source !== undefined);

  // Track connected nodes for orphan filtering
  _connectedNodeIds = new Set();
  edgeData.forEach(e => {
    _connectedNodeIds.add(e.data.source);
    _connectedNodeIds.add(e.data.target);
  });

  // Preserve positions from previous render
  const oldPositions = new Map(currentNodes.map(n => [n.id, { x: n.x, y: n.y }]));
  const svgEl = svg.node();
  const W = svgEl.clientWidth || window.innerWidth;
  const H = svgEl.clientHeight || window.innerHeight;

  currentNodes = nodeData.map(e => ({
    ...e.data,
    x: oldPositions.get(e.data.id)?.x ?? W / 2 + (Math.random() - 0.5) * 200,
    y: oldPositions.get(e.data.id)?.y ?? H / 2 + (Math.random() - 0.5) * 200,
  }));

  // Fresh link copies — D3 will mutate source/target to node objects
  const allLinks = edgeData.map(e => ({ source: e.data.source, target: e.data.target }));

  const visibleSet = getVisibleNodeIds();

  // ── Links ──
  svgLinks = linkG.selectAll('line')
    .data(allLinks)
    .join('line')
    .attr('stroke', 'rgba(160,160,160,0.25)')
    .attr('stroke-width', settings.linkThickness)
    .attr('opacity', 0.7)
    .attr('marker-end', settings.arrows ? 'url(#arrow)' : null)
    .style('display', d => (visibleSet.has(d.source) && visibleSet.has(d.target)) ? null : 'none');

  // ── Nodes ──
  svgNodes = nodeG.selectAll('circle')
    .data(currentNodes, d => d.id)
    .join('circle')
    .attr('r', d => nodeRadius(d))
    .style('fill', d => nodeColor(d))
    .attr('stroke', d => settings.groupByFile ? fileColor(d.file) : 'none')
    .attr('stroke-width', 2)
    .attr('filter', 'url(#glow)')
    .attr('cursor', 'pointer')
    .style('display', d => visibleSet.has(d.id) ? null : 'none')
    .call(drag)
    .on('click', (event, d) => {
      event.stopPropagation();
      if (d.isSynthetic) return;
      if (d.isCluster) {
        _expandedClusters.add(d.id);
        applyComplexity();
        return;
      }
      vscode.postMessage({ type: 'navigate', file: d.file, line: d.line });
    })
    .on('mouseover', (event, d) => {
      d3.select(event.currentTarget)
        .style('fill', '#7eb9ff')
        .attr('r', nodeRadius(d) * 1.15)
        .attr('filter', 'url(#glow-hover)');
      svgLinks
        ?.attr('stroke', l => (l.source?.id ?? l.source) === d.id || (l.target?.id ?? l.target) === d.id
          ? '#5aabff' : 'rgba(160,160,160,0.25)')
        .attr('stroke-width', l => (l.source?.id ?? l.source) === d.id || (l.target?.id ?? l.target) === d.id
          ? Math.max(1.5, settings.linkThickness) : settings.linkThickness)
        .attr('opacity', l => (l.source?.id ?? l.source) === d.id || (l.target?.id ?? l.target) === d.id
          ? 1 : 0.15);
      svgLabels?.filter(l => l.id === d.id)
        .style('opacity', 1)
        .attr('font-size', '11.5px')
        .attr('fill', '#ffffff');
    })
    .on('mouseout', (event, d) => {
      d3.select(event.currentTarget)
        .style('fill', nodeColor(d))
        .attr('r', nodeRadius(d))
        .attr('filter', 'url(#glow)');
      svgLinks
        ?.attr('stroke', 'rgba(160,160,160,0.25)')
        .attr('stroke-width', settings.linkThickness)
        .attr('opacity', 0.7);
      svgLabels?.filter(l => l.id === d.id)
        .style('opacity', currentZoom >= settings.textFadeThreshold ? 1 : 0)
        .attr('font-size', d.isSynthetic ? '12px' : '9px')
        .attr('fill', (d.isCluster || d.isSynthetic) ? '#ffffff' : '#d4d4d4');
    });

  // ── Labels ──
  svgLabels = labelG.selectAll('text')
    .data(currentNodes, d => d.id)
    .join('text')
    .text(d => d.label)
    .attr('font-size', d => d.isSynthetic ? '12px' : '9px')
    .attr('fill', d => (d.isCluster || d.isSynthetic) ? '#ffffff' : '#d4d4d4')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', d => (d.isCluster || d.isSynthetic) ? 'middle' : 'auto')
    .attr('pointer-events', 'none')
    .style('display', d => visibleSet.has(d.id) ? null : 'none')
    .style('opacity', currentZoom >= settings.textFadeThreshold ? 1 : 0);

  // ── Simulation ──
  if (simulation) simulation.stop();
  simulation = d3.forceSimulation(currentNodes)
    .force('link', d3.forceLink(allLinks).id(d => d.id)
      .distance(() => settings.linkDistance)
      .strength(() => settings.linkForce * 0.1))
    .force('charge', d3.forceManyBody().strength(-settings.repelForce))
    .force('center', d3.forceCenter(W / 2, H / 2).strength(settings.centerForce * 0.5))
    .force('collision', d3.forceCollide(d => nodeRadius(d) + 2))
    .velocityDecay(0.3)
    .alphaDecay(0.003)
    .on('tick', ticked);
}

// ── Filters ───────────────────────────────────────────────────────────────────
function getVisibleNodeIds() {
  const query = document.getElementById('search')?.value.toLowerCase() ?? '';
  const visible = new Set();
  currentNodes.forEach(n => {
    if (query && !n.label.toLowerCase().includes(query)) return;
    if (settings.existingFilesOnly && !n.isCluster && !n.isSynthetic) {
      if (!n.file || !n.line || n.line <= 0) return;
    }
    if (!settings.showOrphans && !_connectedNodeIds.has(n.id)) return;
    visible.add(n.id);
  });
  return visible;
}

function applyFilters() {
  if (!svgNodes || !svgLinks || !svgLabels) return;
  const visibleSet = getVisibleNodeIds();
  svgNodes.style('display', d => visibleSet.has(d.id) ? null : 'none');
  svgLabels.style('display', d => visibleSet.has(d.id) ? null : 'none');
  svgLinks.style('display', d => {
    const src = d.source?.id ?? d.source;
    const tgt = d.target?.id ?? d.target;
    return (visibleSet.has(src) && visibleSet.has(tgt)) ? null : 'none';
  });
}

// ── Display settings ──────────────────────────────────────────────────────────
function applyDisplaySettings() {
  if (!svgNodes || !svgLinks || !svgLabels) return;
  svgNodes
    .attr('r', d => nodeRadius(d))
    .attr('stroke', d => settings.groupByFile ? fileColor(d.file) : 'none');
  svgLinks
    .attr('stroke-width', settings.linkThickness)
    .attr('marker-end', settings.arrows ? 'url(#arrow)' : null);
  updateTextVisibility();
}

// ── Layout update ─────────────────────────────────────────────────────────────
function rerunLayout() {
  if (!simulation) return;
  const svgEl = svg.node();
  const W = svgEl.clientWidth || window.innerWidth;
  const H = svgEl.clientHeight || window.innerHeight;
  simulation.force('center', d3.forceCenter(W / 2, H / 2).strength(settings.centerForce * 0.5));
  simulation.force('charge').strength(-settings.repelForce);
  simulation.force('link').strength(settings.linkForce * 0.1).distance(settings.linkDistance);
  simulation.alpha(0.5).restart();
}

// ── Complexity ────────────────────────────────────────────────────────────────
function applyComplexity() {
  if (!graphData || !_importanceScores) return;
  const degreeMap = new Map();
  graphData.nodes.forEach(n => degreeMap.set(n.id, 0));
  graphData.edges.forEach(e => {
    if (e.source === '::MAIN::0') return;
    degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
  });
  const clusterResult = computeClusters(graphData, _importanceScores, complexityLevel);
  const elements = buildClusteredElements(graphData, clusterResult, complexityLevel, _importanceScores, _expandedClusters, degreeMap);
  renderElements(elements);
}

// ── Main entry ────────────────────────────────────────────────────────────────
function renderGraph(data) {
  graphData = data;
  _importanceScores = computeImportanceScores(graphData);
  _expandedClusters = new Set();
  _hasFitted = false;

  const nodeCount = data.nodes.length;
  if (nodeCount > 200) {
    complexityLevel = Math.max(0.1, Math.min(0.9, 200 / nodeCount));
    const slider = document.getElementById('slider-complexity');
    const valEl = document.getElementById('val-complexity');
    if (slider) slider.value = String(complexityLevel);
    if (valEl) valEl.textContent = complexityLevel.toFixed(2);
  }

  applyComplexity();
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'graph') renderGraph(message.data);
});

// ── Settings panel ────────────────────────────────────────────────────────────
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');

settingsBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.toggle('open');
});

document.addEventListener('click', (e) => {
  if (settingsPanel && !settingsPanel.contains(e.target) && e.target !== settingsBtn) {
    settingsPanel.classList.remove('open');
  }
});

// ── Layout mode controls ──────────────────────────────────────────────────────
document.getElementById('btn-layout-dynamic')?.addEventListener('click', () => setLayoutMode('dynamic'));
document.getElementById('btn-layout-static')?.addEventListener('click', () => setLayoutMode('static'));

// ── Filter controls ───────────────────────────────────────────────────────────
document.getElementById('search')?.addEventListener('input', applyFilters);

document.getElementById('toggle-existing')?.addEventListener('change', (e) => {
  settings.existingFilesOnly = e.target.checked;
  applyFilters();
});

document.getElementById('toggle-orphans')?.addEventListener('change', (e) => {
  settings.showOrphans = e.target.checked;
  applyFilters();
});

// ── Group controls ────────────────────────────────────────────────────────────
document.getElementById('toggle-group-file')?.addEventListener('change', (e) => {
  settings.groupByFile = e.target.checked;
  applyDisplaySettings();
});

document.getElementById('toggle-group-flow')?.addEventListener('change', (e) => {
  e.target.checked = false; // Dagre not available in D3 mode
  const notice = document.getElementById('flow-notice');
  if (notice) {
    notice.style.display = 'block';
    setTimeout(() => { notice.style.display = 'none'; }, 3000);
  }
});

// ── Display controls ──────────────────────────────────────────────────────────
document.getElementById('toggle-arrows')?.addEventListener('change', (e) => {
  settings.arrows = e.target.checked;
  applyDisplaySettings();
});

function wireSlider(id, valId, settingsKey, onInput) {
  const slider = document.getElementById(id);
  const valEl = document.getElementById(valId);
  if (!slider) return;
  slider.addEventListener('input', () => {
    settings[settingsKey] = parseFloat(slider.value);
    if (valEl) valEl.textContent = slider.value;
    onInput();
  });
}

wireSlider('slider-text-fade', 'val-text-fade', 'textFadeThreshold', applyDisplaySettings);
wireSlider('slider-node-size', 'val-node-size', 'nodeSize', applyDisplaySettings);
wireSlider('slider-link-thickness', 'val-link-thickness', 'linkThickness', applyDisplaySettings);
wireSlider('slider-center-force', 'val-center-force', 'centerForce', rerunLayout);
wireSlider('slider-repel-force', 'val-repel-force', 'repelForce', rerunLayout);
wireSlider('slider-link-force', 'val-link-force', 'linkForce', rerunLayout);
wireSlider('slider-link-distance', 'val-link-distance', 'linkDistance', rerunLayout);

const complexitySlider = document.getElementById('slider-complexity');
const complexityVal = document.getElementById('val-complexity');
if (complexitySlider) {
  complexitySlider.addEventListener('input', () => {
    complexityLevel = parseFloat(complexitySlider.value);
    if (complexityVal) complexityVal.textContent = complexityLevel.toFixed(2);
    _expandedClusters = new Set();
    clearTimeout(_clusterTimer);
    _clusterTimer = setTimeout(applyComplexity, 80);
  });
}
