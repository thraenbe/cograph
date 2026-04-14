// ── Constants ────────────────────────────────────────────────────────────────
const FILE_PADDING               = 28;
const FOLDER_PADDING             = 40;
const PATH_SEP_RE                = /[\\/]+/;       // handles both / and \ (B1)
const INTERACT_EDGE_PX           = 12;             // px-width of resize hit zone on bubble border
const FOLDER_TITLEBAR_HEIGHT     = 30;             // px height of the draggable title bar

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
const EMPTY_FILE_EXTS = new Set(['.py', '.js', '.ts']);

function groupByFile(nodes) {
  const map = new Map();
  nodes.forEach(n => {
    if (n.isLibrary || !n.file) return;
    if (n.isCluster || n.isSynthetic) return;  // B2
    if (!map.has(n.file)) map.set(n.file, []);
    map.get(n.file).push(n);
  });
  if (settings.showEmptyFiles && state.allScannedFiles?.length) {
    state.allScannedFiles.forEach(fp => {
      const dot = fp.lastIndexOf('.');
      const ext = dot >= 0 ? fp.slice(dot) : '';
      if (!map.has(fp) && EMPTY_FILE_EXTS.has(ext)) map.set(fp, []);
    });
  }
  return map;
}

// Returns Map<folderPath, { depth, parent: string|null, childFolders: Set<string>, files: string[] }>
function buildFolderTree(nodesByFile) {
  const leafFolders = new Set();
  nodesByFile.forEach((_, filePath) => leafFolders.add(pathDirname(filePath)));
  if (!leafFolders.size) return new Map();

  // Find common prefix depth
  const splitLeafs = [...leafFolders].map(fp => fp.split(PATH_SEP_RE).filter(Boolean));
  let commonLen = splitLeafs[0].length;
  splitLeafs.forEach(parts => {
    let i = 0;
    while (i < commonLen && parts[i] === splitLeafs[0][i]) i++;
    commonLen = i;
  });

  // Collect all folders: leaf + all intermediate ancestors down to common root
  const allFolders = new Set(leafFolders);
  leafFolders.forEach(fp => {
    let current = fp;
    while (true) {
      const parent = pathDirname(current);
      if (parent === current) break;                             // filesystem root
      const parentParts = parent.split(PATH_SEP_RE).filter(Boolean);
      if (parentParts.length <= commonLen) break;               // reached common root
      allFolders.add(parent);
      current = parent;
    }
  });

  // Build tree entries
  const tree = new Map();
  allFolders.forEach(fp => {
    const parts = fp.split(PATH_SEP_RE).filter(Boolean);
    tree.set(fp, { depth: parts.length - commonLen, parent: null, childFolders: new Set(), files: [] });
  });

  // Set parent-child folder links
  allFolders.forEach(fp => {
    const parent = pathDirname(fp);
    if (parent !== fp && allFolders.has(parent)) {
      tree.get(fp).parent = parent;
      tree.get(parent).childFolders.add(fp);
    }
  });

  // Assign direct files to their immediate parent folder
  nodesByFile.forEach((_, filePath) => {
    const folder = pathDirname(filePath);
    if (tree.has(folder)) tree.get(folder).files.push(filePath);
  });

  return tree;
}

// ── Hue assignment ───────────────────────────────────────────────────────────
const GOLDEN_ANGLE = 137.508;

function computeFolderHues(folderTree) {
  const roots = [];
  folderTree.forEach((info, fp) => { if (!info.parent) roots.push(fp); });
  roots.sort();

  function assignHue(folderPath, baseHue) {
    const info = folderTree.get(folderPath);
    info.hue = baseHue;
    const children = [...info.childFolders].sort();
    children.forEach(child => assignHue(child, baseHue));
  }

  roots.forEach((fp, i) => assignHue(fp, (i * GOLDEN_ANGLE) % 360));
}

// ── Color helpers ─────────────────────────────────────────────────────────────
function isLightTheme() {
  return document.body.classList.contains('vscode-light');
}

