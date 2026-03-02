const vscode = acquireVsCodeApi();
let cy;

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'graph') {
    renderGraph(message.data);
  }
});

function renderGraph(data) {
  cy = cytoscape({
    container: document.getElementById('cy'),
    elements: {
      nodes: data.nodes.map((n) => ({ data: { id: n.id, label: n.name, file: n.file, line: n.line } })),
      edges: data.edges.map((e) => ({ data: { source: e.source, target: e.target } })),
    },
    layout: { name: 'cose' },
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
          width: 1,
          'line-color': '#888',
          'target-arrow-color': '#888',
          'target-arrow-shape': 'triangle',
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
}

document.getElementById('search')?.addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase();
  if (!cy) return;
  cy.nodes().forEach((node) => {
    const visible = node.data('label').toLowerCase().includes(query);
    node.style('display', visible ? 'element' : 'none');
  });
});
