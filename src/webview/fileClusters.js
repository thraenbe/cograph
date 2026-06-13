// fileClusters.js — progressive folder drill-down for very large repos.
//
// Renders the cheap folder skeleton (from the `structure` message) as collapsed
// cloud nodes. Detail level 0 = a single root node; clicking a folder expands it
// one level (child folders + direct files); clicking a parsed file expands it to
// its function nodes. Reuses the same `renderElements` path as the normal graph,
// so node popups / navigation / colouring work unchanged.
//
// All functions are globals (loaded after folder.js, before main.js).

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

function fcClusterSize(count) {
  return 36 * Math.max(1, Math.log2((count || 0) + 1));
}

// ── Element builders ──────────────────────────────────────────────────────────
function folderElement(folderPath, info, isRoot) {
  return {
    data: {
      id: 'folder::' + folderPath,
      label: (isRoot ? (fcBasename(folderPath) || 'Project') : fcBasename(folderPath)),
      _size: fcClusterSize(info.fileCount),
      isFolderCluster: true,
      isCluster: true,        // → cloud render + click handler
      isSynthetic: false,     // must be false so the cloud click fires
      memberCount: info.fileCount,
      childCount: info.childFolders.length + info.files.length,
      file: null,
      line: 0,
      _folderPath: folderPath,
    },
  };
}

function fileElement(filePath, fnCount, parsed, parsing) {
  return {
    data: {
      id: 'file::' + filePath,
      label: fcBasename(filePath) + (parsing ? ' ⏳' : ''),
      _size: parsed && fnCount ? fcClusterSize(fnCount) : 12,
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

  function visitFolder(folderPath) {
    const info = tree.folders[folderPath];
    if (!info) { return; }
    if (!expandedFolders.has(folderPath)) {
      elements.push(folderElement(folderPath, info, folderPath === tree.root));
      return;
    }
    for (const child of info.childFolders) { visitFolder(child); }
    for (const file of info.files) { visitFile(file); }
  }

  function visitFile(filePath) {
    const fns = nodesByFile.get(filePath) || [];
    const folderParsed = parsedFolders.has(fcDirname(filePath));
    if (expandedFolders.has(filePath) && folderParsed && fns.length) {
      for (const n of fns) { elements.push(functionElement(n)); }
    } else {
      elements.push(fileElement(filePath, fns.length, folderParsed, parsingFolders.has(fcDirname(filePath))));
    }
  }

  visitFolder(tree.root);
  return elements;
}

// ── Render + interaction (browser-only; needs renderElements/state/D3) ────────
function applyFileClusters() {
  if (typeof renderElements !== 'function') { return; }
  if (!state.structureTree) { return; }
  const elements = buildSkeletonElements(
    state.structureTree, state.expandedFolders, state.parsedFolders, state.graphData, state.parsingFolders,
  );
  // TODO(B-P4): aggregated folder→folder edges with call-count weights.
  renderElements(elements, new Map());
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
    } else {
      state.expandedFolders.add(fp);
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

function enterFileClusterMode() {
  state.fileClusterMode = true;
  state.folderMode = false;
  state.classMode = false;
  if (typeof document !== 'undefined') {
    document.getElementById('btn-file-cluster-mode')?.classList.add('active');
    document.getElementById('btn-folder-mode')?.classList.remove('active');
    document.getElementById('btn-class-mode')?.classList.remove('active');
  }
  applyFileClusters();
}

function exitFileClusterMode() {
  state.fileClusterMode = false;
  if (typeof document !== 'undefined') {
    document.getElementById('btn-file-cluster-mode')?.classList.remove('active');
  }
  if (state.graphData && typeof applyComplexity === 'function') { applyComplexity(); }
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
    applyFileClusters,
    ingestGraphData,
    mergeGraphDataPatch,
    toggleFileClusterExpand,
    enterFileClusterMode,
    exitFileClusterMode,
    renderStructureSkeleton,
    fcDirname,
    fcBasename,
  };
}
