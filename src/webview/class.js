// ── Constants ─────────────────────────────────────────────────────────────────
const CLASS_PADDING        = 20;
const CLASS_TITLEBAR_HEIGHT = 22;
const CLASS_CLUSTER_STRENGTH = 0.04;

// ── Color helper ──────────────────────────────────────────────────────────────
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Grouping ──────────────────────────────────────────────────────────────────
// Returns Map<classKey, { className, language, classExtends, classImplements, nodes[] }>
// Skips library, cluster, synthetic, orphan, and nodes without className.
function groupByClass(nodes) {
  const map = new Map();
  nodes.forEach(n => {
    if (n.isLibrary || n.isCluster || n.isSynthetic) return;
    if (!n.className) return;
    const key = `${n.file ?? ''}::${n.className}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        className:       n.className,
        language:        n.language ?? null,
        classExtends:    n.classExtends ?? null,
        classImplements: n.classImplements ?? [],
        nodes:           [],
      });
    }
    map.get(key).nodes.push(n);
  });
  return map;
}

// ── Label parts ───────────────────────────────────────────────────────────────
// Returns [{text, style}] where style is 'normal' | 'dim' | 'italic-dim'
function buildClassLabelParts(className, classExtends, classImplements) {
  const parts = [{ text: className, style: 'normal' }];
  if (classExtends) {
    parts.push({ text: `:${classExtends}`, style: 'dim' });
  }
  if (classImplements && classImplements.length) {
    classImplements.forEach(iface => {
      parts.push({ text: `:${iface}`, style: 'italic-dim' });
    });
  }
  return parts;
}

// ── D3 data join ──────────────────────────────────────────────────────────────
function renderClassBubbles(classG, classByKey) {
  const classData = [];
  classByKey.forEach(info => classData.push(info));

  return classG.selectAll('g.class-bubble')
    .data(classData, d => d.key)
    .join(
      enter => {
        const g = enter.append('g').attr('class', 'class-bubble');
        g.append('rect').attr('class', 'class-bubble-shape');
        g.append('rect').attr('class', 'class-bubble-titlebar');
        g.append('text').attr('class', 'class-bubble-label');
        return g;
      },
      update => update,
      exit => exit.remove()
    );
}

// ── Tick update ───────────────────────────────────────────────────────────────
function tickClassOverlay() {
  if (!state.classMode || !state.svgClassBubbles) return;
  const visibleIds = getVisibleNodeIds();  // global from main.js

  state.svgClassBubbles.each(function(d) {
    const points = d.nodes
      .filter(n => visibleIds.has(n.id) && n.x != null && n.y != null)
      .map(n => ({ x: n.x, y: n.y, r: nodeRadius(n) }));  // global from rendering.js

    if (!points.length) {
      d3.select(this).style('display', 'none');
      return;
    }
    d3.select(this).style('display', null);

    const bc = boundingCircle(points);  // global from folder.js
    const langColor = getLanguageColor(d.language) ?? '#888888';  // global from colors.js

    const minX = bc.cx - bc.r - CLASS_PADDING;
    const minY = bc.cy - bc.r - CLASS_PADDING;
    const maxX = bc.cx + bc.r + CLASS_PADDING;
    const maxY = bc.cy + bc.r + CLASS_PADDING;
    const w = maxX - minX;
    const h = maxY - minY;

    d3.select(this).select('.class-bubble-shape')
      .attr('x', minX).attr('y', minY)
      .attr('width', w).attr('height', h)
      .attr('fill', 'rgba(20,20,20,0.45)')
      .attr('stroke', langColor);

    d3.select(this).select('.class-bubble-titlebar')
      .attr('x', minX).attr('y', minY)
      .attr('width', w).attr('height', CLASS_TITLEBAR_HEIGHT)
      .attr('fill', hexToRgba(langColor.startsWith('#') ? langColor : '#888888', 0.85))
      .attr('rx', 8);

    // Build label tspans once per data item
    const labelEl = d3.select(this).select('.class-bubble-label');
    if (!d._labelBuilt) {
      d._labelBuilt = true;
      const parts = buildClassLabelParts(d.className, d.classExtends, d.classImplements);
      labelEl.selectAll('tspan').remove();
      parts.forEach(part => {
        const ts = labelEl.append('tspan').text(part.text);
        if (part.style === 'dim') {
          ts.attr('fill-opacity', 0.6);
        } else if (part.style === 'italic-dim') {
          ts.attr('fill-opacity', 0.5).attr('font-style', 'italic');
        }
      });
    }

    labelEl
      .attr('x', (minX + maxX) / 2)
      .attr('y', minY + CLASS_TITLEBAR_HEIGHT / 2)
      .attr('dominant-baseline', 'central');
  });
}

// ── Cluster force ─────────────────────────────────────────────────────────────
function createClassClusterForce(classByKey) {
  return function(alpha) {
    classByKey.forEach(info => {
      const valid = info.nodes.filter(n => n.x != null && n.y != null);
      if (!valid.length) return;
      const cx = valid.reduce((s, n) => s + n.x, 0) / valid.length;
      const cy = valid.reduce((s, n) => s + n.y, 0) / valid.length;
      valid.forEach(n => {
        if (n.fx != null) return;
        n.vx = (n.vx ?? 0) + (cx - n.x) * CLASS_CLUSTER_STRENGTH * alpha;
        n.vy = (n.vy ?? 0) + (cy - n.y) * CLASS_CLUSTER_STRENGTH * alpha;
      });
    });
  };
}

// ── Drag factory (title bar — move all class nodes) ───────────────────────────
function createClassDrag() {
  return d3.drag()
    .on('start', function(event, d) {
      d._dragStart = { x: event.x, y: event.y };
      d._nodeStarts = d.nodes.map(n => ({ n, x: n.x ?? 0, y: n.y ?? 0 }));
      if (state.layoutMode === 'dynamic' && !event.active && state.simulation)
        state.simulation.alphaTarget(0.3).restart();
      d.nodes.forEach(n => { n.fx = n.x; n.fy = n.y; });
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
        d.nodes.forEach(n => { n.fx = null; n.fy = null; });
      }
    });
}

// ── Resize drag (border zone — scale all class nodes from centroid) ────────────
function createClassResizeDrag() {
  return d3.drag()
    .on('start', function(event, d) {
      const x = +d3.select(this).attr('x'), y = +d3.select(this).attr('y');
      const w = +d3.select(this).attr('width'), h = +d3.select(this).attr('height');
      const INTERACT_EDGE_PX = 12;
      if (Math.min(event.x - x, (x + w) - event.x, event.y - y, (y + h) - event.y) >= INTERACT_EDGE_PX) return;
      const cx = x + w / 2, cy = y + h / 2;
      d._resizeCenter = { x: cx, y: cy };
      d._resizeStartDist = Math.hypot(event.x - cx, event.y - cy) || 1;
      d._nodeStarts = d.nodes.map(n => ({ n, ox: (n.x ?? 0) - cx, oy: (n.y ?? 0) - cy }));
      if (state.layoutMode === 'dynamic' && !event.active && state.simulation)
        state.simulation.alphaTarget(0.3).restart();
      d.nodes.forEach(n => { n.fx = n.x; n.fy = n.y; });
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
        d.nodes.forEach(n => { n.fx = null; n.fy = null; });
      }
    });
}

// ── Module export guard (for Node.js tests) ───────────────────────────────────
if (typeof module !== 'undefined') {
  module.exports = {
    groupByClass, buildClassLabelParts, renderClassBubbles,
    tickClassOverlay, createClassClusterForce,
    createClassDrag, createClassResizeDrag, hexToRgba,
  };
}
