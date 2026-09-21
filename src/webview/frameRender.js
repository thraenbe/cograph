// frameRender.js — the frames layout engine's render path. Called from
// rendering.js renderElements when usesFrames() is true; everything else in
// the webview (filters, git colours, hover, popups, save) keeps working on
// the flat selections this module publishes on state.svg*.
//
// Coordinates are hybrid: node DATA (n.x/n.y/fx/fy) stays absolute, each frame
// renders in a translated <g> and per-node DOM writes subtract the frame
// origin. Moving a frame is one transform write + a data-only delta.

function usesFrames() {
  return state.layoutEngine === 'shelf'
    && typeof isDrilldown === 'function' && isDrilldown();
}

// Module-lifetime render state (webview singleton, like rendering.js layers).
const __fr = {
  sched: null,
  sims: new Map(),        // frame path -> SimRecord (localSim)
  frameSel: new Map(),    // frame path -> d3 selection of its <g.frame>
  byId: new Map(),        // node id -> node object (current render)
  cross: [],              // cross-frame link objects (current render)
  members: new Map(),     // frame path -> member records (current render)
  crossFor: null,         // the __fr.cross array the two caches below were built from
  crossAgg: null,         // aggregated frame pairs (crossLinks.aggregateCrossPairs)
  crossByNode: null,      // node id -> cross links (hover lookup)
  posDirty: new Set(),    // frame paths awaiting a coalesced position write
  posRaf: 0,
  hoverDrawn: false,      // cross-hover lines currently in the DOM
};

function frInnerOrigin(f) { return innerOrigin(f); } // frames.js global

const FR_APPLY_BUDGET_MS = 1;

// ── Simulation transport (sync localSim | worker pool, see simBackend.js) ─────
function simApi() {
  if (!__fr.backend) {
    const cfg = (typeof window !== 'undefined' && window.COGRAPH_CONFIG) || {};
    const syncApi = {
      kind: 'sync', createSim, tickSim, pin, release, applySettings,
      resizeSim, updateSlots, destroySim, alphaOf, unsettle,
    };
    if (typeof createSimBackend !== 'function') { __fr.backend = { api: () => syncApi }; return syncApi; }
    __fr.backend = createSimBackend({
      mode: cfg.workers, workerUri: cfg.workerUri, syncApi,
      env: {
        Worker: (typeof Worker !== 'undefined') ? Worker : undefined,
        fetch: (typeof fetch === 'function') ? (u) => fetch(u) : undefined,
        Blob: (typeof Blob !== 'undefined') ? Blob : undefined,
        createObjectURL: (typeof URL !== 'undefined' && URL.createObjectURL) ? (b) => URL.createObjectURL(b) : undefined,
        hardwareConcurrency: (typeof navigator !== 'undefined') ? navigator.hardwareConcurrency : undefined,
      },
      onPositions: () => { if (__fr.sched) { __fr.sched.wake(); } },
      onFallback: onSimBackendFallback,
      log: (entry) => { if (typeof vscode !== 'undefined') { vscode.postMessage({ type: 'webview-log', entry }); } },
    });
  }
  return __fr.backend.api();
}

/** The worker pool died: rebuild every record on the synchronous transport. */
function onSimBackendFallback() {
  for (const [path, rec] of [...__fr.sims]) {
    rec.gen = -1;                       // proxy records: nothing left to notify
    __fr.sims.delete(path);
    if (__fr.sched) { __fr.sched.remove(path); }
  }
  if (state.frames && usesFrames()) { syncFrameSims(__fr.members); }
}

function ensureFrameScheduler() {
  if (__fr.sched) { return __fr.sched; }
  __fr.sched = createScheduler({
    raf: (cb) => requestAnimationFrame(cb),
    caf: (h) => cancelAnimationFrame(h),
    now: () => performance.now(),
    // Sync: ≤4 simulations tick per animation frame. Workers: every frame that
    // received fresh positions may be drained.
    maxActive: () => (simApi().kind === 'worker' ? Infinity : 4),
    tick: (rec) => simApi().tickSim(rec),
    beforeTick: (rec) => {
      const f = state.frames && state.frames.byPath.get(rec.path);
      if (f) { syncPins(rec, frInnerOrigin(f), simApi()); }
    },
    onPauseChange: (paused) => { const a = simApi(); if (a.setPaused) { a.setPaused(paused); } },
    // Nothing free to move (no members, or every member pinned): settle at once.
    isInert: (rec) => !rec.nodes.some(n => n.fx == null),
    // Per-step work touches ONLY the frames that ticked. File slots and
    // cross-link bundles depend on frame geometry alone, which does not
    // move during settle — they update on render / frame moves.
    // onResult (not onTick) so the DOM writes count against the step budget.
    onResult: (r) => applySimResult(r),
    // Workers: applying positions is the only main-thread cost left — cap it
    // per animation frame; unpainted inboxes keep just the newest positions.
    budgetMs: () => (simApi().kind === 'worker' ? FR_APPLY_BUDGET_MS : Infinity),
    // perf.js hooks — each is one boolean check while perfLog is off.
    onWake: () => { if (typeof perfMark === 'function') { perfMark('sim:start'); } },
    onStep: (ms) => {
      if (typeof perfTick === 'function') { perfTick(ms); perfFrame(ms); }
    },
    onIdle: () => { if (typeof perfSettled === 'function') { perfSettled(); } },
  });
  return __fr.sched;
}

