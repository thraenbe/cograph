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
document.getElementById('btn-layout-dynamic')?.addEventListener('click', () => {
  setLayoutMode('dynamic');
  window.markDirty?.();
});
document.getElementById('btn-layout-static')?.addEventListener('click', () => {
  setLayoutMode('static');
  window.markDirty?.();
});
document.getElementById('btn-engine-shelf')?.addEventListener('click', () => {
  setLayoutEngine('shelf');
  window.markDirty?.();
});
document.getElementById('btn-engine-global')?.addEventListener('click', () => {
  setLayoutEngine('global');
  window.markDirty?.();
});

// ── Filter controls ───────────────────────────────────────────────────────────
const searchInput = document.getElementById('search');
const btnClearSearch = document.getElementById('btn-clear-search');
const searchCount = document.getElementById('search-count');

searchInput?.addEventListener('input', (e) => {
  if (btnClearSearch) {
    btnClearSearch.style.display = e.target.value.length > 0 ? 'block' : 'none';
  }
  applyFilters();
});

btnClearSearch?.addEventListener('click', () => {
  clearSearch();
  searchInput?.focus();
});

document.getElementById('toggle-orphans')?.addEventListener('change', (e) => {
  settings.showOrphans = e.target.checked;
  applyFilters();
});

document.getElementById('toggle-libraries')?.addEventListener('change', (e) => {
  settings.showLibraries = e.target.checked;
  applyComplexity();
});

document.getElementById('toggle-empty-files')?.addEventListener('change', (e) => {
  settings.showEmptyFiles = e.target.checked;
  applyComplexity();
});

/** Empties the filter box; returns false if it was already empty, so Escape can move on to the panel. */
function clearSearch() {
  if (!searchInput || searchInput.value === '') return false;
  searchInput.value = '';
  if (btnClearSearch) btnClearSearch.style.display = 'none';
  applyFilters();
  updateSearchCount(null);
  return true;
}

/** Tells the user how many nodes survived the current filter — silent until they type, red at zero. */
function updateSearchCount(visibleIds) {
  if (!searchCount) return;
  if (!searchInput?.value) {
    searchCount.style.display = 'none';
    searchCount.textContent = '';
    searchCount.classList.remove('search-count--none');
    return;
  }
  const count = visibleIds ? visibleIds.size : 0;
  searchCount.style.display = 'block';
  searchCount.textContent = count === 1 ? '1 match' : `${count} matches`;
  searchCount.classList.toggle('search-count--none', count === 0);
}

// ── Configuration controls ────────────────────────────────────────────────────
document.getElementById('toggle-func-popup')?.addEventListener('change', (e) => {
  settings.openFunctionPopup = e.target.checked;
});