function folderFillColor(depth, hue) {
  if (isLightTheme()) {
    const s = Math.min(25, 12 + depth * 3);
    const l = Math.min(95, 88 + depth * 2);
    return `hsla(${hue}, ${s}%, ${l}%, 0.70)`;
  }
  const s = Math.min(20, 8 + depth * 3);
  const l = Math.max(10, 18 - depth * 2);
  return `hsla(${hue}, ${s}%, ${l}%, 0.55)`;
}
function folderStrokeColor(depth, hue) {
  if (isLightTheme()) {
    const s = Math.min(30, 15 + depth * 4);
    const l = Math.max(55, 72 - depth * 5);
    return `hsla(${hue}, ${s}%, ${l}%, 0.60)`;
  }
  const s = Math.min(25, 10 + depth * 4);
  const l = Math.max(25, 38 - depth * 4);
  return `hsla(${hue}, ${s}%, ${l}%, 0.35)`;
}
function folderTitlebarColor(depth, hue) {
  if (isLightTheme()) {
    const s = Math.min(35, 18 + depth * 4);
    const l = Math.max(68, 82 - depth * 4);
    return `hsla(${hue}, ${s}%, ${l}%, 0.92)`;
  }
  const s = Math.min(25, 12 + depth * 4);
  const l = Math.max(14, 24 - depth * 3);
  return `hsla(${hue}, ${s}%, ${l}%, 0.88)`;
}

// ── Language inference helper ─────────────────────────────────────────────────
function inferLangFromPath(fp) {
  const dot = fp.lastIndexOf('.');
  const ext = dot >= 0 ? fp.slice(dot) : '';
  if (ext === '.py') return 'python';
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  return null;
}

// ── D3 data joins ─────────────────────────────────────────────────────────────
function renderFileCircles(fileG, nodesByFile) {
  const fileData = [];
  nodesByFile.forEach((nodes, filePath) => {
    fileData.push({
      filePath,
      shortName: pathBasename(filePath),
      lang: nodes[0]?.language ?? inferLangFromPath(filePath),
      nodes,
      isEmpty: nodes.length === 0,
    });
  });
  return fileG.selectAll('g.file-bubble')
    .data(fileData, d => d.filePath)
    .join(
      enter => {
        const g = enter.append('g').attr('class', 'file-bubble');
        g.append('ellipse').attr('class', 'file-circle-shape');
        g.append('text').attr('class', 'file-circle-label');
        g.append('text').attr('class', 'file-circle-subtitle');
        return g;
      },
      update => update,
      exit => exit.remove()
    )
    .on('dblclick', (event, d) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'navigate', file: d.filePath, line: 1 });
    })
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

function getAllFolderNodes(folderPath, folderTree, nodesByFile) {
  const nodes = [];
  const info = folderTree.get(folderPath);
  if (!info) return nodes;
  info.files.forEach(fp => nodes.push(...(nodesByFile.get(fp) ?? [])));
  info.childFolders.forEach(cp => nodes.push(...getAllFolderNodes(cp, folderTree, nodesByFile)));
  return nodes;
}