/** Write a simulation result's local positions back to the absolute node data
 *  and refresh that frame's DOM. */
function applySimResult(r) {
  const f = state.frames && state.frames.byPath.get(r.path);
  if (!f) { return; }
  applySimData(r, f);
  // Frame geometry does not move during settle: positions only, no chrome.
  tickFramePositions(r.path);
  if (state._frameHoverId != null) { updateCrossHover(); }
}

function applySimData(r, f) {
  const io = frInnerOrigin(f);
  for (const ln of r.nodes) {
    const sn = ln._ref;
    if (!sn) { continue; }
    sn.x = io.x + ln.x;
    sn.y = io.y + ln.y;
  }
}

// ── Main render entry (called from renderElements) ────────────────────────────
function renderFrameLayout(allLinks, visibleSet) {
  const tree = state.structureTree;
  // Clear the global-path layers this engine replaces (engine switches must
  // never leave duplicate nodes in two layers).
  nodeG.selectAll('*').remove();
  labelG.selectAll('*').remove();
  folderG.selectAll('*').remove();
  classG.selectAll('*').remove();
  libNodeG.selectAll('*').remove();
  libLabelG.selectAll('*').remove();
  linkG.selectAll('line:not(.cross-bundle):not(.cross-hover)').remove();
  state.svgFolderBubbles = null;
  state.svgDrilldownBoxes = null;
  state.svgClassBubbles = null;
  state.svgLibNodes = null;
  state.svgLibLabels = null;
  if (state.simulation && !state.simulation.isFrameFacade) { state.simulation.stop(); }
  state.pendingReheat = false;

  // 1) Frames from the current visible members.
  const members = collectMembers(state.currentNodes, tree, settings.nodeSize);
  const upd = updateFrames(state.frames, tree, state.expandedFolders, members);
  state.frames = upd.frames;
  __fr.members = members;
  __fr.byId = new Map(state.currentNodes.map(n => [n.id, n]));
  if (applyPendingLayout()) { return; } // saved expansion differs → re-render scheduled
  setFrameSliderNoops(true);

  // 2) Ownership stamp (includes per-file partition frames).
  const frameOfId = new Map();
  for (const [path, mems] of members) {
    if (!state.frames.byPath.has(path)) { continue; }
    for (const m of mems) {
      frameOfId.set(m.id, path);
      m._ref = __fr.byId.get(m.id) || null;
    }
  }
  for (const n of state.currentNodes) { n._frame = frameOfId.get(n.id) ?? null; }

  // 3) Frame groups (parents before children in DOM → children paint on top).
  const depthOf = (f) => f.path.split(/[\\/]+/).length;
  const frameData = [...state.frames.byPath.values()]
    .sort((a, b) => depthOf(a) - depthOf(b) || (a.path < b.path ? -1 : 1));
  const sel = frameG.selectAll('g.frame').data(frameData, f => f.path).join(
    enter => {
      const grp = enter.append('g').attr('class', 'frame');
      grp.append('rect').attr('class', 'folder-bubble-shape')
        .attr('rx', 8).attr('stroke-width', 1.5).attr('pointer-events', 'all');
      grp.append('rect').attr('class', 'folder-bubble-titlebar')
        .attr('rx', 8).attr('pointer-events', 'all').attr('cursor', 'grab');
      grp.append('text').attr('class', 'folder-bubble-label')
        .attr('text-anchor', 'middle').attr('font-weight', '600')
        .attr('dominant-baseline', 'central').attr('pointer-events', 'none');
      grp.append('g').attr('class', 'f-slots');
      grp.append('g').attr('class', 'f-links');
      grp.append('g').attr('class', 'f-nodes');
      grp.append('g').attr('class', 'f-labels');
      return grp;
    },
    update => update,
    exit => exit.remove(),
  );
  sel.order();
  __fr.frameSel = new Map();
  sel.each(function (f) {
    const grp = d3.select(this);
    __fr.frameSel.set(f.path, grp); // sub-selections cached after the joins below
  });
  __fr.visCache = visibleSet;
  sel.select('.folder-bubble-label')
    .attr('font-size', `${12 * settings.textSize}px`)
    .attr('fill', (typeof isLightTheme === 'function' && isLightTheme()) ? '#333333' : '#cccccc');
  sel.select('.folder-bubble-titlebar').call(createFrameTitleDrag(frameDragDeps()));
  sel.select('.folder-bubble-shape').call(createFrameResizeDrag());
  sel.on('contextmenu', onFrameContextMenu);

  // 4) Per-frame nodes/labels + intra links; cross links in the top layer.
  const { intra, cross } = splitEdgesByFrame(allLinks, id => frameOfId.get(id) ?? null);
  __fr.cross = cross;
  __fr.intraByFrame = intra;
  for (const l of allLinks) {
    l._s = __fr.byId.get(typeof l.source === 'object' ? l.source.id : l.source) || null;
    l._t = __fr.byId.get(typeof l.target === 'object' ? l.target.id : l.target) || null;
  }
  __fr.frameDom = new Map();
  for (const f of frameData) {
    const sub = __fr.frameSel.get(f.path);
    const memberNodes = (members.get(f.path) || []).map(m => m._ref).filter(Boolean);
    renderFrameSlots(f, sub);
    const circles = renderNodes(visibleSet, memberNodes, sub.select('g.f-nodes'));
    const clouds = renderCloudNodes(visibleSet, memberNodes, sub.select('g.f-nodes'));
    const labels = renderLabels(visibleSet, memberNodes, sub.select('g.f-labels'));
    const links = renderLinks(intra.get(f.path) || [], visibleSet, sub.select('g.f-links'));
    links.attr('opacity', d => d.pending ? 0.25 : linkRestOpacity());
    __fr.frameDom.set(f.path, { sub, circles, clouds, labels, links });
    if (f.kind === 'root') {
      // Subtle dashed outline + name: root-level files stop looking like
      // stray debris floating outside every frame.
      sub.select('.folder-bubble-shape')
        .style('display', null)
        .attr('fill', 'none')
        .attr('stroke-dasharray', '6 5')
        .attr('stroke-opacity', 0.25)
        .attr('pointer-events', 'none');
      sub.select('.folder-bubble-titlebar').style('display', 'none');
      sub.select('.folder-bubble-label')
        .style('display', null)
        .attr('text-anchor', 'start')
        .attr('opacity', 0.5);
    }
  }

  // 5) Flat selections for every existing consumer (filters, git, hover…).
  state.svgNodes = frameG.selectAll('circle.regular-node');
  state.svgCloudNodes = frameG.selectAll('path.cloud-node');
  state.svgLabels = frameG.selectAll('g.f-labels text');
  state.svgLinks = frameG.selectAll('g.f-links line');

  // 6) The per-file grouping is the slot rects above — the bounding-circle
  // overlay would just draw halos across frames, so it stays empty here.
  fileG.selectAll('*').remove();
  state.svgFileCircles = null;

  // 7) Deterministic placement: any member without a live position inside its
  // slot is grid-placed (Static keeps it; Dynamic uses it as the seed).
  placeMembersInSlots(members);

  // 8) Simulations + facade. Static = scheduler paused: zero ticks, the grid
  // IS the layout until the user switches the motion toggle to Dynamic.
  syncFrameSims(members);
  if (__fr.sched) {
    if (state.layoutMode === 'static') { __fr.sched.pauseAll(); }
    else { __fr.sched.resumeAll(); __fr.sched.wake(); }
  }

  tickFrames();
  if (!state.hasFitted) { state.hasFitted = true; fitToView(); }
}

