const vscode = acquireVsCodeApi();

// ── State ─────────────────────────────────────────────────────────────────────
const settings = {
  existingFilesOnly: false,
  showOrphans: true,
  showLibraries: false,
  showEmptyFiles: false,
  groupByFile: false,
  arrows: true,
  textFadeThreshold: 0.5,
  nodeSize: 2.5,
  textSize: 1.5,
  linkThickness: 4,
  centerForce: 0.025,
  repelForce: 250,
  linkForce: 1,
  fileClusterForce: 0.04,
  openFunctionPopup: true,
};

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
    if (n.file && !n.isLibrary && !n.isCluster && !n.isSynthetic) {
      const nf = pathDirname(n.file);
      const inside = (folder) => nf === folder || nf.startsWith(folder + '/') || nf.startsWith(folder + '\\');
      if (state.onlyShowFolder && !inside(state.onlyShowFolder)) return;
      for (const hf of state.hiddenFolders) {
        if (inside(hf)) return;
      }
    }
    visible.add(n.id);
  });
  return visible;
}

function applyFilters() {
  if (!state.svgNodes || !state.svgLinks || !state.svgLabels) return;
  const visibleSet = getVisibleNodeIds();
  state.svgNodes.style('display', d => visibleSet.has(d.id) ? null : 'none');
  state.svgCloudNodes?.style('display', d => visibleSet.has(d.id) ? null : 'none');
  state.svgLabels.style('display', d => visibleSet.has(d.id) ? null : 'none');
  state.svgLibNodes?.style('display', d => visibleSet.has(d.id) ? null : 'none');
  state.svgLibLabels?.style('display', d => visibleSet.has(d.id) ? null : 'none');
  state.svgLinks.style('display', d => {
    const src = d.source?.id ?? d.source;
    const tgt = d.target?.id ?? d.target;
    return (visibleSet.has(src) && visibleSet.has(tgt)) ? null : 'none';
  });
}

// ── Display settings ──────────────────────────────────────────────────────────
function applyDisplaySettings() {
  if (!state.svgNodes || !state.svgLinks || !state.svgLabels) return;
  state.svgNodes
    .attr('r', d => nodeRadius(d))
    .attr('stroke', d => resolveNodeStroke(d))
    .attr('stroke-width', d => resolveNodeStrokeWidth(d));
  state.svgCloudNodes?.attr('d', d => generateCloudPath(nodeRadius(d), bumpCountFor(d)));
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
  state.svgFileCircles?.selectAll('.file-circle-label')
    .attr('font-size', `${11 * settings.textSize}px`);
  state.svgFolderBubbles?.selectAll('.folder-bubble-label')
    .attr('font-size', function(d) { return `${(12 + 6 / (d.depth + 1)) * settings.textSize}px`; });
  state.svgClassBubbles?.selectAll('.class-bubble-label')
    .attr('font-size', `${11 * settings.textSize}px`);
  updateTextVisibility();
}

