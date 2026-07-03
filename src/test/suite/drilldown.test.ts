import * as assert from 'assert';

// Pure drill-down helpers from the webview modules (no DOM/D3 needed).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fc = require('../../../src/webview/fileClusters.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const folder = require('../../../src/webview/folder.js');
// jsdom is loaded at module scope: the first require is slow, and inside a
// setup() hook it can blow the hook timeout.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require('jsdom');

// A 3-level tree: /p (d0) → /p/a (d1) → /p/a/b (d2), plus a sibling /p/c (d1).
function makeTree(totalFiles = 4) {
  return {
    root: '/p',
    totalFiles,
    folders: {
      '/p':     { path: '/p',     depth: 0, parent: null,   childFolders: ['/p/a', '/p/c'], files: ['/p/x.ts'],     fileCount: totalFiles },
      '/p/a':   { path: '/p/a',   depth: 1, parent: '/p',   childFolders: ['/p/a/b'],       files: ['/p/a/y.ts'],   fileCount: 2 },
      '/p/a/b': { path: '/p/a/b', depth: 2, parent: '/p/a', childFolders: [],               files: ['/p/a/b/z.ts'], fileCount: 1 },
      '/p/c':   { path: '/p/c',   depth: 1, parent: '/p',   childFolders: [],               files: ['/p/c/w.ts'],   fileCount: 1 },
    },
    files: [
      { path: '/p/x.ts',     language: 'typescript' },
      { path: '/p/a/y.ts',   language: 'typescript' },
      { path: '/p/a/b/z.ts', language: 'python' },
      { path: '/p/c/w.ts',   language: 'typescript' },
    ],
  };
}

// These suites set the shared globals `state`/`settings`; save/restore so they
// don't leak into other webview test files that share the same globals.
let _savedState: any;
let _savedSettings: any;
setup(() => { _savedState = (global as any).state; _savedSettings = (global as any).settings; });
teardown(() => { (global as any).state = _savedState; (global as any).settings = _savedSettings; });

suite('drilldown depth helpers', () => {
  test('maxFolderDepth reflects the deepest folder', () => {
    assert.strictEqual(fc.maxFolderDepth(makeTree()), 2);
    assert.strictEqual(fc.maxFolderDepth({ folders: {} }), 0);
    assert.strictEqual(fc.maxFolderDepth(null), 0);
  });

  test('expandToDepth opens every folder shallower than D (D=0 → root only)', () => {
    const t = makeTree();
    assert.deepStrictEqual([...fc.expandToDepth(t, 0)].sort(), []);
    assert.deepStrictEqual([...fc.expandToDepth(t, 1)].sort(), ['/p']);
    assert.deepStrictEqual([...fc.expandToDepth(t, 2)].sort(), ['/p', '/p/a', '/p/c']);
    assert.deepStrictEqual([...fc.expandToDepth(t, 3)].sort(), ['/p', '/p/a', '/p/a/b', '/p/c']);
  });

  test('expandToDetail: 0 → root only, 1 → every folder open', () => {
    const t = makeTree();
    // raw 0 → nothing expanded (root collapsed).
    assert.deepStrictEqual([...fc.expandToDetail(t, 0)], []);
    // raw 1 → every folder open (a parsed folder then shows its files' functions).
    const full = fc.expandToDetail(t, 1);
    for (const fp of Object.keys(t.folders)) { assert.ok(full.has(fp), `folder ${fp} expanded`); }
    // Files are NOT in the expansion set — they surface via their open+parsed folder.
    for (const f of t.files) { assert.ok(!full.has(f.path), `file ${f.path} not in set`); }
    // Mid value expands strictly fewer than full and at least the root.
    const mid = fc.expandToDetail(t, 0.5);
    assert.ok(mid.size > 0 && mid.size < full.size);
  });
});