function frameDragDeps() {
  return {
    frames: () => state.frames,
    framePaths: () => [...state.frames.byPath.keys()],
    nodesOf: (path) => (__fr.members.get(path) || []).map(m => m._ref).filter(Boolean),
    pin: (fs, path, pos) => pinFrame(fs, path, pos),
    origin: frInnerOrigin,
    onMoved: (path) => { tickFrame(path); updateCrossLinks(); },
  };
}

function onFrameContextMenu(event, f) {
  if (f.kind === 'root' || typeof showContextMenu !== 'function') { return; }
  event.preventDefault();
  event.stopPropagation();
  const fp = f.path;
  const shortName = fp.split(/[\\/]+/).filter(Boolean).pop() || fp;
  const items = [
    { label: `${shortName} (Folder)`, isHeader: true },
    { label: 'Elapse folder', action: () => { if (typeof elapseFolder === 'function') { elapseFolder(fp); } } },
    { label: 'Collapse folder', action: () => { if (typeof collapseFolder === 'function') { collapseFolder(fp); } } },
    { label: 'Only show this folder', action: () => { state.onlyShowFolder = fp; applyFilters(); updateFolderPanel(); } },
    { label: 'Hide folder', action: () => { state.hiddenFolders.add(fp); applyFilters(); updateFolderPanel(); } },
    { label: 'Go to folder', action: () => vscode.postMessage({ type: 'navigate', file: fp, line: 1 }) },
  ];
  if (state.hiddenFolders.size > 0 || state.onlyShowFolder) {
    items.push({ label: 'Show all', action: () => { state.hiddenFolders.clear(); state.onlyShowFolder = null; applyFilters(); updateFolderPanel(); } });
  }
  showContextMenu(event, items);
}

