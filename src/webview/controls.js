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

// ── Function popup controls ────────────────────────────────────────────────────
function closeFuncPopupFloat() {
  const card = document.getElementById('func-card');
  if (!card) return;
  card.classList.remove('func-card--floating');
  card.style.left = '';
  card.style.top = '';
  card.style.width = '';
  card.style.height = '';
  state.funcCardDragged = false;
  const popup = document.getElementById('func-popup');
  if (popup) delete popup.dataset.noBackdropClose;
}

function closeFuncPopup() {
  closeFuncPopupFloat();
  const popup = document.getElementById('func-popup');
  if (popup) popup.style.display = 'none';
  state.activeFuncNode = null;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const popup = document.getElementById('func-popup');
    if (popup && popup.style.display !== 'none') closeFuncPopup();
  }
});

document.getElementById('func-popup-close')?.addEventListener('click', () => {
  closeFuncPopup();
});
document.getElementById('func-popup')?.addEventListener('click', (e) => {
  const popup = document.getElementById('func-popup');
  if (e.target === popup && !popup.dataset.noBackdropClose) closeFuncPopup();
});
document.getElementById('func-open-file-btn')?.addEventListener('click', () => {
  if (!state.activeFuncNode) return;
  const d = state.activeFuncNode;
  vscode.postMessage({ type: 'navigate', file: d.file, line: d.line });
});
document.getElementById('func-source-textarea')?.addEventListener('input', () => { updateFuncHighlight(); updateSaveBtn(); });

document.getElementById('func-source-textarea')?.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    const btn = document.getElementById('func-save-btn');
    if (!btn?.disabled) btn?.click();
    return;
  }
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const ta = e.target;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + '\t' + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + 1;
  updateFuncHighlight();
});

document.getElementById('func-save-btn')?.addEventListener('click', () => {
  if (!state.activeFuncNode) return;
  const d = state.activeFuncNode;
  const textarea = document.getElementById('func-source-textarea');
  if (!textarea || textarea.readOnly) return;
  vscode.postMessage({ type: 'save-func-source', file: d.file, line: d.line, newSource: textarea.value });
  closeFuncPopup();
});

// ── Drag to move ───────────────────────────────────────────────────────────────
function initFuncDrag() {
  const header = document.getElementById('func-header');
  if (!header) return;
  let dragging = false;
  let startX, startY, startLeft, startTop;

  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    const card = document.getElementById('func-card');
    const popup = document.getElementById('func-popup');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    state.funcCardX = rect.left;
    state.funcCardY = rect.top;
    state.funcCardW = rect.width;
    state.funcCardH = rect.height;
    card.classList.add('func-card--floating');
    card.style.left = state.funcCardX + 'px';
    card.style.top = state.funcCardY + 'px';
    card.style.width = state.funcCardW + 'px';
    card.style.height = state.funcCardH + 'px';
    if (popup) popup.dataset.noBackdropClose = '1';
    state.funcCardDragged = true;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = state.funcCardX;
    startTop = state.funcCardY;
    dragging = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const card = document.getElementById('func-card');
    if (!card) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const newLeft = Math.max(0, Math.min(window.innerWidth - state.funcCardW, startLeft + dx));
    const newTop = Math.max(0, Math.min(window.innerHeight - state.funcCardH, startTop + dy));
    card.style.left = newLeft + 'px';
    card.style.top = newTop + 'px';
  });

  document.addEventListener('mouseup', () => { dragging = false; });

  header.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    closeFuncPopupFloat();
  });
}

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

// ── Resize by dragging borders/corners ────────────────────────────────────────
function initFuncResize() {
  const handles = document.querySelectorAll('.func-resize-handle');
  if (!handles.length) return;
  let resizing = false;
  let dir, startX, startY, startLeft, startTop, startW, startH;

  handles.forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      const card = document.getElementById('func-card');
      const popup = document.getElementById('func-popup');
      if (!card) return;
      if (!state.funcCardDragged) {
        const rect = card.getBoundingClientRect();
        state.funcCardX = rect.left;
        state.funcCardY = rect.top;
        state.funcCardW = rect.width;
        state.funcCardH = rect.height;
        card.classList.add('func-card--floating');
        card.style.left = state.funcCardX + 'px';
        card.style.top = state.funcCardY + 'px';
        card.style.width = state.funcCardW + 'px';
        card.style.height = state.funcCardH + 'px';
        if (popup) popup.dataset.noBackdropClose = '1';
        state.funcCardDragged = true;
      }
      dir = handle.dataset.dir;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseFloat(card.style.left) || 0;
      startTop = parseFloat(card.style.top) || 0;
      startW = parseFloat(card.style.width) || card.offsetWidth;
      startH = parseFloat(card.style.height) || card.offsetHeight;
      resizing = true;
      e.preventDefault();
      e.stopPropagation();
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const card = document.getElementById('func-card');
    if (!card) return;
    applyResizeDelta(card, dir, e.clientX - startX, e.clientY - startY, startLeft, startTop, startW, startH);
  });

  document.addEventListener('mouseup', () => { resizing = false; });
}

initFuncDrag();
initFuncResize();

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