document.getElementById('btn-reset-layout')?.addEventListener('click', () => {
  const defaults = {
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
    linkDistance: 40,
    velocityDecay: 0.3,
    collidePad: 1.5,
    slotPad: 0,
    repelRange: Infinity,
  };

  Object.assign(settings, defaults);
  setRepelRangeUI(Infinity);

  for (const [key, val] of Object.entries({
    'slider-text-fade': { valId: 'val-text-fade', value: defaults.textFadeThreshold },
    'slider-node-size': { valId: 'val-node-size', value: defaults.nodeSize },
    'slider-text-size': { valId: 'val-text-size', value: defaults.textSize },
    'slider-link-thickness': { valId: 'val-link-thickness', value: defaults.linkThickness },
    'slider-center-force': { valId: 'val-center-force', value: defaults.centerForce },
    'slider-repel-force': { valId: 'val-repel-force', value: defaults.repelForce },
    'slider-link-force': { valId: 'val-link-force', value: defaults.linkForce },
    'slider-file-cluster': { valId: 'val-file-cluster', value: defaults.fileClusterForce },
    'slider-folder-repel': { valId: 'val-folder-repel', value: defaults.folderRepelForce },
    'slider-file-repel': { valId: 'val-file-repel', value: defaults.fileRepelForce },
    'slider-link-distance': { valId: 'val-link-distance', value: defaults.linkDistance },
    'slider-velocity-decay': { valId: 'val-velocity-decay', value: defaults.velocityDecay },
    'slider-collide-pad': { valId: 'val-collide-pad', value: defaults.collidePad },
    'slider-slot-pad': { valId: 'val-slot-pad', value: defaults.slotPad }
  })) {
    const slider = document.getElementById(key);
    const valEl = document.getElementById(val.valId);
    if (slider) slider.value = val.value;
    if (valEl) valEl.textContent = val.value;
  }

  state.userZoomed = false; // Reset Layout re-arms the automatic fit
  applyDisplaySettings();
  rerunLayout();
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
wireSlider('slider-node-size', 'val-node-size', 'nodeSize', () => {
  applyDisplaySettings();
  // Node size changes slot geometry in the shelf: re-render (debounced) so
  // the packer resizes slots and the static grid re-places members (F16).
  if (typeof usesFrames === 'function' && usesFrames()) {
    clearTimeout(state._nodeSizeTimer);
    state._nodeSizeTimer = setTimeout(() => {
      if (typeof applyFileClusters === 'function') { applyFileClusters(); }
    }, 120);
  }
});
wireSlider('slider-text-size', 'val-text-size', 'textSize', applyDisplaySettings);
wireSlider('slider-link-thickness', 'val-link-thickness', 'linkThickness', applyDisplaySettings);
wireSlider('slider-center-force', 'val-center-force', 'centerForce', rerunLayout);
wireSlider('slider-repel-force', 'val-repel-force', 'repelForce', rerunLayout);
wireSlider('slider-link-force', 'val-link-force', 'linkForce', rerunLayout);
wireSlider('slider-file-cluster', 'val-file-cluster', 'fileClusterForce', rerunLayout);
wireSlider('slider-link-distance', 'val-link-distance', 'linkDistance', rerunLayout);
wireSlider('slider-velocity-decay', 'val-velocity-decay', 'velocityDecay', rerunLayout);
wireSlider('slider-collide-pad', 'val-collide-pad', 'collidePad', rerunLayout);
wireSlider('slider-slot-pad', 'val-slot-pad', 'slotPad', rerunLayout);
wireSlider('slider-folder-repel', 'val-folder-repel', 'folderRepelForce', rerunLayout);
wireSlider('slider-file-repel', 'val-file-repel', 'fileRepelForce', rerunLayout);

// "Repel range" — Global charge distanceMax. The slider's MAX position means
// unlimited (Infinity, the classic global behaviour), shown as ∞.
const repelRangeSlider = document.getElementById('slider-repel-range');
const repelRangeVal = document.getElementById('val-repel-range');
function setRepelRangeUI(value) {
  if (!repelRangeSlider) { return; }
  const max = parseFloat(repelRangeSlider.max);
  const unlimited = value == null || value === Infinity || value >= max;
  repelRangeSlider.value = String(unlimited ? max : value);
  if (repelRangeVal) { repelRangeVal.textContent = unlimited ? '\u221E' : String(value); }
}
repelRangeSlider?.addEventListener('input', () => {
  const raw = parseFloat(repelRangeSlider.value);
  const unlimited = raw >= parseFloat(repelRangeSlider.max);
  settings.repelRange = unlimited ? Infinity : raw;
  if (repelRangeVal) { repelRangeVal.textContent = unlimited ? '\u221E' : String(raw); }
  rerunLayout();
});

// "show more forces" — inline expander for the advanced force sliders.
document.getElementById('btn-show-more-forces')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const adv = document.getElementById('forces-advanced');
  const btn = e.currentTarget;
  const open = adv?.classList.toggle('open');
  if (btn) { btn.innerHTML = open ? 'show fewer forces \u25B4' : 'show more forces \u25BE'; }
});

// ── Collapsible legend headers ────────────────────────────────────────────────
function wireLegendToggle(headerId, bodyId) {
  const header = document.getElementById(headerId);
  const body = document.getElementById(bodyId);
  if (!header || !body) return;
  header.addEventListener('click', () => {
    const collapsed = body.style.display === 'none';
    body.style.display = collapsed ? '' : 'none';
    header.querySelector('.tl-chevron').classList.toggle('collapsed', !collapsed);
  });
}
wireLegendToggle('toggle-git-legend', 'git-legend-body');
wireLegendToggle('toggle-folder-filters', 'folder-filters-body');