function renderFolderBubbles(folderG, folderTree, nodesByFile) {
  const folderData = [];
  folderTree.forEach((info, folderPath) => {
    folderData.push({
      folderPath,
      shortName: pathBasename(folderPath) || folderPath,
      depth: info.depth,
      hue: info.hue ?? 0,
      parent: info.parent,
      childFolderPaths: [...info.childFolders],
      files: info.files,
      allNodes: getAllFolderNodes(folderPath, folderTree, nodesByFile),
    });
  });
  // Sort shallowest first → parent rects rendered behind child rects in SVG z-order
  folderData.sort((a, b) => a.depth - b.depth);

  return folderG.selectAll('g.folder-bubble')
    .data(folderData, d => d.folderPath)
    .join(
      enter => {
        const g = enter.append('g').attr('class', 'folder-bubble');
        g.append('rect').attr('class', 'folder-bubble-shape');
        g.append('rect').attr('class', 'folder-bubble-titlebar');
        g.append('text').attr('class', 'folder-bubble-label');
        return g;
      },
      update => update,
      exit => exit.remove()
    )
    .on('contextmenu', (event, d) => {
      event.preventDefault();
      event.stopPropagation();
      const items = [
        { label: `${d.shortName} (Folder)`, isHeader: true },
        { label: 'Rename',           action: () => vscode.postMessage({ type: 'request-rename-folder', folderPath: d.folderPath }) },
        { label: 'New File',         action: () => vscode.postMessage({ type: 'request-new-file',      folderPath: d.folderPath }) },
        { label: 'Hide Folder',      action: () => { state.hiddenFolders.add(d.folderPath); applyFilters(); ticked(); updateFolderPanel(); } },
        { label: 'Only Show Folder', action: () => { state.onlyShowFolder = d.folderPath; applyFilters(); ticked(); updateFolderPanel(); } },
      ];
      if (state.hiddenFolders.size > 0 || state.onlyShowFolder) {
        items.push({ label: 'Show All Folders', action: () => { state.hiddenFolders.clear(); state.onlyShowFolder = null; applyFilters(); ticked(); updateFolderPanel(); } });
      }
      showContextMenu(event, items);
    });
}

