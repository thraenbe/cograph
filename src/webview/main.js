const vscode = acquireVsCodeApi();

// ── Dirty state (unsaved-changes indicator) ───────────────────────────────────
let __isDirty = false;
window.markDirty = function markDirty() {
  if (__isDirty) { return; }
  __isDirty = true;
  vscode.postMessage({ type: 'dirty-state', dirty: true });
};
window.clearDirty = function clearDirty() {
  if (!__isDirty) { return; }
  __isDirty = false;
  vscode.postMessage({ type: 'dirty-state', dirty: false });
};

// Lazy per-folder parse: ask the extension to analyze a folder's direct files,
// showing a spinner on the folder/file nodes until the `graph-patch` arrives.
window.requestFolderParse = function requestFolderParse(folderPath) {
  const info = state.structureTree && state.structureTree.folders
    ? state.structureTree.folders[folderPath] : null;
  const files = info && info.files ? info.files : [];
  if (!files.length) { return; }
  if (state.parsingFolders.has(folderPath)) { return; } // already in flight
  state.parsingFolders.add(folderPath);
  if (typeof applyFileClusters === 'function') { applyFileClusters(); }
  vscode.postMessage({ type: 'expand-folder', folderPath, files });
};

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
  fileClusterForce: 0.2,
  folderRepelForce: 0.25,
  fileRepelForce: 0.25,
  linkDistance: 40,   // shelf sims run this at 0.75x (localSim.lsLinkDistance)
  repelRange: Infinity, // Global charge distanceMax; Infinity = unlimited (classic; shelf uses its fixed 140)
  velocityDecay: 0.3,
  collidePad: 1.5,
  slotPad: 0,
  openFunctionPopup: true,
};

// ── Layout toggles: engine (Shelf | Global) × motion (Dynamic | Static) ───────
function updateLayoutButtons() {
  for (const m of ['dynamic', 'static']) {
    document.getElementById(`btn-layout-${m}`)?.classList.toggle('active', state.layoutMode === m);
  }
  for (const e of ['shelf', 'global']) {
    document.getElementById(`btn-engine-${e}`)?.classList.toggle('active', state.layoutEngine === e);
  }
  if (typeof updateForcesPanel === 'function') {
    updateForcesPanel(state.layoutEngine, state.layoutMode);
  }
  const hint = document.getElementById('layout-hint');
  if (hint) {
    const engine = state.layoutEngine === 'shelf' ? 'Folder frames & file slots' : 'One free-floating graph';
    const motion = state.layoutMode === 'static' ? 'frozen' : 'settles live';
    hint.textContent = `${engine} \u00b7 ${motion}`;
  }
}

// Motion axis — classic semantics on either engine: static stops the simulation
// (the frame facade pauses its scheduler) and pins nodes; dynamic releases them.
function setLayoutMode(mode) {
  if (!['dynamic', 'static'].includes(mode)) { mode = 'dynamic'; }
  state.layoutMode = mode;
  updateLayoutButtons();

  if (mode === 'static') {
    if (state.simulation) {
      state.simulation.stop();
      state.currentNodes.forEach(d => { d.fx = d.x; d.fy = d.y; });
    }
    return;
  }
  state.currentNodes.forEach(d => { d.fx = null; d.fy = null; });
  if (state.simulation) state.simulation.alpha(0.3).restart();
}

