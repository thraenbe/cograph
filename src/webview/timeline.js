// Timeline playback module.
// Animates the graph being built up in git-chronological order: starting from an
// empty graph, function nodes pop in one at a time until the current complete
// state is reached. Library nodes appear when their first project-node
// referencer appears.

(function () {
  const tl = state.timeline;
  let indexById = new Map();

  function isAlwaysVisible(n) {
    if (!n) return false;
    if (n.isCluster || n.isSynthetic) return true;
    if (n.id === '::MAIN::0') return true;
    return false;
  }

  function rebuildOrder(entries) {
    indexById = new Map();
    tl.libOrder = new Map();

    const tsById = new Map();
    if (Array.isArray(entries)) {
      for (const e of entries) { tsById.set(e.id, e.ts); }
    }

    const graph = state.graphData;
    if (!graph || !Array.isArray(graph.nodes)) {
      tl.order = [];
      return;
    }

    const FAR_FUTURE = Number.MAX_SAFE_INTEGER;
    const projectNodes = graph.nodes.filter(n => n && !n.isLibrary && n.file && n.id !== '::MAIN::0');
    const ordered = projectNodes
      .map(n => ({ id: n.id, ts: tsById.has(n.id) ? tsById.get(n.id) : FAR_FUTURE }))
      .sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    tl.order = ordered.map(e => e.id);
    tl.order.forEach((id, i) => indexById.set(id, i));

    for (const edge of graph.edges || []) {
      const srcId = edge.source && typeof edge.source === 'object' ? edge.source.id : edge.source;
      const tgtId = edge.target && typeof edge.target === 'object' ? edge.target.id : edge.target;
      const srcIdx = indexById.get(srcId);
      if (srcIdx === undefined) continue;
      const tgtNode = graph.nodes.find(n => n.id === tgtId);
      if (!tgtNode || !tgtNode.isLibrary) continue;
      const appearAfter = srcIdx + 1;
      const prev = tl.libOrder.get(tgtId);
      if (prev === undefined || appearAfter < prev) {
        tl.libOrder.set(tgtId, appearAfter);
      }
    }
  }

  function filterPredicate(n) {
    if (isAlwaysVisible(n)) return true;
    if (n && n.isLibrary) {
      const libAt = tl.libOrder.get(n.id);
      if (libAt === undefined) return false;
      return tl.currentIdx >= libAt;
    }
    const idx = indexById.get(n.id);
    if (idx === undefined) return true;
    return idx < tl.currentIdx;
  }

  function setProgressLabel() {
    const total = tl.order.length;
    const cur = Math.floor(tl.currentIdx);
    const valEl = document.getElementById('val-timeline-pos');
    if (valEl) { valEl.textContent = `${cur} / ${total}`; }
    const slider = document.getElementById('slider-timeline-pos');
    if (slider) {
      slider.value = String(cur);
      const pct = total > 0 ? (cur / total) * 100 : 0;
      if (slider.style && typeof slider.style.setProperty === 'function') {
        slider.style.setProperty('--tl-fill', pct + '%');
      }
    }
  }

  function updateButtonLabels() {
    const playBtn = document.getElementById('btn-timeline-play');
    if (!playBtn) { return; }
    const iconHtml = tl.isPlaying ? '&#10074;&#10074;' : '&#9654;';
    const iconEl = playBtn.querySelector && playBtn.querySelector('.tl-tx-play-icon');
    if (iconEl) {
      iconEl.innerHTML = iconHtml;
    } else {
      playBtn.innerHTML = iconHtml;
    }
    if (playBtn.classList && typeof playBtn.classList.toggle === 'function') {
      playBtn.classList.toggle('is-playing', tl.isPlaying);
    }
    if (typeof playBtn.setAttribute === 'function') {
      playBtn.setAttribute('aria-label', tl.isPlaying ? 'Pause' : 'Play');
    }
  }

  function applyTimelineFilter() {
    if (typeof applyFilters === 'function') { applyFilters(); }
  }

  function cancelLoop() {
    if (tl.rafHandle != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(tl.rafHandle);
    }
    tl.rafHandle = null;
  }

  function tick(nowMs) {
    if (!tl.isPlaying) { tl.rafHandle = null; return; }
    const dt = tl.lastFrameMs == null ? 0 : (nowMs - tl.lastFrameMs) / 1000;
    tl.lastFrameMs = nowMs;

    const prevFloor = Math.floor(tl.currentIdx);
    tl.currentIdx = Math.min(tl.order.length, tl.currentIdx + tl.nodesPerSec * dt);
    const nextFloor = Math.floor(tl.currentIdx);

    if (nextFloor !== prevFloor) {
      applyTimelineFilter();
      setProgressLabel();
    }

    if (tl.currentIdx >= tl.order.length) {
      pause();
      return;
    }
    tl.rafHandle = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(tick)
      : null;
  }

  function play() {
    if (tl.order.length === 0) return;
    if (tl.currentIdx >= tl.order.length) { tl.currentIdx = 0; }
    tl.isPlaying = true;
    tl.lastFrameMs = null;
    updateButtonLabels();
    applyTimelineFilter();
    setProgressLabel();
    tl.rafHandle = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(tick)
      : null;
  }

  function pause() {
    tl.isPlaying = false;
    cancelLoop();
    updateButtonLabels();
  }

  function reset() {
    pause();
    tl.currentIdx = 0;
    applyTimelineFilter();
    setProgressLabel();
  }

  function armControls() {
    const hasOrder = tl.order.length > 0;
    const playBtn = document.getElementById('btn-timeline-play');
    const resetBtn = document.getElementById('btn-timeline-reset');
    const posSlider = document.getElementById('slider-timeline-pos');
    if (playBtn) {
      playBtn.disabled = !hasOrder;
      playBtn.title = hasOrder ? 'Play / pause timeline' : 'Loading history…';
    }
    if (resetBtn) { resetBtn.disabled = !hasOrder; }
    if (posSlider) {
      posSlider.disabled = !hasOrder;
      posSlider.max = String(tl.order.length);
    }
  }

  function disarmControls() {
    tl.filterPredicate = null;
    tl.order = [];
    tl.libOrder = new Map();
    indexById = new Map();
    tl.currentIdx = 0;
    pause();
    armControls();
    setProgressLabel();
  }

  function receiveTimelineData(entries) {
    rebuildOrder(entries);
    tl.currentIdx = tl.order.length; // default: full state visible (timeline idle at end)
    tl.filterPredicate = filterPredicate;
    armControls();
    setProgressLabel();
    updateButtonLabels();
  }

  window.receiveTimelineData = receiveTimelineData;
  window.resetTimelineState = disarmControls;

  document.getElementById('btn-timeline-play')?.addEventListener('click', () => {
    if (tl.isPlaying) { pause(); } else { play(); }
  });
  document.getElementById('btn-timeline-reset')?.addEventListener('click', reset);

  document.getElementById('slider-timeline-speed')?.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) {
      tl.nodesPerSec = v;
      const valEl = document.getElementById('val-timeline-speed');
      if (valEl) { valEl.textContent = String(v); }
    }
  });

  document.getElementById('slider-timeline-pos')?.addEventListener('input', (e) => {
    pause();
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v)) {
      tl.currentIdx = Math.max(0, Math.min(tl.order.length, v));
      applyTimelineFilter();
      setProgressLabel();
    }
  });

  if (typeof module !== 'undefined') {
    module.exports = {
      receiveTimelineData,
      disarmControls,
      play,
      pause,
      reset,
      filterPredicate,
      _internal: { tick, rebuildOrder, get indexById() { return indexById; } },
    };
  }
})();
