declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

const vscode = acquireVsCodeApi();

const NODE_RENDER_LIMIT = 500;

let cy: cytoscape.Core | undefined;

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'graph') {
    renderGraph(message.data);
  }
});

function renderGraph(data: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  if (data.nodes.length > NODE_RENDER_LIMIT) {
    showLargeGraphWarning(data.nodes.length, data.edges.length, data);
    return;
  }
  renderCytoscape(data);
}

function showLargeGraphWarning(
  nodeCount: number,
  edgeCount: number,
  data: { nodes: GraphNode[]; edges: GraphEdge[] }
) {
  const cyEl = document.getElementById('cy');
  if (!cyEl) {
    return;
  }
  cyEl.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;font-family:sans-serif;padding:24px;box-sizing:border-box">
      <div style="font-size:48px">&#x26A0;</div>
      <p style="margin:0;font-size:15px;text-align:center">
        This graph has <strong>${nodeCount}</strong> nodes and <strong>${edgeCount}</strong> edges —
        rendering may freeze VS Code.
      </p>
      <button id="render-anyway" style="padding:8px 20px;cursor:pointer;font-size:14px">
        Render anyway
      </button>
    </div>`;
  document.getElementById('render-anyway')?.addEventListener('click', () => {
    renderCytoscape(data);
  });
}

function renderCytoscape(data: { nodes: GraphNode[]; edges: GraphEdge[] }) {
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

let searchDebounce: ReturnType<typeof setTimeout> | undefined;

document.getElementById('search')?.addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    if (!cy) {
      return;
    }
    const query = (e.target as HTMLInputElement).value.toLowerCase();
    cy.batch(() => {
      cy!.nodes().forEach((node) => {
        const visible = node.data('label').toLowerCase().includes(query);
        node.style('display', visible ? 'element' : 'none');
      });
    });
  }, 150);
});

interface GraphNode {
  id: string;
  name: string;
  file: string;
  line: number;
}

interface GraphEdge {
  source: string;
  target: string;
}