// ── Git mode toggle ───────────────────────────────────────────────────────────
function setGitLegendVisible(visible) {
  const display = visible ? '' : 'none';
  document.getElementById('toggle-git-legend').style.display = display;
  document.getElementById('git-legend-body').style.display = display;
}
setGitLegendVisible(state.gitMode);
document.getElementById('btn-git-mode')?.classList.toggle('active', state.gitMode);

document.getElementById('btn-git-mode')?.addEventListener('click', () => {
  state.gitMode = !state.gitMode;
  document.getElementById('btn-git-mode')?.classList.toggle('active', state.gitMode);
  setGitLegendVisible(state.gitMode);
  applyGitColors();
  if (state.gitMode && !state.hasFitted) {
    state.hasFitted = true;
    fitToView();
  }
  window.markDirty?.();
});

// ── Language mode toggle ──────────────────────────────────────────────────────
function setLangLegendVisible(visible) {
  document.getElementById('language-legend').style.display = visible ? '' : 'none';
}
setLangLegendVisible(state.languageMode);
document.getElementById('btn-language-mode')?.classList.toggle('active', state.languageMode);

document.getElementById('btn-language-mode')?.addEventListener('click', () => {
  state.languageMode = !state.languageMode;
  document.getElementById('btn-language-mode')?.classList.toggle('active', state.languageMode);
  setLangLegendVisible(state.languageMode);
  applyGitColors();
  window.markDirty?.();
});

// ── Folder mode ────────────────────────────────────────────────────────────────
document.getElementById('btn-folder-mode')?.classList.toggle('active', state.folderMode);
document.getElementById('btn-folder-mode')?.addEventListener('click', () => {
  state.folderMode = !state.folderMode;
  document.getElementById('btn-folder-mode')?.classList.toggle('active', state.folderMode);
  applyComplexity();
  window.markDirty?.();
});

/** Pure file-filter predicate (R2a) — mirrors the folder rules. */
function fileFilterAllows(filePath, onlyShowFile, hiddenFiles) {
  if (onlyShowFile && filePath !== onlyShowFile) { return false; }
  if (hiddenFiles && hiddenFiles.has(filePath)) { return false; }
  return true;
}

/** Restore saved file filters (additive payload fields; old saves = none). */
function applySavedFileFilters(payload) {
  if (!payload) { return false; }
  let changed = false;
  // W2: folder filters restore here too (the name predates round 3).
  if (Array.isArray(payload.hiddenFolders)) {
    state.hiddenFolders = new Set(payload.hiddenFolders);
    changed = true;
  }
  if (payload.onlyShowFolder !== undefined) {
    state.onlyShowFolder = payload.onlyShowFolder ?? null;
    changed = true;
  }
  if (Array.isArray(payload.hiddenFiles)) {
    state.hiddenFiles = new Set(payload.hiddenFiles);
    changed = true;
  }
  if (payload.onlyShowFile !== undefined) {
    state.onlyShowFile = payload.onlyShowFile ?? null;
    changed = true;
  }
  if (changed) { updateFolderPanel(); }
  return changed;
}