// ── Layout update ─────────────────────────────────────────────────────────────
function rerunLayout() {
  if (!state.simulation) return;
  const svgEl = svg.node();
  const W = svgEl.clientWidth || window.innerWidth;
  const H = svgEl.clientHeight || window.innerHeight;
  state.simulation.force('center', d3.forceCenter(W / 2, H / 2).strength(0.05));
  state.simulation.force('x', d3.forceX(W / 2).strength(settings.centerForce));
  state.simulation.force('y', d3.forceY(H / 2).strength(settings.centerForce));
  state.simulation.force('charge').strength(-settings.repelForce);
  state.simulation.force('link').strength(d => d.isLibraryEdge ? settings.linkForce * 0.1 * 0.3 : settings.linkForce * 0.1).distance(40);
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
  const clusterResult = state.clusterGroupBy === 'connectivity'
    ? computeClusters(projectData, state.importanceScores, state.complexityLevel)
    : computeStructuralClusters(projectData, state.clusterGroupBy, state.complexityLevel);
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
          elements.push({ data: { ...n, label: n.name, _size: 6, isCluster: false, isSynthetic: false } });
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
  // For structural modes, seed each cluster at the centroid of its members'
  // current on-screen positions so the layout starts compact instead of random.
  const positionHints = new Map();
  if (state.clusterGroupBy !== 'connectivity' && state.currentNodes.length > 0) {
    const currentById = new Map(state.currentNodes.map(n => [n.id, n]));
    for (const [clusterId, members] of clusterResult.clusterMembers) {
      const pts = members
        .map(id => currentById.get(id))
        .filter(n => n?.x != null && n?.y != null);
      if (pts.length > 0) {
        positionHints.set(clusterId, {
          x: pts.reduce((s, n) => s + n.x, 0) / pts.length,
          y: pts.reduce((s, n) => s + n.y, 0) / pts.length,
        });
      }
    }
  }

  renderElements(elements, positionHints);
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
  if (nodeCount >= 500) {
    state.complexityLevel = Math.max(0.1, Math.min(0.9, 500 / nodeCount));
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
  if (message.type === 'func-source') {
    const inst = [...state.funcPopups.values()].find(p => p.reqId === message.reqId);
    if (!inst) return;
    inst.colorizedHtml = message.colorizedHtml ?? null;
    inst.endLine       = message.endLine       ?? null;
    if (message.error) {
      inst.textarea.value = `(error: ${message.error})`;
      inst.textarea.readOnly = true;
      inst.originalSource = null;
    } else {
      inst.textarea.value = message.source;
      inst.textarea.readOnly = false;
      inst.originalSource = message.source;
    }
    updateFuncHighlight(inst);
    updateSaveBtn(inst);
    return;
  }
  if (message.type === 'graph') {
    state.gitAvailable = message.gitAvailable ?? false;
    const gitPanel = document.getElementById('panel-git');
    if (gitPanel) gitPanel.style.display = state.gitAvailable ? '' : 'none';
    state.pendingReheat = message.isReanalysis && state.hasFitted;
    state.allScannedFiles = message.data.files ?? [];
    renderGraph(message.data, message.isReanalysis);
    if (state.gitMode && state.gitAvailable) { applyGitColors(); }
    return;
  }
  if (message.type === 'git-update') {
    const byId = new Map(message.nodes.map(n => [n.id, n.gitStatus]));
    state.currentNodes.forEach(n => { if (byId.has(n.id)) { n.gitStatus = byId.get(n.id); } });
    if (state.gitMode) { applyGitColors(); }
    return;
  }
  if (message.type === 'reload-layout') {
    const svgEl = svg.node();
    const W = svgEl?.clientWidth || window.innerWidth;
    const H = svgEl?.clientHeight || window.innerHeight;
    state.currentNodes.forEach(d => {
      d.fx = null;
      d.fy = null;
      d.x = W / 2 + (Math.random() - 0.5) * 200;
      d.y = H / 2 + (Math.random() - 0.5) * 200;
      d.vx = 0;
      d.vy = 0;
    });
    rerunLayout();
    return;
  }
  if (message.type === 'graph-loaded') {
    const { settings: saved, nodePositions } = message.payload;
    if (!state.currentNodes.length || !nodePositions) { return; }

    // Apply saved display state
    if (saved.complexityLevel !== undefined) {
      state.complexityLevel = saved.complexityLevel;
      const slider = document.getElementById('slider-complexity');
      const valEl = document.getElementById('val-complexity');
      if (slider) { slider.value = String(saved.complexityLevel); }
      if (valEl) { valEl.textContent = Number(saved.complexityLevel).toFixed(2); }
    }
    if (saved.clusterGroupBy !== undefined) { state.clusterGroupBy = saved.clusterGroupBy; }
    if (saved.gitMode !== undefined) {
      state.gitMode = saved.gitMode;
      document.getElementById('btn-git-mode')?.classList.toggle('active', saved.gitMode);
    }
    if (saved.languageMode !== undefined) {
      state.languageMode = saved.languageMode;
      document.getElementById('btn-language-mode')?.classList.toggle('active', saved.languageMode);
    }
    if (saved.folderMode !== undefined) {
      state.folderMode = saved.folderMode;
      document.getElementById('btn-folder-mode')?.classList.toggle('active', saved.folderMode);
    }
    if (saved.classMode !== undefined) {
      state.classMode = saved.classMode;
      document.getElementById('btn-class-mode')?.classList.toggle('active', saved.classMode);
    }

    // Apply saved node positions
    for (const n of state.currentNodes) {
      const pos = nodePositions[n.id];
      if (pos) {
        n.x = pos.x;
        n.y = pos.y;
        n.fx = pos.x;
        n.fy = pos.y;
      }
    }

    if (saved.layoutMode === 'static') {
      setLayoutMode('static');
    } else {
      // Use positions as starting points, then release into dynamic simulation
      if (state.simulation) {
        state.simulation.alpha(0.1).restart();
        setTimeout(() => {
          state.currentNodes.forEach(n => { n.fx = null; n.fy = null; });
        }, 300);
      }
    }

    // Re-apply clustering and colors so the restored state renders correctly
    applyComplexity();
    if (state.gitMode && state.gitAvailable) { applyGitColors(); }
    return;
  }
});
