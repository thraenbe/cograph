// fileClusters.js — progressive folder drill-down for very large repos.
//
// Renders the cheap folder skeleton (from the `structure` message) as collapsed
// cloud nodes. Detail level 0 = a single root node; clicking a folder expands it
// one level (child folders + direct files); clicking a parsed file expands it to
// its function nodes. Reuses the same `renderElements` path as the normal graph,
// so node popups / navigation / colouring work unchanged.
//
// All functions are globals (loaded after folder.js, before main.js).

// Shared edge-aggregation core (`aggregateEdges`) is a webview global from
// aggregate.js; in Node unit tests pull it onto `global` once. A top-level
// `const` would redeclare across the webview's shared script scope.
if (typeof aggregateEdges === 'undefined' && typeof require !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  global.aggregateEdges = require('./aggregate.js').aggregateEdges;
}

// ── Path helpers (self-contained so the module is unit-testable) ──────────────
function fcDirname(fp) {
  const idx = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'));
  return idx >= 0 ? fp.substring(0, idx) : '';
}
function fcBasename(fp) {
  const idx = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'));
  return idx >= 0 ? fp.substring(idx + 1) : fp;
}

const FC_EXT_LANG = {
  '.py': 'python',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.java': 'java',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c++': 'cpp',
  '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.h++': 'cpp', '.h': 'cpp',
};
function fcLangFromPath(fp) {
  const dot = fp.lastIndexOf('.');
  return dot >= 0 ? (FC_EXT_LANG[fp.slice(dot)] ?? null) : null;
}

// Size hierarchy: folders > files > functions, so the drill-down reads at a glance.
function folderSize(count) { return Math.min(92, 30 + 11 * Math.log2((count || 0) + 1)); }
function fileSize(fnCount, parsed) { return parsed && fnCount ? Math.min(54, 16 + 7 * Math.log2(fnCount + 1)) : 16; }

// ── Detail (0..1) ⇄ folder expansion ──────────────────────────────────────────
// The Detail slider in file mode is a 0..1 value: 0 = only the root folder shows;
// 1 = the entire graph (every folder + file expanded to functions); in between it
// opens the tree progressively deeper.

function maxFolderDepth(tree) {
  if (!tree || !tree.folders) { return 0; }
  let m = 0;
  for (const k in tree.folders) { const d = tree.folders[k].depth || 0; if (d > m) { m = d; } }
  return m;
}

/** Folders to mark expanded so the tree is uniformly open to `depth` (folders only). */
function expandToDepth(tree, depth) {
  const set = new Set();
  if (!tree || !tree.folders) { return set; }
  for (const k in tree.folders) {
    if ((tree.folders[k].depth || 0) < depth) { set.add(k); }
  }
  return set;
}

/** Expanded set for a 0..1 detail value. The level scale is folders-only:
 *  0 = root collapsed … maxFolderDepth+1 = every folder open. Files need no
 *  per-file tier — a file's functions show as soon as its open folder is parsed. */
function expandToDetail(tree, raw) {
  if (!tree || !tree.folders) { return new Set(); }
  // 0 = root only … (maxDepth+1) = every folder open. A file's functions show as
  // soon as its (open) folder is parsed, so no per-file expansion is needed.
  const levels = maxFolderDepth(tree) + 1;
  const target = Math.round(Math.max(0, Math.min(1, raw)) * levels);
  return expandToDepth(tree, target);
}

/** Ask the host to parse any expanded-but-unparsed folder so its functions appear. */
function requestParseForExpanded() {
  if (typeof window === 'undefined' || !window.requestFolderParse) { return; }
  const folders = state.structureTree && state.structureTree.folders;
  if (!folders) { return; }
  for (const fp of state.expandedFolders) {
    if (folders[fp] && !state.parsedFolders.has(fp) && !state.parsingFolders.has(fp)) {
      window.requestFolderParse(fp);
    }
  }
}

function setDetailSlider(raw) {
  if (typeof document === 'undefined') { return; }
  const slider = document.getElementById('slider-complexity');
  const valEl = document.getElementById('val-complexity');
  if (slider) { slider.value = String(raw); }
  if (valEl) { valEl.textContent = raw.toFixed(2); }
}

/** Initial detail: < 200 files → full graph (1); otherwise collapsed at root (0).
 *  No explicit parse request here — the background full pass parses the whole repo
 *  and marks every folder parsed, so functions fill in as it completes. */
