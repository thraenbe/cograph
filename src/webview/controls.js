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
document.getElementById('btn-layout-dynamic')?.addEventListener('click', () => setLayoutMode('dynamic'));
document.getElementById('btn-layout-static')?.addEventListener('click', () => setLayoutMode('static'));

// ── Filter controls ───────────────────────────────────────────────────────────
document.getElementById('search')?.addEventListener('input', applyFilters);

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
wireSlider('slider-node-size', 'val-node-size', 'nodeSize', applyDisplaySettings);
wireSlider('slider-text-size', 'val-text-size', 'textSize', applyDisplaySettings);
wireSlider('slider-link-thickness', 'val-link-thickness', 'linkThickness', applyDisplaySettings);
wireSlider('slider-center-force', 'val-center-force', 'centerForce', rerunLayout);
wireSlider('slider-repel-force', 'val-repel-force', 'repelForce', rerunLayout);
wireSlider('slider-link-force', 'val-link-force', 'linkForce', rerunLayout);
wireSlider('slider-link-distance', 'val-link-distance', 'linkDistance', rerunLayout);

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
wireLegendToggle('toggle-detail-legend', 'detail-legend-body');
wireLegendToggle('toggle-git-legend', 'git-legend-body');

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
});

// ── Folder mode ────────────────────────────────────────────────────────────────
document.getElementById('btn-folder-mode')?.classList.toggle('active', state.folderMode);
document.getElementById('btn-folder-mode')?.addEventListener('click', () => {
  state.folderMode = !state.folderMode;
  document.getElementById('btn-folder-mode')?.classList.toggle('active', state.folderMode);
  applyComplexity();
});

// ── Class mode ─────────────────────────────────────────────────────────────────
document.getElementById('btn-class-mode')?.classList.toggle('active', state.classMode);
document.getElementById('btn-class-mode')?.addEventListener('click', () => {
  state.classMode = !state.classMode;
  document.getElementById('btn-class-mode')?.classList.toggle('active', state.classMode);
  applyComplexity();
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
  if (e.key === 'Escape' && state.funcPopups.size > 0) {
    const top = [...state.funcPopups.values()].reduce((a, b) =>
      parseInt(b.element.style.zIndex) > parseInt(a.element.style.zIndex) ? b : a);
    closeFuncPopupInstance(top);
  }
});

if (typeof module !== 'undefined') {
  module.exports = { applyResizeDelta };
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
    state.complexityLevel = parseFloat(complexitySlider.value);
    if (complexityVal) complexityVal.textContent = state.complexityLevel.toFixed(2);
    state.expandedClusters = new Set();
    clearTimeout(state.clusterTimer);
    state.clusterTimer = setTimeout(applyComplexity, 80);
  });
}
