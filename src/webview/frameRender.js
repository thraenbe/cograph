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
    // Frames on screen get the simulation slots first (W3 culling knows them).
    prefer: (rec) => __cull.culler.isVisible(rec.path),
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
  if (!state.slotPlacedIds) { state.slotPlacedIds = new Set(); }
  for (const ln of r.nodes) {
    const sn = ln._ref;
    if (!sn) { continue; }
    sn.x = io.x + ln.x;
    sn.y = io.y + ln.y;
    state.slotPlacedIds.add(ln.id); // sim-written = deliberately placed
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

  // 1) Frames from the current visible members. The structural scope (round
  // 3: Hide entirely / Only show / subgraph) is applied HERE: out-of-scope
  // folders get no frame, out-of-scope members no slot — the pack then
  // closes the gaps like any expand/collapse.
  const sc = (typeof buildScope === 'function') ? buildScope(state) : null;
  const active = sc && scopeActive(sc);
  const allow = active ? ((d) => memberInScope(d, sc)) : null;
  const folderOk = active ? ((p) => frameFolderVisible(p, sc)) : null;
  // A CHANGED scope re-shelves the affected parents (W2b) — a merely ACTIVE
  // one (e.g. a restored save) keeps the laid-out rects.
  const scopeSig = !active ? '' : JSON.stringify([
    [...sc.hiddenFolders].sort(), sc.onlyShowFolder,
    [...sc.hiddenFiles].sort(), sc.onlyShowFile,
    sc.subgraph ? [[...sc.subgraph.include].sort(), [...(sc.subgraph.exclude || [])].sort()] : null,
  ]);
  const reshelve = __fr.scopeSig !== undefined && __fr.scopeSig !== scopeSig;
  __fr.scopeSig = scopeSig;
  if (reshelve && !state.userZoomed && !state._frameInteracting
    && typeof setTimeout === 'function') {
    // A scope change that SHRINKS the layout leaves the view hanging over
    // empty space (growth is already covered by shouldRefit). Re-fit once
    // after the re-pack glide — never when the user owns the viewport (F2).
    if (__fr.scopeRefit) { clearTimeout(__fr.scopeRefit); }
    __fr.scopeRefit = setTimeout(() => {
      __fr.scopeRefit = null;
      if (!state.userZoomed && !state._frameInteracting) { fitToView(); }
    }, 230);
  }
  const members = collectMembers(state.currentNodes, tree, settings.nodeSize, allow);
  const prevAbs = new Map();
  if (state.frames && state.frames.byPath) {
    for (const [p2, f2] of state.frames.byPath) {
      if (f2.abs) { prevAbs.set(p2, { x: f2.abs.x, y: f2.abs.y }); }
    }
  }
  const upd = updateFrames(state.frames, tree, state.expandedFolders, members, { folderOk, reshelve });
  state.frames = upd.frames;
  // Re-pack animation: frames that already existed and were MOVED by this
  // layout pass glide to their new spot (drags/sim ticks stay instant).
  __fr.animateMoves = new Set();
  for (const [p2, f2] of upd.frames.byPath) {
    const was = prevAbs.get(p2);
    if (was && f2.abs && (Math.abs(was.x - f2.abs.x) > 0.5 || Math.abs(was.y - f2.abs.y) > 0.5)) {
      __fr.animateMoves.add(p2);
    }
  }
  __fr.members = members;
  __fr.byId = new Map(state.currentNodes.map(n => [n.id, n]));
  if (applyPendingLayout()) { return; } // saved expansion differs → re-render scheduled

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
      grp.append('path').attr('class', 'folder-bubble-shape')
        .attr('stroke-width', 1.5).attr('pointer-events', 'all');
      // Draft A chrome: the tab is purely visual; the transparent titlebar
      // rect below keeps the whole 30px strip as the drag hit-area.
      const tab = grp.append('g').attr('class', 'frame-tab').attr('pointer-events', 'none');
      tab.append('path').attr('class', 'frame-tab-shape');
      tab.append('path').attr('class', 'frame-tab-glyph').attr('d', FOLDER_GLYPH);
      tab.append('text').attr('class', 'frame-tab-counts').attr('text-anchor', 'end');
      grp.append('text').attr('class', 'folder-bubble-label')
        .attr('text-anchor', 'start').attr('font-weight', '600')
        .attr('dominant-baseline', 'central').attr('pointer-events', 'none');
      grp.append('rect').attr('class', 'folder-bubble-titlebar')
        .attr('fill', 'transparent').attr('pointer-events', 'all').attr('cursor', 'grab');
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
  const titleDrag = createFrameTitleDrag(frameDragDeps())
    // The pointer must be measured against the STABLE zoomed layer, never the
    // dragged frame's own <g> (d3-drag's default container is this.parentNode,
    // which moves with the drag → feedback loop, the frame leaps around).
    // Same fix P1 shipped for node drags.
    .container(function () { return g.node(); })
    .on('start.fitguard', () => {
      state._frameInteracting = true;
      // Cross bundles + hover lines re-anchor on every frame move — hide them
      // for the duration instead of dragging arrowheads across the canvas.
      linkG.classed('bundles-hidden', true);
    })
    .on('end.fitguard', () => {
      state._frameInteracting = false;
      linkG.classed('bundles-hidden', false);
      onFrameMoveSettled();
    })
    // Drop: resolve overlaps INCREMENTALLY — a full re-render would re-shelve
    // the whole parent (uxtest measured 756 foreign nodes moving 1.5k px for a
    // 70px drag). Only siblings intersecting the dropped rect shift, minimally
    // and capped to the parent; everything else stays put.
    .on('end.repack', function (event, f) {
      if (usesFrames()) { resolveDropOverlaps(f); }
    });
  sel.select('.folder-bubble-titlebar').call(titleDrag);
  // Drag-handle discoverability: hovering the strip marks the frame group so
  // CSS can brighten the flap (cursor is already 'grab').
  sel.select('.folder-bubble-titlebar')
    .on('mouseenter.afford', function () { d3.select(this.parentNode).classed('drag-hover', true); })
    .on('mouseleave.afford', function () { d3.select(this.parentNode).classed('drag-hover', false); });
  sel.select('.folder-bubble-shape').call(createFrameResizeDrag());
  sel.on('contextmenu', onFrameContextMenu);

  // 4) Per-frame nodes/labels + intra links; cross links in the top layer.
  const { intra, cross } = splitEdgesByFrame(allLinks, id => frameOfId.get(id) ?? null);
  __fr.cross = cross;
  __fr.intraByFrame = intra;
  stampLinkRefs(allLinks, __fr.byId);
  __fr.frameDom = new Map();
  __fr.counts = new Map();
  for (const f of frameData) {
    const sub = __fr.frameSel.get(f.path);
    const memberNodes = (members.get(f.path) || []).map(m => m._ref).filter(Boolean);
    __fr.counts.set(f.path, memberCounts(memberNodes));
    // B6: functions in a dense slot hide their labels until zoomed in.
    for (const m of (members.get(f.path) || [])) {
      if (!m._ref) { continue; }
      const slot = f.slots && f.slotOf ? f.slots.get(f.slotOf.get(m.id)) : null;
      m._ref._denseSlot = !!(slot && (slot.count || 0) > DENSE.SLOT_N);
    }
    renderFrameSlots(f, sub);
    const circles = renderNodes(visibleSet, memberNodes, sub.select('g.f-nodes'));
    const clouds = renderCloudNodes(visibleSet, memberNodes, sub.select('g.f-nodes'));
    const labels = renderLabels(visibleSet, memberNodes, sub.select('g.f-labels'));
    const links = renderLinks(intra.get(f.path) || [], visibleSet, sub.select('g.f-links'));
    links.attr('opacity', d => d.pending ? 0.25 : linkRestOpacity());
    __fr.frameDom.set(f.path, { sub, circles, clouds, labels, links });
    if (f.kind === 'root') {
      // Subtle dashed outline + name: root-level files stop looking like
      // stray debris floating outside every frame. No tab, no drag strip.
      sub.select('.folder-bubble-shape')
        .style('display', null)
        .attr('fill', 'none')
        .attr('stroke-dasharray', '6 5')
        .attr('stroke-opacity', 0.25)
        .attr('pointer-events', 'none');
      sub.select('g.frame-tab').style('display', 'none');
      sub.select('.folder-bubble-titlebar').style('display', 'none');
      sub.select('.folder-bubble-label')
        .style('display', null)
        .attr('text-anchor', 'start')
        .attr('opacity', 0.5);
    }
  }

  if (typeof updateTextVisibility === 'function') { updateTextVisibility(); }

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
  if (!state.hasFitted) {
    state.hasFitted = true;
    fitToView();
  } else {
    const svgEl = (typeof svg !== 'undefined' && svg.node) ? svg.node() : null;
    const vw = (svgEl && svgEl.clientWidth) || (typeof window !== 'undefined' ? window.innerWidth : 0);
    const vh = (svgEl && svgEl.clientHeight) || (typeof window !== 'undefined' ? window.innerHeight : 0);
    if (shouldRefit(frameBounds(state.frames), state.currentZoom || 1, vw, vh,
      state.userZoomed, state._frameInteracting)) {
      // The layout outgrew what the viewer currently sees and they haven't
      // taken the viewport — fit again (F2).
      fitToView();
    }
  }
}