// ── Simulations ───────────────────────────────────────────────────────────────
function syncFrameSims(members) {
  const sched = ensureFrameScheduler();
  const api = simApi();
  const alive = new Set();
  for (const [path, f] of state.frames.byPath) {
    const mems = members.get(path) || [];
    if (!mems.length) { continue; }
    alive.add(path);
    const intraLinks = intraLinkIdsFor(path);
    const slots = slotInteriors(f, mems);
    const existing = __fr.sims.get(path);
    const same = existing && existing.gen !== -1
      && existing.byId.size === mems.length && mems.every(m => existing.byId.has(m.id));
    if (same) {
      if (existing.inner.w !== f.inner.w || existing.inner.h !== f.inner.h) {
        api.resizeSim(existing, f.inner);
      }
      if (!sameSlotGeometry(slots, existing.slotById)) {
        api.updateSlots(existing, slots);   // geometry changed → clamp + reheat
      } else {
        existing.slotById = slots;          // identical geometry → refresh reference
      }
      continue;
    }
    if (existing) { api.destroySim(existing); sched.remove(path); }
    // Seed local positions from current absolute ones when they already lie
    // inside the frame (continuity); everything else starts on the spiral.
    const io = frInnerOrigin(f);
    const seed = new Map();
    for (const m of mems) {
      const sn = m._ref;
      if (!sn || !Number.isFinite(sn.x)) { continue; }
      const lx = sn.x - io.x, ly = sn.y - io.y;
      if (lx > -f.inner.w * 0.25 && lx < f.inner.w * 1.25
        && ly > -f.inner.h * 0.25 && ly < f.inner.h * 1.25) {
        seed.set(m.id, { x: lx, y: ly });
      }
    }
    const rec = api.createSim(f, mems, intraLinks, settings,
      { d3: (typeof d3 !== 'undefined') ? d3 : null, paused: sched.isPaused() || state.layoutMode === 'static' },
      seed, slots);
    __fr.sims.set(path, rec);
    sched.add(rec, { expanded: true });
    applySimData(rec, f); // first paint already inside the frame
  }
  for (const [path, rec] of [...__fr.sims]) {
    if (!alive.has(path)) { api.destroySim(rec); __fr.sims.delete(path); sched.remove(path); }
  }
  state.simulation = createFrameSimFacade({
    sched,
    getSims: () => __fr.sims,
    getNodes: () => state.currentNodes,
    getSettings: () => settings,
    ls: { applySettings: (r, p) => simApi().applySettings(r, p), unsettle: (r, a) => simApi().unsettle(r, a) },
    alphaOf: (r) => simApi().alphaOf(r),
  });
  state.simulation._kind = 'frames';
}

/** Slot maps equal by geometry — no sorting or string building per render. */
function sameSlotGeometry(a, b) {
  const na = a ? a.size : 0, nb = b ? b.size : 0;
  if (na !== nb) { return false; }
  if (!na) { return true; }
  for (const [k, r] of a) {
    const q = b.get(k);
    if (!q || q.x !== r.x || q.y !== r.y || q.w !== r.w || q.h !== r.h) { return false; }
  }
  return true;
}

function intraLinkIdsFor(path) {
  const out = [];
  const idOf = (e) => (typeof e === 'object' && e !== null) ? e.id : e;
  for (const l of (__fr.intraByFrame && __fr.intraByFrame.get(path)) || []) {
    out.push({ source: idOf(l.source), target: idOf(l.target) });
  }
  return out;
}

// ── Per-tick DOM writes ───────────────────────────────────────────────────────
// Chrome (transform, rect, colours, title) changes only on render / frame
// move / resize / settings; member positions change on every simulation step.
// tickFrame = both; the scheduler and node drags use tickFramePositions alone.
function tickFrame(path) {
  tickFrameChrome(path);
  tickFramePositions(path);
}

function tickFrameChrome(path) {
  const f = state.frames && state.frames.byPath.get(path);
  const sub = __fr.frameSel.get(path);
  if (!f || !sub) { return; }
  sub.attr('transform', `translate(${f.abs.x},${f.abs.y})`);
  if (f.kind === 'root') {
    sub.select('.folder-bubble-shape')
      .attr('x', 0).attr('y', 0).attr('width', f.abs.w).attr('height', f.abs.h)
      .attr('stroke', (typeof isLightTheme === 'function' && isLightTheme()) ? '#666666' : '#9fb0c3');
    sub.select('.folder-bubble-label')
      .attr('x', 10).attr('y', -10)
      .text(f.path.split(/[\\/]+/).filter(Boolean).pop() || f.path);
  }
  if (f.kind !== 'root') {
    const depth = (state.structureTree.folders[f.path]?.depth) ?? 1;
    const hue = (typeof ddHue === 'function') ? ddHue(f.path) : 0;
    sub.select('.folder-bubble-shape')
      .attr('x', 0).attr('y', 0).attr('width', f.abs.w).attr('height', f.abs.h)
      .attr('fill', folderFillColor(depth, hue))
      .attr('stroke', folderStrokeColor(depth, hue));
    sub.select('.folder-bubble-titlebar')
      .attr('x', 0).attr('y', 0).attr('width', f.abs.w).attr('height', 30)
      .attr('fill', folderTitlebarColor(depth, hue));
    sub.select('.folder-bubble-label')
      .attr('x', f.abs.w / 2).attr('y', 15)
      .text(f.path.split(/[\\/]+/).filter(Boolean).pop() || f.path);
  }
}