// ── Tick update ───────────────────────────────────────────────────────────────
// Called every simulation tick from rendering.js:ticked()
function tickFolderOverlay() {
  if (!state.folderMode || !state.svgFileCircles || !state.svgFolderBubbles) return;

  const visibleIds = getVisibleNodeIds();   // global from main.js — safe at call time
  const fileCircleMap = new Map();          // filePath -> { cx, cy, r }

  state.svgFileCircles.each(function(d) {
    // ── guard: hide this file circle if its folder is hidden ──────────────────
    const _ffp = pathDirname(d.filePath);
    const _inHidden = (folder) => _ffp === folder || _ffp.startsWith(folder + '/') || _ffp.startsWith(folder + '\\');
    if (state.onlyShowFolder && !_inHidden(state.onlyShowFolder)) { d3.select(this).style('display', 'none'); return; }
    for (const hf of state.hiddenFolders) { if (_inHidden(hf)) { d3.select(this).style('display', 'none'); return; } }
    // ─────────────────────────────────────────────────────────────────────────
    const langColor = getLanguageColor(d.lang) ?? '#888888';   // global from colors.js
    let displayColor = langColor;
    let fileChanged = false;
    if (state.gitMode) {
      for (const n of d.nodes) {
        const s = n.gitStatus?.unstaged ?? n.gitStatus?.staged;
        if (s === 'added')    { displayColor = '#4caf50'; fileChanged = true; break; }
        if (s === 'modified') { displayColor = '#ff9800'; fileChanged = true; }
      }
    }
    const strokeWidth = fileChanged ? 12 : 1.5;
    const points = d.nodes
      .filter(n => visibleIds.has(n.id) && n.x != null && n.y != null)
      .map(n => ({ x: n.x, y: n.y, r: nodeRadius(n) }));       // global from rendering.js

    if (!points.length) {
      if (!d.isEmpty) { d3.select(this).style('display', 'none'); return; }
      // Empty file: initialise position near SVG centre on first tick
      if (d._cx == null) {
        const svgEl = svg.node();
        d._cx = (svgEl.clientWidth  || 800) / 2 + (Math.random() - 0.5) * 300;
        d._cy = (svgEl.clientHeight || 600) / 2 + (Math.random() - 0.5) * 300;
      }
      const bc = { cx: d._cx, cy: d._cy, r: 30 };
      fileCircleMap.set(d.filePath, bc);
      d3.select(this).style('display', null)
        .select('.file-circle-shape')
          .attr('cx', bc.cx).attr('cy', bc.cy)
          .attr('rx', bc.r).attr('ry', bc.r * 0.92)
          .attr('fill', displayColor).attr('fill-opacity', 0.03)
          .attr('stroke', displayColor).attr('stroke-opacity', 0.35)
          .attr('stroke-width', strokeWidth)
          .attr('stroke-dasharray', '4 3');
      d3.select(this).select('.file-circle-label')
        .attr('x', bc.cx).attr('y', bc.cy)
        .attr('fill', displayColor).text(d.shortName);
      d3.select(this).select('.file-circle-subtitle')
        .attr('x', bc.cx).attr('y', bc.cy + 14)
        .attr('fill', displayColor).attr('font-size', '9px').attr('opacity', 0.6)
        .text('empty');
      return;
    }
    d3.select(this).style('display', null);

    if (state.classMode) {
      const CLASS_PAD = 20; // matches CLASS_PADDING in class.js
      const classPtsMap = new Map();
      d.nodes
        .filter(n => visibleIds.has(n.id) && n.x != null && n.y != null && n.className)
        .forEach(n => {
          if (!classPtsMap.has(n.className)) classPtsMap.set(n.className, []);
          classPtsMap.get(n.className).push({ x: n.x, y: n.y, r: nodeRadius(n) });
        });
      classPtsMap.forEach(cPts => {
        const cbc = boundingCircle(cPts);
        const hw = cbc.r + CLASS_PAD;
        points.push(
          { x: cbc.cx - hw, y: cbc.cy - hw },
          { x: cbc.cx + hw, y: cbc.cy - hw },
          { x: cbc.cx + hw, y: cbc.cy + hw },
          { x: cbc.cx - hw, y: cbc.cy + hw },
        );
      });
    }

    const bc = boundingCircle(points);
    bc.r = Math.max(bc.r + FILE_PADDING, 30);                  // B6: minimum radius
    fileCircleMap.set(d.filePath, bc);

    d3.select(this).select('.file-circle-shape')
      .attr('cx', bc.cx).attr('cy', bc.cy)
      .attr('rx', bc.r).attr('ry', bc.r * 0.92)
      .attr('fill', displayColor).attr('fill-opacity', 0.07)       // B3: separate opacity attrs
      .attr('stroke', displayColor).attr('stroke-opacity', 0.9)
      .attr('stroke-width', strokeWidth)
      .attr('stroke-dasharray', null);

    d3.select(this).select('.file-circle-label')
      .attr('x', bc.cx).attr('y', bc.cy - bc.r * 0.92 + strokeWidth / 2 + 16)   // inside, below inner stroke edge
      .attr('fill', displayColor)
      .text(d.shortName);

    d3.select(this).select('.file-circle-subtitle')
      .attr('x', bc.cx).attr('y', bc.cy - bc.r * 0.92 + strokeWidth / 2 + 28)
      .attr('fill', displayColor).attr('font-size', '9px').attr('opacity', 0.5)
      .text(`+${d.nodes.length} fn${d.nodes.length === 1 ? '' : 's'}`);
  });

  // Bottom-up rect computation: deepest folders first so parents can union children
  const folderItems = [];
  state.svgFolderBubbles.each(function(d) { folderItems.push([d, this]); });
  folderItems.sort((a, b) => b[0].depth - a[0].depth);   // deepest first

  const folderRectMap = new Map();   // folderPath -> padded {minX, minY, maxX, maxY} | null

  folderItems.forEach(([d, el]) => {
    let rect = null;

    // Union direct file circles
    d.files.forEach(fp => {
      const bc = fileCircleMap.get(fp);
      if (!bc) return;
      rect = unionRect(rect, { minX: bc.cx - bc.r, minY: bc.cy - bc.r * 0.92,
                                maxX: bc.cx + bc.r, maxY: bc.cy + bc.r * 0.92 });
    });

    // Union child folder rects (already computed — deepest first ensures this)
    d.childFolderPaths.forEach(childPath => {
      const cr = folderRectMap.get(childPath);
      if (!cr) return;
      rect = unionRect(rect, cr);
    });

    if (!rect) {
      d3.select(el).style('display', 'none');
      folderRectMap.set(d.folderPath, null);
      return;
    }

    const padded = {
      minX: rect.minX - FOLDER_PADDING,  minY: rect.minY - FOLDER_PADDING,
      maxX: rect.maxX + FOLDER_PADDING,  maxY: rect.maxY + FOLDER_PADDING,
    };
    folderRectMap.set(d.folderPath, padded);

    d3.select(el).style('display', null);
    d3.select(el).select('.folder-bubble-shape')
      .attr('x', padded.minX).attr('y', padded.minY)
      .attr('width',  padded.maxX - padded.minX)
      .attr('height', padded.maxY - padded.minY)
      .attr('fill',   folderFillColor(d.depth, d.hue))
      .attr('stroke', folderStrokeColor(d.depth, d.hue));

    d3.select(el).select('.folder-bubble-titlebar')
      .attr('x', padded.minX).attr('y', padded.minY)
      .attr('width',  padded.maxX - padded.minX)
      .attr('height', FOLDER_TITLEBAR_HEIGHT)
      .attr('fill',   folderTitlebarColor(d.depth, d.hue))
      .attr('rx', 8);

    d3.select(el).select('.folder-bubble-label')
      .attr('x', (padded.minX + padded.maxX) / 2)
      .attr('y', padded.minY + FOLDER_TITLEBAR_HEIGHT / 2)
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
        n.vx = (n.vx ?? 0) + (cx - n.x) * settings.fileClusterForce * alpha;
        n.vy = (n.vy ?? 0) + (cy - n.y) * settings.fileClusterForce * alpha;
      });
    });
  };
}

