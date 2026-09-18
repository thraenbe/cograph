// drilldown.js — the File-lens drill-down folder boxes and their forces,
// extracted verbatim from folder.js (tech-debt: file-size split). Loaded after
// folder.js, before fileClusters.js; all functions are shared globals in the
// webview. Local copies of the shared constants/path helpers keep the module
// require()-able on its own in Node unit tests.

const DD_FILE_PADDING = 28;    // == FILE_PADDING (folder.js)
const DD_FOLDER_PADDING = 40;  // == FOLDER_PADDING (folder.js)
const DD_TITLEBAR_HEIGHT = 30; // == FOLDER_TITLEBAR_HEIGHT (folder.js)

function ddDirname(fp) {
  const idx = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'));
  return idx >= 0 ? fp.substring(0, idx) : '(root)';
}
function ddBasename(fp) {
  const idx = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'));
  return idx >= 0 ? fp.substring(idx + 1) : fp;
}

// ── Drill-down folder boxes (file mode) ───────────────────────────────────────
// In file (drill-down) mode each EXPANDED folder gets a box wrapping exactly its
// visible descendants. Boxes are independent padded bounding rects, so a child
// box always nests inside its parent (child members ⊆ parent members); a per-folder
// clustering force keeps each folder's nodes together so foreign nodes stay out.

function ddHue(folderPath) {
  let h = 0;
  for (let i = 0; i < folderPath.length; i++) { h = (h * 31 + folderPath.charCodeAt(i)) >>> 0; }
  return h % 360;
}

function ddNodePath(n) {
  if (n.isFolderCluster) { return n._folderPath; }
  if (n.isFileCluster) { return n._filePath; }
  return n.file || null;
}

function pathUnder(p, folder) {
  return p === folder || p.startsWith(folder + '/') || p.startsWith(folder + '\\');
}

/** One box per expanded folder, carrying the member node objects under it. */
function buildDrilldownBoxData() {
  const tree = state.structureTree;
  if (!tree || !tree.folders) { return []; }
  const boxes = [];
  for (const folderPath of state.expandedFolders) {
    if (folderPath === tree.root) { continue; } // no box around the whole project root
    const info = tree.folders[folderPath];
    if (!info) { continue; } // an expanded file path, not a folder
    const members = state.currentNodes.filter(n => {
      const p = ddNodePath(n);
      return p && pathUnder(p, folderPath);
    });
    if (!members.length) { continue; }
    boxes.push({
      folderPath,
      shortName: ddBasename(folderPath) || folderPath,
      depth: info.depth || 0,
      hue: ddHue(folderPath),
      members,
    });
  }
  boxes.sort((a, b) => a.depth - b.depth); // shallow first → parents behind children
  return boxes;
}

function renderDrilldownBoxes(boxes) {
  const sel = folderG.selectAll('g.folder-bubble')
    .data(boxes, d => d.folderPath)
    .join(
      enter => {
        const grp = enter.append('g').attr('class', 'folder-bubble');
        grp.append('rect').attr('class', 'folder-bubble-shape');
        grp.append('rect').attr('class', 'folder-bubble-titlebar');
        grp.append('text').attr('class', 'folder-bubble-label');
        return grp;
      },
      update => update,
      exit => exit.remove()
    )
    .on('contextmenu', (event, d) => {
      event.preventDefault();
      event.stopPropagation();
      const items = [
        { label: `${d.shortName} (Folder)`, isHeader: true },
        { label: 'Elapse folder',         action: () => { if (typeof elapseFolder === 'function') { elapseFolder(d.folderPath); } } },
        { label: 'Collapse folder',       action: () => { if (typeof collapseFolder === 'function') { collapseFolder(d.folderPath); } } },
        { label: 'Only show this folder', action: () => { state.onlyShowFolder = d.folderPath; applyFilters(); ticked(); updateFolderPanel(); } },
        { label: 'Hide folder',           action: () => { state.hiddenFolders.add(d.folderPath); applyFilters(); ticked(); updateFolderPanel(); } },
        { label: 'Go to folder',          action: () => vscode.postMessage({ type: 'navigate', file: d.folderPath, line: 1 }) },
      ];
      if (state.hiddenFolders.size > 0 || state.onlyShowFolder) {
        items.push({ label: 'Show all', action: () => { state.hiddenFolders.clear(); state.onlyShowFolder = null; applyFilters(); ticked(); updateFolderPanel(); } });
      }
      showContextMenu(event, items);
    });
  sel.each(function(d) {
    d3.select(this).select('.folder-bubble-shape')
      .attr('rx', 8).attr('stroke-width', 1.5).attr('pointer-events', 'none');
    d3.select(this).select('.folder-bubble-titlebar')
      .attr('rx', 8).attr('pointer-events', 'all').attr('cursor', 'grab');
    d3.select(this).select('.folder-bubble-label')
      .attr('font-size', `${(12 + 6 / ((d.depth || 0) + 1)) * settings.textSize}px`)
      .attr('text-anchor', 'middle').attr('font-weight', '600')
      .attr('dominant-baseline', 'central')
      .attr('fill', isLightTheme() ? '#333333' : '#cccccc').attr('pointer-events', 'none');
  });
  // Drag the box by its titlebar → moves the whole folder's members.
  sel.select('.folder-bubble-titlebar').call(createDrilldownBoxDrag());
  return sel;
}