suite('drilldown folder paths', () => {
  test('pathUnder matches a folder and its descendants only', () => {
    assert.ok(folder.pathUnder('/p/a/b', '/p/a'));
    assert.ok(folder.pathUnder('/p/a', '/p/a'));
    assert.ok(!folder.pathUnder('/p/c', '/p/a'));
    assert.ok(!folder.pathUnder('/p/ab', '/p/a'), 'prefix without separator is not "under"');
  });

  test('ddNodePath returns the path a node is filed under', () => {
    assert.strictEqual(folder.ddNodePath({ isFolderCluster: true, _folderPath: '/p/a' }), '/p/a');
    assert.strictEqual(folder.ddNodePath({ isFileCluster: true, _filePath: '/p/a/y.ts' }), '/p/a/y.ts');
    assert.strictEqual(folder.ddNodePath({ file: '/p/a/y.ts' }), '/p/a/y.ts');
    assert.strictEqual(folder.ddNodePath({ file: null }), null);
  });
});

suite('buildDrilldownBoxData', () => {
  test('one box per expanded folder; members are exactly its descendants', () => {
    (global as any).state = {
      structureTree: makeTree(),
      expandedFolders: new Set(['/p', '/p/a']),
      currentNodes: [
        { id: 'folder::/p/a',     isFolderCluster: true, _folderPath: '/p/a' },
        { id: 'folder::/p/c',     isFolderCluster: true, _folderPath: '/p/c' },
        { id: 'file::/p/a/b/z.ts', isFileCluster: true,  _filePath: '/p/a/b/z.ts' },
        { id: 'fnX',              file: '/p/x.ts' },
        { id: 'fnY',              file: '/p/a/y.ts' },
      ],
    };
    const boxes = folder.buildDrilldownBoxData();
    const byPath = new Map<string, any>(boxes.map((b: any) => [b.folderPath, b]));

    // The project root ('/p') gets NO box; only non-root expanded folders do.
    assert.deepStrictEqual(boxes.map((b: any) => b.folderPath).sort(), ['/p/a']);
    assert.ok(!byPath.has('/p'), 'root folder is not boxed');

    // /p/a contains only its descendants — NOT /p/c, NOT the root file fnX.
    const a = byPath.get('/p/a');
    const aIds = a.members.map((m: any) => m.id);
    assert.ok(aIds.includes('fnY') && aIds.includes('file::/p/a/b/z.ts'));
    assert.ok(!aIds.includes('folder::/p/c'), 'sibling folder excluded');
    assert.ok(!aIds.includes('fnX'), 'root-level file excluded');
  });

  test('boxes are ordered shallow-first (parents render behind children)', () => {
    (global as any).state = {
      structureTree: makeTree(),
      expandedFolders: new Set(['/p/a/b', '/p/a', '/p']),
      currentNodes: [
        { id: 'fnY', file: '/p/a/y.ts' },
        { id: 'fnZ', file: '/p/a/b/z.ts' },
      ],
    };
    // Root '/p' excluded; remaining boxes ordered by depth (1 before 2).
    const boxes = folder.buildDrilldownBoxData();
    assert.deepStrictEqual(boxes.map((b: any) => b.depth), [1, 2]);
    assert.deepStrictEqual(boxes.map((b: any) => b.folderPath), ['/p/a', '/p/a/b']);
  });

  test('an expanded file path (not a folder) produces no box', () => {
    (global as any).state = {
      structureTree: makeTree(),
      expandedFolders: new Set(['/p/a/y.ts']),
      currentNodes: [{ id: 'fnY', file: '/p/a/y.ts' }],
    };
    assert.deepStrictEqual(folder.buildDrilldownBoxData(), []);
  });
});

suite('elapse / collapse folder', () => {
  function freshState() {
    (global as any).state = {
      structureTree: makeTree(),
      expandedFolders: new Set<string>(),
      parsedFolders: new Set<string>(),
      parsingFolders: new Set<string>(),
    };
  }

  test('elapseFolder expands the folder, its subfolders, and all its files', () => {
    freshState();
    fc.elapseFolder('/p/a');
    const exp = (global as any).state.expandedFolders as Set<string>;
    assert.ok(exp.has('/p/a') && exp.has('/p/a/b'), 'subtree folders expanded');
    assert.ok(exp.has('/p/a/y.ts') && exp.has('/p/a/b/z.ts'), 'descendant files expanded → functions');
    assert.ok(!exp.has('/p/c') && !exp.has('/p/x.ts'), 'nothing outside the folder is touched');
  });

  test('collapseFolder removes the folder and its whole subtree', () => {
    freshState();
    (global as any).state.expandedFolders = new Set(['/p', '/p/a', '/p/a/b', '/p/a/y.ts']);
    fc.collapseFolder('/p/a');
    const exp = (global as any).state.expandedFolders as Set<string>;
    assert.deepStrictEqual([...exp], ['/p'], 'only the /p/a subtree is collapsed');
  });
});

