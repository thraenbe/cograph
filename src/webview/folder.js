// ── Constants ────────────────────────────────────────────────────────────────
const FILE_PADDING     = 28;
const FOLDER_PADDING   = 40;
const CLUSTER_STRENGTH = 0.04;
const PATH_SEP_RE      = /[\\/]+/;       // handles both / and \ (B1)

// ── Path utilities ────────────────────────────────────────────────────────────
function pathDirname(fp) {
  const idx = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'));  // B1
  return idx >= 0 ? fp.substring(0, idx) : '(root)';
}
function pathBasename(fp) {
  const idx = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'));  // B1
  return idx >= 0 ? fp.substring(idx + 1) : fp;
}

// ── Bounding circle ───────────────────────────────────────────────────────────
// points: Array<{x, y, r?}>  — r is the child radius (0 for raw nodes)
function boundingCircle(points) {
  if (!points.length) return { cx: 0, cy: 0, r: 0 };
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const r  = points.reduce((max, p) =>
    Math.max(max, Math.hypot(p.x - cx, p.y - cy) + (p.r ?? 0)), 0);
  return { cx, cy, r };
}

// ── Grouping ──────────────────────────────────────────────────────────────────
// Returns Map<filePath, node[]>
// Skips library nodes, nodes without file, and any clustered/synthetic nodes (B2)
function groupByFile(nodes) {
  const map = new Map();
  nodes.forEach(n => {
    if (n.isLibrary || !n.file) return;
    if (n.isCluster || n.isSynthetic || n.isOrphanCluster) return;  // B2
    if (!map.has(n.file)) map.set(n.file, []);
    map.get(n.file).push(n);
  });
  return map;
}

// Returns Map<folderPath, filePath[]>
function groupByFolder(filePaths) {
  const map = new Map();
  filePaths.forEach(fp => {
    const folder = pathDirname(fp);   // B1
    if (!map.has(folder)) map.set(folder, []);
    map.get(folder).push(fp);
  });
  return map;
}

// Returns Map<folderPath, depth>  (0 = root-most folder in this workspace)
function computeFolderDepths(folderPaths) {
  if (!folderPaths.length) return new Map();
  // Split every path using the cross-platform regex (B1)
  const splitPaths = folderPaths.map(fp => fp.split(PATH_SEP_RE).filter(Boolean));
  // Find common prefix length
  let commonLen = splitPaths[0].length;
  splitPaths.forEach(parts => {
    let i = 0;
    while (i < commonLen && parts[i] === splitPaths[0][i]) i++;
    commonLen = i;
  });
  return new Map(folderPaths.map((fp, i) => [fp, splitPaths[i].length - commonLen]));
}

// ── Color helpers ─────────────────────────────────────────────────────────────
function folderFillColor(depth) {
  const l = Math.max(18, 38 - depth * 5);
  return `rgba(${l + 10},${l + 10},${l + 10},0.55)`;
}
function folderStrokeColor(depth) {
  const l = Math.max(60, 90 - depth * 8);
  return `rgba(${l},${l},${l},0.35)`;
}

// ── D3 data joins ─────────────────────────────────────────────────────────────
function renderFileCircles(fileG, nodesByFile) {
  const fileData = [];
  nodesByFile.forEach((nodes, filePath) => {
    fileData.push({ filePath, shortName: pathBasename(filePath), lang: nodes[0]?.language ?? null, nodes });
  });
  return fileG.selectAll('g.file-bubble')
    .data(fileData, d => d.filePath)
    .join(
      enter => {
        const g = enter.append('g').attr('class', 'file-bubble');
        g.append('ellipse').attr('class', 'file-circle-shape');
        g.append('text').attr('class', 'file-circle-label');
        return g;
      },
      update => update,
      exit => exit.remove()
    )
    .on('contextmenu', (event, d) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event, [
        { label: 'Rename',       action: () => {} },
        { label: 'New function', action: () => {} },
        { label: 'Go to File',   action: () => vscode.postMessage({ type: 'navigate', file: d.filePath, line: 1 }) },
      ]);
    });
}

function renderFolderBubbles(folderG, foldersByPath, folderDepths) {
  const folderData = [];
  foldersByPath.forEach((filePaths, folderPath) => {
    folderData.push({
      folderPath,
      shortName: pathBasename(folderPath) || folderPath,
      filePaths,
      depth: folderDepths.get(folderPath) ?? 0,
    });
  });
  return folderG.selectAll('g.folder-bubble')
    .data(folderData, d => d.folderPath)
    .join(
      enter => {
        const g = enter.append('g').attr('class', 'folder-bubble');
        g.append('ellipse').attr('class', 'folder-bubble-shape');
        g.append('text').attr('class', 'folder-bubble-label');
        return g;
      },
      update => update,
      exit => exit.remove()
    )
    .on('contextmenu', (event, d) => {
      event.preventDefault();
      event.stopPropagation();
      showContextMenu(event, [
        { label: 'Rename',           action: () => {} },
        { label: 'New file',         action: () => {} },
        { label: 'Only show Folder', action: () => {} },
      ]);
    });
}