function setInitialDetailDepth() {
  const tree = state.structureTree;
  if (!tree) { return; }
  const raw = (tree.totalFiles || 0) < 200 ? 1 : 0;
  state.detailDepth = raw;
  state.expandedFolders = expandToDetail(tree, raw);
  setDetailSlider(raw);
}

/** Apply a 0..1 detail value from the slider (file mode only). */
function applyDetailDepth(raw) {
  const tree = state.structureTree;
  if (!tree) { return; }
  state.detailDepth = raw;
  state.expandedFolders = expandToDetail(tree, raw);
  if (typeof document !== 'undefined') {
    const valEl = document.getElementById('val-complexity');
    if (valEl) { valEl.textContent = raw.toFixed(2); }
  }
  requestParseForExpanded();
  applyFileClusters();
}

/** Nudge the slider a little on a click-dive (continuous 0..1). */
function nudgeDetailSlider(dir) {
  if (typeof document === 'undefined') { return; }
  const slider = document.getElementById('slider-complexity');
  if (!slider) { return; }
  const raw = Math.max(0, Math.min(1, parseFloat(slider.value) + dir * 0.05));
  slider.value = String(raw);
  const valEl = document.getElementById('val-complexity');
  if (valEl) { valEl.textContent = raw.toFixed(2); }
}

/** Right-click "Elapse folder": expand a folder and its whole subtree (folders +
 *  files) so every function inside it is shown directly. Parses on demand. */
function elapseFolder(folderPath) {
  const tree = state.structureTree;
  if (!tree || !tree.folders) { return; }
  const under = (p) => p === folderPath || p.startsWith(folderPath + '/') || p.startsWith(folderPath + '\\');
  for (const fp in tree.folders) { if (under(fp)) { state.expandedFolders.add(fp); } }
  for (const f of (tree.files || [])) { if (under(f.path)) { state.expandedFolders.add(f.path); } }
  requestParseForExpanded();
  applyFileClusters();
  if (typeof window !== 'undefined') { window.markDirty?.(); }
}

/** Right-click "Collapse folder": collapse a folder (and its subtree) back to a
 *  single folder node. */
function collapseFolder(folderPath) {
  const under = (p) => p === folderPath || p.startsWith(folderPath + '/') || p.startsWith(folderPath + '\\');
  for (const p of [...state.expandedFolders]) { if (under(p)) { state.expandedFolders.delete(p); } }
  applyFileClusters();
  if (typeof window !== 'undefined') { window.markDirty?.(); }
}

// Recursive language breakdown per folder, so a folder is coloured by the mix of
// code it contains (like the old project/cluster node). Memoised on the tree.
function folderLanguages(tree) {
  if (tree._folderLang) { return tree._folderLang; }
  const counts = new Map(); // folderPath -> { lang: count }
  for (const f of (tree.files || [])) {
    if (!f.language) { continue; }
    let dir = fcDirname(f.path);
    while (dir) {
      if (tree.folders[dir]) {
        let c = counts.get(dir);
        if (!c) { c = {}; counts.set(dir, c); }
        c[f.language] = (c[f.language] || 0) + 1;
      }
      if (dir === tree.root) { break; }
      const parent = fcDirname(dir);
      if (!parent || parent === dir) { break; }
      dir = parent;
    }
  }
  const out = new Map();
  for (const [folder, c] of counts) {
    const total = Object.values(c).reduce((a, b) => a + b, 0) || 1;
    out.set(folder, Object.entries(c)
      .map(([lang, n]) => ({ lang, fraction: n / total }))
      .sort((a, b) => b.fraction - a.fraction));
  }
  tree._folderLang = out;
  return out;
}

// ── Element builders ──────────────────────────────────────────────────────────
function folderElement(folderPath, info, isRoot, languageBreakdown) {
  const count = info.fileCount;
  return {
    data: {
      id: 'folder::' + folderPath,
      label: (isRoot ? (fcBasename(folderPath) || 'Project') : fcBasename(folderPath)),
      _sub: `${count} ${count === 1 ? 'file' : 'files'}`,
      _size: folderSize(count),
      isFolderCluster: true,
      isCluster: true,        // → cloud render path + click handler
      isSynthetic: false,     // must be false so the cloud click fires
      memberCount: count,
      childCount: info.childFolders.length + info.files.length,
      languageBreakdown: (languageBreakdown && languageBreakdown.length) ? languageBreakdown : null,
      file: null,
      line: 0,
      _folderPath: folderPath,
    },
  };
}

