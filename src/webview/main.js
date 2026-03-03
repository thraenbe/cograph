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
    if (settings.existingFilesOnly) {
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
    ],
  });

  cy.on('tap', 'node', (evt) => {
    const node = evt.target;
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
    const size = 36 * settings.nodeSize * 1.15;
    node.style({ width: size, height: size });
  });
  cy.on('mouseout', 'node', (evt) => {
    const node = evt.target;
    node.removeClass('hovered');
    node.connectedEdges().removeClass('highlighted');
    const size = 36 * settings.nodeSize;
    node.style({ width: size, height: size });
  });

  if (typeof cy.navigator === 'function') {
    cy.navigator({ container: '#minimap' });
  }

  applyFilters();
  applyDisplaySettings();
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
