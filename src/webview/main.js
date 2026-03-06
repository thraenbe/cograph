const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────────────────────
const settings = {
  existingFilesOnly: false,
  showOrphans: true,
  groupByFile: false,
  arrows: true,
  textFadeThreshold: 0.5,
  nodeSize: 2.5,
  linkThickness: 4,
  centerForce: 1,
  repelForce: 500,
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
  simulation.force('center', d3.forceCenter(W / 2, H / 2).strength(settings.centerForce));
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