// Global guard (F-guard): the first click on Engine: Global above
// GLOBAL_GUARD.N nodes only warns; a second click within the window switches.
let __globalGuard = null;
let __guardHintTimer = null;
function globalGuardInstance() {
  if (!__globalGuard && typeof createGlobalGuard === 'function') {
    __globalGuard = createGlobalGuard();
  }
  return __globalGuard;
}
function showGlobalGuardHint(kind) {
  const el = document.getElementById('global-guard-hint');
  if (!el) { return; }
  el.textContent = (typeof globalGuardHintText === 'function') ? globalGuardHintText(kind) : '';
  el.style.display = '';
  clearTimeout(__guardHintTimer);
  __guardHintTimer = setTimeout(hideGlobalGuardHint, 6000);
}
function hideGlobalGuardHint() {
  clearTimeout(__guardHintTimer);
  const el = document.getElementById('global-guard-hint');
  if (el) { el.style.display = 'none'; }
}
/** Hint (never block) when Detail pushes an already-Global layout past N. */
function maybeWarnGlobalSize() {
  if (typeof GLOBAL_GUARD === 'undefined' || state.layoutEngine !== 'global') { return; }
  if (state.currentNodes.length > GLOBAL_GUARD.N) {
    if (!state._globalSizeHinted) {
      state._globalSizeHinted = true;
      showGlobalGuardHint('detail');
    }
  } else {
    state._globalSizeHinted = false;
  }
}

// Engine axis — 'shelf' (folder frames; implies the File lens) | 'global'
// (classic single simulation). Re-renders, then re-applies a static freeze so
// the target engine honours the current motion mode.
function setLayoutEngine(engine, opts = {}) {
  if (!['shelf', 'global'].includes(engine)) { engine = 'global'; }
  if (engine === 'global' && state.layoutEngine !== 'global') {
    const guard = globalGuardInstance();
    if (guard && guard.check(state.currentNodes.length, opts) === 'blocked') {
      showGlobalGuardHint('switch');
      return; // a second click within the window switches
    }
  }
  hideGlobalGuardHint();
  state.layoutEngine = engine;
  updateLayoutButtons();
  // Detach the old engine's simulation BEFORE re-rendering: a still-settling
  // global sim otherwise keeps firing ticks into the new engine's DOM (F3).
  if (state.simulation && !state.simulation.isFrameFacade && state.simulation.on) {
    state.simulation.on('tick', null).on('end', null);
    state.simulation.stop();
  }
  state.currentNodes.forEach(d => { d.fx = null; d.fy = null; });
  state.userZoomed = false; // an engine switch re-lays out — allow auto-fit
  if (engine === 'shelf' && state.viewMode === 'workflow') {
    if (typeof enterFileClusterMode === 'function') { enterFileClusterMode(); }
  } else if (typeof applyComplexity === 'function') {
    applyComplexity();
  }
  if (state.layoutMode === 'static') { setLayoutMode('static'); }
  // One coalesced tick of the OLD engine may already sit in a rAF; it fires
  // after this switch and scribbles on the new DOM. Queue a repair pass
  // behind it (F3).
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (typeof usesFrames === 'function' && usesFrames() && typeof tickFrames === 'function') {
        tickFrames();
      } else if (typeof ticked === 'function' && state.currentNodes.length) {
        ticked();
      }
    });
  }
}
updateLayoutButtons(); // boot config may differ from the HTML's active buttons

// ── Filters ───────────────────────────────────────────────────────────────────
// Memoised when visibility.js is loaded (perf's branch): tick paths call this
// 1-2× per simulation tick, so the O(N) scan only re-runs when an input
// actually changed. EVERY filter must appear in the memo inputs — a missing
// one makes the memo serve a stale set after that filter changes (this bit
// the R2a file filters on the integrated branch).
const __visMemo = (typeof createVisibleMemo === 'function') ? createVisibleMemo() : null;
let __searchEl;
function getVisibleNodeIds() {
  if (__searchEl === undefined) { __searchEl = document.getElementById('search'); }
  const query = __searchEl?.value.toLowerCase() ?? '';
  const tlPredicate = state.timeline?.filterPredicate;
  if (!__visMemo) { return computeVisibleNodeIds(query, tlPredicate); }
  return __visMemo.get({
    query, volatile: !!tlPredicate,
    showLibraries: settings.showLibraries, existingFilesOnly: settings.existingFilesOnly,
    showOrphans: settings.showOrphans, nodes: state.currentNodes, connected: state.connectedNodeIds,
    onlyShowFolder: state.onlyShowFolder, hiddenFolders: state.hiddenFolders,
    onlyShowFile: state.onlyShowFile, hiddenFiles: state.hiddenFiles, // R2a
  }, () => computeVisibleNodeIds(query, tlPredicate));
}