suite('createDrilldownSeparationForce', () => {
  test('pushes sibling folders apart along their centroid axis', () => {
    (global as any).settings = { folderRepelForce: 0.25 };
    const a = { id: 'a', file: '/p/a/y.ts',  x: 0, y: 0, vx: 0, vy: 0 };
    const b = { id: 'b', file: '/p/c/w.ts',  x: 1, y: 0, vx: 0, vy: 0 };
    (global as any).state = { structureTree: makeTree(), currentNodes: [a, b] };

    const force = folder.createDrilldownSeparationForce();
    force(1);

    // /p/a (left) is pushed -x, /p/c (right) is pushed +x → they separate.
    assert.ok(a.vx < 0, 'left sibling pushed left');
    assert.ok(b.vx > 0, 'right sibling pushed right');
  });

  test('a pinned node (fx set) is not moved', () => {
    (global as any).settings = { folderRepelForce: 0.25 };
    const a = { id: 'a', file: '/p/a/y.ts', x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: 0 };
    const b = { id: 'b', file: '/p/c/w.ts', x: 1, y: 0, vx: 0, vy: 0 };
    (global as any).state = { structureTree: makeTree(), currentNodes: [a, b] };
    folder.createDrilldownSeparationForce()(1);
    assert.strictEqual(a.vx, 0, 'pinned node velocity unchanged');
  });
});

suite('isDrilldown()', () => {
  test('true with file lens + cluster view + structure tree', () => {
    (global as any).state = { clusterGroupBy: 'file', viewMode: 'cluster', structureTree: makeTree() };
    assert.strictEqual(fc.isDrilldown(), true);
  });

  test('false when the lens is not file', () => {
    (global as any).state = { clusterGroupBy: 'connect', viewMode: 'cluster', structureTree: makeTree() };
    assert.strictEqual(fc.isDrilldown(), false);
    (global as any).state.clusterGroupBy = 'class';
    assert.strictEqual(fc.isDrilldown(), false);
  });

  test('false while the workflow view is active', () => {
    (global as any).state = { clusterGroupBy: 'file', viewMode: 'workflow', structureTree: makeTree() };
    assert.strictEqual(fc.isDrilldown(), false);
  });

  test('false without a structure tree (fallback to plain clustering)', () => {
    (global as any).state = { clusterGroupBy: 'file', viewMode: 'cluster', structureTree: null };
    assert.strictEqual(fc.isDrilldown(), false);
    (global as any).state.structureTree = {}; // tree without folders
    assert.strictEqual(fc.isDrilldown(), false);
  });
});

suite('graph message routing (classifyGraphMessage)', () => {
  const drilldownState = () => ({ clusterGroupBy: 'file', viewMode: 'cluster', structureTree: makeTree() });

  test('workflow payload → render even while drill-down is active', () => {
    (global as any).state = drilldownState();
    const data = { nodes: [], edges: [], workflow: { clusters: [], stageCount: 1 } };
    assert.strictEqual(fc.isWorkflowPayload(data), true);
    assert.strictEqual(fc.classifyGraphMessage(data), 'render');
  });

  test('non-workflow payload while drill-down is active → ingest', () => {
    (global as any).state = drilldownState();
    assert.strictEqual(fc.classifyGraphMessage({ nodes: [], edges: [] }), 'ingest');
  });

  test('non-workflow payload outside drill-down → render', () => {
    (global as any).state = { clusterGroupBy: 'connect', viewMode: 'cluster', structureTree: makeTree() };
    assert.strictEqual(fc.classifyGraphMessage({ nodes: [], edges: [] }), 'render');
  });

  test('a workflow marker without a clusters array is not a workflow payload', () => {
    (global as any).state = drilldownState();
    const data = { nodes: [], edges: [], workflow: {} };
    assert.strictEqual(fc.isWorkflowPayload(data), false);
    assert.strictEqual(fc.classifyGraphMessage(data), 'ingest');
  });

  test('null/missing data → render, no throw', () => {
    (global as any).state = drilldownState();
    assert.strictEqual(fc.isWorkflowPayload(null), false);
    assert.strictEqual(fc.classifyGraphMessage(null), 'ingest');
    // Outside drill-down, null data still routes to render without throwing.
    (global as any).state = { clusterGroupBy: 'connect', viewMode: 'cluster', structureTree: null };
    assert.strictEqual(fc.classifyGraphMessage(null), 'render');
  });
});