/** Re-fit only while the viewport is still the automatic one: never after a
 *  user zoom/pan gesture, never during a frame drag/resize, and only when the
 *  layout overflows the CURRENT view by >30% in either dimension. Comparing
 *  against the live zoom (not the last fitted bounds) keeps progressive loads
 *  — many small graph patches — from ratcheting past a stale baseline. */
function shouldRefit(bounds, k, viewW, viewH, userZoomed, interacting) {
  if (userZoomed || interacting || !bounds || !k || !viewW || !viewH) { return false; }
  return bounds.w * k > viewW * 1.3 || bounds.h * k > viewH * 1.3;
}

/** Translate a frame (and its whole subtree: nodes, pins, sub-frames) by a
 *  parent-local delta WITHOUT pinning it. The moved frames glide (200ms). */
function translateFrameSubtree(f, dx, dy) {
  if (!dx && !dy) { return; }
  f.local.x = Math.round((f.local.x ?? 0) + dx);
  f.local.y = Math.round((f.local.y ?? 0) + dy);
  resolveAbs(state.frames);
  const under = (p) => p === f.path || p.startsWith(f.path + '/') || p.startsWith(f.path + '\\');
  if (!__fr.animateMoves) { __fr.animateMoves = new Set(); }
  for (const path of state.frames.byPath.keys()) {
    if (!under(path)) { continue; }
    for (const m of (__fr.members.get(path) || [])) {
      const n = m._ref;
      if (!n) { continue; }
      n.x += dx; n.y += dy;
      if (n.fx != null) { n.fx += dx; n.fy += dy; }
    }
    __fr.animateMoves.add(path);
    tickFrame(path);
  }
}

