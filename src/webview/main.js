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

  if (settings.groupByFile) {
    const files = new Set(data.nodes.map((n) => n.file).filter(Boolean));
    files.forEach((file) => {
      elements.push({ data: { id: `file::${file}`, label: file.split('/').pop() } });
    });
    data.nodes.forEach((n) => {
      const parent = n.file ? `file::${n.file}` : undefined;
      elements.push({ data: { id: n.id, label: n.name, file: n.file, line: n.line, parent } });
    });
  } else {
    data.nodes.forEach((n) => {
      elements.push({ data: { id: n.id, label: n.name, file: n.file, line: n.line } });
    });
  }

  data.edges.forEach((e) => {
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
    cy.nodes().not('[id = "::MAIN::0"]').style({
      padding: `${6 * settings.nodeSize}px`,
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

function rerunLayout() {
  if (!cy) return;
  cy.layout(getLayout()).run();
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
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'font-size': '10px',
          'background-color': '#4e9bf0',
          color: '#fff',
          'text-valign': 'center',
          'text-halign': 'center',
          width: 'label',
          height: 'label',
          padding: '6px',
          shape: 'roundrectangle',
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
        selector: 'node[id = "::MAIN::0"]',
        style: {
          'background-color': '#e05252',
          'font-weight': 'bold',
          width: 60,
          height: 60,
          shape: 'ellipse',
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