suite('detail depth (setInitialDetailDepth / applyDetailDepth)', () => {
  let savedWindow: any;
  setup(() => { savedWindow = (global as any).window; });
  teardown(() => { (global as any).window = savedWindow; });

  test('setInitialDetailDepth: under 200 files → full detail (1), all folders expanded', () => {
    (global as any).state = { structureTree: makeTree(4), expandedFolders: new Set(), detailDepth: -1 };
    fc.setInitialDetailDepth();
    const st = (global as any).state;
    assert.strictEqual(st.detailDepth, 1);
    for (const fp of Object.keys(st.structureTree.folders)) {
      assert.ok(st.expandedFolders.has(fp), `folder ${fp} expanded`);
    }
  });

  test('setInitialDetailDepth: 200-file boundary → collapsed at root (0)', () => {
    (global as any).state = { structureTree: makeTree(200), expandedFolders: new Set(), detailDepth: -1 };
    fc.setInitialDetailDepth();
    const st = (global as any).state;
    assert.strictEqual(st.detailDepth, 0, 'exactly 200 files is no longer "small"');
    assert.strictEqual(st.expandedFolders.size, 0, 'nothing expanded');
  });

  test('applyDetailDepth wires expandToDetail onto state and records detailDepth', () => {
    (global as any).window = undefined; // no parse channel needed here
    (global as any).state = {
      structureTree: makeTree(),
      expandedFolders: new Set(['/p/a/b']), // manually-toggled state is replaced wholesale
      parsedFolders: new Set(), parsingFolders: new Set(),
      detailDepth: 0,
    };
    fc.applyDetailDepth(0.5);
    const st = (global as any).state;
    assert.strictEqual(st.detailDepth, 0.5);
    assert.deepStrictEqual(
      [...st.expandedFolders].sort(),
      [...fc.expandToDetail(st.structureTree, 0.5)].sort(),
      'expandedFolders regenerated uniformly from the raw value',
    );
  });

  test('applyDetailDepth requests a parse for each expanded-but-unparsed folder', () => {
    const requested: string[] = [];
    (global as any).window = { requestFolderParse: (fp: string) => requested.push(fp) };
    (global as any).state = {
      structureTree: makeTree(),
      expandedFolders: new Set(),
      parsedFolders: new Set(), parsingFolders: new Set(),
      detailDepth: 0,
    };
    fc.applyDetailDepth(0.5); // opens /p, /p/a, /p/c
    assert.deepStrictEqual(requested.sort(), ['/p', '/p/a', '/p/c']);
  });

  test('applyDetailDepth requests nothing when every expanded folder is parsed or in flight', () => {
    const requested: string[] = [];
    (global as any).window = { requestFolderParse: (fp: string) => requested.push(fp) };
    (global as any).state = {
      structureTree: makeTree(),
      expandedFolders: new Set(),
      parsedFolders: new Set(['/p', '/p/a']), parsingFolders: new Set(['/p/c']),
      detailDepth: 0,
    };
    fc.applyDetailDepth(0.5);
    assert.deepStrictEqual(requested, [], 'no redundant parse requests');
  });
});