/** Drop resolution (R1c): the dropped frame is sacred — it stays EXACTLY
 *  where the user released it. Only siblings whose rect intersects the
 *  dropped rect shift, each by the minimum translation (shelf axis
 *  preferred), gap-padded and clamped inside the parent. NO cascade: a
 *  displaced sibling overlapping a third frame is accepted — uxtest measured
 *  a full re-shelve moving 756 foreign nodes 1.5k px for a 70px drag, and a
 *  frame sliding away from the pointer is worse than an overlap. */
function resolveDropOverlaps(dropped) {
  const fs = state.frames;
  const f = fs && fs.byPath.get(dropped && dropped.path);
  if (!f) { return; }
  const parent = fs.byPath.get(f.parent);
  if (!parent) { return; }
  const pad = FRAME.GAP;
  const touchesDrop = (b) =>
    f.local.x < b.local.x + b.local.w + pad && b.local.x < f.local.x + f.local.w + pad
    && f.local.y < b.local.y + b.local.h + pad && b.local.y < f.local.y + f.local.h + pad;
  for (const sibPath of parent.children) {
    if (sibPath === f.path) { continue; }
    const s2 = fs.byPath.get(sibPath);
    if (!s2 || s2.pinned || !touchesDrop(s2)) { continue; }
    // Candidate pushes: right / left / down / up. Smallest wins, with a bias
    // toward the shelf axis (x) so rows stay rows.
    const cands = [
      { dx: (f.local.x + f.local.w + pad) - s2.local.x, dy: 0 },
      { dx: (f.local.x - pad) - (s2.local.x + s2.local.w), dy: 0 },
      { dx: 0, dy: (f.local.y + f.local.h + pad) - s2.local.y },
      { dx: 0, dy: (f.local.y - pad) - (s2.local.y + s2.local.h) },
    ].sort((a, b) =>
      (Math.abs(a.dx) + Math.abs(a.dy) * 1.6) - (Math.abs(b.dx) + Math.abs(b.dy) * 1.6));
    const want = cands[0];
    const target = clampFrameLocal(fs, sibPath, {
      x: s2.local.x + want.dx, y: s2.local.y + want.dy,
    });
    translateFrameSubtree(s2, target.x - s2.local.x, target.y - s2.local.y);
  }
  onFrameMoveSettled();
  if (typeof window !== 'undefined') { window.markDirty?.(); }
}

/** Deps for slot drags (R2b). Slot data is frame-local; pins are stored
 *  content-local. */
function slotDragDeps(framePath) {
  return {
    container: function () { return g.node(); },
    frame: () => state.frames && state.frames.byPath.get(framePath),
    bounds: (fr) => {
      const off = fr.kind === 'root'
        ? { x: 0, y: 0 }
        : { x: FRAME.PAD, y: FRAME.PAD + FRAME.TITLE + FRAME.NAME_H };
      return { x0: off.x, y0: off.y, x1: off.x + fr.inner.w, y1: off.y + fr.inner.h };
    },
    move: (handleEl, d, dx, dy) => {
      const fr = state.frames.byPath.get(framePath);
      const grp = d3.select(handleEl.parentNode);
      grp.select('.file-slot-shape').attr('x', d.x).attr('y', d.y);
      grp.select('.file-slot-handle').attr('x', d.x).attr('y', d.y);
      grp.select('.file-slot-label').attr('x', d.x + 6).attr('y', d.y + 11);
      // live slot rect (sims clamp/pull against it) + member nodes ride along
      const live = fr && fr.slots && fr.slots.get(d.key);
      if (live) { live.x += dx; live.y += dy; }
      for (const m of (__fr.members.get(framePath) || [])) {
        if (!m._ref || (fr.slotOf && fr.slotOf.get(m.id)) !== d.key) { continue; }
        m._ref.x += dx; m._ref.y += dy;
        if (m._ref.fx != null) { m._ref.fx += dx; m._ref.fy += dy; }
      }
      tickFrame(framePath);
    },
    commit: (fr, d) => {
      const off = fr.kind === 'root'
        ? { x: 0, y: 0 }
        : { x: FRAME.PAD, y: FRAME.PAD + FRAME.TITLE + FRAME.NAME_H };
      if (!fr.slotPins) { fr.slotPins = new Map(); }
      fr.slotPins.set(d.key, {
        x: d.x - off.x - fr.contentPos.x,
        y: d.y - off.y - fr.contentPos.y,
      });
      // One re-render: the pinned slot becomes a fixed obstacle, free slots
      // re-pack around it, sims re-target, the static grid re-places.
      if (typeof applyFileClusters === 'function') { applyFileClusters(); }
      if (typeof window !== 'undefined') { window.markDirty?.(); }
    },
  };
}