function computeVisibleNodeIds(query, tlPredicate) {
  if (typeof perfCount === 'function') { perfCount('getVisibleNodeIds'); }
  const visible = new Set();
  state.currentNodes.forEach(n => {
    if (n.isLibrary) {
      if (!settings.showLibraries) return;
      if (query && !n.label.toLowerCase().includes(query)) return;
      if (tlPredicate && !tlPredicate(n)) return;
      visible.add(n.id);
      return;
    }
    if (query && !n.label.toLowerCase().includes(query)) return;
    if (settings.existingFilesOnly && !n.isCluster && !n.isSynthetic) {
      if (!n.file || !n.line || n.line <= 0) return;
    }
    if (!settings.showOrphans && !state.connectedNodeIds.has(n.id)) return;
    // Folder only-show / hide filters — applied to function nodes AND drill-down
    // skeleton nodes (folder::/file::) by their path.
    let nf = null;
    if (n.isFolderCluster) { nf = n._folderPath; }
    else if (n.isFileCluster) { nf = pathDirname(n._filePath); }
    else if (n.file && !n.isLibrary && !n.isCluster && !n.isSynthetic) { nf = pathDirname(n.file); }
    if (nf != null && (state.onlyShowFolder || state.hiddenFolders.size)) {
      const inside = (folder) => nf === folder || nf.startsWith(folder + '/') || nf.startsWith(folder + '\\');
      if (state.onlyShowFolder && !inside(state.onlyShowFolder)) return;
      for (const hf of state.hiddenFolders) {
        if (inside(hf)) return;
      }
    }
    // File-level filters (R2a): functions by their file, collapsed file::
    // nodes by their path; folder glyphs are unaffected.
    if (state.onlyShowFile || (state.hiddenFiles && state.hiddenFiles.size)) {
      const ff = n.isFileCluster ? n._filePath
        : (n.file && !n.isLibrary && !n.isCluster && !n.isSynthetic ? n.file : null);
      if (ff != null && typeof fileFilterAllows === 'function'
          && !fileFilterAllows(ff, state.onlyShowFile, state.hiddenFiles)) return;
    }
    if (tlPredicate && !tlPredicate(n)) return;
    visible.add(n.id);
  });
  return visible;
}

// Bursts (key repeat, timeline frames) collapse to one pass per animation
// frame; a single call still applies synchronously. Only elements whose
// visibility flipped are written (visibility.js).
const __filterGate = (typeof createBurstGate === 'function')
  ? createBurstGate(typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : null)
  : null;
const __filterApplier = (typeof createFilterApplier === 'function') ? createFilterApplier() : null;

function applyFilters() {
  if (!state.svgNodes || !state.svgLinks || !state.svgLabels) return;
  if (__filterGate) { __filterGate.run(applyFiltersNow); } else { applyFiltersNow(); }
}

// Hide folder/file, Only show and Show all reshape the LAYOUT since round 3
// (frames/slots/boxes are scope-filtered at build time — scope.js), so every
// filter MUTATION re-renders the drill-down; plain applyFilters stays the
// cheap display pass for search/timeline/settings.
function applyStructuralFilters() {
  if (typeof isDrilldown === 'function' && isDrilldown()
    && typeof applyFileClusters === 'function') {
    applyFileClusters();
  }
  applyFilters();
}