/** Repo text (paths, names) rendered through innerHTML must be escaped. */
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateFolderPanel() {
  const body = document.getElementById('folder-filters-body');
  if (!body) return;

  const hasFilters = state.onlyShowFolder || state.hiddenFolders.size > 0
    || state.onlyShowFile || (state.hiddenFiles && state.hiddenFiles.size > 0)
    || !!state.scope; // W4: an active subgraph always shows its section

  if (hasFilters) {
    body.style.display = '';
    document.querySelector('#toggle-folder-filters .tl-chevron')?.classList.remove('collapsed');
  }

  if (!hasFilters) {
    body.innerHTML = '<div class="folder-filter-empty">No active filters</div>';
    return;
  }

  const rows = [];
  if (state.onlyShowFolder) {
    rows.push(`
      <div class="folder-filter-row">
        <span class="folder-filter-icon">◎</span>
        <span class="folder-filter-label" title="${escHtml(state.onlyShowFolder)}">${escHtml(pathBasename(state.onlyShowFolder))}</span>
        <button class="folder-filter-clear" data-action="clear-only">✕</button>
      </div>`);
  }
  state.hiddenFolders.forEach(fp => {
    rows.push(`
      <div class="folder-filter-row">
        <span class="folder-filter-icon folder-filter-icon--hidden">⊘</span>
        <span class="folder-filter-label" title="${escHtml(fp)}">${escHtml(pathBasename(fp))}</span>
        <button class="folder-filter-clear" data-action="unhide" data-path="${escHtml(fp)}">✕</button>
      </div>`);
  });
  if (state.onlyShowFile) {
    rows.push(`
      <div class="folder-filter-row chip-file">
        <span class="folder-filter-icon">◎</span>
        <span class="folder-filter-label" title="${escHtml(state.onlyShowFile)}">${escHtml(pathBasename(state.onlyShowFile))}</span>
        <button class="folder-filter-clear" data-action="clear-only-file">✕</button>
      </div>`);
  }
  (state.hiddenFiles ?? new Set()).forEach(fp => {
    rows.push(`
      <div class="folder-filter-row chip-file">
        <span class="folder-filter-icon folder-filter-icon--hidden">⊘</span>
        <span class="folder-filter-label" title="${escHtml(fp)}">${escHtml(pathBasename(fp))}</span>
        <button class="folder-filter-clear" data-action="unhide-file" data-path="${escHtml(fp)}">✕</button>
      </div>`);
  });
  rows.push(`<button class="folder-filter-show-all" id="btn-folder-show-all">Show All</button>`);

  // Subgraph section (W4): the scope's name, one row per maximal EXCLUDED
  // subtree with a Visualize action, and an exit row. 'Show All' above only
  // clears the view filters — it never touches the host scope (Q3).
  if (state.scope && typeof excludedTopFolders === 'function') {
    const relOf = (abs) => abs === state.scope.root ? '.'
      : abs.slice(state.scope.root.length + 1).replace(/\\/g, '/');
    rows.push(`<div class="folder-filter-subhead subgraph-head">Subgraph: ${escHtml(state.scope.name ?? 'unsaved')}</div>`);
    for (const ex of excludedTopFolders(state.structureTree, state.scope)) {
      const rel = relOf(ex.path);
      const pending = state.scopePending && state.scopePending.has(rel);
      rows.push(`
      <div class="folder-filter-row subgraph-row">
        <span class="folder-filter-icon folder-filter-icon--hidden">⊘</span>
        <span class="folder-filter-label" title="${escHtml(ex.path)}">${escHtml(pathBasename(ex.path))} · ${ex.fileCount}</span>
        ${pending
    ? '<span class="subgraph-pending">…</span>'
    : `<button class="subgraph-visualize" data-rel="${escHtml(rel)}">Visualize</button>`}
      </div>`);
    }
    rows.push(`<button class="folder-filter-show-all subgraph-exit">Show whole project</button>`);
  }
  body.innerHTML = rows.join('');

  body.querySelectorAll('.subgraph-visualize').forEach(btn => {
    btn.addEventListener('click', () => {
      const rel = btn.dataset.rel;
      state.scopePending = state.scopePending || new Set();
      state.scopePending.add(rel);
      vscode.postMessage({ type: 'subgraph-include', path: rel });
      updateFolderPanel(); // pending spinner until the re-sent `subgraph` lands
    });
  });
  body.querySelector('.subgraph-exit')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'subgraph-exit' });
  });

  body.querySelector('#btn-folder-show-all')?.addEventListener('click', () => {
    state.hiddenFolders.clear(); state.onlyShowFolder = null;
    state.hiddenFiles?.clear(); state.onlyShowFile = null;
    applyStructuralFilters(); ticked(); updateFolderPanel();
  });
  body.querySelectorAll('.folder-filter-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'clear-only') { state.onlyShowFolder = null; }
      else if (btn.dataset.action === 'unhide') { state.hiddenFolders.delete(btn.dataset.path); }
      else if (btn.dataset.action === 'clear-only-file') { state.onlyShowFile = null; }
      else if (btn.dataset.action === 'unhide-file') { state.hiddenFiles?.delete(btn.dataset.path); }
      applyStructuralFilters(); ticked(); updateFolderPanel();
    });
  });
}

updateFolderPanel();

// ── Class mode ─────────────────────────────────────────────────────────────────
document.getElementById('btn-class-mode')?.classList.toggle('active', state.classMode);
document.getElementById('btn-class-mode')?.addEventListener('click', () => {
  state.classMode = !state.classMode;
  document.getElementById('btn-class-mode')?.classList.toggle('active', state.classMode);
  applyComplexity();
  window.markDirty?.();
});