suite('nudgeDetailSlider()', () => {
  let savedDocument: any;

  setup(() => {
    savedDocument = (global as any).document;
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
      <input id="slider-complexity" type="range" min="0" max="1" step="0.01" value="0.2" />
      <span id="val-complexity">0.20</span>
    </body></html>`);
    (global as any).document = dom.window.document;
    (global as any).state = { detailDepth: 0.2 };
  });

  teardown(() => { (global as any).document = savedDocument; });

  test('keeps state.detailDepth in sync with the slider', () => {
    fc.nudgeDetailSlider(+1);
    const slider = (global as any).document.getElementById('slider-complexity');
    assert.strictEqual(slider.value, '0.25');
    assert.strictEqual((global as any).state.detailDepth, 0.25, 'state mirrors the nudged slider');
    assert.strictEqual((global as any).document.getElementById('val-complexity').textContent, '0.25');
  });

  test('clamped nudges are mirrored too', () => {
    const slider = (global as any).document.getElementById('slider-complexity');
    slider.value = '0.02';
    fc.nudgeDetailSlider(-1); // 0.02 - 0.05 → clamped to 0
    assert.strictEqual(slider.value, '0');
    assert.strictEqual((global as any).state.detailDepth, 0);
  });
});

suite('enterFileClusterMode()', () => {
  let savedApplyComplexity: any;
  let applyComplexityCalls: number;
  setup(() => {
    savedApplyComplexity = (global as any).applyComplexity;
    applyComplexityCalls = 0;
    (global as any).applyComplexity = () => { applyComplexityCalls++; };
  });
  teardown(() => { (global as any).applyComplexity = savedApplyComplexity; });

  test('seeds parsedFolders from the tree when a full graph is already loaded', () => {
    (global as any).state = {
      structureTree: makeTree(),
      graphData: { nodes: [{ id: 'fnY', file: '/p/a/y.ts' }], edges: [] },
      expandedFolders: new Set(), parsedFolders: new Set(), parsingFolders: new Set(),
    };
    fc.enterFileClusterMode();
    const st = (global as any).state;
    assert.deepStrictEqual(
      [...st.parsedFolders].sort(),
      Object.keys(st.structureTree.folders).sort(),
      'every folder marked parsed — functions expand without a re-parse',
    );
  });

  test('does not fabricate parsedFolders when no graph data is loaded', () => {
    (global as any).state = {
      structureTree: makeTree(),
      graphData: null,
      expandedFolders: new Set(), parsedFolders: new Set(), parsingFolders: new Set(),
    };
    fc.enterFileClusterMode();
    assert.strictEqual((global as any).state.parsedFolders.size, 0);
  });

  test('sets viewMode=cluster, clusterGroupBy=file, classMode=false and dispatches applyComplexity', () => {
    (global as any).state = {
      structureTree: makeTree(),
      graphData: null, viewMode: 'workflow', clusterGroupBy: 'connect', classMode: true,
      expandedFolders: new Set(), parsedFolders: new Set(), parsingFolders: new Set(),
    };
    fc.enterFileClusterMode();
    const st = (global as any).state;
    assert.strictEqual(st.viewMode, 'cluster');
    assert.strictEqual(st.clusterGroupBy, 'file');
    assert.strictEqual(st.classMode, false);
    assert.strictEqual(applyComplexityCalls, 1, 'render dispatched through applyComplexity');
  });

  test('initial detail depth follows repo size on entry (large repo starts collapsed)', () => {
    (global as any).state = {
      structureTree: makeTree(500),
      graphData: null,
      expandedFolders: new Set(), parsedFolders: new Set(), parsingFolders: new Set(),
    };
    fc.enterFileClusterMode();
    assert.strictEqual((global as any).state.detailDepth, 0);
    assert.strictEqual((global as any).state.expandedFolders.size, 0);
  });
});

suite('createFileSeparationForce', () => {
  test('pushes overlapping sibling files apart', () => {
    (global as any).settings = { fileRepelForce: 0.25 };
    const a = { id: 'a', x: 0, y: 0, vx: 0, vy: 0 };
    const b = { id: 'b', x: 1, y: 0, vx: 0, vy: 0 };
    const nodesByFile = new Map([['/p/a/x.ts', [a]], ['/p/a/y.ts', [b]]]);
    folder.createFileSeparationForce(nodesByFile)(1);
    assert.ok(a.vx < 0 && b.vx > 0, 'sibling file groups separate');
  });

  test('files in different folders are not paired (folder repel handles those)', () => {
    (global as any).settings = { fileRepelForce: 0.25 };
    const a = { id: 'a', x: 0, y: 0, vx: 0, vy: 0 };
    const b = { id: 'b', x: 1, y: 0, vx: 0, vy: 0 };
    const nodesByFile = new Map([['/p/a/x.ts', [a]], ['/p/b/y.ts', [b]]]);
    folder.createFileSeparationForce(nodesByFile)(1);
    assert.strictEqual(a.vx, 0, 'no cross-folder file separation');
  });
});