function tickFramePositions(path) {
  const f = state.frames && state.frames.byPath.get(path);
  const sub = __fr.frameSel.get(path);
  if (!f || !sub) { return; }
  const ox = f.abs.x, oy = f.abs.y;
  const dom = __fr.frameDom && __fr.frameDom.get(path);
  const circles = dom ? dom.circles : sub.select('g.f-nodes').selectAll('circle.regular-node');
  const clouds = dom ? dom.clouds : sub.select('g.f-nodes').selectAll('path.cloud-node');
  const labels = dom ? dom.labels : sub.select('g.f-labels').selectAll('text');
  const links = dom ? dom.links : sub.select('g.f-links').selectAll('line');
  circles.each(function (d) {
    this.setAttribute('cx', d.x - ox);
    this.setAttribute('cy', d.y - oy);
  });
  clouds.each(function (d) {
    this.setAttribute('transform', `translate(${d.x - ox},${d.y - oy})`);
  });
  labels.each(function (d) {
    const below = d.isFolderCluster || d.isFileCluster;
    const y = (below ? d.y + nodeRadius(d) + 6
      : (d.isCluster || d.isSynthetic) ? d.y
        : d.y + nodeRadius(d) + 10) - oy;
    const x = d.x - ox;
    this.setAttribute('x', x);
    this.setAttribute('y', y);
    for (let i = 0; i < this.children.length; i++) { this.children[i].setAttribute('x', x); }
  });
  links.each(function (d) {
    const s = d._s, t = d._t;
    if (!s || !t) { return; }
    const dx = t.x - s.x, dy = t.y - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const r1 = nodeRadius(s), r2 = nodeRadius(t);
    this.setAttribute('x1', s.x + (dx / dist) * r1 - ox);
    this.setAttribute('y1', s.y + (dy / dist) * r1 - oy);
    this.setAttribute('x2', t.x - (dx / dist) * r2 - ox);
    this.setAttribute('y2', t.y - (dy / dist) * r2 - oy);
  });
}

/**
 * Node-drag fast path (rendering.js ticked(d)): only the dragged node's frame
 * changes, so re-write that frame's positions — coalesced to one write per
 * animation frame — instead of re-ticking every frame and all cross links.
 */
function tickFrameOfNode(d) {
  const path = d && d._frame;
  if (!path || !__fr.frameSel.has(path)) { tickFrames(); return; }
  __fr.posDirty.add(path);
  if (__fr.posRaf) { return; }
  if (typeof requestAnimationFrame !== 'function') { flushFramePositions(); return; }
  __fr.posRaf = requestAnimationFrame(flushFramePositions);
}

function flushFramePositions() {
  __fr.posRaf = 0;
  const __perfT0 = (typeof perfBegin === 'function') ? perfBegin() : 0;
  for (const path of __fr.posDirty) { tickFramePositions(path); }
  __fr.posDirty.clear();
  if (state._frameHoverId != null) { updateCrossHover(); }
  if (__perfT0) { perfEnd('drag:flush', __perfT0); }
}

function tickFrames() {
  if (!state.frames) { return; }
  const __perfT0 = (typeof perfBegin === 'function') ? perfBegin() : 0;
  for (const path of __fr.frameSel.keys()) { tickFrame(path); }
  updateCrossLinks();
  if (__perfT0) { perfEnd('tickFrames', __perfT0); }
}

// ── Cross-frame links (aggregated bundles between title-bar ports) ────────────
// Bundles depend on frame geometry only (render / frame move / resize); the
// hovered node's individual links depend on the hover id and node positions.
// The pair aggregation and the per-node index are cached per render.
function updateCrossLinks() {
  if (!state.frames || !usesFrames()) {
    linkG.selectAll('line.cross-bundle').remove();
    linkG.selectAll('line.cross-hover').remove();
    __fr.hoverDrawn = false;
    return;
  }
  const __perfT0 = (typeof perfBegin === 'function') ? perfBegin() : 0;
  updateCrossBundles();
  updateCrossHover();
  if (__perfT0) { perfEnd('updateCrossLinks', __perfT0); }
}

function crossCaches() {
  const cross = __fr.cross || [];
  if (__fr.crossFor !== cross) {
    __fr.crossFor = cross;
    __fr.crossAgg = aggregateCrossPairs(cross, crossFrameOfId);
    __fr.crossByNode = indexCrossByNode(cross);
  }
  return __fr;
}

function crossFrameOfId(id) {
  const n = __fr.byId.get(id);
  return n ? n._frame : null;
}