function applyFiltersNow() {
  if (!state.svgNodes || !state.svgLinks || !state.svgLabels) return;
  const __t0 = (typeof perfBegin === 'function') ? perfBegin() : 0;
  const visibleSet = getVisibleNodeIds();
  if (__filterApplier) {
    __filterApplier.apply({
      nodes: [state.svgNodes, state.svgCloudNodes, state.svgLabels, state.svgLibNodes, state.svgLibLabels],
      links: state.svgLinks,
    }, visibleSet);
  } else {
    applyFiltersFull(visibleSet);
  }

  if (typeof tickFolderOverlay === 'function') tickFolderOverlay();
  if (typeof tickClassOverlay === 'function') tickClassOverlay(visibleSet);
  if (typeof updateSearchCount === 'function') updateSearchCount(visibleSet);
  if (__t0) { perfEnd('applyFilters', __t0); }
}

function applyFiltersFull(visibleSet) {
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

function applyDisplaySettings() {
  if (!state.svgNodes || !state.svgLinks || !state.svgLabels) return;
  state.svgNodes
    .attr('r', d => nodeRadius(d))
    .attr('stroke', d => resolveNodeStroke(d))
    .attr('stroke-width', d => resolveNodeStrokeWidth(d));
  state.svgCloudNodes?.attr('d', d => generateNodeShapePath(d, nodeRadius(d)));
  state.svgLinks
    .attr('stroke-width', d => settings.linkThickness * (typeof edgeWeightScale === 'function' ? edgeWeightScale(d._count) : 1))
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
  if (typeof usesFrames === 'function' && usesFrames()
      && typeof applyFrameDisplaySettings === 'function') {
    applyFrameDisplaySettings();
  }
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
  const charge = state.simulation.force('charge');
  charge.strength(typeof chargeStrength === 'function' ? chargeStrength : -settings.repelForce);
  charge.distanceMax?.(settings.repelRange ?? Infinity);
  // Keep folder/file edges weak + long so folders stay separated (see startSimulation).
  const folderLink = typeof isFolderLink === 'function' ? isFolderLink : () => false;
  state.simulation.force('link')
    .strength(d => d.isLibraryEdge ? settings.linkForce * 0.1 * 0.3
      : folderLink(d) ? settings.linkForce * 0.1 * 0.25 : settings.linkForce * 0.1)
    .distance(d => folderLink(d) ? 120 : (settings.linkDistance ?? 40));
  state.simulation.force('collision')?.radius?.(d => nodeRadius(d) + (settings.collidePad ?? 1.5));
  state.simulation.velocityDecay?.(settings.velocityDecay ?? 0.3);
  state.simulation.alpha(0.5).restart();
}

// ── Complexity ────────────────────────────────────────────────────────────────
function applyWorkflowComplexity() {
  const projectData = {
    nodes: state.graphData.nodes.filter(n => !n.isLibrary),
    edges: state.graphData.edges.filter(e => !e.isLibraryEdge),
    workflow: state.graphData.workflow,
  };
  const degreeMap = new Map();
  projectData.nodes.forEach(n => degreeMap.set(n.id, 0));
  projectData.edges.forEach(e => {
    if (e.source === '::MAIN::0') return;
    degreeMap.set(e.source, (degreeMap.get(e.source) ?? 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) ?? 0) + 1);
  });
  const wv = deriveWorkflowView(projectData, state.workflowLevel);
  state.workflowStageCount = wv.stageCount;
  state.workflowDividerStage = wv.dividerStage;
  const elements = buildClusteredElements(projectData, wv, 0.5, state.importanceScores, new Set(), degreeMap);
  // Carry pipeline stage + tier onto each rendered node so the layered layout can place it.
  for (const el of elements) {
    if (el.data.source === undefined) {
      const lay = wv.layout.get(el.data.id);
      if (lay) { el.data._stage = lay.stage; el.data._tier = lay.tier; }
    }
  }
  renderElements(elements, new Map());
}