// ── Save Graph Layout ─────────────────────────────────────────────────────────
function buildSavePayload() {
  const nodePositions = {};
  for (const n of state.currentNodes) {
    nodePositions[n.id] = { x: n.x ?? n.fx ?? 0, y: n.y ?? n.fy ?? 0 };
  }
  const payload = {
    settings: {
      complexityLevel: state.complexityLevel,
      clusterGroupBy: state.clusterGroupBy,
      layoutMode: state.layoutMode,
      layoutEngine: state.layoutEngine,
      gitMode: state.gitMode,
      languageMode: state.languageMode,
      folderMode: state.folderMode,
      classMode: state.classMode,
      detailDepth: state.detailDepth,
      // Infinity does not survive JSON — it round-trips as null (= unlimited).
      repelRange: settings.repelRange ?? Infinity,
    },
    nodePositions,
  };
  // Frames engine (v2 additions): drill-down expansion + packed frame rects
  // (parent-inner-local). Node positions stay absolute as in v1.
  if (state.expandedFolders && state.expandedFolders.size) {
    payload.expandedFolders = [...state.expandedFolders].sort();
  }
  // File filters (R2a, additive — old builds ignore them)
  if (state.hiddenFolders && state.hiddenFolders.size) {
    payload.hiddenFolders = [...state.hiddenFolders].sort();
  }
  if (state.onlyShowFolder) { payload.onlyShowFolder = state.onlyShowFolder; }
  if (state.hiddenFiles && state.hiddenFiles.size) {
    payload.hiddenFiles = [...state.hiddenFiles].sort();
  }
  if (state.onlyShowFile) { payload.onlyShowFile = state.onlyShowFile; }
  if (state.frames && typeof serializeFrames === 'function') {
    payload.frames = serializeFrames(state.frames);
  }
  return payload;
}

/** Consume a saved layout's drill-down state (detail depth + expanded
 *  folders). The frames engine does this in applyPendingLayout as frames
 *  appear; the Global engine calls it once on graph-loaded, BEFORE node
 *  positions are applied, so they land on the saved visible set (F14).
 *  Returns true when anything was applied. */
function applySavedDrilldownState(payload) {
  if (!payload) { return false; }
  let changed = false;
  const saved = payload.settings || {};
  if (saved.detailDepth != null) {
    state.detailDepth = saved.detailDepth;
    if (typeof setDetailSlider === 'function') { setDetailSlider(state.detailDepth); }
    changed = true;
  }
  if (Array.isArray(payload.expandedFolders)) {
    state.expandedFolders = new Set(payload.expandedFolders);
    if (typeof requestParseForExpanded === 'function') { requestParseForExpanded(); }
    changed = true;
  }
  return changed;
}

/** Restore saved display settings from a graph-loaded payload onto state + the
 *  control DOM (buildSavePayload's read-side mirror). Any saved cluster lens
 *  (removed Class/Connect, legacy 'connectivity'/'auto') loads as File. */
function applySavedViewSettings(saved) {
  if (saved.complexityLevel !== undefined) {
    state.complexityLevel = saved.complexityLevel;
    const slider = document.getElementById('slider-complexity');
    const valEl = document.getElementById('val-complexity');
    if (slider) { slider.value = String(saved.complexityLevel); }
    if (valEl) { valEl.textContent = Number(saved.complexityLevel).toFixed(2); }
  }
  if (saved.repelRange !== undefined) {
    settings.repelRange = saved.repelRange == null ? Infinity : saved.repelRange;
    setRepelRangeUI(settings.repelRange);
  }
  if (saved.clusterGroupBy !== undefined) {
    // Only the File lens exists; saves from builds with the Class/Connect
    // lenses (or the older 'connectivity'/'auto' names) load silently as File.
    state.clusterGroupBy = 'file';
  }
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
}

document.getElementById('btn-save-graph')?.addEventListener('click', () => {
  vscode.postMessage({
    type: 'save-graph',
    mode: 'save-as',
    payload: buildSavePayload(),
  });
});

document.getElementById('btn-open-chat')?.addEventListener('click', () => {
  vscode.postMessage({ type: 'open-chat' });
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'save-request') {
    vscode.postMessage({
      type: 'save-graph',
      mode: msg.mode,
      payload: buildSavePayload(),
    });
  }
});