// ── Rect union helper ─────────────────────────────────────────────────────────
function unionRect(acc, r) {
  if (!acc) return { minX: r.minX, minY: r.minY, maxX: r.maxX, maxY: r.maxY };
  return {
    minX: Math.min(acc.minX, r.minX), minY: Math.min(acc.minY, r.minY),
    maxX: Math.max(acc.maxX, r.maxX), maxY: Math.max(acc.maxY, r.maxY),
  };
}

// ── Folder separation force ───────────────────────────────────────────────────
// Pushes sibling-folder nodes apart so their bubbles don't overlap
function createFolderSeparationForce(folderTree, nodesByFile) {
  // Build folderPath -> all descendant nodes (not just direct children)
  const folderAllNodes = new Map();
  folderTree.forEach((_, folderPath) => {
    folderAllNodes.set(folderPath, getAllFolderNodes(folderPath, folderTree, nodesByFile));
  });

  // Collect sibling pairs (same parent, each pair listed once)
  const siblingPairs = [];
  folderTree.forEach((info, folderPath) => {
    if (!info.parent) return;
    const siblings = [...(folderTree.get(info.parent)?.childFolders ?? [])];
    siblings.forEach(sibling => {
      if (sibling > folderPath) siblingPairs.push([folderPath, sibling]);
    });
  });

  return function(alpha) {
    siblingPairs.forEach(([pathA, pathB]) => {
      const nodesA = (folderAllNodes.get(pathA) ?? []).filter(n => n.x != null && n.fx == null);
      const nodesB = (folderAllNodes.get(pathB) ?? []).filter(n => n.x != null && n.fx == null);
      if (!nodesA.length || !nodesB.length) return;

      const cxA = nodesA.reduce((s, n) => s + n.x, 0) / nodesA.length;
      const cyA = nodesA.reduce((s, n) => s + n.y, 0) / nodesA.length;
      const cxB = nodesB.reduce((s, n) => s + n.x, 0) / nodesB.length;
      const cyB = nodesB.reduce((s, n) => s + n.y, 0) / nodesB.length;

      // Compute bounding extents for overlap detection
      const extA = nodesA.reduce((e, n) => {
        const r = n._r ?? 5;
        return { minX: Math.min(e.minX, n.x - r), maxX: Math.max(e.maxX, n.x + r),
                 minY: Math.min(e.minY, n.y - r), maxY: Math.max(e.maxY, n.y + r) };
      }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
      const extB = nodesB.reduce((e, n) => {
        const r = n._r ?? 5;
        return { minX: Math.min(e.minX, n.x - r), maxX: Math.max(e.maxX, n.x + r),
                 minY: Math.min(e.minY, n.y - r), maxY: Math.max(e.maxY, n.y + r) };
      }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

      const pad = FOLDER_PADDING * 2;
      const overlapX = (extA.maxX + pad) - (extB.minX - pad);
      const overlapY = (extA.maxY + pad) - (extB.minY - pad);
      const overlapping = overlapX > 0 && overlapY > 0
        && (extB.maxX + pad) - (extA.minX - pad) > 0
        && (extB.maxY + pad) - (extA.minY - pad) > 0;

      const dx = cxA - cxB || 0.01;
      const dy = cyA - cyB || 0.01;
      const dist = Math.hypot(dx, dy);
      const boost = overlapping ? 3.0 : 1.0;
      const strength = 0.25 * alpha * boost / dist;

      nodesA.forEach(n => { n.vx += dx * strength; n.vy += dy * strength; });
      nodesB.forEach(n => { n.vx -= dx * strength; n.vy -= dy * strength; });
    });
  };
}

// ── Cursor helpers ────────────────────────────────────────────────────────────
// Maps an angle (degrees, 0=east, clockwise) to a CSS resize cursor
function _resizeCursor(deg) {
  const a = ((deg % 360) + 360) % 360;
  if (a < 22.5  || a >= 337.5) return 'ew-resize';
  if (a < 67.5)                return 'se-resize';
  if (a < 112.5)               return 'ns-resize';
  if (a < 157.5)               return 'sw-resize';
  if (a < 202.5)               return 'ew-resize';
  if (a < 247.5)               return 'nw-resize';
  if (a < 292.5)               return 'ns-resize';
  return 'ne-resize';
}

// Returns cursor string for a point (mx, my) relative to an ellipse
function _fileCursor(mx, my, cx, cy, rx, ry) {
  const dx = mx - cx, dy = my - cy;
  const nd = Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
  if (Math.abs(nd - 1) * ((rx + ry) / 2) < INTERACT_EDGE_PX)
    return _resizeCursor(Math.atan2(dy, dx) * 180 / Math.PI);
  return 'grab';
}

// Returns cursor string for a point (mx, my) relative to a rect
function _folderCursor(mx, my, x, y, w, h) {
  const nearL = mx - x        < INTERACT_EDGE_PX;
  const nearR = (x + w) - mx  < INTERACT_EDGE_PX;
  const nearT = my - y        < INTERACT_EDGE_PX;
  const nearB = (y + h) - my  < INTERACT_EDGE_PX;
  if (nearL && nearT) return 'nw-resize';
  if (nearR && nearT) return 'ne-resize';
  if (nearL && nearB) return 'sw-resize';
  if (nearR && nearB) return 'se-resize';
  if (nearL)          return 'w-resize';
  if (nearR)          return 'e-resize';
  if (nearT)          return 'n-resize';
  if (nearB)          return 's-resize';
  return 'default';   // interior — no drag action
}

// ── Hover cursor handlers (attached via .on('mousemove', ...)) ────────────────
function onFileHoverMove(event, d) {
  const shape = d3.select(this).select('.file-circle-shape');
  const cx = +shape.attr('cx'), cy = +shape.attr('cy');
  const rx = +shape.attr('rx'), ry = +shape.attr('ry');
  if (!rx || !ry) return;
  const [mx, my] = d3.pointer(event, this);
  shape.attr('cursor', _fileCursor(mx, my, cx, cy, rx, ry));
}

function onFolderHoverMove(event, d) {
  const shape = d3.select(this).select('.folder-bubble-shape');
  const x = +shape.attr('x'), y = +shape.attr('y');
  const w = +shape.attr('width'), h = +shape.attr('height');
  if (!w || !h) return;
  const [mx, my] = d3.pointer(event, this);
  shape.attr('cursor', _folderCursor(mx, my, x, y, w, h));
}

// ── File / Folder drag factories ─────────────────────────────────────────────
// Interior click → move (translate all child nodes by drag delta)
// Border click   → resize (scale child nodes from cluster centroid)
function createFileDrag() {
  return d3.drag()
    .on('start', function(event, d) {
      if (d.nodes.length === 0) {
        d._emptyStart = { cx: d._cx ?? event.x, cy: d._cy ?? event.y, ex: event.x, ey: event.y };
        return;
      }
      const shape = d3.select(this).select('.file-circle-shape');
      const cx = +shape.attr('cx'), cy = +shape.attr('cy');
      const rx = +shape.attr('rx'), ry = +shape.attr('ry');
      const dx = event.x - cx, dy = event.y - cy;
      const nd = Math.sqrt((dx / (rx || 1)) ** 2 + (dy / (ry || 1)) ** 2);
      const isResize = Math.abs(nd - 1) * ((rx + ry) / 2 || 1) < INTERACT_EDGE_PX;

      d._dragMode = isResize ? 'resize' : 'move';
      d._dragStart = { x: event.x, y: event.y };
      if (isResize) {
        d._resizeCenter = { x: cx, y: cy };
        d._resizeStartDist = Math.hypot(dx, dy) || 1;
        d._nodeStarts = d.nodes.map(n => ({ n, ox: (n.x ?? 0) - cx, oy: (n.y ?? 0) - cy }));
      } else {
        d._nodeStarts = d.nodes.map(n => ({ n, x: n.x ?? 0, y: n.y ?? 0 }));
      }
      if (state.layoutMode === 'dynamic' && !event.active && state.simulation)
        state.simulation.alphaTarget(0.3).restart();
      d.nodes.forEach(n => { n.fx = n.x; n.fy = n.y; });
    })
    .on('drag', function(event, d) {
      if (d.nodes.length === 0) {
        if (!d._emptyStart) return;
        d._cx = d._emptyStart.cx + (event.x - d._emptyStart.ex);
        d._cy = d._emptyStart.cy + (event.y - d._emptyStart.ey);
        if (state.layoutMode === 'static') ticked();
        return;
      }
      if (d._dragMode === 'resize') {
        const { x: cx, y: cy } = d._resizeCenter;
        const scale = (Math.hypot(event.x - cx, event.y - cy) || 1) / d._resizeStartDist;
        d._nodeStarts.forEach(({ n, ox, oy }) => {
          n.fx = cx + ox * scale; n.fy = cy + oy * scale;
          if (state.layoutMode === 'static') { n.x = n.fx; n.y = n.fy; }
        });
      } else {
        const dx = event.x - d._dragStart.x, dy = event.y - d._dragStart.y;
        d._nodeStarts.forEach(({ n, x, y }) => {
          n.fx = x + dx; n.fy = y + dy;
          if (state.layoutMode === 'static') { n.x = n.fx; n.y = n.fy; }
        });
      }
      if (state.layoutMode === 'static') ticked();
    })
    .on('end', function(event, d) {
      if (d.nodes.length === 0) { delete d._emptyStart; return; }
      delete d._dragStart; delete d._nodeStarts; delete d._dragMode;
      delete d._resizeCenter; delete d._resizeStartDist;
      if (state.layoutMode === 'dynamic') {
        if (!event.active && state.simulation) state.simulation.alphaTarget(0);
        d.nodes.forEach(n => { n.fx = null; n.fy = null; });
      }
    });
}

// Move drag — attached to the title bar; translates all descendant nodes
function createFolderDrag() {
  return d3.drag()
    .on('start', function(event, d) {
      d._dragStart = { x: event.x, y: event.y };
      d._nodeStarts = d.allNodes.map(n => ({ n, x: n.x ?? 0, y: n.y ?? 0 }));
      if (state.layoutMode === 'dynamic' && !event.active && state.simulation)
        state.simulation.alphaTarget(0.3).restart();
      d.allNodes.forEach(n => { n.fx = n.x; n.fy = n.y; });
    })
    .on('drag', function(event, d) {
      const dx = event.x - d._dragStart.x, dy = event.y - d._dragStart.y;
      d._nodeStarts.forEach(({ n, x, y }) => {
        n.fx = x + dx; n.fy = y + dy;
        if (state.layoutMode === 'static') { n.x = n.fx; n.y = n.fy; }
      });
      if (state.layoutMode === 'static') ticked();
    })
    .on('end', function(event, d) {
      delete d._dragStart; delete d._nodeStarts;
      if (state.layoutMode === 'dynamic') {
        if (!event.active && state.simulation) state.simulation.alphaTarget(0);
        d.allNodes.forEach(n => { n.fx = null; n.fy = null; });
      }
    });
}

// Resize drag — attached to the shape; activates only on border zone
function createFolderResizeDrag() {
  return d3.drag()
    .filter(function(event) {
      const el = d3.select(this);
      const x = +el.attr('x'), y = +el.attr('y');
      const w = +el.attr('width'), h = +el.attr('height');
      const [mx, my] = d3.pointer(event, this);
      return Math.min(mx - x, (x + w) - mx, my - y, (y + h) - my) < INTERACT_EDGE_PX;
    })
    .on('start', function(event, d) {
      const x = +d3.select(this).attr('x'), y = +d3.select(this).attr('y');
      const w = +d3.select(this).attr('width'), h = +d3.select(this).attr('height');
      const cx = x + w / 2, cy = y + h / 2;
      d._resizeCenter = { x: cx, y: cy };
      d._resizeStartDist = Math.hypot(event.x - cx, event.y - cy) || 1;
      d._nodeStarts = d.allNodes.map(n => ({ n, ox: (n.x ?? 0) - cx, oy: (n.y ?? 0) - cy }));
      if (state.layoutMode === 'dynamic' && !event.active && state.simulation)
        state.simulation.alphaTarget(0.3).restart();
      d.allNodes.forEach(n => { n.fx = n.x; n.fy = n.y; });
    })
    .on('drag', function(event, d) {
      if (!d._nodeStarts) return;
      const { x: cx, y: cy } = d._resizeCenter;
      const scale = (Math.hypot(event.x - cx, event.y - cy) || 1) / d._resizeStartDist;
      d._nodeStarts.forEach(({ n, ox, oy }) => {
        n.fx = cx + ox * scale; n.fy = cy + oy * scale;
        if (state.layoutMode === 'static') { n.x = n.fx; n.y = n.fy; }
      });
      if (state.layoutMode === 'static') ticked();
    })
    .on('end', function(event, d) {
      const hadResize = !!d._nodeStarts;
      delete d._nodeStarts; delete d._resizeCenter; delete d._resizeStartDist;
      if (hadResize && state.layoutMode === 'dynamic') {
        if (!event.active && state.simulation) state.simulation.alphaTarget(0);
        d.allNodes.forEach(n => { n.fx = null; n.fy = null; });
      }
    });
}

// ── Context menu ──────────────────────────────────────────────────────────────
function showContextMenu(event, items) {
  const menu = document.getElementById('ctx-menu');
  const list = document.getElementById('ctx-menu-list');
  if (!menu || !list) return;
  const actionItems = items.filter(item => !item.isHeader);
  let actionIdx = 0;
  list.innerHTML = items
    .map(item => item.isHeader
      ? `<li class="ctx-menu-header">${item.label}</li>`
      : `<li class="ctx-menu-item" data-idx="${actionIdx++}">${item.label}</li>`)
    .join('');
  list.querySelectorAll('.ctx-menu-item').forEach((li, i) => {
    li.addEventListener('click', e => { e.stopPropagation(); actionItems[i].action(); hideContextMenu(); });
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
    tickFolderOverlay, groupByFile, buildFolderTree, computeFolderHues,
    folderFillColor, folderStrokeColor, folderTitlebarColor,
    renderFileCircles, renderFolderBubbles, createFileClusterForce,
    createFolderSeparationForce, createFileDrag, createFolderDrag, createFolderResizeDrag,
    onFileHoverMove, onFolderHoverMove,
    getAllFolderNodes, unionRect,
    showContextMenu, hideContextMenu, boundingCircle,
    pathDirname, pathBasename, inferLangFromPath,
    EMPTY_FILE_EXTS,
  };
}
