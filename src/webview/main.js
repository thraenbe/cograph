const vscode = acquireVsCodeApi();
let cy;

const settings = {
  existingFilesOnly: false,
  showOrphans: true,
  groupByFile: false,
  groupByFlow: false,
  arrows: true,
  textFadeThreshold: 0.5,
  nodeSize: 1.0,
  linkThickness: 1,
  centerForce: 0.1,
  repelForce: 2048,
  linkForce: 1,
  linkDistance: 80,
};

let graphData = null;
let complexityLevel = 1.0;
let _importanceScores = null;
let _clusterTimer = null;

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'graph') {
    renderGraph(message.data);
  }
});

function buildElements(data) {
  const elements = [];

  const entryPointIds = new Set(
    data.edges.filter((e) => e.source === '::MAIN::0').map((e) => e.target)
  );

  if (settings.groupByFile) {
    const files = new Set(data.nodes.map((n) => n.file).filter(Boolean));
    files.forEach((file) => {
      elements.push({ data: { id: `file::${file}`, label: file.split('/').pop() } });
    });
    data.nodes.forEach((n) => {
      if (n.id === '::MAIN::0') return;
      const parent = n.file ? `file::${n.file}` : undefined;
      elements.push({ data: { id: n.id, label: n.name, file: n.file, line: n.line, parent, isEntryPoint: entryPointIds.has(n.id) } });
    });
  } else {
    data.nodes.forEach((n) => {
      if (n.id === '::MAIN::0') return;
      elements.push({ data: { id: n.id, label: n.name, file: n.file, line: n.line, isEntryPoint: entryPointIds.has(n.id) } });
    });
  }

  data.edges.forEach((e) => {
    if (e.source === '::MAIN::0') return;
    elements.push({ data: { source: e.source, target: e.target } });
  });

  return elements;
}

function getLayout() {
  if (settings.groupByFlow) {
    return { name: 'dagre', rankDir: 'LR' };
  }
  return {
    name: 'cose',
    gravity: settings.centerForce,
    repulsion: settings.repelForce,
    springCoeff: settings.linkForce,
    idealEdgeLength: settings.linkDistance,
    animate: true,
    animationDuration: 400,
    animationEasing: 'ease-out',
  };
}

function applyFilters() {
  if (!cy) return;

  const query = document.getElementById('search')?.value.toLowerCase() ?? '';
  cy.nodes().forEach((node) => {
    if (node.isParent()) return;
    let visible = true;
    if (query && !node.data('label').toLowerCase().includes(query)) {
      visible = false;
    }
    if (settings.existingFilesOnly && !node.data('isCluster') && !node.data('isSynthetic')) {
      const file = node.data('file');
      const line = node.data('line');
      if (!file || !line || line <= 0) visible = false;
    }
    if (!settings.showOrphans && node.connectedEdges().length === 0) {
      visible = false;
    }
    node.style('display', visible ? 'element' : 'none');
  });
}

function applyDisplaySettings() {
  if (!cy) return;
  const arrowShape = settings.arrows ? 'triangle' : 'none';
  cy.batch(() => {
    cy.nodes().style({
      width: 36 * settings.nodeSize,
      height: 36 * settings.nodeSize,
    });
    cy.edges().style({
      width: settings.linkThickness,
      'target-arrow-shape': arrowShape,
    });
  });
  cy.off('zoom');
  cy.on('zoom', () => {
    const opacity = cy.zoom() >= settings.textFadeThreshold ? 1 : 0;
    cy.batch(() => cy.nodes().style('text-opacity', opacity));
  });
  const opacity = cy.zoom() >= settings.textFadeThreshold ? 1 : 0;
  cy.batch(() => cy.nodes().style('text-opacity', opacity));
}

function applyComplexity() {
  if (!cy || !graphData || !_importanceScores) return;
  const clusterResult = computeClusters(graphData, _importanceScores, complexityLevel);
  const elements = buildClusteredElements(graphData, clusterResult, complexityLevel);
  cy.elements().remove();
  cy.add(elements);
  applyFilters();
  applyDisplaySettings();
  cy.nodes().forEach((node) => {
    const s = node.data('_size');
    if (s) node.style({ width: s * settings.nodeSize, height: s * settings.nodeSize });
  });
  cy.layout(getLayout()).run();
}

let _layoutTimer = null;
function rerunLayout() {
  if (!cy) return;
  clearTimeout(_layoutTimer);
  _layoutTimer = setTimeout(() => cy.layout(getLayout()).run(), 60);
}

function rebuildGraph() {
  if (!graphData) return;
  renderGraph(graphData);
}

