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
const folderG = g.append('g').attr('class', 'folder-bubbles');
const classG  = g.append('g').attr('class', 'class-bubbles');
const fileG   = g.append('g').attr('class', 'file-circles');
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
  if (d.isLibrary) return '#c8a84b';
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
  if (!state.svgLabels) return;
  const opacity = state.currentZoom >= settings.textFadeThreshold ? 1 : 0;
  state.svgLabels.style('opacity', opacity);
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
  const scale = Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2) / (maxY - minY || 1), 4);
  svg.transition().duration(500).call(
    zoomBehavior.transform,
    d3.zoomIdentity
      .translate(W / 2 - scale * (minX + maxX) / 2, H / 2 - scale * (minY + maxY) / 2)
      .scale(scale)
  );
}

// ── Drag (swimming effect) ────────────────────────────────────────────────────
const drag = d3.drag()
  .on('start', (event, d) => {
    if (state.layoutMode === 'dynamic' && !event.active && state.simulation)
      state.simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  })
  .on('drag', (event, d) => {
    d.fx = event.x;
    d.fy = event.y;
    if (state.layoutMode === 'static') {
      // Simulation stopped — sync x/y directly so ticked() renders correctly
      d.x = event.x;
      d.y = event.y;
      ticked();
    }
  })
  .on('end', (event, d) => {
    if (state.layoutMode === 'dynamic') {
      if (!event.active && state.simulation) state.simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null; // release — node rejoins simulation
    }
    // static: keep fx/fy pinned so node stays exactly where dropped
  });

// ── Tick ──────────────────────────────────────────────────────────────────────
function ticked() {
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
  state.svgLabels?.each(function (d) {
    this.setAttribute('x', d.x);
    this.setAttribute('y', (d.isCluster || d.isSynthetic) ? d.y : d.y + nodeRadius(d) + 10);
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

  tickFolderOverlay();   // global from folder.js
  tickClassOverlay();    // global from class.js
}

// ── Node event handlers ───────────────────────────────────────────────────────
function onNodeMouseOver(event, d) {
  d3.select(event.currentTarget)
    .style('fill', '#7eb9ff')
    .attr('r', nodeRadius(d) * 1.15)
    .attr('filter', 'url(#glow-hover)');
  state.svgLinks
    ?.attr('stroke', l => (l.source?.id ?? l.source) === d.id || (l.target?.id ?? l.target) === d.id
      ? '#5aabff' : l.isLibraryEdge ? 'rgba(200,168,75,0.3)' : 'rgba(160,160,160,0.25)')
    .attr('stroke-width', l => (l.source?.id ?? l.source) === d.id || (l.target?.id ?? l.target) === d.id
      ? Math.max(1.5, settings.linkThickness) : settings.linkThickness)
    .attr('opacity', l => (l.source?.id ?? l.source) === d.id || (l.target?.id ?? l.target) === d.id
      ? 1 : 0.15);
  state.svgLabels?.filter(l => l.id === d.id)
    .style('opacity', 1)
    .attr('font-size', `${11.5 * settings.textSize}px`)
    .attr('fill', '#ffffff');
}

function onNodeMouseOut(event, d) {
  d3.select(event.currentTarget)
    .style('fill', resolveNodeFill(d))
    .attr('r', nodeRadius(d))
    .attr('filter', 'url(#glow)');
  state.svgLinks
    ?.attr('stroke', l => l.isLibraryEdge ? 'rgba(200,168,75,0.3)' : 'rgba(160,160,160,0.25)')
    .attr('stroke-width', settings.linkThickness)
    .attr('opacity', 0.7);
  state.svgLabels?.filter(l => l.id === d.id)
    .style('opacity', state.currentZoom >= settings.textFadeThreshold ? 1 : 0)
    .attr('font-size', d => `${(d.isSynthetic ? 12 : 9) * settings.textSize}px`)
    .attr('fill', (d.isCluster || d.isSynthetic) ? '#ffffff' : '#d4d4d4');
}

// ── Render sub-functions ──────────────────────────────────────────────────────
function prepareRenderData(elements) {
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
    x: oldPositions.get(e.data.id)?.x ?? W / 2 + (Math.random() - 0.5) * 200,
    y: oldPositions.get(e.data.id)?.y ?? H / 2 + (Math.random() - 0.5) * 200,
  }));

  const allLinks = edgeData.map(e => ({ source: e.data.source, target: e.data.target, isLibraryEdge: e.data.isLibraryEdge ?? false }));
  const visibleSet = getVisibleNodeIds();
  return { allLinks, visibleSet };
}

function renderLinks(allLinks, visibleSet) {
  return linkG.selectAll('line')
    .data(allLinks)
    .join('line')
    .attr('stroke', d => d.isLibraryEdge ? 'rgba(200,168,75,0.3)' : 'rgba(160,160,160,0.25)')
    .attr('stroke-dasharray', d => d.isLibraryEdge ? '6,3' : null)
    .attr('stroke-width', settings.linkThickness)
    .attr('opacity', 0.7)
    .attr('marker-end', settings.arrows ? 'url(#arrow)' : null)
    .style('display', d => (visibleSet.has(d.source) && visibleSet.has(d.target)) ? null : 'none');
}