function crossFrameAt(p) {
  const f = state.frames.byPath.get(p);
  if (!f) { return null; }
  const titleRect = f.kind === 'root'
    ? { x: f.abs.x, y: f.abs.y, w: f.abs.w, h: 0 }
    : titleBarRect(f);
  return { abs: f.abs, titleRect };
}

function updateCrossBundles() {
  const bundles = routeBundles(crossCaches().crossAgg, crossFrameAt);
  const linkDefault = getCSSVar('--cograph-link-default');
  linkG.selectAll('line.cross-bundle').data(bundles, d => d.key).join('line')
    .attr('class', 'cross-bundle')
    .attr('stroke', linkDefault)
    .attr('stroke-width', d => settings.linkThickness * edgeWeightScale(d.count))
    .attr('stroke-dasharray', d => d.pending ? '4,3' : null)
    .attr('opacity', 0.55)
    .attr('marker-end', settings.arrows ? 'url(#arrow)' : null)
    .attr('x1', d => d.x1).attr('y1', d => d.y1)
    .attr('x2', d => d.x2).attr('y2', d => d.y2)
    .each(function (d) {
      let t = this.querySelector('title');
      if (!t) { t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); this.appendChild(t); }
      t.textContent = d.pending ? `${d.count}+ calls (parsing…)` : `${d.count} calls`;
    });
}

/** The hovered node's individual cross links — O(degree) via the node index. */
function updateCrossHover() {
  if (!state.frames || !usesFrames()) { return; }
  const hoverId = state._frameHoverId ?? null;
  const touching = hoverId == null ? [] : (crossCaches().crossByNode.get(hoverId) || []);
  const individual = individualLinksFor(touching, hoverId,
    id => { const n = __fr.byId.get(id); return n ? { x: n.x, y: n.y } : null; });
  if (!individual.length && !__fr.hoverDrawn) { return; }
  __fr.hoverDrawn = individual.length > 0;
  // pointer-events none (F10): these lines start at the hovered glyph, i.e.
  // under the cursor. As event targets they stole the hover → mouseout →
  // removed → mouseover → redrawn, ~30 times per second.
  linkG.selectAll('line.cross-hover').data(individual).join('line')
    .attr('class', 'cross-hover')
    .attr('pointer-events', 'none')
    .attr('stroke', getCSSVar('--cograph-link-hover'))
    .attr('stroke-width', Math.max(1.5, settings.linkThickness))
    .attr('opacity', 0.9)
    .attr('marker-end', settings.arrows ? 'url(#arrow)' : null)
    .attr('x1', d => d.x1).attr('y1', d => d.y1)
    .attr('x2', d => d.x2).attr('y2', d => d.y2);
}

// ── Teardown (leaving the frames engine / drill-down) ─────────────────────────
function teardownFrames() {
  setFrameSliderNoops(false);
  if (__fr.sched) { __fr.sched.stop(); }
  for (const rec of __fr.sims.values()) { simApi().destroySim(rec); }
  __fr.sims.clear();
  __fr.frameSel.clear();
  if (__fr.frameDom) { __fr.frameDom.clear(); }
  __fr.cross = [];
  __fr.visCache = null;
  frameG.selectAll('*').remove();
  linkG.selectAll('line.cross-bundle').remove();
  linkG.selectAll('line.cross-hover').remove();
  if (state.simulation && state.simulation.isFrameFacade) {
    state.simulation = null;
    state.pendingReheat = false;
  }
  // state.frames is kept: returning from workflow/global restores stable rects.
}

/** Drop every packed rect so the next render re-packs from scratch. */
function resetFrames() {
  teardownFrames();
  state.frames = null;
}

/** Grid-place every member whose absolute position is missing or outside its
 *  slot interior. Positions already inside their slot (drags, saved layouts,
 *  settled sims) are left alone. */
function placeMembersInSlots(members) {
  for (const [path, mems] of members) {
    const f = state.frames.byPath.get(path);
    if (!f) { continue; }
    const io = frInnerOrigin(f);
    // Group by slot, preserving member order (file/line order).
    const bySlot = new Map();
    for (const m of mems) {
      const key = f.slotOf && f.slotOf.get(m.id);
      if (!key) { continue; }
      if (!bySlot.has(key)) { bySlot.set(key, []); }
      bySlot.get(key).push(m);
    }
    for (const group of bySlot.values()) {
      const interior = slotInteriorFor(f, group[0].id);
      if (!interior) { continue; }
      const absRect = { x: io.x + interior.x, y: io.y + interior.y, w: interior.w, h: interior.h };
      const loose = group.filter(m => {
        const sn = m._ref;
        return !sn || !Number.isFinite(sn.x)
          || sn.x < absRect.x || sn.x > absRect.x + absRect.w
          || sn.y < absRect.y || sn.y > absRect.y + absRect.h;
      });
      if (!loose.length) { continue; }
      const grid = gridPositions(loose, absRect);
      for (const m of loose) {
        const sn = m._ref;
        const p = grid.get(m.id);
        if (sn && p) { sn.x = p.x; sn.y = p.y; }
      }
    }
  }
}

