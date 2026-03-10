// ── Language colors ───────────────────────────────────────────────────────────
const languageColors = {
  python:     '#3572A5',
  typescript: '#dd3b71',
  javascript: '#f7df1e',
};

function getLanguageColor(lang) {
  if (!lang) return null;
  if (languageColors[lang]) return languageColors[lang];
  let hash = 0;
  for (let i = 0; i < lang.length; i++) hash = lang.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${((hash >>> 0) % 360)}, 55%, 55%)`;
}

// ── Git color resolvers ───────────────────────────────────────────────────────
function resolveNodeFill(d) {
  if (state.gitMode && !d.isCluster && !d.isSynthetic && !d.isOrphanCluster && d.gitStatus) {
    const status = d.gitStatus.unstaged ?? d.gitStatus.staged;
    if (status === 'added')    return '#4caf50';
    if (status === 'modified') return '#ff9800';
    if (status === 'deleted')  return '#555';
  }
  if (state.languageMode && !d.isCluster && !d.isSynthetic && !d.isOrphanCluster && d.language) {
    return getLanguageColor(d.language);
  }
  return nodeColor(d);
}

function resolveNodeStroke(d) {
  if (state.gitMode && d.gitStatus?.staged != null && !d.isCluster && !d.isSynthetic)
    return '#ffffff';
  return settings.groupByFile ? fileColor(d.file) : 'none';
}

function resolveNodeStrokeWidth(d) {
  if (state.gitMode && d.gitStatus?.staged != null && !d.isCluster && !d.isSynthetic) return 3;
  return 2;
}

function renderLanguageLegend() {
  const el = document.getElementById('language-legend');
  if (!el) return;
  if (!state.graphData) { el.innerHTML = ''; return; }

  const langs = [...new Set(
    state.graphData.nodes.map(n => n.language).filter(Boolean)
  )].sort();

  if (langs.length === 0) { el.innerHTML = ''; return; }

  el.innerHTML = langs.map(lang => {
    const color = getLanguageColor(lang);
    return `<div class="lang-legend-row">
      <input type="color" class="lang-swatch" data-lang="${lang}" value="${color}" title="Click to change color">
      <span class="lang-label">${lang}</span>
    </div>`;
  }).join('');

  el.querySelectorAll('.lang-swatch').forEach(input => {
    input.addEventListener('input', (e) => {
      languageColors[e.target.dataset.lang] = e.target.value;
      applyGitColors();
    });
  });
}

if (typeof module !== 'undefined') {
  module.exports = { resolveNodeFill, getLanguageColor, renderLanguageLegend };
}

function applyGitColors() {
  if (!state.svgNodes) return;
  state.svgNodes
    .style('fill', d => resolveNodeFill(d))
    .attr('stroke', d => resolveNodeStroke(d))
    .attr('stroke-width', d => resolveNodeStrokeWidth(d));
  state.svgLabels?.style('text-decoration', d =>
    state.gitMode && (d.gitStatus?.unstaged === 'deleted' || d.gitStatus?.staged === 'deleted') ? 'line-through' : null
  );
  renderLanguageLegend();
}