// ── Tick update ───────────────────────────────────────────────────────────────
// Called every simulation tick from rendering.js:ticked()
function tickFolderOverlay() {
  if (!state.folderMode || !state.svgFileCircles || !state.svgFolderBubbles) return;

  const visibleIds = getVisibleNodeIds();   // global from main.js — safe at call time
  const fileCircleMap = new Map();          // filePath -> { cx, cy, r }

  state.svgFileCircles.each(function(d) {
    const langColor = getLanguageColor(d.lang) ?? '#888888';   // global from colors.js
    const points = d.nodes
      .filter(n => visibleIds.has(n.id) && n.x != null && n.y != null)
      .map(n => ({ x: n.x, y: n.y, r: nodeRadius(n) }));       // global from rendering.js

    if (!points.length) {
      d3.select(this).style('display', 'none');
      return;
    }
    d3.select(this).style('display', null);

    const bc = boundingCircle(points);
    bc.r = Math.max(bc.r + FILE_PADDING, 30);                  // B6: minimum radius
    fileCircleMap.set(d.filePath, bc);

    d3.select(this).select('.file-circle-shape')
      .attr('cx', bc.cx).attr('cy', bc.cy)
      .attr('rx', bc.r).attr('ry', bc.r * 0.92)
      .attr('fill', langColor).attr('fill-opacity', 0.07)       // B3: separate opacity attrs
      .attr('stroke', langColor).attr('stroke-opacity', 0.9);

    d3.select(this).select('.file-circle-label')
      .attr('x', bc.cx).attr('y', bc.cy - bc.r * 0.92 - 6)
      .attr('fill', langColor)
      .text(d.shortName);
  });

  state.svgFolderBubbles.each(function(d) {
    const points = d.filePaths
      .map(fp => fileCircleMap.get(fp))
      .filter(Boolean)
      .map(bc => ({ x: bc.cx, y: bc.cy, r: bc.r }));

    if (!points.length) {
      d3.select(this).style('display', 'none');
      return;
    }
    d3.select(this).style('display', null);

    const bc = boundingCircle(points);
    bc.r = Math.max(bc.r + FOLDER_PADDING, 50);

    d3.select(this).select('.folder-bubble-shape')
      .attr('cx', bc.cx).attr('cy', bc.cy)
      .attr('rx', bc.r).attr('ry', bc.r * 0.88)
      .attr('fill', folderFillColor(d.depth))
      .attr('stroke', folderStrokeColor(d.depth));

    d3.select(this).select('.folder-bubble-label')
      .attr('x', bc.cx).attr('y', bc.cy - bc.r * 0.88 - 6)
      .text(d.shortName);
  });
}

// ── File cluster force ────────────────────────────────────────────────────────
// Mild force that nudges same-file nodes toward each other
function createFileClusterForce(nodesByFile) {
  return function(alpha) {
    nodesByFile.forEach(nodes => {
      const valid = nodes.filter(n => n.x != null && n.y != null);
      if (!valid.length) return;
      const cx = valid.reduce((s, n) => s + n.x, 0) / valid.length;
      const cy = valid.reduce((s, n) => s + n.y, 0) / valid.length;
      valid.forEach(n => {
        if (n.fx != null) return;   // don't disturb pinned nodes
        n.vx = (n.vx ?? 0) + (cx - n.x) * CLUSTER_STRENGTH * alpha;
        n.vy = (n.vy ?? 0) + (cy - n.y) * CLUSTER_STRENGTH * alpha;
      });
    });
  };
}

// ── Context menu ──────────────────────────────────────────────────────────────
function showContextMenu(event, items) {
  const menu = document.getElementById('ctx-menu');
  const list = document.getElementById('ctx-menu-list');
  if (!menu || !list) return;
  list.innerHTML = items
    .map((item, i) => `<li class="ctx-menu-item" data-idx="${i}">${item.label}</li>`)
    .join('');
  list.querySelectorAll('.ctx-menu-item').forEach((li, i) => {
    li.addEventListener('click', e => { e.stopPropagation(); items[i].action(); hideContextMenu(); });
  });
  menu.style.left    = event.pageX + 'px';
  menu.style.top     = event.pageY + 'px';
  menu.style.display = 'block';
  // Clamp to viewport (B7)
  const rect = menu.getBoundingClientRect();
  if (rect.right  > window.innerWidth)  menu.style.left = (event.pageX - rect.width)  + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top  = (event.pageY - rect.height) + 'px';
}

function hideContextMenu() {
  const menu = document.getElementById('ctx-menu');
  if (menu) menu.style.display = 'none';
}

// ── Module export guard (for Node.js tests) ───────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = {
    tickFolderOverlay, groupByFile, groupByFolder,
    computeFolderDepths, folderFillColor, folderStrokeColor,
    renderFileCircles, renderFolderBubbles, createFileClusterForce,
    showContextMenu, hideContextMenu, boundingCircle,
    pathDirname, pathBasename,
  };
}
