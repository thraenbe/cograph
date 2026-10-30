// ── Language colors ───────────────────────────────────────────────────────────
const languageColors = {
  python:     '#3572A5',
  typescript: '#dd3b71',
  javascript: '#f7df1e',
  java:       '#b07219',
  cpp:        '#f34b7d',
  c:          '#555555',
};

function getLanguageColor(lang) {
  if (!lang) return null;
  if (languageColors[lang]) return languageColors[lang];
  let hash = 0;
  for (let i = 0; i < lang.length; i++) hash = lang.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${((hash >>> 0) % 360)}, 55%, 55%)`;
}

// ── Git color resolvers ───────────────────────────────────────────────────────
/** The theme's "deleted" colour (--cograph-git-deleted). One source for the
 *  function nodes and for the file slot / file circle around them. */
function gitDeletedColor() {
  return typeof getComputedStyle !== 'undefined'
    ? (getComputedStyle(document.documentElement).getPropertyValue('--cograph-git-deleted').trim() || '#777777')
    : '#777777';
}

function resolveNodeFill(d) {
  if (state.gitMode && !d.isCluster && !d.isSynthetic && d.gitStatus) {
    const status = d.gitStatus.unstaged ?? d.gitStatus.staged;
    if (status === 'added')    return '#4caf50';
    if (status === 'modified') return '#ff9800';
    if (status === 'deleted')  return gitDeletedColor();
  }
  if (state.languageMode && !d.isCluster && !d.isSynthetic && d.language) {
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

  // Language names can come from a cache file the repository itself commits:
  // built as DOM nodes, never as markup (code scanning alert #2).
  el.replaceChildren(...langs.map(lang => {
    const row = document.createElement('div');
    row.className = 'lang-legend-row';
    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.className = 'lang-swatch';
    swatch.dataset.lang = lang;
    swatch.value = getLanguageColor(lang);
    swatch.title = 'Click to change color';
    const label = document.createElement('span');
    label.className = 'lang-label';
    label.textContent = lang;
    row.append(swatch, label);
    return row;
  }));

  el.querySelectorAll('.lang-swatch').forEach(input => {
    input.addEventListener('input', (e) => {
      languageColors[e.target.dataset.lang] = e.target.value;
      applyGitColors();
    });
  });
}

if (typeof module !== 'undefined') {
  module.exports = { resolveNodeFill, gitDeletedColor, getLanguageColor, renderLanguageLegend };
}

function applyGitColors() {
  if (!state.svgNodes) return;
  state.svgNodes
    .style('fill', d => resolveNodeFill(d))
    .attr('stroke', d => resolveNodeStroke(d))
    .attr('stroke-width', d => resolveNodeStrokeWidth(d));
  state.svgCloudNodes?.style('fill', d => resolveClusterFill(d));
  state.svgLabels?.style('text-decoration', d =>
    state.gitMode && (d.gitStatus?.unstaged === 'deleted' || d.gitStatus?.staged === 'deleted') ? 'line-through' : null
  );
  if (typeof tickFolderOverlay === 'function') tickFolderOverlay();
  renderLanguageLegend();
}