function fileElement(filePath, fnCount, parsed, parsing) {
  const sub = parsing ? 'parsing…'
    : (parsed && fnCount ? `${fnCount} ${fnCount === 1 ? 'fn' : 'fns'}` : '');
  return {
    data: {
      id: 'file::' + filePath,
      label: fcBasename(filePath),
      _sub: sub,
      _size: fileSize(fnCount, parsed),
      isFileCluster: true,
      isCluster: true,
      isSynthetic: false,
      memberCount: fnCount,
      parsed: !!parsed,
      parsing: !!parsing,
      language: fcLangFromPath(filePath),
      file: filePath,
      line: 1,
      _filePath: filePath,
    },
  };
}

function functionElement(n) {
  return {
    data: {
      id: n.id,
      label: n.name,
      _size: 8,
      file: n.file,
      line: n.line,
      isCluster: false,
      isSynthetic: false,
      memberCount: 1,
      language: n.language,
      className: n.className,
      classExtends: n.classExtends,
      classImplements: n.classImplements,
      gitStatus: n.gitStatus,
    },
  };
}

// An invisible layout anchor for a function-less file, so the file-circle overlay
// can draw an (empty) circle that's positioned inside the folder instead of
// floating. Excluded from the node/label render passes (isFileAnchor).
function fileAnchorElement(filePath) {
  return {
    data: {
      id: 'fileanchor::' + filePath,
      label: fcBasename(filePath),
      _size: 2,
      file: filePath,
      line: 0,
      isCluster: false,
      isSynthetic: false,
      isFileAnchor: true,
      language: fcLangFromPath(filePath),
    },
  };
}

/**
 * Build the visible element set for the current drill-down state. Pure function
 * of (tree, expandedFolders, parsedFolders, graphData, parsingFolders).
 */
function buildSkeletonElements(tree, expandedFolders, parsedFolders, graphData, parsingFolders) {
  const elements = [];
  if (!tree || !tree.folders || !tree.root) { return elements; }
  parsingFolders = parsingFolders || new Set();

  const nodesByFile = new Map();
  if (graphData && graphData.nodes) {
    for (const n of graphData.nodes) {
      if (n.isLibrary || !n.file) { continue; }
      if (!nodesByFile.has(n.file)) { nodesByFile.set(n.file, []); }
      nodesByFile.get(n.file).push(n);
    }
  }
  const langByFolder = folderLanguages(tree);

  function visitFolder(folderPath) {
    const info = tree.folders[folderPath];
    if (!info) { return; }
    if (!expandedFolders.has(folderPath)) {
      elements.push(folderElement(folderPath, info, folderPath === tree.root, langByFolder.get(folderPath)));
      return;
    }
    for (const child of info.childFolders) { visitFolder(child); }
    for (const file of info.files) { visitFile(file); }
  }

  function visitFile(filePath) {
    const fns = nodesByFile.get(filePath) || [];
    const folderParsed = parsedFolders.has(fcDirname(filePath));
    if (folderParsed) {
      // Parsed folder → the file is a file circle: its functions, or an invisible
      // anchor so a function-less file still gets a (positioned) empty circle.
      if (fns.length) { for (const n of fns) { elements.push(functionElement(n)); } }
      else { elements.push(fileAnchorElement(filePath)); }
    } else {
      // Folder not parsed yet → a collapsed file node (with a spinner while parsing).
      elements.push(fileElement(filePath, fns.length, false, parsingFolders.has(fcDirname(filePath))));
    }
  }

  visitFolder(tree.root);
  return elements;
}

/**
 * Map a function node to the id of whichever skeleton/function node currently
 * represents it (its file's expanded function, the collapsed file, or the nearest
 * collapsed ancestor folder on the visible frontier).
 */
function visibleNodeIdOf(node, expandedFolders, parsedFolders, tree) {
  const fp = node.file;
  if (!fp) { return null; }
  const fileFolder = fcDirname(fp);

  if (expandedFolders.has(fileFolder)) {
    // Folder open + parsed → its functions are shown directly; open but unparsed →
    // the collapsed file node is what's visible.
    if (parsedFolders.has(fileFolder)) { return node.id; }
    return 'file::' + fp;
  }
  // Folder closed → walk up to the deepest open ancestor; the collapsed folder
  // just below it is what's visible.
  let current = fileFolder;
  let child = null;
  while (current) {
    if (expandedFolders.has(current)) { return 'folder::' + (child || current); }
    const info = tree.folders ? tree.folders[current] : null;
    const parent = info ? info.parent : null;
    if (!parent) { return 'folder::' + current; } // reached root, still collapsed
    child = current;
    current = parent;
  }
  return 'folder::' + fileFolder;
}