/** Drag a drill-down folder box by its header → translate all member nodes. */
function createDrilldownBoxDrag() {
  return d3.drag()
    .on('start', function (event, d) {
      d._dragStart = { x: event.x, y: event.y };
      d._nodeStarts = d.members.map(n => ({ n, x: n.x ?? 0, y: n.y ?? 0 }));
      reheatForDrag(event);
      d.members.forEach(n => { n.fx = n.x; n.fy = n.y; });
    })
    .on('drag', function (event, d) {
      const dx = event.x - d._dragStart.x, dy = event.y - d._dragStart.y;
      d._nodeStarts.forEach(({ n, x, y }) => {
        n.fx = x + dx; n.fy = y + dy;
        if (dragMovesDirectly()) { n.x = n.fx; n.y = n.fy; }
      });
      if (dragMovesDirectly()) { ticked(); }
    })
    .on('end', function (event, d) {
      delete d._dragStart; delete d._nodeStarts;
      if (coolAfterDrag(event)) {
        d.members.forEach(n => { n.fx = null; n.fy = null; });
      }
      if (typeof window !== 'undefined') { window.markDirty?.(); }
    });
}

/** Per-tick: size each box to the padded bounding rect of its visible members. */
function tickDrilldownBoxes() {
  if (!state.svgDrilldownBoxes) { return; }
  const visible = (typeof getVisibleNodeIds === 'function') ? getVisibleNodeIds() : null;
  state.svgDrilldownBoxes.each(function(d) {
    const pts = d.members.filter(n =>
      (!visible || visible.has(n.id)) && n.x != null && n.y != null);
    if (pts.length === 0) { d3.select(this).style('display', 'none'); return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(n => {
      const r = nodeRadius(n);
      if (n.x - r < minX) { minX = n.x - r; }
      if (n.y - r < minY) { minY = n.y - r; }
      if (n.x + r > maxX) { maxX = n.x + r; }
      if (n.y + r > maxY) { maxY = n.y + r; }
    });
    minX -= DD_FOLDER_PADDING; minY -= DD_FOLDER_PADDING;
    maxX += DD_FOLDER_PADDING; maxY += DD_FOLDER_PADDING;
    const el = d3.select(this).style('display', null);
    el.select('.folder-bubble-shape')
      .attr('x', minX).attr('y', minY).attr('width', maxX - minX).attr('height', maxY - minY)
      .attr('fill', folderFillColor(d.depth, d.hue)).attr('stroke', folderStrokeColor(d.depth, d.hue));
    el.select('.folder-bubble-titlebar')
      .attr('x', minX).attr('y', minY).attr('width', maxX - minX).attr('height', DD_TITLEBAR_HEIGHT)
      .attr('fill', folderTitlebarColor(d.depth, d.hue)).attr('rx', 8);
    el.select('.folder-bubble-label')
      .attr('x', (minX + maxX) / 2).attr('y', minY + DD_TITLEBAR_HEIGHT / 2).text(d.shortName);
  });
}

/** Cohesion force: pull each folder's members toward their centroid (deeper = tighter)
 *  so a box's bounding rect stays tight and excludes foreign nodes. */
function createDrilldownClusterForce(boxes) {
  function force(alpha) {
    for (const box of boxes) {
      const mem = box.members;
      if (mem.length < 2) { continue; }
      let cx = 0, cy = 0, k = 0;
      for (const n of mem) { if (n.x != null) { cx += n.x; cy += n.y; k++; } }
      if (!k) { continue; }
      cx /= k; cy /= k;
      const s = (settings.fileClusterForce ?? 0.2) * alpha * (1 + (box.depth || 0) * 0.3);
      for (const n of mem) {
        if (n.fx != null) { continue; }
        n.vx += (cx - n.x) * s;
        n.vy += (cy - n.y) * s;
      }
    }
  }
  force.initialize = () => {};
  return force;
}

function ddExtent(nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const r = (typeof nodeRadius === 'function') ? nodeRadius(n) : 5;
    if (n.x - r < minX) { minX = n.x - r; }
    if (n.y - r < minY) { minY = n.y - r; }
    if (n.x + r > maxX) { maxX = n.x + r; }
    if (n.y + r > maxY) { maxY = n.y + r; }
  }
  return { minX, minY, maxX, maxY };
}

/** Push sibling folders' node groups apart (driven by the Folder Repel Force
 *  slider) so their boxes don't overlap. Works whether a sibling is an expanded
 *  box or a single collapsed node. Built per-render; reads live positions per tick. */