function renderGraph(data) {
  graphData = data;
  if (cy) {
    cy.destroy();
    cy = null;
  }

  cy = cytoscape({
    container: document.getElementById('cy'),
    elements: buildElements(data),
    layout: getLayout(),
    minZoom: 0.1,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'font-size': '10px',
          'background-color': '#a0a0a0',
          color: '#cccccc',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'text-margin-y': 8,
          width: 36,
          height: 36,
          shape: 'ellipse',
        },
      },
      {
        selector: 'edge',
        style: {
          width: settings.linkThickness,
          'line-color': '#888',
          'target-arrow-color': '#888',
          'target-arrow-shape': settings.arrows ? 'triangle' : 'none',
          'curve-style': 'bezier',
        },
      },
      {
        selector: 'node:selected',
        style: { 'background-color': '#f0a04e' },
      },
      {
        selector: 'node[?isEntryPoint]',
        style: {
          'background-color': '#e05252',
        },
      },
      {
        selector: 'node.hovered',
        style: {
          'background-color': '#4e9bf0',
          color: '#ffffff',
          'font-size': '11.5px',
        },
      },
      {
        selector: 'edge.highlighted',
        style: {
          'line-color': '#4e9bf0',
          'target-arrow-color': '#4e9bf0',
          width: 2,
        },
      },
      {
        selector: 'node[?isCluster]',
        style: {
          'background-color': '#7c4dbb',
          color: '#ffffff',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '80px',
          'font-size': '10px',
        },
      },
      {
        selector: 'node[?isOrphanCluster]',
        style: { 'background-color': '#666666' },
      },
      {
        selector: '$node > node',
        style: {
          'background-color': 'rgba(80, 80, 120, 0.1)',
          'border-color': '#666',
          'border-width': 1,
          label: 'data(label)',
          'font-size': '11px',
          color: '#aaa',
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': -8,
        },
      },
      {
        selector: 'node[?isSynthetic]',
        style: {
          'background-color': 'var(--vscode-button-background, #0e639c)',
          color: '#ffffff',
          'font-size': '14px',
          width: 80,
          height: 80,
          label: 'data(label)',
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': '70px',
        },
      },
    ],
  });

  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
    if (node.data('isSynthetic') || node.data('isCluster')) return;
    vscode.postMessage({
      type: 'navigate',
      file: node.data('file'),
      line: node.data('line'),
    });
  });

  cy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    node.addClass('hovered');
    node.connectedEdges().addClass('highlighted');
    const base = node.data('_size') ?? 36;
    node.style({ width: base * settings.nodeSize * 1.15, height: base * settings.nodeSize * 1.15 });
  });
  cy.on('mouseout', 'node', (evt) => {
    const node = evt.target;
    node.removeClass('hovered');
    node.connectedEdges().removeClass('highlighted');
    const base = node.data('_size') ?? 36;
    node.style({ width: base * settings.nodeSize, height: base * settings.nodeSize });
  });

  if (typeof cy.navigator === 'function') {
    cy.navigator({ container: '#minimap' });
  }

  _importanceScores = computeImportanceScores(graphData);
  applyComplexity();
}

// ── Settings panel ──────────────────────────────────────────────────────────

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

// ── Filter controls ──────────────────────────────────────────────────────────

document.getElementById('search')?.addEventListener('input', () => applyFilters());

document.getElementById('toggle-existing')?.addEventListener('change', (e) => {
  settings.existingFilesOnly = e.target.checked;
  applyFilters();
});

document.getElementById('toggle-orphans')?.addEventListener('change', (e) => {
  settings.showOrphans = e.target.checked;
  applyFilters();
});

// ── Group controls ───────────────────────────────────────────────────────────

document.getElementById('toggle-group-file')?.addEventListener('change', (e) => {
  settings.groupByFile = e.target.checked;
  rebuildGraph();
});

document.getElementById('toggle-group-flow')?.addEventListener('change', (e) => {
  settings.groupByFlow = e.target.checked;
  rebuildGraph();
});

// ── Display controls ─────────────────────────────────────────────────────────

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
wireSlider('slider-link-thickness', 'val-link-thickness', 'linkThickness', applyDisplaySettings);
wireSlider('slider-center-force', 'val-center-force', 'centerForce', rerunLayout);
wireSlider('slider-repel-force', 'val-repel-force', 'repelForce', rerunLayout);
wireSlider('slider-link-force', 'val-link-force', 'linkForce', rerunLayout);
wireSlider('slider-link-distance', 'val-link-distance', 'linkDistance', rerunLayout);

const complexitySlider = document.getElementById('slider-complexity');
const complexityVal = document.getElementById('val-complexity');
if (complexitySlider) {
  complexitySlider.addEventListener('input', () => {
    complexityLevel = parseFloat(complexitySlider.value);
    if (complexityVal) complexityVal.textContent = complexityLevel.toFixed(2);
    clearTimeout(_clusterTimer);
    _clusterTimer = setTimeout(applyComplexity, 80);
  });
}