// ── Saved layouts (v2 frames / v1 migration) ──────────────────────────────────
/** Consume state.savedLayout as its pieces become applicable. Returns true
 *  when the saved expansion differs and a re-render was scheduled. */
function applyPendingLayout() {
  const p = state.savedLayout;
  if (!p || !state.frames) { return false; }
  if (!p._metaApplied) {
    p._metaApplied = true;
    if (p.settings && p.settings.detailDepth != null) {
      state.detailDepth = p.settings.detailDepth;
      if (typeof setDetailSlider === 'function') { setDetailSlider(state.detailDepth); }
    }
    if (Array.isArray(p.expandedFolders)) {
      const want = new Set(p.expandedFolders);
      const differs = want.size !== state.expandedFolders.size
        || [...want].some(x => !state.expandedFolders.has(x));
      if (differs) {
        state.expandedFolders = want;
        if (typeof requestParseForExpanded === 'function') { requestParseForExpanded(); }
        Promise.resolve().then(() => {
          if (typeof applyFileClusters === 'function') { applyFileClusters(); }
        });
        return true;
      }
    }
  }
  if (p.frames) {
    const subset = {};
    let applied = 0;
    for (const path in p.frames) {
      if (state.frames.byPath.has(path)) { subset[path] = p.frames[path]; applied++; }
    }
    if (applied) {
      deserializeFrames(subset, state.frames);
      for (const path in subset) { delete p.frames[path]; }
    }
    if (Object.keys(p.frames).length === 0) { delete p.frames; }
  } else if (p.nodePositions && !p._v1Applied) {
    p._v1Applied = true;
    migrateV1IntoFrames(p, state.frames);
  }
  if (!p.frames) { state.savedLayout = null; }
  return false;
}

/** v1 layouts carry only absolute node positions: derive each frame's rect
 *  from the bounding box of its members' saved positions and pin it. */