function createDrilldownSeparationForce() {
  const tree = state.structureTree;
  if (!tree || !tree.folders) { return function () {}; }
  // Visible member nodes per folder (computed once per render).
  const folderMembers = new Map();
  for (const fp in tree.folders) { folderMembers.set(fp, []); }
  for (const n of state.currentNodes) {
    const p = ddNodePath(n);
    if (!p) { continue; }
    for (const fp in tree.folders) {
      if (pathUnder(p, fp)) { folderMembers.get(fp).push(n); }
    }
  }
  // Sibling folder pairs (same parent), each pair once.
  const pairs = [];
  for (const fp in tree.folders) {
    const parent = tree.folders[fp].parent;
    if (!parent) { continue; }
    for (const sib of (tree.folders[parent].childFolders || [])) {
      if (sib > fp) { pairs.push([fp, sib]); }
    }
  }
  return function (alpha) {
    for (const [pa, pb] of pairs) {
      const na = folderMembers.get(pa).filter(n => n.x != null && n.fx == null);
      const nb = folderMembers.get(pb).filter(n => n.x != null && n.fx == null);
      if (!na.length || !nb.length) { continue; }
      let cxa = 0, cya = 0; na.forEach(n => { cxa += n.x; cya += n.y; }); cxa /= na.length; cya /= na.length;
      let cxb = 0, cyb = 0; nb.forEach(n => { cxb += n.x; cyb += n.y; }); cxb /= nb.length; cyb /= nb.length;
      const ea = ddExtent(na), eb = ddExtent(nb);
      const pad = DD_FOLDER_PADDING * 2;
      const overlapping = (ea.maxX + pad) > (eb.minX - pad) && (eb.maxX + pad) > (ea.minX - pad)
                       && (ea.maxY + pad) > (eb.minY - pad) && (eb.maxY + pad) > (ea.minY - pad);
      // Only resolve overlaps. Pushing already-separated siblings apart at every
      // distance (even weakly) makes isolated folders drift off-screen, especially
      // at a high Folder Repel Force.
      if (!overlapping) { continue; }
      const dx = (cxa - cxb) || 0.01, dy = (cya - cyb) || 0.01;
      const dist = Math.hypot(dx, dy);
      const s = (settings.folderRepelForce ?? 0.25) * alpha * 3.0 / dist;
      na.forEach(n => { n.vx += dx * s; n.vy += dy * s; });
      nb.forEach(n => { n.vx -= dx * s; n.vy -= dy * s; });
    }
  };
}

/** Push sibling files' node groups apart (driven by the File Repel Force slider)
 *  so their circles don't overlap. Only same-folder file pairs, overlap-only, and
 *  skips very large folders for performance. */
function createFileSeparationForce(nodesByFile) {
  const byFolder = new Map();
  for (const [fp, nodes] of nodesByFile) {
    if (!nodes.length) { continue; }
    const dir = ddDirname(fp);
    if (!byFolder.has(dir)) { byFolder.set(dir, []); }
    byFolder.get(dir).push(nodes);
  }
  const pairs = [];
  for (const files of byFolder.values()) {
    if (files.length < 2 || files.length > 60) { continue; } // cap big folders (perf)
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) { pairs.push([files[i], files[j]]); }
    }
  }
  return function (alpha) {
    for (const [ga, gb] of pairs) {
      const na = ga.filter(n => n.x != null && n.fx == null);
      const nb = gb.filter(n => n.x != null && n.fx == null);
      if (!na.length || !nb.length) { continue; }
      let cxa = 0, cya = 0; na.forEach(n => { cxa += n.x; cya += n.y; }); cxa /= na.length; cya /= na.length;
      let cxb = 0, cyb = 0; nb.forEach(n => { cxb += n.x; cyb += n.y; }); cxb /= nb.length; cyb /= nb.length;
      const ea = ddExtent(na), eb = ddExtent(nb);
      const pad = DD_FILE_PADDING;
      const overlapping = (ea.maxX + pad) > (eb.minX - pad) && (eb.maxX + pad) > (ea.minX - pad)
                       && (ea.maxY + pad) > (eb.minY - pad) && (eb.maxY + pad) > (ea.minY - pad);
      if (!overlapping) { continue; }
      const dx = (cxa - cxb) || 0.01, dy = (cya - cyb) || 0.01;
      const dist = Math.hypot(dx, dy);
      const s = (settings.fileRepelForce ?? 0.25) * alpha * 3.0 / dist;
      na.forEach(n => { n.vx += dx * s; n.vy += dy * s; });
      nb.forEach(n => { n.vx -= dx * s; n.vy -= dy * s; });
    }
  };
}

// ── Module export guard (for Node.js tests) ───────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = {
    ddHue, ddNodePath, pathUnder,
    buildDrilldownBoxData, renderDrilldownBoxes, createDrilldownBoxDrag,
    tickDrilldownBoxes, createDrilldownClusterForce, ddExtent,
    createDrilldownSeparationForce, createFileSeparationForce,
    ddDirname, ddBasename,
    DD_FILE_PADDING, DD_FOLDER_PADDING, DD_TITLEBAR_HEIGHT,
  };
}
