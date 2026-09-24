// scope.js — structural view scope (round 3, W1/W4).
//
// ONE pure predicate family decides which folders and files EXIST in the
// layout: Hide folder / Hide file and the Only-show state (view state, saved
// with the view) and the host's subgraph scope (host state, W4) all compose
// here. Frames, slots, Global drill-down boxes and file circles consult these
// predicates at build time, so hiding removes the thing entirely and the
// shelf re-packs — display:none on nodes (applyFilters) stays the cheap
// per-node pass on top.
//
// frames.js stays unit-pure: the render call sites build the scope object
// from state and pass closures in; nothing here reads globals.

/** true when `path` equals `prefix` or lies inside it (separator-aware). */
function pathUnder(path, prefix) {
  if (!path || !prefix) { return false; }
  return path === prefix
    || path.startsWith(prefix + '/')
    || path.startsWith(prefix + '\\');
}

/** Snapshot the structural filters from state-shaped input. `subgraph` is
 *  W4's {include:Set, exclude:Set} (absolute tree paths) or null. */
function buildScope(st) {
  const sg = st.scope;
  return {
    hiddenFolders: st.hiddenFolders || new Set(),
    onlyShowFolder: st.onlyShowFolder || null,
    hiddenFiles: st.hiddenFiles || new Set(),
    onlyShowFile: st.onlyShowFile || null,
    subgraph: (sg && sg.include && sg.include.size) ? sg : null,
  };
}

/** Fast path: nothing is structurally filtered. */
function scopeActive(sc) {
  return !!(sc && (sc.hiddenFolders.size || sc.onlyShowFolder
    || sc.hiddenFiles.size || sc.onlyShowFile || sc.subgraph));
}

/** FRAME rule: may folder `path` keep its frame (Shelf) / box (Global)?
 *  Hidden subtrees vanish. With an Only folder, its ANCESTORS stay — they
 *  are the containers the shown subtree lives in. A subgraph keeps a folder
 *  that intersects an include (inside it, or an ancestor of it) and is not
 *  carved out by an exclude. */
function frameFolderVisible(path, sc) {
  for (const h of sc.hiddenFolders) {
    if (pathUnder(path, h)) { return false; }
  }
  if (sc.onlyShowFolder
    && !pathUnder(path, sc.onlyShowFolder)
    && !pathUnder(sc.onlyShowFolder, path)) { return false; }
  if (sc.subgraph) {
    let touches = false;
    for (const inc of sc.subgraph.include) {
      if (pathUnder(path, inc) || pathUnder(inc, path)) { touches = true; break; }
    }
    if (!touches) { return false; }
    for (const ex of (sc.subgraph.exclude || [])) {
      if (pathUnder(path, ex)) { return false; }
    }
  }
  return true;
}

/** MEMBER rule: may a graph node keep a place in the layout (a slot, a
 *  collapsed glyph)? Folder-cluster glyphs follow the folder rules on their
 *  own subtree (no ancestor allowance — a collapsed ancestor of an Only
 *  folder shows nothing anyway) and are exempt from FILE filters (R2a).
 *  File-bearing nodes follow the folder rules on their file's path, then
 *  the file filters. Nodes without a path (synthetics) always stay. */
function memberInScope(d, sc) {
  if (d.isFolderCluster) {
    const p = d._folderPath;
    if (!p) { return true; }
    for (const h of sc.hiddenFolders) {
      if (pathUnder(p, h)) { return false; }
    }
    if (sc.onlyShowFolder
      && !pathUnder(p, sc.onlyShowFolder)
      && !pathUnder(sc.onlyShowFolder, p)) { return false; }
    if (sc.subgraph) {
      let touches = false;
      for (const inc of sc.subgraph.include) {
        if (pathUnder(p, inc) || pathUnder(inc, p)) { touches = true; break; }
      }
      if (!touches) { return false; }
      for (const ex of (sc.subgraph.exclude || [])) {
        if (pathUnder(p, ex)) { return false; }
      }
    }
    return true;
  }
  const file = d.file ?? d._filePath ?? null;
  if (!file) { return true; }
  for (const h of sc.hiddenFolders) {
    if (pathUnder(file, h)) { return false; }
  }
  if (sc.onlyShowFolder && !pathUnder(file, sc.onlyShowFolder)) { return false; }
  if (sc.subgraph) {
    let inside = false;
    for (const inc of sc.subgraph.include) {
      if (pathUnder(file, inc)) { inside = true; break; }
    }
    if (!inside) { return false; }
    for (const ex of (sc.subgraph.exclude || [])) {
      if (pathUnder(file, ex)) { return false; }
    }
  }
  if (sc.hiddenFiles.has(file)) { return false; }
  if (sc.onlyShowFile && file !== sc.onlyShowFile) { return false; }
  return true;
}

/** Map the host's `subgraph` message (workspace-relative POSIX include/
 *  exclude + native workspace root) to absolute tree paths. Returns null for
 *  the no-scope form (include []). Unknown keys (__seq etc.) are ignored. */
function mapSubgraphMessage(m) {
  if (!m || !Array.isArray(m.include) || !m.include.length) { return null; }
  const root = String(m.root || '').replace(/[\\/]+$/, '');
  const sep = root.includes('\\') ? '\\' : '/';
  const abs = (rel) => {
    const parts = String(rel).split('/').filter(x => x && x !== '.');
    return parts.length ? root + sep + parts.join(sep) : root;
  };
  return {
    name: m.name ?? null,
    root,
    include: new Set(m.include.map(abs)),
    exclude: new Set((m.exclude || []).map(abs)),
  };
}

/** A subgraph's MAXIMAL excluded subtrees, for the Filters panel: walk from
 *  the root, descend through containers (ancestors of an include) and
 *  included folders (to surface exclude carve-outs), and report the first
 *  out-of-scope folder on each branch. fileCount is the tree's recursive
 *  count. Deterministic (sorted). */
function excludedTopFolders(tree, sg) {
  if (!tree || !tree.folders || !sg) { return []; }
  const out = [];
  const kidsOf = (p) => {
    const info = tree.folders[p];
    if (info && Array.isArray(info.childFolders)) { return [...info.childFolders].sort(); }
    return Object.keys(tree.folders).filter(q => tree.folders[q].parent === p).sort();
  };
  const visit = (p) => {
    for (const c of kidsOf(p)) {
      let underEx = false;
      for (const ex of sg.exclude) { if (pathUnder(c, ex)) { underEx = true; break; } }
      let underInc = false, container = false;
      for (const inc of sg.include) {
        if (pathUnder(c, inc)) { underInc = true; break; }
        if (pathUnder(inc, c)) { container = true; }
      }
      if (underEx || (!underInc && !container)) {
        out.push({ path: c, fileCount: tree.folders[c] ? (tree.folders[c].fileCount ?? 0) : 0 });
        continue; // maximal subtree — never descend into it
      }
      visit(c);
    }
  };
  visit(tree.root);
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { pathUnder, buildScope, scopeActive, frameFolderVisible, memberInScope,
    mapSubgraphMessage, excludedTopFolders };
}