// ── Context menu global dismiss ────────────────────────────────────────────────
document.addEventListener('mousedown', e => {
  const menu = document.getElementById('ctx-menu');
  if (menu && !menu.contains(e.target)) hideContextMenu();
}, true);   // capture phase — fires before d3-zoom's stopImmediatePropagation

// ── Library doc popup controls ────────────────────────────────────────────────
document.getElementById('lib-doc-close')?.addEventListener('click', () => {
  document.getElementById('lib-doc-popup').style.display = 'none';
  state.activeLibNode = null;
});

document.getElementById('lib-doc-popup')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('lib-doc-popup')) {
    document.getElementById('lib-doc-popup').style.display = 'none';
    state.activeLibNode = null;
  }
});

document.getElementById('lib-doc-goto-btn')?.addEventListener('click', () => {
  if (!state.activeLibNode) return;
  const d = state.activeLibNode;
  vscode.postMessage({ type: 'open-docs', libraryName: d.libraryName, functionName: d.name, language: d.language });
});

// ── Global keyboard shortcuts ─────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Unwind order: topmost popup, then the filter query, then the panel.
    if (state.funcPopups.size > 0) {
      const top = [...state.funcPopups.values()].reduce((a, b) =>
        parseInt(b.element.style.zIndex) > parseInt(a.element.style.zIndex) ? b : a);
      closeFuncPopupInstance(top);
      return;
    }
    if (clearSearch()) return;
    if (settingsPanel?.classList.contains('open')) {
      settingsPanel.classList.remove('open');
      searchInput?.blur();
    }
    return;
  }

  // Ctrl/Cmd+F — open the panel first, the box is display:none while it's closed.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    settingsPanel?.classList.add('open');
    searchInput?.focus();
    searchInput?.select();
  }
});

if (typeof module !== 'undefined') {
  module.exports = { applyResizeDelta, applySavedViewSettings, applySavedDrilldownState, applySavedFileFilters, fileFilterAllows, buildSavePayload, clearSearch, updateSearchCount, updateFolderPanel };
}

// ── Resize math helper ────────────────────────────────────────────────────────
function applyResizeDelta(card, dir, dx, dy, startLeft, startTop, startW, startH) {
  let newLeft = startLeft, newTop = startTop, newW = startW, newH = startH;
  if (dir.includes('e')) newW = Math.max(320, startW + dx);
  if (dir.includes('s')) newH = Math.max(200, startH + dy);
  if (dir.includes('w')) { newW = Math.max(320, startW - dx); newLeft = startLeft + startW - newW; }
  if (dir.includes('n')) { newH = Math.max(200, startH - dy); newTop = startTop + startH - newH; }
  newLeft = Math.max(0, Math.min(window.innerWidth - newW, newLeft));
  newTop = Math.max(0, Math.min(window.innerHeight - newH, newTop));
  card.style.left = newLeft + 'px';
  card.style.top = newTop + 'px';
  card.style.width = newW + 'px';
  card.style.height = newH + 'px';
}


const complexitySlider = document.getElementById('slider-complexity');
const complexityVal = document.getElementById('val-complexity');
if (complexitySlider) {
  complexitySlider.addEventListener('input', () => {
    const raw = parseFloat(complexitySlider.value);
    if (typeof isDrilldown === 'function' && isDrilldown()) {
      // File mode: the slider is a uniform "open folders to depth D" control.
      clearTimeout(state.clusterTimer);
      state.clusterTimer = setTimeout(() => applyDetailDepth(raw), 80);
      window.markDirty?.();
      return;
    }
    if (state.viewMode === 'workflow') {
      // Workflow mode reinterprets the 0..1 slider as 10 discrete detail levels.
      const levels = (typeof WORKFLOW_LEVELS !== 'undefined') ? WORKFLOW_LEVELS : 10;
      state.workflowLevel = Math.round(raw * (levels - 1));
      if (complexityVal) complexityVal.textContent = String(state.workflowLevel);
    } else {
      state.complexityLevel = raw;
      if (complexityVal) complexityVal.textContent = raw.toFixed(2);
    }
    state.expandedClusters = new Set();
    clearTimeout(state.clusterTimer);
    state.clusterTimer = setTimeout(applyComplexity, 80);
    window.markDirty?.();
  });
}