/** W5: a member dropped OUTSIDE its slot interior in Shelf+Dynamic snaps
 *  back into the slot. The reheat goes through the FACADE while the node is
 *  still pinned (restart's pin scan bumps exactly this frame), the pin is
 *  released one microtask later (queued after that scan), and the slot
 *  clamp + pull glide the node home. Static keeps drops pinned — Bela's
 *  rule; Global has no slots. Returns true when it took the release over. */
function snapBackToSlot(d) {
  if (typeof usesFrames !== 'function' || !usesFrames()) { return false; }
  if (state.layoutMode !== 'dynamic') { return false; }
  if (!d || d.fx == null || !d._frame || !state.frames) { return false; }
  const f = state.frames.byPath.get(d._frame);
  if (!f) { return false; }
  const interior = slotInteriorFor(f, d.id);
  if (!interior) { return false; }
  const io = frInnerOrigin(f);
  if (d.fx >= io.x + interior.x && d.fx <= io.x + interior.x + interior.w
    && d.fy >= io.y + interior.y && d.fy <= io.y + interior.y + interior.h) { return false; }
  // Move the PIN into the slot instead of merely releasing it: in big-graph
  // Dynamic the drag wrote the abs node directly and the LOCAL sim copy
  // never left the slot, so a released sim has nothing to correct and never
  // emits (the click miss). The pin is the facade's transport — beforeTick
  // syncs it into the local sim on either transport — and the direct x/y
  // write plus tickFrame paints the snap immediately.
  const mx = Math.min(12, interior.w / 4), my = Math.min(12, interior.h / 4);
  d.fx = Math.max(io.x + interior.x + mx, Math.min(io.x + interior.x + interior.w - mx, d.fx));
  d.fy = Math.max(io.y + interior.y + my, Math.min(io.y + interior.y + interior.h - my, d.fy));
  d.x = d.fx; d.y = d.fy;
  tickFrame(d._frame);
  if (state.simulation) { state.simulation.alphaTarget(0.3).restart(); }
  if (typeof setTimeout === 'function') {
    setTimeout(() => {
      d.fx = null; d.fy = null; // free it once the sim owns the position
      if (state.simulation) { state.simulation.alphaTarget(0); }
    }, 200);
  }
  return true;
}