function applyComplexity() {
  if (isDrilldown()) { applyFileClusters(); return; }
  if (!state.graphData || !state.importanceScores) return;
  if (state.viewMode === 'workflow') { applyWorkflowComplexity(); return; }
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
  // Reaches here only for 'file' without a structure tree (falls back to plain
  // file-structural clustering instead of the drill-down).
  const clusterResult = computeStructuralClusters(projectData, 'file', state.complexityLevel);
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
  // Seed each cluster at the centroid of its members' current on-screen
  // positions so the layout starts compact instead of random.
  const positionHints = new Map();
  if (state.currentNodes.length > 0) {
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
  maybeWarnGlobalSize();
}

// ── Main entry ────────────────────────────────────────────────────────────────
function renderGraph(data, isReanalysis = false) {
  state.graphData = data;
  const projectData = { nodes: data.nodes.filter(n => !n.isLibrary), edges: data.edges.filter(e => !e.isLibraryEdge) };
  state.importanceScores = computeImportanceScores(projectData);
  state.expandedClusters = new Set();
  state.expandedLibClusters = new Set();
  if (!isReanalysis) {
    state.hasFitted = false;
    state.userZoomed = false;
    if (state.slotPlacedIds) { state.slotPlacedIds.clear(); } // new graph, new placements
  }

  // Detect the AI Workflow Graph (its presence is marked by graph.workflow).
  // Workflow payloads route here even while the drill-down is active (see
  // classifyGraphMessage); the cluster grouping (clusterGroupBy) is preserved
  // across workflow toggles.
  const wasWorkflow = state.viewMode === 'workflow';
  const isWorkflow = isWorkflowPayload(data);
  state.viewMode = isWorkflow ? 'workflow' : 'cluster';
  const levels = (typeof WORKFLOW_LEVELS !== 'undefined') ? WORKFLOW_LEVELS : 10;
  if (isWorkflow) {
    state.workflowStageCount = data.workflow.stageCount || 1;
    state.workflowDividerStage = Number.isFinite(data.workflow.dividerStage)
      ? data.workflow.dividerStage : (state.workflowStageCount - 1);
    if (!wasWorkflow) { state.workflowLevel = 0; state.hasFitted = false; } // start least detailed
    const slider = document.getElementById('slider-complexity');
    const valEl = document.getElementById('val-complexity');
    if (slider) slider.value = String(state.workflowLevel / Math.max(1, levels - 1));
    if (valEl) valEl.textContent = String(state.workflowLevel);
  } else if (wasWorkflow) {
    state.hasFitted = false; // returning to the force layout
    if (isDrilldown()) {
      // Back to the folder drill-down: this fresh full analysis covers the whole
      // tree, and workflow mode repurposed the Detail slider as its 0..9 level —
      // restore both. Drill-down expansion state (expandedFolders/detailDepth)
      // is intentionally preserved.
      state.parsedFolders = new Set(Object.keys(state.structureTree.folders));
      setDetailSlider(state.detailDepth);
    }
  }

  const nodeCount = projectData.nodes.length;
  // In drill-down the slider means detail depth — don't clobber it for big repos.
  if (!isWorkflow && !isDrilldown() && nodeCount >= 500) {
    state.complexityLevel = Math.max(0.1, Math.min(0.9, 500 / nodeCount));
    const slider = document.getElementById('slider-complexity');
    const valEl = document.getElementById('val-complexity');
    if (slider) slider.value = String(state.complexityLevel);
    if (valEl) valEl.textContent = state.complexityLevel.toFixed(2);
  }

  applyComplexity();
  renderLanguageLegend();
}

// ── Ready handshake (F11, readyHandshake.js) ────────────────────────────────
// Dedupe first (its listener must precede every other one), announce `ready`
// once all scripts ran.
if (typeof installSeqDedupe === 'function') {
  installSeqDedupe(window);
  announceReady(document, (m) => vscode.postMessage(m));
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
    state.fileGitStatus = message.fileGitStatus ?? {};
    const gitPanel = document.getElementById('panel-git');
    if (gitPanel) gitPanel.style.display = state.gitAvailable ? '' : 'none';
    state.pendingReheat = message.isReanalysis && state.hasFitted;
    state.allScannedFiles = message.data.files ?? [];
    // Boot guard: a Global boot config with a first graph beyond the guard
    // threshold would freeze on any expansion — start in Shelf and say so.
    if (!state._globalBootGuarded) {
      state._globalBootGuarded = true;
      const realNodes = (message.data.nodes ?? []).filter(n => !n.isLibrary).length;
      if (state.layoutEngine === 'global' && typeof GLOBAL_GUARD !== 'undefined'
          && realNodes > GLOBAL_GUARD.N) {
        state.layoutEngine = 'shelf';
        updateLayoutButtons();
        showGlobalGuardHint('boot');
      }
    }
    window.resetTimelineState?.();
    if (classifyGraphMessage(message.data) === 'ingest') {
      // Skeleton is showing — fold the analysis result into it without losing
      // the user's drill-down, instead of switching to the full graph.
      // Workflow payloads never take this path: only renderGraph can show them.
      ingestGraphData(message.data);
    } else {
      renderGraph(message.data, message.isReanalysis);
    }
    if (state.gitMode && state.gitAvailable) { applyGitColors(); }
    if (!message.isReanalysis) { window.clearDirty?.(); }
    return;
  }
  if (message.type === 'structure') {
    if (typeof renderStructureSkeleton === 'function') {
      renderStructureSkeleton(message.tree, message.autoEngage);
    }
    return;
  }
  if (message.type === 'graph-patch') {
    if (message.fileGitStatus) { state.fileGitStatus = message.fileGitStatus; }
    if (message.parsedFolder) { state.parsingFolders.delete(message.parsedFolder); }
    // Incremental/reconcile: drop stale nodes for replaced files before merging fresh ones.
    if (message.replacedFiles && message.replacedFiles.length && state.graphData) {
      const rm = new Set(message.replacedFiles);
      const removedIds = new Set(state.graphData.nodes.filter(n => rm.has(n.file)).map(n => n.id));
      state.graphData = {
        nodes: state.graphData.nodes.filter(n => !rm.has(n.file)),
        edges: state.graphData.edges.filter(e => !removedIds.has(e.source) && !removedIds.has(e.target)),
        files: state.graphData.files,
      };
    }
    // Patches never carry workflow metadata today; the classifier keeps the
    // routing invariant explicit and shared with the `graph` handler.
    if (classifyGraphMessage(message.patch) === 'ingest') {
      ingestGraphData(message.patch, message.parsedFolder);
    } else {
      // Normal mode (e.g. incremental save): merge and re-render the full graph.
      mergeGraphDataPatch(message.patch);
      if (state.graphData) { renderGraph(state.graphData, true); }
    }
    if (state.gitMode && state.gitAvailable) { applyGitColors(); }
    return;
  }
  if (message.type === 'analysis-state') {
    if (message.parsingFolder) {
      if (message.error) { state.parsingFolders.delete(message.parsingFolder); }
      else { state.parsingFolders.add(message.parsingFolder); }
      if (isDrilldown()) { applyFileClusters(); }
    }
    if (message.backgroundParsing !== undefined) {
      state.backgroundParsing = message.backgroundParsing;
    }
    return;
  }
  if (message.type === 'timeline-data') {
    window.receiveTimelineData?.(message.nodes);
    return;
  }
  if (message.type === 'git-update') {
    const byId = new Map(message.nodes.map(n => [n.id, n.gitStatus]));
    state.currentNodes.forEach(n => { if (byId.has(n.id)) { n.gitStatus = byId.get(n.id); } });
    if (message.fileGitStatus) { state.fileGitStatus = message.fileGitStatus; }
    if (state.gitMode) { applyGitColors(); }
    return;
  }
  if (message.type === 'reload-layout') {
    if (typeof usesFrames === 'function' && usesFrames() && typeof resetFrames === 'function') {
      resetFrames();          // drop packed rects → next render re-packs from scratch
      state.hasFitted = false;
      state.userZoomed = false;
      applyFileClusters();
      window.clearDirty?.();
      return;
    }
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
    window.clearDirty?.();
    return;
  }
  if (message.type === 'clear-dirty') {
    __isDirty = false;
    return;
  }
  if (message.type === 'config') {
    // Live push of cograph.layout.defaultEngine / defaultMode (engine first —
    // it re-renders; the motion freeze must land on the new engine).
    if (['shelf', 'global'].includes(message.defaultEngine)) {
      setLayoutEngine(message.defaultEngine, { force: true }); // user changed the setting
    }
    if (['dynamic', 'static'].includes(message.defaultMode)) {
      setLayoutMode(message.defaultMode);
    }
    return;
  }
  if (message.type === 'graph-loaded') {
    const { settings: saved, nodePositions } = message.payload;
    if (!state.currentNodes.length || !nodePositions) { return; }
    // Frames engine: renderFrameLayout consumes this via applyPendingLayout()
    // (frame rects, expandedFolders, detailDepth) as the frames appear.
    state.savedLayout = message.payload;

    // Apply saved display state (defined in controls.js).
    applySavedViewSettings(saved);
    if (typeof applySavedFileFilters === 'function') {
      applySavedFileFilters(message.payload); // engine-independent (R2a)
    }

    // Two-axis restore. Legacy payloads carried only layoutMode, where 'shelf'
    // meant the frames engine with dynamic motion.
    const savedEngine = ['shelf', 'global'].includes(saved.layoutEngine)
      ? saved.layoutEngine
      : (saved.layoutMode === 'shelf' ? 'shelf' : 'global');
    const savedMotion = saved.layoutMode === 'static' ? 'static' : 'dynamic';
    if (savedEngine !== state.layoutEngine) { setLayoutEngine(savedEngine, { force: true }); } // a saved Global view IS the explicit choice

    const isGlobalRestore = savedEngine === 'global';
    if (isGlobalRestore) {
      // Global consumes the drill-down state here (the frames engine consumes
      // it in applyPendingLayout as frames appear) and re-renders FIRST, so
      // the saved positions land on the saved visible node set (F14).
      if (typeof applySavedDrilldownState === 'function') {
        applySavedDrilldownState(message.payload);
      }
      state.savedLayout = null; // consumed — nothing left for the frames path
      applyComplexity();
    }

    // Apply saved node positions (stamped: a saved position is a placement,
    // so the shelf grid must not overwrite it)
    if (!state.slotPlacedIds) { state.slotPlacedIds = new Set(); }
    for (const n of state.currentNodes) {
      const pos = nodePositions[n.id];
      if (pos) {
        n.x = pos.x;
        n.y = pos.y;
        n.fx = pos.x;
        n.fy = pos.y;
        state.slotPlacedIds.add(n.id);
      }
    }

    if (savedMotion !== 'static') {
      // Use positions as starting points, then release into dynamic simulation
      state.layoutMode = 'dynamic';
      updateLayoutButtons();
      if (state.simulation) {
        state.simulation.alpha(0.1).restart();
        setTimeout(() => {
          state.currentNodes.forEach(n => { n.fx = null; n.fy = null; });
        }, 300);
      }
    }

    // Re-apply clustering so the restored state renders correctly. Under
    // Global the render already happened ABOVE — re-rendering here would
    // re-settle the simulation and move the restored positions (F14); a
    // repaint + re-fit is all that is left to do.
    if (isGlobalRestore) {
      state.hasFitted = false; // auto-fit the RESTORED layout, not the throwaway settle
      ticked();
    } else {
      applyComplexity();
    }
    if (savedMotion === 'static') { setLayoutMode('static'); } // pin AFTER the final render
    if (state.gitMode && state.gitAvailable) { applyGitColors(); }
    // Restoring a saved graph is not a dirty change — sync local flag with extension
    __isDirty = false;
    return;
  }
});