/**
 * Aggregate real call edges into weighted edges between the currently-visible
 * skeleton nodes. weight = number of underlying calls; `pending` marks edges that
 * touch an un-parsed subtree (so the count is provisional).
 */
function buildWeightedEdges(graphData, expandedFolders, parsedFolders, tree) {
  if (!graphData || !graphData.edges) { return []; }
  const nodeById = new Map(graphData.nodes.map(n => [n.id, n]));
  const mapId = (id) => {
    const n = nodeById.get(id);
    return n ? visibleNodeIdOf(n, expandedFolders, parsedFolders, tree) : null;
  };
  const pendingFor = (sId, tId) => {
    const sn = nodeById.get(sId);
    const tn = nodeById.get(tId);
    return !parsedFolders.has(fcDirname(sn.file)) || !parsedFolders.has(fcDirname(tn.file));
  };
  return aggregateEdges(graphData.edges, mapId, { weighted: true, pendingFor });
}

// ── Render + interaction (browser-only; needs renderElements/state/D3) ────────
function applyFileClusters() {
  if (typeof renderElements !== 'function') { return; }
  if (!state.structureTree) { return; }
  const nodeEls = buildSkeletonElements(
    state.structureTree, state.expandedFolders, state.parsedFolders, state.graphData, state.parsingFolders,
  );
  const edgeEls = buildWeightedEdges(
    state.graphData, state.expandedFolders, state.parsedFolders, state.structureTree,
  );
  renderElements([...nodeEls, ...edgeEls], new Map());
}

/**
 * Fold an analysis result into the skeleton. A full result (no `parsedFolder`)
 * covers the whole tree, so every folder becomes parsed; a subset result marks
 * just that folder. Nodes are merged by id so drill-down state and prior data
 * survive. Re-renders the current view.
 */
/** Merge a patch into state.graphData by id (deduped edges, unioned files) and
 *  recompute importance scores. No re-render. */
function mergeGraphDataPatch(data) {
  if (!data) { return; }
  if (!state.graphData) {
    state.graphData = { nodes: [], edges: [], files: [] };
  }
  const byId = new Map(state.graphData.nodes.map(n => [n.id, n]));
  for (const n of (data.nodes || [])) { byId.set(n.id, n); }
  const edgeKeys = new Set(state.graphData.edges.map(e => `${e.source}|${e.target}|${e.isLibraryEdge ? 1 : 0}`));
  const edges = state.graphData.edges.slice();
  for (const e of (data.edges || [])) {
    const k = `${e.source}|${e.target}|${e.isLibraryEdge ? 1 : 0}`;
    if (!edgeKeys.has(k)) { edgeKeys.add(k); edges.push(e); }
  }
  const files = [...new Set([...(state.graphData.files || []), ...(data.files || [])])];
  state.graphData = { nodes: [...byId.values()], edges, files };

  if (typeof computeImportanceScores === 'function') {
    state.importanceScores = computeImportanceScores({
      nodes: state.graphData.nodes.filter(n => !n.isLibrary),
      edges: state.graphData.edges.filter(e => !e.isLibraryEdge),
    });
  }
}

function ingestGraphData(data, parsedFolder) {
  mergeGraphDataPatch(data);
  if (parsedFolder) {
    state.parsedFolders.add(parsedFolder);
  } else if (state.structureTree && state.structureTree.folders) {
    // Full analysis covers the whole tree.
    state.parsedFolders = new Set(Object.keys(state.structureTree.folders));
  }
  applyFileClusters();
}

