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

document.getElementById('toggle-existing')?.addEventListener('change', (e) => {
  settings.existingFilesOnly = e.target.checked;
  applyFilters();
});

document.getElementById('toggle-orphans')?.addEventListener('change', (e) => {
  settings.showOrphans = e.target.checked;
  applyFilters();
});

// ── Group controls ────────────────────────────────────────────────────────────
document.getElementById('toggle-group-file')?.addEventListener('change', (e) => {
  settings.groupByFile = e.target.checked;
  applyDisplaySettings();
});

document.getElementById('toggle-group-flow')?.addEventListener('change', (e) => {
  e.target.checked = false; // Dagre not available in D3 mode
  const notice = document.getElementById('flow-notice');
  if (notice) {
    notice.style.display = 'block';
    setTimeout(() => { notice.style.display = 'none'; }, 3000);
  }
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

// ── Git mode toggle ───────────────────────────────────────────────────────────
document.getElementById('btn-git-mode')?.addEventListener('click', () => {
  state.gitMode = !state.gitMode;
  document.getElementById('btn-git-mode')?.classList.toggle('active', state.gitMode);
  applyGitColors();
  // If the simulation hasn't auto-fit yet, do it now so git colors are immediately visible
  if (state.gitMode && !state.hasFitted) {
    state.hasFitted = true;
    fitToView();
  }
});

// ── Language mode toggle ──────────────────────────────────────────────────────
document.getElementById('btn-language-mode')?.addEventListener('click', () => {
  state.languageMode = !state.languageMode;
  document.getElementById('btn-language-mode')?.classList.toggle('active', state.languageMode);
  applyGitColors();
});

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
