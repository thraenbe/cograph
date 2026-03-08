const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────────────────────
const settings = {
  existingFilesOnly: false,
  showOrphans: true,
  showLibraries: false,
  groupByFile: false,
  arrows: true,
  textFadeThreshold: 0.5,
  nodeSize: 2.5,
  textSize: 1.0,
  linkThickness: 4,
  centerForce: 1,
  repelForce: 500,
  linkForce: 1,
  linkDistance: 40,
};

// ── Library doc popup ─────────────────────────────────────────────────────────
function showLibDocPopup(d) {
  state.activeLibNode = d;
  const docsUrl = d.language === 'python'
    ? `https://docs.python.org/3/library/${d.libraryName.split('.')[0]}`
    : `https://www.npmjs.com/package/${d.libraryName}`;

  document.getElementById('lib-doc-title').textContent = `${d.libraryName}.${d.name}`;
  document.getElementById('lib-doc-lang-badge').textContent = d.language === 'python' ? 'Python' : 'TypeScript';
  document.getElementById('lib-doc-lang-badge').className = `lang-badge lang-badge-${d.language}`;
  document.getElementById('lib-doc-function').textContent = d.name;
  document.getElementById('lib-doc-package').textContent = d.libraryName;
  document.getElementById('lib-doc-url').textContent = docsUrl;

  const descEl = document.getElementById('lib-doc-desc');
  const descRow = document.getElementById('lib-doc-desc-row');
  if (descEl) { descEl.textContent = '…'; }
  if (descRow) { descRow.style.display = 'block'; }

  document.getElementById('lib-doc-popup').style.display = 'flex';
  state.libDescRequestId = Date.now();
  vscode.postMessage({ type: 'get-lib-description', libraryName: d.libraryName, functionName: d.name, language: d.language, reqId: state.libDescRequestId });
}

// ── Layout mode toggle ────────────────────────────────────────────────────────
function setLayoutMode(mode) {
  state.layoutMode = mode;
  document.getElementById('btn-layout-dynamic')?.classList.toggle('active', mode === 'dynamic');
  document.getElementById('btn-layout-static')?.classList.toggle('active', mode === 'static');
  const forcesSection = document.getElementById('forces-section');
  if (forcesSection) forcesSection.style.opacity = mode === 'dynamic' ? '1' : '0.4';

  if (mode === 'static') {
    if (state.simulation) {
      state.simulation.stop();
      state.currentNodes.forEach(d => { d.fx = d.x; d.fy = d.y; });
    }
  } else {
    state.currentNodes.forEach(d => { d.fx = null; d.fy = null; });
    if (state.simulation) state.simulation.alpha(0.3).restart();
  }
}

// ── Filters ───────────────────────────────────────────────────────────────────
function getVisibleNodeIds() {
  const query = document.getElementById('search')?.value.toLowerCase() ?? '';
  const visible = new Set();
  state.currentNodes.forEach(n => {
    if (n.isLibrary) {
      if (!settings.showLibraries) return;
      if (query && !n.label.toLowerCase().includes(query)) return;
      visible.add(n.id);
      return;
    }
    if (query && !n.label.toLowerCase().includes(query)) return;
    if (settings.existingFilesOnly && !n.isCluster && !n.isSynthetic) {
      if (!n.file || !n.line || n.line <= 0) return;
    }
    if (!settings.showOrphans && !state.connectedNodeIds.has(n.id)) return;
    visible.add(n.id);
  });
  return visible;
}

function applyFilters() {
  if (!state.svgNodes || !state.svgLinks || !state.svgLabels) return;
  const visibleSet = getVisibleNodeIds();
  state.svgNodes.style('display', d => visibleSet.has(d.id) ? null : 'none');
  state.svgLabels.style('display', d => visibleSet.has(d.id) ? null : 'none');
  state.svgLibNodes?.style('display', d => visibleSet.has(d.id) ? null : 'none');
  state.svgLibLabels?.style('display', d => visibleSet.has(d.id) ? null : 'none');
  state.svgLinks.style('display', d => {
    const src = d.source?.id ?? d.source;
    const tgt = d.target?.id ?? d.target;
    return (visibleSet.has(src) && visibleSet.has(tgt)) ? null : 'none';
  });
}

// ── Language colors ───────────────────────────────────────────────────────────
const languageColors = {
  python:     '#3572A5',
  typescript: '#3178c6',
};