function frameDragDeps() {
  return {
    frames: () => state.frames,
    framePaths: () => [...state.frames.byPath.keys()],
    nodesOf: (path) => (__fr.members.get(path) || []).map(m => m._ref).filter(Boolean),
    pin: (fs, path, pos) => {
      // Contain the drag inside the parent on all four sides, then keep the
      // ancestor chain's DOM truthful — pinFrame can grow ancestors, and a
      // drag only re-ticks the moved subtree otherwise (R1).
      pinFrame(fs, path, clampFrameLocal(fs, path, pos));
      let p = fs.byPath.get(path)?.parent;
      while (p) { tickFrame(p); p = fs.byPath.get(p)?.parent; }
    },
    origin: frInnerOrigin,
    onMoved: (path) => {
      tickFrame(path);
      // Bundles are hidden for the whole drag — rebuilding them per move is
      // wasted work; end.fitguard re-routes them once on release.
      if (typeof linkG === 'undefined' || !linkG.classed('bundles-hidden')) {
        updateCrossLinks();
      }
    },
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
    { label: 'Only show this folder', action: () => { state.onlyShowFolder = fp; applyStructuralFilters(); updateFolderPanel(); } },
    { label: 'Hide folder', action: () => { state.hiddenFolders.add(fp); applyStructuralFilters(); updateFolderPanel(); } },
    { label: 'Go to folder', action: () => vscode.postMessage({ type: 'navigate', file: fp, line: 1 }) },
  ];
  if (state.hiddenFolders.size > 0 || state.onlyShowFolder) {
    items.push({ label: 'Show all', action: () => { state.hiddenFolders.clear(); state.onlyShowFolder = null; state.hiddenFiles.clear(); state.onlyShowFile = null; applyStructuralFilters(); updateFolderPanel(); } });
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
      // F13: every render builds NEW node objects (prepareRenderData). A reused
      // record must write into those — with stale _ref the simulation kept
      // ticking into the discarded objects and nothing on screen moved (dead
      // force sliders / drag reheats after any Detail change). Both transports
      // keep their records' nodes on the main thread, so this covers workers too.
      for (const m of mems) {
        const ln = existing.byId.get(m.id);
        if (ln) { ln._ref = m._ref ?? null; }
      }
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

/** Stamp node refs on link data and resolve string endpoints to node
 *  objects. The object endpoints matter beyond convenience: a coalesced
 *  global tick queued in a rAF right before an engine switch still runs one
 *  last time against the NEW frame selections — with string endpoints it
 *  wrote thousands of NaN line attributes per switch (F3). */
function stampLinkRefs(allLinks, byId) {
  for (const l of allLinks) {
    l._s = byId.get(typeof l.source === 'object' ? l.source.id : l.source) || null;
    l._t = byId.get(typeof l.target === 'object' ? l.target.id : l.target) || null;
    if (l._s) { l.source = l._s; }
    if (l._t) { l.target = l._t; }
  }
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
  const glide = __fr.animateMoves && __fr.animateMoves.delete(path);
  if (glide && sub.transition) {
    sub.transition('frame-move').duration(200).attr('transform', `translate(${f.abs.x},${f.abs.y})`);
  } else {
    sub.attr('transform', `translate(${f.abs.x},${f.abs.y})`);
  }
  if (f.kind === 'root') {
    sub.select('.folder-bubble-shape')
      .attr('d', rectPath(0, 0, f.abs.w, f.abs.h))
      .attr('stroke', (typeof isLightTheme === 'function' && isLightTheme()) ? '#666666' : '#9fb0c3');
    sub.select('.folder-bubble-label')
      .attr('x', 10).attr('y', -10)
      .text(f.path.split(/[\\/]+/).filter(Boolean).pop() || f.path);
  }
  if (f.kind !== 'root') {
    const depth = (state.structureTree.folders[f.path]?.depth) ?? 1;
    const hue = (typeof ddHue === 'function') ? ddHue(f.path) : 0;
    const name = f.path.split(/[\\/]+/).filter(Boolean).pop() || f.path;
    const tw = tabWidth(name, f.abs.w);
    const mutedFill = (typeof isLightTheme === 'function' && isLightTheme()) ? '#333333' : '#cccccc';
    sub.select('.folder-bubble-shape')
      .attr('d', tabBodyPath(0, 0, f.abs.w, f.abs.h, tw))
      .attr('fill', folderFillColor(depth, hue))
      .attr('stroke', folderStrokeColor(depth, hue));
    sub.select('.frame-tab-shape')
      .attr('d', tabOnlyPath(0, 0, tw))
      .attr('fill', folderTitlebarColor(depth, hue));
    sub.select('.frame-tab-glyph')
      .attr('transform', 'translate(9,6) scale(0.85)')
      .attr('fill', mutedFill);
    // R4: the flap is empty (glyph only) — the name lives in the body, on the
    // reserved line just below the flap; ellipsis at the frame width.
    sub.select('.folder-bubble-label')
      .attr('x', 10).attr('y', TAB.H + 10)
      .text(cutLabel(name, Math.max(4, Math.floor((f.abs.w * 0.6) / TAB.CHAR_W))));
    const cnt = __fr.counts && __fr.counts.get(path);
    sub.select('.frame-tab-counts')
      .attr('x', f.abs.w - 6).attr('y', TAB.H + 10)
      .attr('fill', mutedFill)
      .text(cnt ? countsText(cnt.files, cnt.fns, f.abs.w - 20 - name.length * TAB.CHAR_W) : '');
    sub.select('.folder-bubble-titlebar')
      .attr('x', 0).attr('y', 0).attr('width', f.abs.w).attr('height', 30);
  }
}

function tickFramePositions(path) {
  const f = state.frames && state.frames.byPath.get(path);
  const sub = __fr.frameSel.get(path);
  if (!f || !sub) { return; }
  // Off-screen (culled) frames keep simulating into the node data, but their
  // DOM is written once when they scroll back into view.
  if (!__cull.culler.isVisible(path)) { __cull.stale.add(path); return; }
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
    // W3: collapsed folder names live inside the glyph body.
    const inGlyph = d.isFolderCluster && typeof closedFolderLabelPos === 'function'
      ? closedFolderLabelPos(nodeRadius(d)) : null;
    const y = (inGlyph ? d.y + inGlyph.y
      : (d.isFolderCluster || d.isFileCluster) ? d.y + nodeRadius(d) + 6
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
  applyFrameCulling();            // render / frame move / resize change what is on screen
  for (const path of __fr.frameSel.keys()) { tickFrame(path); }
  updateCrossLinks();
  if (__perfT0) { perfEnd('tickFrames', __perfT0); }
}

// ── Viewport culling + level of detail (W3) ──────────────────────────────────
// Pan/zoom is paint- and layout-bound (20k-65k SVG elements). Frames outside
// the (padded) viewport and, below a zoom factor, whole layers — labels, then
// intra-frame links, then the function nodes (a sub-2px node carries no
// information; the coloured file slots remain) — are DETACHED from the document
// (frameCull.js: display:none subtrees still cost Blink on every scale change).
const FR_CULL_PAD_PX = 240;      // keep a margin so a pan does not pop frames in
const FR_LOD_LINKS_AT = 0.4;
const FR_LOD_NODES_AT = 0.3;
// Below the links threshold only the strongest cross-folder bundles are drawn:
// at fit-to-view 1 300 translucent viewport-spanning lines cost 45 ms per frame
// (10k fixture: 16 → 50 fps without them) and read as a hairball anyway.
const FR_LOD_MAX_BUNDLES = 200;
// Gesture LOD: a viewport full of full-detail content (fmt: 4 300 labels + 13 800
// lines in four giant frames at k 0.66) repaints at 4 fps. While a pan/zoom
// gesture runs, labels/links over the element budget are parked; they return
// FR_GESTURE_IDLE_MS after the last zoom event.
const FR_GESTURE_IDLE_MS = 180;
const __cull = {
  culler: (typeof createFrameCuller === 'function') ? createFrameCuller() : { update: () => ({ shown: [], hidden: [] }), isVisible: () => true, reset() {} },
  dom: (typeof createDomCuller === 'function') ? createDomCuller() : null,
  lod: (typeof createLod === 'function') ? createLod() : null,
  want: { labels: true, links: true, nodes: true, slotLabels: true },
  stale: new Set(),              // culled frames whose positions changed meanwhile
  raf: 0,
  frameSelFor: null,             // the frameSel map the culler state belongs to
  zoomLinks: true,               // links drawn at this zoom level (drives the bundle cap)
  gesture: false,                // a pan/zoom gesture is running
  idleTimer: 0,
};

/** Called by the zoom handler: at most one culling pass per animation frame. */
function onFramesZoom() {
  __cull.gesture = true;
  if (__cull.idleTimer) { clearTimeout(__cull.idleTimer); }
  __cull.idleTimer = setTimeout(() => { __cull.idleTimer = 0; __cull.gesture = false; applyFrameCulling(); }, FR_GESTURE_IDLE_MS);
  if (__cull.raf || typeof requestAnimationFrame !== 'function') { return; }
  __cull.raf = requestAnimationFrame(() => { __cull.raf = 0; applyFrameCulling(); });
}

function applyFrameCulling() {
  if (!state.frames || !usesFrames() || !__cull.dom || typeof viewportRect !== 'function') { return; }
  if (typeof svg === 'undefined' || typeof d3 === 'undefined') { return; }   // DOM-less unit tests
  const __perfT0 = (typeof perfBegin === 'function') ? perfBegin() : 0;
  if (__cull.frameSelFor !== __fr.frameSel) {       // re-render: fresh, attached, full-detail <g>s
    __cull.frameSelFor = __fr.frameSel;
    __cull.culler.reset();
    __cull.stale.clear();
    __cull.dom.reset(frameG.node(), [...__fr.frameSel].map(([path, sel]) => [path, sel.node()]));
  }
  const svgEl = svg.node();
  const t = d3.zoomTransform(svgEl);
  const view = viewportRect(t, svgEl.clientWidth || window.innerWidth, svgEl.clientHeight || window.innerHeight, FR_CULL_PAD_PX);
  const lod = __cull.lod.update(t.k, { labels: settings.textFadeThreshold ?? 0.5, links: FR_LOD_LINKS_AT, nodes: FR_LOD_NODES_AT });
  const bundlesChanged = __cull.zoomLinks !== lod.links;   // bundles follow the ZOOM level only
  __cull.zoomLinks = lod.links;
  const { shown, hidden } = __cull.culler.update(state.frames.byPath.values(), view);
  const want = { labels: lod.labels, links: lod.links, nodes: lod.nodes, slotLabels: lod.nodes };
  if (__cull.gesture && typeof gestureBudget === 'function') {
    const budget = gestureBudget(visibleDetailCounts());
    want.labels = want.labels && budget.labels;
    want.links = want.links && budget.links;
  }
  const wantChanged = ['labels', 'links', 'nodes', 'slotLabels'].some(k => want[k] !== __cull.want[k]);
  __cull.want = want;

  for (const path of hidden) { __cull.dom.hide(path); }
  for (const path of shown) {
    __cull.dom.applyLod(path, __cull.want);         // while still detached: no layout work
    __cull.dom.show(path);
    __cull.stale.delete(path);
    tickFrame(path);                                // chrome + positions may both be stale
  }
  if (wantChanged || hidden.length || shown.length) {
    for (const path of __cull.dom.paths()) {
      if (__cull.culler.isVisible(path)) { __cull.dom.applyLod(path, __cull.want); }
    }
  }
  if (bundlesChanged) { updateCrossBundles(); }
  if (shown.length && __fr.sched) { __fr.sched.wake(); }
  if (__perfT0) { perfEnd('cull', __perfT0); }
}

/**
 * A frame move settled (title-bar drag released, drop overlaps resolved):
 * re-route the bundles and re-run culling — a detached sibling pushed into
 * the viewport by the drop, or a child carried on-screen by its parent, must
 * be re-attached now, not at the next zoom.
 */
function onFrameMoveSettled() {
  if (typeof linkG !== 'undefined') { updateCrossLinks(); }   // layer absent in unit tests
  applyFrameCulling();
}

/** Full-detail elements of the frames currently in the viewport. */
function visibleDetailCounts() {
  let nodes = 0, links = 0;
  for (const path of __fr.frameSel.keys()) {
    if (!__cull.culler.isVisible(path)) { continue; }
    nodes += (__fr.members.get(path) || []).length;
    links += ((__fr.intraByFrame && __fr.intraByFrame.get(path)) || []).length;
  }
  return { nodes, links };
}

/** Before any re-render (rendering.js renderElements): everything back in the document. */
function restoreFrameDom() {
  if (__cull.dom) { __cull.dom.restoreAll(); }
  __cull.culler.reset();
  __cull.stale.clear();
}

/** Hovered label while the labels layer is parked: lend it to the frame <g>. */
function borrowHoverLabel(el, frame, on) {
  const sub = frame && __fr.frameSel.get(frame);
  if (!el || !sub) { return; }
  if (on && !el.isConnected && sub.node().isConnected) {
    el.__lodHome = el.parentNode;
    sub.node().appendChild(el);
  } else if (!on && el.__lodHome) {
    el.__lodHome.appendChild(el);
    el.__lodHome = null;
  }
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
  // Ports sit on the tab (its right shoulder faces the free strip), not
  // the full-width strip — bundles visually attach to the folder's name.
  let titleRect;
  if (f.kind === 'root') {
    titleRect = { x: f.abs.x, y: f.abs.y, w: f.abs.w, h: 0 };
  } else {
    const name = p.split(/[\\/]+/).filter(Boolean).pop() || p;
    const tw = Math.min(tabWidth(name, f.abs.w) + 12, f.abs.w);
    titleRect = { x: f.abs.x, y: f.abs.y, w: tw, h: TAB.H };
  }
  return { abs: f.abs, titleRect };
}

function updateCrossBundles() {
  let aggs = crossCaches().crossAgg;
  if (__cull.zoomLinks === false && aggs.length > FR_LOD_MAX_BUNDLES) {
    aggs = [...aggs].sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1)).slice(0, FR_LOD_MAX_BUNDLES);
  }
  const bundles = routeBundles(aggs, crossFrameAt);
  const linkDefault = getCSSVar('--cograph-link-default');
  linkG.selectAll('line.cross-bundle').data(bundles, d => d.key).join('line')
    .attr('class', 'cross-bundle')
    .attr('stroke', linkDefault)
    .attr('stroke-width', d => settings.linkThickness * edgeWeightScale(d.count))
    .attr('stroke-dasharray', d => d.pending ? '4,3' : null)
    .attr('opacity', 0.55)
    .attr('marker-end', settings.arrows ? 'url(#arrow-bundle)' : null)
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
    .attr('marker-end', settings.arrows ? 'url(#arrow-bundle)' : null)
    .attr('x1', d => d.x1).attr('y1', d => d.y1)
    .attr('x2', d => d.x2).attr('y2', d => d.y2);
}

// ── Teardown (leaving the frames engine / drill-down) ─────────────────────────
function teardownFrames() {
  __fr.posDirty.clear();   // a queued drag flush must not touch the next engine's DOM (F3 class)
  if (__cull.dom) { __cull.dom.reset(null, []); }   // forget this session's <g>s: never re-insert them later
  __cull.culler.reset();
  __cull.stale.clear();
  __cull.frameSelFor = null;
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
  if (state.slotPlacedIds) { state.slotPlacedIds.clear(); }
  __fr.slotRects = null;
  // state.frames is kept: returning from workflow/global restores stable rects.
}

/** Drop every packed rect so the next render re-packs from scratch. */
function resetFrames() {
  teardownFrames();
  state.frames = null;
}

/** Grid-place slot members. A member keeps its position only when it was
 *  explicitly PLACED before (grid, settled sim, saved layout — tracked by id
 *  in state.slotPlacedIds so graph patches replacing node objects don't lose
 *  it) AND it still lies inside its slot interior. Never-placed seed clouds
 *  always grid (the F1 blob: a seed cloud inside a big slot used to pass as
 *  "already placed"). In Static motion a slot whose rect moved or resized
 *  re-grids its members outright — their old coordinates belong to nowhere. */
function placeMembersInSlots(members) {
  if (!state.slotPlacedIds) { state.slotPlacedIds = new Set(); }
  const placed = state.slotPlacedIds;
  const prevRects = __fr.slotRects || new Map();
  const nextRects = new Map();
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
    for (const [key, group] of bySlot) {
      const interior = slotInteriorFor(f, group[0].id);
      if (!interior) { continue; }
      const absRect = { x: io.x + interior.x, y: io.y + interior.y, w: interior.w, h: interior.h };
      const rectKey = path + '\u0000' + key;
      nextRects.set(rectKey, absRect);
      const prev = prevRects.get(rectKey);
      const rectChanged = prev && (
        Math.abs(prev.x - absRect.x) > 0.5 || Math.abs(prev.y - absRect.y) > 0.5
        || Math.abs(prev.w - absRect.w) > 0.5 || Math.abs(prev.h - absRect.h) > 0.5);
      const regridAll = rectChanged && state.layoutMode === 'static';
      let loose = group.filter(m => {
        const sn = m._ref;
        if (!sn || !Number.isFinite(sn.x)) { return true; }
        if (regridAll) { return true; }
        if (!placed.has(m.id)) { return true; } // seed position, never placed
        return sn.x < absRect.x || sn.x > absRect.x + absRect.w
          || sn.y < absRect.y || sn.y > absRect.y + absRect.h;
      });
      if (!loose.length) { continue; }
      // Static: gridding only the loose subset would drop newcomers onto the
      // cells stamped members already occupy — the grid IS the arrangement,
      // so any loose member re-grids the whole slot. Dynamic leaves the rest
      // to the simulation.
      if (state.layoutMode === 'static' && loose.length < group.length) {
        loose = group;
      }
      const grid = gridPositions(loose, absRect);
      for (const m of loose) {
        const sn = m._ref;
        const p = grid.get(m.id);
        if (sn && p) {
          sn.x = p.x; sn.y = p.y;
          // Static pins follow the grid, or the pin snaps the node right back.
          if (sn.fx != null) { sn.fx = p.x; sn.fy = p.y; }
          placed.add(m.id);
        }
      }
    }
  }
  __fr.slotRects = nextRects;
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
    .on('start', function () { state._frameInteracting = true; })
    .filter(function (event, f) {
      const [mx, my] = d3.pointer(event, g.node());
      return (mx - f.abs.x < EDGE) || (f.abs.x + f.abs.w - mx < EDGE)
        || (my - f.abs.y < EDGE) || (f.abs.y + f.abs.h - my < EDGE);
    })
    .on('drag', function (event, f) {
      const w = Math.max(FRAME.MIN_INNER_W + 2 * FRAME.PAD, event.x - f.abs.x);
      const h = Math.max(FRAME.MIN_INNER_H + 2 * FRAME.PAD + FRAME.TITLE + FRAME.NAME_H, event.y - f.abs.y);
      pinFrame(state.frames, f.path, null, { w, h });
      const rec = __fr.sims.get(f.path);
      const nf = state.frames.byPath.get(f.path);
      if (rec && nf) { simApi().resizeSim(rec, nf.inner); }
      if (__fr.sched) { __fr.sched.wake(); }
      tickFrame(f.path);
      updateCrossLinks();
    })
    .on('end', function () {
      state._frameInteracting = false;
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
  // Frame-local content origin — MUST match innerOrigin (frames.js) minus
  // f.abs, and the offsets in slotDragDeps: the packer, the member grid and
  // the pin math all measure from there (R4 added NAME_H; F19).
  const off = f.kind === 'root'
    ? { x: 0, y: 0 }
    : { x: FRAME.PAD, y: FRAME.PAD + FRAME.TITLE + FRAME.NAME_H };
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
        grp.append('rect').attr('class', 'file-slot-handle')
          .attr('fill', 'transparent').attr('pointer-events', 'all').attr('cursor', 'grab');
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
    grp.select('.file-slot-handle')
      .attr('x', d.x).attr('y', d.y).attr('width', d.w).attr('height', SLOT.LABEL_H);
    grp.select('.file-slot-label')
      .attr('x', d.x + 6).attr('y', d.y + 11)
      .attr('font-size', `${9 * settings.textSize}px`)
      .attr('fill', color).attr('fill-opacity', 0.9)
      .text(slotLabelText(slotBasename(d.file), d.count, d.w, 5 * settings.textSize));
  });
  // Every frame's slots are draggable, INCLUDING the root frame's: a handle
  // without a drag behavior lets the mousedown fall through to the zoom
  // behavior, and the whole view pans under the pointer (F19).
  if (typeof createSlotDrag === 'function') {
    sel.select('rect.file-slot-handle').call(createSlotDrag(slotDragDeps(f.path)));
  }
  sel.on('dblclick', (event, d) => {
    event.stopPropagation();
    vscode.postMessage({ type: 'navigate', file: d.file, line: 1 });
  });
  sel.on('contextmenu', (event, d) => {
    if (typeof showContextMenu !== 'function') { return; }
    event.preventDefault();
    event.stopPropagation();
    const items = [
      { label: slotBasename(d.file), isHeader: true },
      { label: 'Go to File', action: () => vscode.postMessage({ type: 'navigate', file: d.file, line: 1 }) },
      { label: 'Hide file', action: () => {
        state.hiddenFiles.add(d.file);
        applyStructuralFilters(); if (typeof updateFolderPanel === 'function') { updateFolderPanel(); }
        window.markDirty?.();
      } },
      { label: 'Show only this file', action: () => {
        state.onlyShowFile = d.file;
        applyStructuralFilters(); if (typeof updateFolderPanel === 'function') { updateFolderPanel(); }
        window.markDirty?.();
      } },
    ];
    if (state.hiddenFiles.size || state.onlyShowFile || state.hiddenFolders.size || state.onlyShowFolder) {
      items.push({ label: 'Show all', action: () => {
        state.hiddenFiles.clear(); state.onlyShowFile = null;
        state.hiddenFolders.clear(); state.onlyShowFolder = null;
        applyStructuralFilters(); if (typeof updateFolderPanel === 'function') { updateFolderPanel(); }
        window.markDirty?.();
      } });
    }
    showContextMenu(event, items);
  });
  return sel;
}

// ── Settings glue ─────────────────────────────────────────────────────────────

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
    tickFramePositions, tickFrameOfNode, onFramesZoom, applyFrameCulling, restoreFrameDom, borrowHoverLabel, teardownFrames,
    resetFrames, updateCrossLinks, updateCrossBundles, updateCrossHover, syncFrameSims, applySimResult, applySimData,
    applyPendingLayout, migrateV1IntoFrames, placeMembersInSlots, shouldRefit, stampLinkRefs,
    snapBackToSlot,
    resolveDropOverlaps, translateFrameSubtree, onFrameMoveSettled,
    applyFrameDisplaySettings, createFrameResizeDrag,
    slotSignature, slotColor, slotBasename, renderFrameSlots, sameSlotGeometry,
    __frState: __fr,   // test hook
  };
}