function migrateV1IntoFrames(payload, fs) {
  const entries = [...fs.byPath.values()]
    .filter(f => f.kind !== 'root')
    .sort((a, b) => a.path.split(/[\/]+/).length - b.path.split(/[\/]+/).length);
  for (const f of entries) {
    const mems = __fr.members.get(f.path) || [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = 0;
    for (const m of mems) {
      const pos = payload.nodePositions[m.id];
      if (!pos) { continue; }
      found++;
      minX = Math.min(minX, pos.x - m.r); maxX = Math.max(maxX, pos.x + m.r);
      minY = Math.min(minY, pos.y - m.r); maxY = Math.max(maxY, pos.y + m.r);
    }
    if (!found) { continue; }
    const parent = fs.byPath.get(f.parent);
    const io = parent ? frInnerOrigin(parent) : { x: 0, y: 0 };
    const local = {
      x: Math.max(0, minX - FRAME.PAD - io.x),
      y: Math.max(0, minY - FRAME.PAD - FRAME.TITLE - io.y),
    };
    const size = {
      w: (maxX - minX) + 2 * FRAME.PAD,
      h: (maxY - minY) + 2 * FRAME.PAD + FRAME.TITLE,
    };
    pinFrame(fs, f.path, local, size);
  }
}

// ── Frame resize (border drag on the frame box) ───────────────────────────────
function createFrameResizeDrag() {
  const EDGE = 12;
  return d3.drag()
    .container(function () { return g.node(); })
    .filter(function (event, f) {
      const [mx, my] = d3.pointer(event, g.node());
      return (mx - f.abs.x < EDGE) || (f.abs.x + f.abs.w - mx < EDGE)
        || (my - f.abs.y < EDGE) || (f.abs.y + f.abs.h - my < EDGE);
    })
    .on('drag', function (event, f) {
      const w = Math.max(FRAME.MIN_INNER_W + 2 * FRAME.PAD, event.x - f.abs.x);
      const h = Math.max(FRAME.MIN_INNER_H + 2 * FRAME.PAD + FRAME.TITLE, event.y - f.abs.y);
      pinFrame(state.frames, f.path, null, { w, h });
      const rec = __fr.sims.get(f.path);
      const nf = state.frames.byPath.get(f.path);
      if (rec && nf) { simApi().resizeSim(rec, nf.inner); }
      if (__fr.sched) { __fr.sched.wake(); }
      tickFrame(f.path);
      updateCrossLinks();
    })
    .on('end', function () {
      if (typeof window !== 'undefined') { window.markDirty?.(); }
    });
}

// ── File slots (the shelf interior) ───────────────────────────────────────────
function slotSignature(slots) {
  if (!slots || !slots.size) { return ''; }
  const parts = [];
  for (const k of [...slots.keys()].sort()) {
    const r = slots.get(k);
    parts.push(`${k}:${r.x},${r.y},${r.w},${r.h}`);
  }
  return parts.join('|');
}

/** Language colour for a slot's file (dim grey for glyph solo slots). */
function slotColor(file) {
  if (!file) { return '#6b7480'; }
  const lang = (typeof inferLangFromPath === 'function') ? inferLangFromPath(file) : null;
  return (typeof getLanguageColor === 'function' && getLanguageColor(lang)) || '#8fa1b3';
}

function slotBasename(file) {
  const idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return idx >= 0 ? file.substring(idx + 1) : file;
}

/** Static per-file slot rects inside a frame (drawn once per render; the
 *  frame group's transform carries them on moves). */
function renderFrameSlots(f, sub) {
  const off = f.kind === 'root'
    ? { x: 0, y: 0 }
    : { x: FRAME.PAD, y: FRAME.PAD + FRAME.TITLE };
  const data = [];
  for (const [key, s] of (f.slots || new Map())) {
    if (!s.file) { continue; } // glyph solo slots need no chrome
    data.push({ key, ...s,
      x: off.x + f.contentPos.x + s.x,
      y: off.y + f.contentPos.y + s.y,
    });
  }
  const sel = sub.select('g.f-slots').selectAll('g.file-slot')
    .data(data, d => d.key)
    .join(
      enter => {
        const grp = enter.append('g').attr('class', 'file-slot');
        grp.append('rect').attr('class', 'file-slot-shape')
          .attr('rx', 6).attr('stroke-width', 1.2).attr('pointer-events', 'all');
        grp.append('text').attr('class', 'file-slot-label')
          .attr('pointer-events', 'none').attr('font-weight', '600');
        return grp;
      },
      update => update,
      exit => exit.remove(),
    );
  sel.each(function (d) {
    const grp = d3.select(this);
    let color = slotColor(d.file);
    let changed = false;
    if (state.gitMode && state.fileGitStatus) {
      const fgs = state.fileGitStatus[d.file.replace(/\\/g, '/')];
      const st = fgs ? (fgs.unstaged ?? fgs.staged) : null;
      if (st === 'added') { color = '#4caf50'; changed = true; }
      else if (st === 'modified') { color = '#ff9800'; changed = true; }
    }
    grp.select('.file-slot-shape')
      .attr('x', d.x).attr('y', d.y).attr('width', d.w).attr('height', d.h)
      .attr('fill', color).attr('fill-opacity', 0.05)
      .attr('stroke', color).attr('stroke-opacity', changed ? 0.95 : 0.5)
      .attr('stroke-width', changed ? 2 : 1.2)
      .attr('stroke-dasharray', d.count ? null : '4 3');
    grp.select('.file-slot-label')
      .attr('x', d.x + 6).attr('y', d.y + 11)
      .attr('font-size', `${9 * settings.textSize}px`)
      .attr('fill', color).attr('fill-opacity', 0.9)
      .text(d.count ? `${slotBasename(d.file)} · ${d.count}` : slotBasename(d.file));
  });
  sel.on('dblclick', (event, d) => {
    event.stopPropagation();
    vscode.postMessage({ type: 'navigate', file: d.file, line: 1 });
  });
  sel.on('contextmenu', (event, d) => {
    if (typeof showContextMenu !== 'function') { return; }
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(event, [
      { label: slotBasename(d.file), isHeader: true },
      { label: 'Go to File', action: () => vscode.postMessage({ type: 'navigate', file: d.file, line: 1 }) },
    ]);
  });
  return sel;
}

// ── Settings glue ─────────────────────────────────────────────────────────────
/** Grey out the two sliders that have no effect under frames (folder/file
 *  repel — separation is guaranteed by the packer). Handlers stay wired. */
function setFrameSliderNoops(on) {
  if (typeof document === 'undefined') { return; }
  for (const id of ['slider-folder-repel', 'slider-file-repel']) {
    const el = document.getElementById(id);
    if (!el) { continue; }
    el.disabled = on;
    if (el.parentElement) {
      el.parentElement.classList.toggle('is-noop', on);
      el.parentElement.title = on ? 'Not used in framed layout' : '';
    }
  }
}

/** Node-size (and text) changes: refresh sim radii; collide reads d.r live. */
function applyFrameDisplaySettings() {
  for (const rec of __fr.sims.values()) {
    for (const ln of rec.nodes) {
      const sn = ln._ref;
      if (sn) { ln.r = ((sn._size ?? 8) / 2) * settings.nodeSize; }
    }
    simApi().unsettle(rec, 0.1);
  }
  if (__fr.sched) { __fr.sched.wake(); }
}

if (typeof module !== 'undefined') {
  module.exports = {
    usesFrames, renderFrameLayout, tickFrames, tickFrame, tickFrameChrome,
    tickFramePositions, tickFrameOfNode, teardownFrames,
    resetFrames, updateCrossLinks, updateCrossBundles, updateCrossHover, syncFrameSims, applySimResult, applySimData,
    applyPendingLayout, migrateV1IntoFrames, setFrameSliderNoops,
    applyFrameDisplaySettings, createFrameResizeDrag,
    slotSignature, slotColor, slotBasename, renderFrameSlots, sameSlotGeometry,
    __frState: __fr,   // test hook
    placeMembersInSlots,
  };
}