function getLanguageColor(lang) {
  if (!lang) return null;
  if (languageColors[lang]) return languageColors[lang];
  let hash = 0;
  for (let i = 0; i < lang.length; i++) hash = lang.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${((hash >>> 0) % 360)}, 55%, 55%)`;
}

// ── Git color resolvers ───────────────────────────────────────────────────────
function resolveNodeFill(d) {
  if (state.gitMode && !d.isCluster && !d.isSynthetic && !d.isOrphanCluster && d.gitStatus) {
    const status = d.gitStatus.unstaged ?? d.gitStatus.staged;
    if (status === 'added')    return '#4caf50';
    if (status === 'modified') return '#ff9800';
    if (status === 'deleted')  return '#555';
  }
  if (state.languageMode && !d.isCluster && !d.isSynthetic && !d.isOrphanCluster && d.language) {
    return getLanguageColor(d.language);
  }
  return nodeColor(d);
}

function resolveNodeStroke(d) {
  if (state.gitMode && d.gitStatus?.staged != null && !d.isCluster && !d.isSynthetic)
    return '#ffffff';
  return settings.groupByFile ? fileColor(d.file) : 'none';
}

function resolveNodeStrokeWidth(d) {
  if (state.gitMode && d.gitStatus?.staged != null && !d.isCluster && !d.isSynthetic) return 3;
  return 2;
}

function renderLanguageLegend() {
  const el = document.getElementById('language-legend');
  if (!el) return;
  if (!state.graphData) { el.innerHTML = ''; return; }

  const langs = [...new Set(
    state.graphData.nodes.map(n => n.language).filter(Boolean)
  )].sort();

  if (langs.length === 0) { el.innerHTML = ''; return; }

  el.innerHTML = langs.map(lang => {
    const color = getLanguageColor(lang);
    return `<div class="lang-legend-row">
      <input type="color" class="lang-swatch" data-lang="${lang}" value="${color}" title="Click to change color">
      <span class="lang-label">${lang}</span>
    </div>`;
  }).join('');

  el.querySelectorAll('.lang-swatch').forEach(input => {
    input.addEventListener('input', (e) => {
      languageColors[e.target.dataset.lang] = e.target.value;
      applyGitColors();
    });
  });
}

function applyGitColors() {
  if (!state.svgNodes) return;
  state.svgNodes
    .style('fill', d => resolveNodeFill(d))
    .attr('stroke', d => resolveNodeStroke(d))
    .attr('stroke-width', d => resolveNodeStrokeWidth(d));
  state.svgLabels?.style('text-decoration', d =>
    state.gitMode && (d.gitStatus?.unstaged === 'deleted' || d.gitStatus?.staged === 'deleted') ? 'line-through' : null
  );
  renderLanguageLegend();
}

// ── Display settings ──────────────────────────────────────────────────────────
function applyDisplaySettings() {
  if (!state.svgNodes || !state.svgLinks || !state.svgLabels) return;
  state.svgNodes
    .attr('r', d => nodeRadius(d))
    .attr('stroke', d => resolveNodeStroke(d))
    .attr('stroke-width', d => resolveNodeStrokeWidth(d));
  state.svgLinks
    .attr('stroke-width', settings.linkThickness)
    .attr('marker-end', settings.arrows ? 'url(#arrow)' : null);
  // Update library node dimensions to match new node size
  state.svgLibNodes
    ?.attr('width', d => nodeRadius(d) * 2)
    .attr('height', d => nodeRadius(d) * 2);
  // Reposition links and labels to reflect new node size
  ticked();
  state.svgLabels.attr('font-size', d => {
    const base = d.isSynthetic ? 12 : 9;
    return `${base * settings.textSize}px`;
  });
  updateTextVisibility();
}

// ── Layout update ─────────────────────────────────────────────────────────────
function rerunLayout() {
  if (!state.simulation) return;
  const svgEl = svg.node();
  const W = svgEl.clientWidth || window.innerWidth;
  const H = svgEl.clientHeight || window.innerHeight;
  state.simulation.force('center', d3.forceCenter(W / 2, H / 2).strength(settings.centerForce));
  state.simulation.force('charge').strength(-settings.repelForce);
  state.simulation.force('link').strength(d => d.isLibraryEdge ? settings.linkForce * 0.1 * 0.3 : settings.linkForce * 0.1).distance(settings.linkDistance);
  state.simulation.alpha(0.5).restart();
}

// ── Complexity ────────────────────────────────────────────────────────────────
function applyComplexity() {
  if (!state.graphData || !state.importanceScores) return;
  const projectData = {
    nodes: state.graphData.nodes.filter(n => !n.isLibrary),
    edges: state.graphData.edges.filter(e => !e.isLibraryEdge),
  };
  const degreeMap = new Map();
  projectData.nodes.forEach(n => degreeMap.set(n.id, 0));
  projectData.edges.forEach(e => {
    if (e.source === '::MAIN::0') return;
    degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
  });
  const clusterResult = computeClusters(projectData, state.importanceScores, state.complexityLevel);
  const elements = buildClusteredElements(projectData, clusterResult, state.complexityLevel, state.importanceScores, state.expandedClusters, degreeMap);
  const nodeToRendered = buildRenderedNodeMap(clusterResult.nodeToCluster, state.expandedClusters);
  if (settings.showLibraries) {
    const libNodes = state.graphData.nodes.filter(n => n.isLibrary);
    const libEdges = state.graphData.edges.filter(e => e.isLibraryEdge);
    const libNodeById = new Map(libNodes.map(n => [n.id, n]));

    // Group by package name
    const byPackage = new Map();
    libNodes.forEach(n => {
      if (!byPackage.has(n.libraryName)) byPackage.set(n.libraryName, []);
      byPackage.get(n.libraryName).push(n);
    });

    // At high detail (>= 0.999) or if manually expanded: show individual nodes
    byPackage.forEach((nodes, pkgName) => {
      const expanded = state.complexityLevel >= 0.999 || state.expandedLibClusters.has(pkgName);
      if (expanded) {
        nodes.forEach(n => {
          elements.push({ data: { ...n, label: n.name, _size: 6, isCluster: false, isSynthetic: false, isOrphanCluster: false } });
        });
      } else {
        elements.push({ data: {
          id: `libcluster::${pkgName}`,
          name: pkgName,
          label: `${pkgName} (${nodes.length})`,
          libraryName: pkgName,
          language: nodes[0].language,
          isLibrary: true,
          isLibCluster: true,
          _count: nodes.length,
          _size: 8,
          file: null,
          line: 0,
          isCluster: false,
          isSynthetic: false,
          isOrphanCluster: false,
        }});
      }
    });

    // Emit edges: reroute to cluster id when collapsed, deduplicate
    const seenEdgeKeys = new Set();
    libEdges.forEach(e => {
      const targetNode = libNodeById.get(e.target);
      if (!targetNode) return;
      const pkgName = targetNode.libraryName;
      const expanded = state.complexityLevel >= 0.999 || state.expandedLibClusters.has(pkgName);
      const targetId = expanded ? e.target : `libcluster::${pkgName}`;
      const sourceId = nodeToRendered.get(e.source) ?? e.source;
      const key = `${sourceId}|${targetId}`;
      if (!seenEdgeKeys.has(key)) {
        seenEdgeKeys.add(key);
        elements.push({ data: { source: sourceId, target: targetId, isLibraryEdge: true } });
      }
    });
  }
  renderElements(elements);
}

// ── Main entry ────────────────────────────────────────────────────────────────
function renderGraph(data, isReanalysis = false) {
  state.graphData = data;
  const projectData = { nodes: data.nodes.filter(n => !n.isLibrary), edges: data.edges.filter(e => !e.isLibraryEdge) };
  state.importanceScores = computeImportanceScores(projectData);
  state.expandedClusters = new Set();
  state.expandedLibClusters = new Set();
  if (!isReanalysis) { state.hasFitted = false; }

  const nodeCount = projectData.nodes.length;
  if (nodeCount > 200) {
    state.complexityLevel = Math.max(0.1, Math.min(0.9, 200 / nodeCount));
    const slider = document.getElementById('slider-complexity');
    const valEl = document.getElementById('val-complexity');
    if (slider) slider.value = String(state.complexityLevel);
    if (valEl) valEl.textContent = state.complexityLevel.toFixed(2);
  }

  applyComplexity();
  renderLanguageLegend();
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'lib-description') {
    if (message.reqId !== state.libDescRequestId) { return; }
    const descEl = document.getElementById('lib-doc-desc');
    const descRow = document.getElementById('lib-doc-desc-row');
    if (descEl && descRow) {
      descEl.textContent = message.description || 'No description available.';
      descRow.style.display = 'block';
    }
    return;
  }
  if (message.type === 'graph') {
    state.gitAvailable = message.gitAvailable ?? false;
    const gitBtn = document.getElementById('btn-git-mode');
    if (gitBtn) gitBtn.style.display = state.gitAvailable ? '' : 'none';
    state.pendingReheat = message.isReanalysis && state.hasFitted;
    renderGraph(message.data, message.isReanalysis);
    return;
  }
  if (message.type === 'git-update') {
    const byId = new Map(message.nodes.map(n => [n.id, n.gitStatus]));
    state.currentNodes.forEach(n => { if (byId.has(n.id)) { n.gitStatus = byId.get(n.id); } });
    if (state.gitMode) { applyGitColors(); }
    return;
  }
});