/** Toggle expansion of a folder/file skeleton node (called from the cloud click handler). */
function toggleFileClusterExpand(d) {
  if (d.isFolderCluster) {
    const fp = d._folderPath;
    if (state.expandedFolders.has(fp)) {
      state.expandedFolders.delete(fp);
      nudgeDetailSlider(-1);
    } else {
      state.expandedFolders.add(fp);
      nudgeDetailSlider(+1); // diving deeper bumps the detail slider a bit
      // Lazily parse this folder's direct files on first expand.
      if (!state.parsedFolders.has(fp) && typeof window !== 'undefined') {
        window.requestFolderParse?.(fp);
      }
    }
    applyFileClusters();
    if (typeof window !== 'undefined') { window.markDirty?.(); }
    return;
  }
  if (d.isFileCluster) {
    const fp = d._filePath;
    const folder = fcDirname(fp);
    if (state.parsedFolders.has(folder)) {
      if (state.expandedFolders.has(fp)) { state.expandedFolders.delete(fp); }
      else { state.expandedFolders.add(fp); }
      applyFileClusters();
      if (typeof window !== 'undefined') { window.markDirty?.(); }
    } else if (typeof window !== 'undefined') {
      // Not parsed yet: pre-expand the file so it reveals its functions as soon
      // as its folder finishes parsing, and kick off the lazy parse.
      state.expandedFolders.add(fp);
      window.requestFolderParse?.(folder);
    }
  }
}

// Drill-down (folder navigation) is the 'file' cluster lens, outside workflow mode.
// Requires a structure tree; without one (e.g. autoEngage disabled) 'file' mode
// falls back to plain file-structural clustering instead of a blank view.
function isDrilldown() {
  return state.clusterGroupBy === 'file'
    && state.viewMode !== 'workflow'
    && !!(state.structureTree && state.structureTree.folders);
}

/** True when `data` is an AI Workflow Graph payload (marked by graph.workflow). */
function isWorkflowPayload(data) {
  return !!(data && data.workflow && Array.isArray(data.workflow.clusters));
}

/** Route an incoming full-graph message: workflow payloads always take the full
 *  renderGraph path (drill-down cannot show the staged layout); everything else
 *  folds into the skeleton while drill-down is active. Returns 'render' | 'ingest'. */
function classifyGraphMessage(data) {
  return (isWorkflowPayload(data) || !isDrilldown()) ? 'render' : 'ingest';
}

function enterFileClusterMode() {
  state.viewMode = 'cluster';
  state.clusterGroupBy = 'file'; // the 'file' lens IS the folder drill-down
  state.classMode = false;
  // If a full graph is already loaded (small repo / valid cache), every folder is
  // parsed — so files expand to functions immediately without a redundant re-parse.
  if (state.graphData && state.graphData.nodes && state.graphData.nodes.length
      && state.structureTree && state.structureTree.folders) {
    state.parsedFolders = new Set(Object.keys(state.structureTree.folders));
  }
  // Pick the initial drill-down depth from repo size (large repos start collapsed).
  setInitialDetailDepth();
  if (typeof document !== 'undefined') {
    document.getElementById('btn-class-mode')?.classList.remove('active');
    ['file', 'class', 'connect'].forEach(m =>
      document.getElementById(`btn-group-${m}`)?.classList.toggle('active', m === 'file'));
  }
  // Dispatch through applyComplexity: drill-down when a structure tree is present,
  // otherwise plain file-structural clustering (no blank view).
  if (typeof applyComplexity === 'function') { applyComplexity(); }
  else { applyFileClusters(); }
}

/** Handle a `structure` message: store the tree and (optionally) engage the mode. */
function renderStructureSkeleton(tree, autoEngage) {
  state.structureTree = tree;
  state.rootFolderPath = tree && tree.root ? tree.root : null;
  if (!state.expandedFolders) { state.expandedFolders = new Set(); }
  if (!state.parsedFolders) { state.parsedFolders = new Set(); }
  if (autoEngage) { enterFileClusterMode(); }
}

if (typeof window !== 'undefined') {
  window.renderStructureSkeleton = renderStructureSkeleton;
  window.toggleFileClusterExpand = toggleFileClusterExpand;
  window.ingestGraphData = ingestGraphData;
  window.mergeGraphDataPatch = mergeGraphDataPatch;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
if (typeof module !== 'undefined') {
  module.exports = {
    buildSkeletonElements,
    buildWeightedEdges,
    visibleNodeIdOf,
    applyFileClusters,
    ingestGraphData,
    mergeGraphDataPatch,
    toggleFileClusterExpand,
    enterFileClusterMode,
    renderStructureSkeleton,
    isDrilldown,
    isWorkflowPayload,
    classifyGraphMessage,
    applyDetailDepth,
    setInitialDetailDepth,
    nudgeDetailSlider,
    maxFolderDepth,
    expandToDepth,
    expandToDetail,
    elapseFolder,
    collapseFolder,
    fcDirname,
    fcBasename,
  };
}
