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

// ── Filter controls ───────────────────────────────────────────────────────────
const searchInput = document.getElementById('search');
const btnClearSearch = document.getElementById('btn-clear-search');

searchInput?.addEventListener('input', (e) => {
  if (btnClearSearch) {
    btnClearSearch.style.display = e.target.value.length > 0 ? 'block' : 'none';
  }
  applyFilters();
});

btnClearSearch?.addEventListener('click', () => {
  if (searchInput) {
    searchInput.value = '';
    btnClearSearch.style.display = 'none';
    applyFilters();
  }
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

// ── Configuration controls ────────────────────────────────────────────────────
document.getElementById('toggle-func-popup')?.addEventListener('change', (e) => {
  settings.openFunctionPopup = e.target.checked;
});

document.getElementById('btn-reset-layout')?.addEventListener('click', () => {
  const defaults = {
    textFadeThreshold: 0.5,
    nodeSize: 2.5,
    textSize: 1.5,
    linkThickness: 4
  };

  Object.assign(settings, defaults);

  for (const [key, val] of Object.entries({
    'slider-text-fade': { valId: 'val-text-fade', value: defaults.textFadeThreshold },
    'slider-node-size': { valId: 'val-node-size', value: defaults.nodeSize },
    'slider-text-size': { valId: 'val-text-size', value: defaults.textSize },
    'slider-link-thickness': { valId: 'val-link-thickness', value: defaults.linkThickness }
  })) {
    const slider = document.getElementById(key);
    const valEl = document.getElementById(val.valId);
    if (slider) slider.value = val.value;
    if (valEl) valEl.textContent = val.value;
  }

  // Forces reset to the size-aware defaults (#27), not fixed 0.05/250/1 — a
  // small repo (≤500 nodes) still lands on today's values. Clearing the
  // user-tuned flag re-arms dynamic defaults; syncForceSliders mirrors them.
  const forceDefaults = computeForceDefaults(state.currentNodes.length);
  settings.centerForce = forceDefaults.centerForce;
  settings.repelForce = forceDefaults.repelForce;
  settings.linkForce = forceDefaults.linkForce;
  settings.userTunedForces = false;
  syncForceSliders();

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

// Push the three main force values from `settings` back into their sliders +
// value labels. Called after dynamic size-based defaults (#27) mutate settings
// (Reset, and startSimulation) so the controls reflect the applied values.
function syncForceSliders() {
  const rows = [
    ['slider-center-force', 'val-center-force', settings.centerForce],
    ['slider-repel-force', 'val-repel-force', settings.repelForce],
    ['slider-link-force', 'val-link-force', settings.linkForce],
  ];
  for (const [sliderId, labelId, value] of rows) {
    const slider = document.getElementById(sliderId);
    const label = document.getElementById(labelId);
    if (slider) slider.value = String(value);
    if (label) label.textContent = String(value);
  }
}

wireSlider('slider-text-fade', 'val-text-fade', 'textFadeThreshold', applyDisplaySettings);
wireSlider('slider-node-size', 'val-node-size', 'nodeSize', applyDisplaySettings);
wireSlider('slider-text-size', 'val-text-size', 'textSize', applyDisplaySettings);
wireSlider('slider-link-thickness', 'val-link-thickness', 'linkThickness', applyDisplaySettings);
// Hand-tuning any of the three main forces opts this repo out of the dynamic
// size-based defaults (#27) until the next Reset.
function markForcesTunedAndRerun() {
  settings.userTunedForces = true;
  rerunLayout();
}
wireSlider('slider-center-force', 'val-center-force', 'centerForce', markForcesTunedAndRerun);
wireSlider('slider-repel-force', 'val-repel-force', 'repelForce', markForcesTunedAndRerun);
wireSlider('slider-link-force', 'val-link-force', 'linkForce', markForcesTunedAndRerun);
wireSlider('slider-file-cluster', 'val-file-cluster', 'fileClusterForce', rerunLayout);
wireSlider('slider-folder-repel', 'val-folder-repel', 'folderRepelForce', rerunLayout);
wireSlider('slider-file-repel', 'val-file-repel', 'fileRepelForce', rerunLayout);

// "view more forces" shortcut — opens the gear settings panel (Center/Repel/Link forces)
document.getElementById('btn-more-forces')?.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel?.classList.add('open');
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

// ── Cluster group-by controls ─────────────────────────────────────────────────
// Three lenses: File (the folder drill-down — default), Class, Connect.
const GROUP_BY_MODES = ['file', 'class', 'connect'];
GROUP_BY_MODES.forEach(mode => {
  document.getElementById(`btn-group-${mode}`)?.addEventListener('click', () => {
    state.expandedClusters = new Set();
    GROUP_BY_MODES.forEach(m =>
      document.getElementById(`btn-group-${m}`)?.classList.toggle('active', m === mode)
    );
    if (mode === 'file') {
      // File mode IS the folder drill-down.
      if (typeof enterFileClusterMode === 'function') { enterFileClusterMode(); }
    } else {
      state.viewMode = 'cluster';
      state.clusterGroupBy = mode;
      applyComplexity();
    }
    window.markDirty?.();
  });
});

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

function updateFolderPanel() {
  const body = document.getElementById('folder-filters-body');
  if (!body) return;

  const hasFilters = state.onlyShowFolder || state.hiddenFolders.size > 0;

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
        <span class="folder-filter-label" title="${state.onlyShowFolder}">${pathBasename(state.onlyShowFolder)}</span>
        <button class="folder-filter-clear" data-action="clear-only">✕</button>
      </div>`);
  }
  state.hiddenFolders.forEach(fp => {
    rows.push(`
      <div class="folder-filter-row">
        <span class="folder-filter-icon folder-filter-icon--hidden">⊘</span>
        <span class="folder-filter-label" title="${fp}">${pathBasename(fp)}</span>
        <button class="folder-filter-clear" data-action="unhide" data-path="${fp}">✕</button>
      </div>`);
  });
  rows.push(`<button class="folder-filter-show-all" id="btn-folder-show-all">Show All</button>`);
  body.innerHTML = rows.join('');

  body.querySelector('#btn-folder-show-all')?.addEventListener('click', () => {
    state.hiddenFolders.clear(); state.onlyShowFolder = null;
    applyFilters(); ticked(); updateFolderPanel();
  });
  body.querySelectorAll('.folder-filter-clear').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.action === 'clear-only') { state.onlyShowFolder = null; }
      else if (btn.dataset.action === 'unhide') { state.hiddenFolders.delete(btn.dataset.path); }
      applyFilters(); ticked(); updateFolderPanel();
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
  return {
    settings: {
      complexityLevel: state.complexityLevel,
      clusterGroupBy: state.clusterGroupBy,
      layoutMode: state.layoutMode,
      gitMode: state.gitMode,
      languageMode: state.languageMode,
      folderMode: state.folderMode,
      classMode: state.classMode,
    },
    nodePositions,
  };
}

/** Restore saved display settings from a graph-loaded payload onto state + the
 *  control DOM (buildSavePayload's read-side mirror). Handles the legacy
 *  'connectivity'/'auto' → 'connect' rename. */
function applySavedViewSettings(saved) {
  if (saved.complexityLevel !== undefined) {
    state.complexityLevel = saved.complexityLevel;
    const slider = document.getElementById('slider-complexity');
    const valEl = document.getElementById('val-complexity');
    if (slider) { slider.value = String(saved.complexityLevel); }
    if (valEl) { valEl.textContent = Number(saved.complexityLevel).toFixed(2); }
  }
  if (saved.clusterGroupBy !== undefined) {
    // Back-compat: 'connectivity'/'auto' were renamed to 'connect'.
    const legacy = { connectivity: 'connect', auto: 'connect' };
    state.clusterGroupBy = legacy[saved.clusterGroupBy] ?? saved.clusterGroupBy;
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

// ── Function popup — Escape closes topmost ────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // 1. Close topmost function popup on Escape
  if (e.key === 'Escape' && state.funcPopups.size > 0) {
    const top = [...state.funcPopups.values()].reduce((a, b) =>
      parseInt(b.element.style.zIndex) > parseInt(a.element.style.zIndex) ? b : a);
    closeFuncPopupInstance(top);
  }

  // 2. Focus search on Ctrl+F or Cmd+F
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    document.getElementById('search')?.focus();
  }
});

if (typeof module !== 'undefined') {
  module.exports = { applyResizeDelta, applySavedViewSettings, syncForceSliders };
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