function renderNodes(visibleSet) {
  return nodeG.selectAll('circle')
    .data(state.currentNodes.filter(n => !n.isLibrary), d => d.id)
    .join('circle')
    .attr('r', d => nodeRadius(d))
    .style('fill', d => resolveNodeFill(d))
    .attr('stroke', d => resolveNodeStroke(d))
    .attr('stroke-width', d => resolveNodeStrokeWidth(d))
    .attr('filter', 'url(#glow)')
    .attr('cursor', 'pointer')
    .style('display', d => visibleSet.has(d.id) ? null : 'none')
    .call(drag)
    .on('click', (event, d) => {
      event.stopPropagation();
      if (d.isSynthetic) return;
      if (d.isCluster) {
        state.expandedClusters.add(d.id);
        applyComplexity();
        return;
      }
      if (settings.openFunctionPopup) {
        showFuncPopup(d);
      } else if (d.file && d.line > 0) {
        vscode.postMessage({ type: 'navigate', file: d.file, line: d.line });
      }
    })
    .on('mouseover', onNodeMouseOver)
    .on('mouseout', onNodeMouseOut);
}

function renderLabels(visibleSet) {
  return labelG.selectAll('text')
    .data(state.currentNodes.filter(n => !n.isLibrary), d => d.id)
    .join('text')
    .text(d => d.label)
    .attr('font-size', d => `${(d.isSynthetic ? 12 : 9) * settings.textSize}px`)
    .attr('fill', d => (d.isCluster || d.isSynthetic) ? '#ffffff' : '#d4d4d4')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', d => (d.isCluster || d.isSynthetic) ? 'middle' : 'auto')
    .attr('pointer-events', 'none')
    .style('display', d => visibleSet.has(d.id) ? null : 'none')
    .style('opacity', state.currentZoom >= settings.textFadeThreshold ? 1 : 0)
    .style('text-decoration', d =>
      state.gitMode && (d.gitStatus?.unstaged === 'deleted' || d.gitStatus?.staged === 'deleted') ? 'line-through' : null
    );
}

function startSimulation(allLinks) {
  if (state.pendingReheat && state.simulation) {
    state.pendingReheat = false;
    state.simulation.nodes(state.currentNodes);
    state.simulation.force('link').links(allLinks);
    state.simulation.alpha(0.1).restart();
    return;
  }
  if (state.simulation) state.simulation.stop();
  const svgEl = svg.node();
  const W = svgEl.clientWidth || window.innerWidth;
  const H = svgEl.clientHeight || window.innerHeight;
  state.simulation = d3.forceSimulation(state.currentNodes)
    .force('link', d3.forceLink(allLinks).id(d => d.id)
      .distance(() => settings.linkDistance)
      .strength(d => d.isLibraryEdge ? settings.linkForce * 0.1 * 0.3 : settings.linkForce * 0.1))
    .force('charge', d3.forceManyBody().strength(-settings.repelForce))
    .force('center', d3.forceCenter(W / 2, H / 2).strength(settings.centerForce))
    .force('collision', d3.forceCollide(d => nodeRadius(d) + 1))
    .velocityDecay(0.3)
    .alphaDecay(0.02)
    .on('tick', ticked);
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
    .attr('fill', '#c8a84b')
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
      d3.select(event.currentTarget).attr('fill', '#f0d080');
      state.svgLinks
        ?.attr('stroke', l => (l.source?.id ?? l.source) === d.id || (l.target?.id ?? l.target) === d.id
          ? '#f0d080' : l.isLibraryEdge ? 'rgba(200,168,75,0.3)' : 'rgba(160,160,160,0.25)')
        .attr('opacity', l => (l.source?.id ?? l.source) === d.id || (l.target?.id ?? l.target) === d.id
          ? 1 : 0.15);
    })
    .on('mouseout', (event, d) => {
      d3.select(event.currentTarget).attr('fill', '#c8a84b');
      state.svgLinks
        ?.attr('stroke', l => l.isLibraryEdge ? 'rgba(200,168,75,0.3)' : 'rgba(160,160,160,0.25)')
        .attr('opacity', 0.7);
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
function renderElements(elements) {
  const { allLinks, visibleSet } = prepareRenderData(elements);
  state.svgLinks = renderLinks(allLinks, visibleSet);
  state.svgNodes = renderNodes(visibleSet);
  state.svgLabels = renderLabels(visibleSet);
  const libNodeData = state.currentNodes.filter(n => n.isLibrary);
  state.svgLibNodes = renderLibraryNodes(libNodeData, visibleSet);
  state.svgLibLabels = renderLibraryLabels(libNodeData, visibleSet);
  startSimulation(allLinks);
  if (state.folderMode) {
    const nodesByFile    = groupByFile(state.currentNodes);
    const folderTree     = buildFolderTree(nodesByFile);

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
        .attr('rx', 8).attr('stroke-width', 1.5).attr('pointer-events', 'all');
      d3.select(this).select('.folder-bubble-titlebar')
        .attr('pointer-events', 'all').attr('cursor', 'grab');
      d3.select(this).select('.folder-bubble-label')
        .attr('font-size', `${(12 + 6 / (d.depth + 1)) * settings.textSize}px`)
        .attr('text-anchor', 'middle').attr('font-weight', '600')
        .attr('dominant-baseline', 'central')
        .attr('fill', '#cccccc').attr('pointer-events', 'none');
    });

    state.svgFileCircles.call(createFileDrag()).on('mousemove', onFileHoverMove);
    state.svgFolderBubbles.select('.folder-bubble-titlebar').call(createFolderDrag());
    state.svgFolderBubbles.select('.folder-bubble-shape').call(createFolderResizeDrag());
    state.svgFolderBubbles.on('mousemove', onFolderHoverMove);

    state.simulation.force('fileCluster', createFileClusterForce(nodesByFile));
    state.simulation.force('folderSeparation', createFolderSeparationForce(folderTree, nodesByFile));
  } else {
    fileG.selectAll('*').remove();
    folderG.selectAll('*').remove();
    state.svgFileCircles   = null;
    state.svgFolderBubbles = null;
    state.simulation?.force('fileCluster', null);
    state.simulation?.force('folderSeparation', null);
  }
  if (state.classMode) {
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

  if (state.gitMode) applyGitColors();
}
