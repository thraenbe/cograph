// stageApi.js — window.stageApi, the hooks a guided tour drives the graph view
// with (docs/tour-protocol.md section 5). Loaded after every other stage script.
//
// Generic graph features: a camera move onto a set of nodes, a spotlight, a
// pulse ring, ghost nodes for functions that no longer exist, an overlay of
// edges independent of bundling, folder expansion, and hiding the chrome.
// The graph keeps working underneath (hover card, click, expand). Every call
// is safe before the first graph (queued until ready), unknown ids are
// ignored, nothing throws. Under prefers-reduced-motion the camera cuts and
// pulses are off.
//
// createStageApi(env) takes the stage globals it uses, so tests drive it in
// jsdom with a scripted state; the boot at the end hands in the real ones.

const STAGE_API_VERSION = 1;
const STAGE_DIM = 0.25;
const STAGE_MAX_SCALE = 2.5;
const STAGE_PARSE_WAIT_MS = 15000;
/** Longer than frameRender's 200 ms frame-move glide. */
const STAGE_SETTLE_MS = 250;
const STAGE_SETTLE_CAP_MS = 3000;

const STAGE_CSS = `
  .stage-spot > g:not(.stage-overlay) :is(circle, path, text, line, rect, polygon):not(.stage-lit) { opacity: ${STAGE_DIM} !important; }
  .stage-overlay { pointer-events: none; }
  .stage-overlay .stage-edge { fill: none; stroke-width: 2.5; vector-effect: non-scaling-stroke; }
  .stage-overlay .stage-edge.added { stroke: var(--vscode-gitDecoration-addedResourceForeground, #4caf50); }
  .stage-overlay .stage-edge.removed { stroke: var(--vscode-gitDecoration-deletedResourceForeground, #e5534b); stroke-dasharray: 6 4; }
  .stage-overlay .stage-edge.path { stroke: var(--vscode-focusBorder, #3794ff); }
  .stage-overlay .stage-ghost circle { fill: none; stroke: var(--vscode-descriptionForeground, #999); stroke-width: 1.5; stroke-dasharray: 4 3; }
  .stage-overlay .stage-ghost text { fill: var(--vscode-descriptionForeground, #999); font-size: 10px; text-anchor: middle; }
  .stage-overlay .stage-pulse { fill: none; stroke: var(--vscode-focusBorder, #3794ff); stroke-width: 3; transform-box: fill-box; transform-origin: center; animation: stage-pulse 1.2s ease-out 1 forwards; }
  @keyframes stage-pulse { from { transform: scale(1); opacity: 0.9; } to { transform: scale(2.6); opacity: 0; } }
  body.stage-chrome-off #top-left-controls, body.stage-chrome-off #pr-view-banner,
  body.stage-chrome-off #settings-btn, body.stage-chrome-off #settings-panel, body.stage-chrome-off #tour-pill { display: none !important; }
`;

const STAGE_SVG_NS = 'http://www.w3.org/2000/svg';

/** POSIX-ish join that keeps the root's own separator style. */
function stageJoin(root, rel) {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
}

function stageDirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i) : '';
}

function stageIsAbs(p) {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function stageEndId(e) { return (e !== null && typeof e === 'object') ? e.id : e; }

function stageKindOf(n) {
  if (n.isFolderCluster) { return 'folder'; }
  if (n.isFileCluster) { return 'file'; }
  return 'function';
}

/**
 * Camera transform that puts the box in the middle of the viewport's visible
 * part (the viewport minus the insets the tour layer covers) at the largest
 * scale that fits it with `padding`, capped like the stage's own fit.
 */
function stageFitTransform(box, view, opts, fitScaleFn) {
  const inset = opts.inset || {};
  const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
  const l = num(inset.left), r = num(inset.right), t = num(inset.top), b = num(inset.bottom);
  const availW = Math.max(40, view.w - l - r);
  const availH = Math.max(40, view.h - t - b);
  const pad = typeof opts.padding === 'number' ? Math.max(0, opts.padding) : 80;
  const bw = box.maxX - box.minX, bh = box.maxY - box.minY;
  let k = fitScaleFn
    ? fitScaleFn(bw, bh, availW, availH, box.maxR || 0, Math.min(pad, Math.min(availW, availH) / 2 - 10))
    : Math.min((availW - 2 * pad) / (bw || 1), (availH - 2 * pad) / (bh || 1), 4);
  k = Math.max(0.02, Math.min(STAGE_MAX_SCALE, isFinite(k) && k > 0 ? k : 1));
  const cx = l + availW / 2, cy = t + availH / 2;
  return { x: cx - k * (box.minX + box.maxX) / 2, y: cy - k * (box.minY + box.maxY) / 2, k };
}

function createStageApi(env) {
  const listeners = { ready: new Set(), 'node-click': new Set(), graph: new Set() };
  const look = { spot: null, spotEdges: true, pulse: null, ghosts: [], edges: [] };
  const ghostPos = new Map();
  const queue = [];
  let isReady = false;
  let readyResolve;
  const readyPromise = new Promise((res) => { readyResolve = res; });
  const overlay = env.overlay;
  const log = (msg) => { try { env.log && env.log(msg); } catch { /* nowhere to report */ } };

  function emit(event, payload) {
    for (const fn of [...listeners[event]]) {
      try { fn(payload); } catch (err) { log(`stageApi ${event} listener: ${err && err.message}`); }
    }
  }

  // ── Lookup ──────────────────────────────────────────────────────────────────
  const state = () => env.state;
  const current = () => state().currentNodes || [];
  const byId = () => { const m = new Map(); for (const n of current()) { m.set(n.id, n); } return m; };
  const allFunctions = () => (state().graphData && state().graphData.nodes) || [];
  const stageRoot = () => (env.stageRoot && env.stageRoot()) || (state().structureTree && state().structureTree.root) || '';

  function toAbs(file) {
    if (!file || typeof file !== 'string') { return null; }
    if (stageIsAbs(file)) { return file; }
    const root = stageRoot();
    return root ? stageJoin(root, file.replace(/^\.\//, '')) : null;
  }
  const samePath = (a, b) => a && b && a.replace(/\\/g, '/') === b.replace(/\\/g, '/');

  /** A node that is on screen for an id: itself, or whichever skeleton node represents it now. */
  function shown(id) {
    const map = byId();
    if (map.has(id)) { return map.get(id); }
    const st = state();
    const fn = allFunctions().find((n) => n.id === id);
    if (fn && env.visibleNodeIdOf && st.structureTree) {
      const vis = env.visibleNodeIdOf(fn, st.expandedFolders || new Set(), st.parsedFolders || new Set(), st.structureTree);
      if (vis && map.has(vis)) { return map.get(vis); }
    }
    return null;
  }

  function folderFrame(path) {
    const fs = state().frames;
    return fs && fs.byPath && fs.byPath.get(path) || null;
  }

  /** Graph-space box of one id (node ± radius, a folder's frame, a ghost); null when unknown. */
  function boxOf(id) {
    if (ghostPos.has(id)) { const p = ghostPos.get(id); return { minX: p.x - 8, minY: p.y - 8, maxX: p.x + 8, maxY: p.y + 8, maxR: 8 }; }
    if (typeof id === 'string' && id.startsWith('folder::')) {
      const f = folderFrame(id.slice(8));
      if (f && f.abs && f.abs.w > 0) { return { minX: f.abs.x, minY: f.abs.y, maxX: f.abs.x + f.abs.w, maxY: f.abs.y + f.abs.h, maxR: 0 }; }
    }
    const n = shown(id);
    if (!n || !isFinite(n.x) || !isFinite(n.y)) { return null; }
    const r = env.nodeRadius ? env.nodeRadius(n) : 6;
    return { minX: n.x - r, minY: n.y - r, maxX: n.x + r, maxY: n.y + r, maxR: r };
  }

  function union(boxes) {
    return boxes.reduce((a, b) => ({
      minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
      maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), maxR: Math.max(a.maxR, b.maxR),
    }));
  }

  // ── Camera ──────────────────────────────────────────────────────────────────
  function moveTo(box, opts) {
    const t = stageFitTransform(box, env.viewport(), opts || {}, env.fitScale);
    const ms = env.reducedMotion() ? 0 : (typeof (opts || {}).ms === 'number' ? Math.max(0, opts.ms) : 600);
    // The tour owns the viewport now: the stage's automatic re-fit must not take it back.
    state().userZoomed = true;
    env.applyTransform(t, ms);
    return new Promise((res) => { if (ms > 0) { env.setTimeout(res, ms + 20); } else { res(); } });
  }

  function fit(ids, opts) {
    const boxes = (Array.isArray(ids) ? ids : []).map(boxOf).filter(Boolean);
    return boxes.length ? moveTo(union(boxes), opts) : Promise.resolve();
  }

  function fitAll(opts) {
    const fs = state().frames;
    if (fs && env.usesFrames && env.usesFrames() && env.frameBounds) {
      const b = env.frameBounds(fs);
      if (b && b.w > 0) { return moveTo({ minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h, maxR: 0 }, { padding: 40, ...(opts || {}) }); }
    }
    const boxes = current().filter((n) => !n.isLibrary).map((n) => boxOf(n.id)).filter(Boolean);
    return boxes.length ? moveTo(union(boxes), { padding: 40, ...(opts || {}) }) : Promise.resolve();
  }

  // ── Spotlight ───────────────────────────────────────────────────────────────
  function litIds() {
    const out = new Set();
    for (const id of look.spot || []) {
      const n = shown(id);
      if (n) { out.add(n.id); }
      if (typeof id === 'string' && id.startsWith('folder::')) {
        const dir = id.slice(8);
        for (const m of current()) {
          const p = m.file || m._filePath || m._folderPath;
          if (p && (samePath(p, dir) || p.replace(/\\/g, '/').startsWith(dir.replace(/\\/g, '/') + '/'))) { out.add(m.id); }
        }
      }
    }
    return out;
  }

  function applySpotlight() {
    const root = env.root();
    if (!root) { return; }
    for (const el of root.querySelectorAll('.stage-lit')) { el.classList.remove('stage-lit'); }
    root.classList.toggle('stage-spot', !!look.spot);
    if (!look.spot) { return; }
    const lit = litIds();
    for (const sel of env.selections()) {
      for (const el of sel.nodes()) {
        const d = el && el.__data__;
        if (!d) { continue; }
        const on = d.source !== undefined
          ? look.spotEdges && (lit.has(stageEndId(d.source)) || lit.has(stageEndId(d.target)))
          : lit.has(d.id);
        if (on) { el.classList.add('stage-lit'); }
      }
    }
  }

  function spotlight(ids, opts) {
    look.spot = Array.isArray(ids) && ids.length ? ids.slice() : null;
    look.spotEdges = !(opts && opts.edges === false);
    applySpotlight();
  }

  // ── Overlay: ghosts, edges, pulse ───────────────────────────────────────────
  function svgEl(tag, attrs, parent) {
    const el = env.doc.createElementNS(STAGE_SVG_NS, tag);
    for (const k in attrs) { el.setAttribute(k, String(attrs[k])); }
    parent.appendChild(el);
    return el;
  }

  /** Where a ghost goes: its file's slot (bottom row), or the margin of the nearest open folder's frame. */
  function ghostSpot(g, i) {
    const file = toAbs(g.file);
    const fs = state().frames;
    if (file && fs && fs.byPath && env.innerOrigin) {
      const f = fs.byPath.get(stageDirname(file));
      const slot = f && f.slots && f.slots.get('file:' + file);
      if (f && slot) {
        const o = env.innerOrigin(f);
        const x0 = o.x + f.contentPos.x + slot.x, y0 = o.y + f.contentPos.y + slot.y;
        return { x: x0 + 14 + (i % 6) * 22, y: y0 + slot.h - 12 - Math.floor(i / 6) * 22 };
      }
      for (let dir = file && stageDirname(file); dir; dir = stageDirname(dir)) {
        const frame = fs.byPath.get(dir);
        if (frame && frame.abs) { return { x: frame.abs.x + 20 + (i % 10) * 22, y: frame.abs.y + frame.abs.h - 14 - Math.floor(i / 10) * 22 }; }
      }
    }
    // No frames (Global engine): beside the callers that still exist, else beside the file's functions.
    const near = (g.callers || []).map(boxOf).filter(Boolean);
    const sameFile = near.length ? near : current().filter((n) => samePath(n.file, file)).map((n) => boxOf(n.id)).filter(Boolean);
    if (!sameFile.length) { return null; }
    const b = union(sameFile);
    return { x: b.maxX + 30, y: (b.minY + b.maxY) / 2 + i * 22 };
  }

  function centre(id) {
    if (ghostPos.has(id)) { return ghostPos.get(id); }
    const b = boxOf(id);
    return b ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : null;
  }

  /** Ghosts and edges are redrawn whole; the pulse ring is one element that only moves (its animation runs once). */
  let pulseEl = null;
  function drawOverlay() {
    if (!overlay) { return; }
    for (const el of [...overlay.childNodes]) { if (el !== pulseEl) { overlay.removeChild(el); } }
    ghostPos.clear();
    look.ghosts.forEach((g, i) => {
      if (!g || typeof g.id !== 'string') { return; }
      const p = ghostSpot(g, i);
      if (!p) { return; }
      ghostPos.set(g.id, p);
      const grp = svgEl('g', { class: 'stage-ghost', 'data-id': g.id }, overlay);
      svgEl('circle', { cx: p.x, cy: p.y, r: 7 }, grp);
      svgEl('text', { x: p.x, y: p.y + 20 }, grp).textContent = String(g.name || '');
      for (const c of g.callers || []) {
        const q = centre(c);
        if (q) { svgEl('line', { class: 'stage-edge removed', x1: q.x, y1: q.y, x2: p.x, y2: p.y }, overlay); }
      }
    });
    for (const e of look.edges) {
      const a = e && centre(e.source), b = e && centre(e.target);
      if (!a || !b) { continue; }
      const kind = ['added', 'removed', 'path'].includes(e.kind) ? e.kind : 'path';
      svgEl('line', { class: 'stage-edge ' + kind, x1: a.x, y1: a.y, x2: b.x, y2: b.y }, overlay);
    }
    const c = pulseEl && look.pulse && centre(look.pulse);
    if (c) { pulseEl.setAttribute('cx', String(c.x)); pulseEl.setAttribute('cy', String(c.y)); }
  }

  function startPulse() {
    if (pulseEl && pulseEl.parentNode) { pulseEl.parentNode.removeChild(pulseEl); }
    pulseEl = null;
    const c = look.pulse && centre(look.pulse);
    if (!overlay || !c || env.reducedMotion()) { return; }
    const el = svgEl('circle', { class: 'stage-pulse', cx: c.x, cy: c.y, r: 12 }, overlay);
    pulseEl = el;
    // One ring: gone when its animation has run.
    env.setTimeout(() => { if (pulseEl === el) { el.remove(); pulseEl = null; } }, 1300);
  }

  /** Nodes keep moving in a dynamic layout: while something is drawn, follow them. */
  let tracking = false;
  function track() {
    const busy = look.ghosts.length || look.edges.length || pulseEl;
    if (!busy) { tracking = false; return; }
    drawOverlay();
    env.setTimeout(track, 250);
  }
  function startTracking() { if (!tracking) { tracking = true; env.setTimeout(track, 250); } }

  function ghost(list) { look.ghosts = Array.isArray(list) ? list.filter(Boolean) : []; drawOverlay(); startTracking(); }
  function edges(list) { look.edges = Array.isArray(list) ? list.filter(Boolean) : []; drawOverlay(); startTracking(); }
  function pulse(id) { look.pulse = typeof id === 'string' ? id : null; startPulse(); startTracking(); }

  // ── Expansion and chrome ────────────────────────────────────────────────────
  function expand(folderPaths) {
    const st = state();
    const tree = st.structureTree;
    if (!tree || !tree.folders || !Array.isArray(folderPaths)) { return Promise.resolve(); }
    const wanted = new Set();
    for (const p of folderPaths) {
      for (let cur = p; cur && tree.folders[cur]; cur = tree.folders[cur].parent) { wanted.add(cur); }
    }
    const added = [...wanted].filter((p) => !st.expandedFolders.has(p));
    if (!added.length) { return Promise.resolve(); }
    for (const p of added) { st.expandedFolders.add(p); }
    // Folders that have never been parsed ask the host (expand-folder), as a click does.
    if (env.requestParseForExpanded) { env.requestParseForExpanded(); }
    if (env.applyFileClusters) { env.applyFileClusters(); }
    const deadline = env.now() + STAGE_PARSE_WAIT_MS;
    return new Promise((res) => {
      const check = () => {
        const pending = added.some((p) => st.parsingFolders && st.parsingFolders.has(p));
        if (!pending || env.now() >= deadline) { res(); return; }
        env.setTimeout(check, 100);
      };
      check();
    });
  }

  function chrome(visible) {
    env.doc.body.classList.toggle('stage-chrome-off', visible === false);
  }

  function theme() {
    const t = env.pageTheme && env.pageTheme();
    if (t === 'light' || t === 'dark') { return t; }
    const b = env.doc.body.classList;
    return b.contains('vscode-light') || b.contains('vscode-high-contrast-light') ? 'light' : 'dark';
  }

  // ── Nodes and resolve ───────────────────────────────────────────────────────
  function nodes() {
    const status = state().fileGitStatus || {};
    return current().filter((n) => !n.isLibrary && !n.isSynthetic && !n.isFileAnchor).map((n) => {
      const file = n.file || n._filePath || n._folderPath || null;
      return {
        // Render nodes carry the display name as `label`; graph nodes as `name`.
        id: n.id, kind: stageKindOf(n), name: n.name || n.label || '', file, line: n.line || 0, className: n.className || null,
        gitStatus: n.gitStatus || (file && status[file]) || null,
      };
    });
  }

  function resolve(q) {
    if (!q || typeof q !== 'object') { return null; }
    const file = toAbs(q.file);
    if (!file) { return null; }
    if (!q.name) { return current().some((n) => n.id === 'file::' + file) || allFunctions().some((n) => samePath(n.file, file)) ? 'file::' + file : null; }
    const named = allFunctions().filter((n) => !n.isLibrary && samePath(n.file, file)
      && (n.name === q.name || (n.className && `${n.className}.${n.name}` === q.name)));
    if (!named.length) { return null; }
    if (typeof q.line !== 'number') { return named[0].id; }
    return named.reduce((best, n) => (Math.abs(n.line - q.line) < Math.abs(best.line - q.line) ? n : best)).id;
  }

  // ── Ready, events, queue ────────────────────────────────────────────────────
  function becomeReady() {
    if (isReady) { return; }
    isReady = true;
    for (const job of queue.splice(0)) { job(); }
    readyResolve();
    emit('ready', undefined);
  }

  /**
   * Laid out: the first fit ran and the stage has been quiet (no re-render) for STAGE_SETTLE_MS:
   * the frames' glide is over and the first patches have been packed. A stage that keeps
   * re-rendering is declared ready after STAGE_SETTLE_CAP_MS all the same.
   */
  let settleSince = null;
  let settleGen = 0;
  function checkReady() {
    if (isReady || !state().hasFitted || current().length === 0) { return isReady; }
    const now = env.now();
    if (settleSince === null) { settleSince = now; }
    const gen = ++settleGen;
    const wait = Math.max(0, Math.min(STAGE_SETTLE_MS, settleSince + STAGE_SETTLE_CAP_MS - now));
    env.setTimeout(() => { if (gen === settleGen || env.now() >= settleSince + STAGE_SETTLE_CAP_MS) { becomeReady(); } }, wait);
    return isReady;
  }

  /** After every re-render the selections are new elements: re-apply the look. */
  function refresh() {
    if (!isReady) { checkReady(); return; }
    applySpotlight();
    drawOverlay();
  }

  function onGraph() {
    if (!checkReady()) { return; }
    refresh();
    emit('graph', undefined);
  }

  function onClick(event) {
    let t = event.target;
    while (t && t !== env.doc && !(t.__data__ && t.__data__.id !== undefined)) { t = t.parentNode; }
    const d = t && t.__data__;
    if (d && typeof d.id === 'string') { emit('node-click', { id: d.id }); }
  }

  /** Before ready: run later, resolve then. Never throws. */
  function guarded(name, fn, asPromise) {
    return function (...args) {
      const run = () => { try { return fn(...args); } catch (err) { log(`stageApi.${name}: ${err && err.message}`); return asPromise ? Promise.resolve() : undefined; } };
      if (isReady || name === 'chrome' || name === 'theme' || name === 'nodes' || name === 'resolve') { return run(); }
      if (!asPromise) { queue.push(run); return undefined; }
      return new Promise((res) => { queue.push(() => { Promise.resolve(run()).then(res, res); }); });
    };
  }

  function on(event, fn) {
    if (!listeners[event] || typeof fn !== 'function') { return () => undefined; }
    listeners[event].add(fn);
    if (event === 'ready' && isReady) { env.setTimeout(() => fn(undefined), 0); }
    return () => listeners[event].delete(fn);
  }

  const api = {
    version: STAGE_API_VERSION,
    ready: () => readyPromise,
    nodes: guarded('nodes', nodes, false),
    resolve: guarded('resolve', resolve, false),
    fit: guarded('fit', fit, true),
    fitAll: guarded('fitAll', fitAll, true),
    spotlight: guarded('spotlight', spotlight, false),
    pulse: guarded('pulse', pulse, false),
    ghost: guarded('ghost', ghost, false),
    edges: guarded('edges', edges, false),
    expand: guarded('expand', expand, true),
    chrome: guarded('chrome', chrome, false),
    theme: guarded('theme', theme, false),
    on,
  };
  return { api, onGraph, onClick, refresh, checkReady };
}

// ── Boot (graph webview and browser stage) ────────────────────────────────────
/* global svg, g, zoomBehavior, d3, state, nodeRadius, fitScale, usesFrames, frameBounds, innerOrigin,
   visibleNodeIdOf, requestParseForExpanded, applyFileClusters, vscode */
function bootStageApi(win) {
  const doc = win.document;
  if (!doc.getElementById('stage-api-style')) {
    const style = doc.createElement('style');
    style.id = 'stage-api-style';
    style.textContent = STAGE_CSS;
    doc.head.appendChild(style);
  }
  const overlay = g.append('g').attr('class', 'stage-overlay').node();
  const motion = win.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const stage = createStageApi({
    doc, state, overlay,
    root: () => g.node(),
    selections: () => [state.svgNodes, state.svgCloudNodes, state.svgLabels, state.svgLinks, state.svgLibNodes].filter(Boolean),
    viewport: () => { const el = svg.node(); return { w: el.clientWidth || win.innerWidth, h: el.clientHeight || win.innerHeight }; },
    applyTransform: (t, ms) => {
      const target = d3.zoomIdentity.translate(t.x, t.y).scale(t.k);
      if (ms > 0) { svg.transition().duration(ms).ease(d3.easeCubicInOut).call(zoomBehavior.transform, target); }
      else { svg.interrupt().call(zoomBehavior.transform, target); }
    },
    reducedMotion: () => !!(motion && motion.matches),
    nodeRadius, fitScale: typeof fitScale === 'function' ? fitScale : null,
    usesFrames: typeof usesFrames === 'function' ? usesFrames : null,
    frameBounds: typeof frameBounds === 'function' ? frameBounds : null,
    innerOrigin: typeof innerOrigin === 'function' ? innerOrigin : null,
    visibleNodeIdOf: typeof visibleNodeIdOf === 'function' ? visibleNodeIdOf : null,
    requestParseForExpanded: typeof requestParseForExpanded === 'function' ? requestParseForExpanded : null,
    applyFileClusters: typeof applyFileClusters === 'function' ? applyFileClusters : null,
    stageRoot: () => (win.COGRAPH_TOUR && win.COGRAPH_TOUR.stageRoot) || null,
    pageTheme: () => (win.COGRAPH_TOUR && win.COGRAPH_TOUR.theme) || null,
    setTimeout: (fn, ms) => win.setTimeout(fn, ms),
    now: () => Date.now(),
    log: (msg) => { if (typeof vscode !== 'undefined') { vscode.postMessage({ type: 'webview-log', entry: { level: 'warn', msg } }); } },
  });
  // After main.js's own handler (registered earlier): the graph is already in state.
  win.addEventListener('message', (event) => {
    const t = event.data && event.data.type;
    if (t === 'graph' || t === 'graph-patch' || t === 'structure') { win.setTimeout(stage.onGraph, 0); }
  });
  svg.node().addEventListener('click', stage.onClick, true);
  // Layout is asynchronous (fit after settle, worker sims): watch for the first fit, then for re-renders.
  let pending = false;
  const overlayNode = overlay;
  new win.MutationObserver((records) => {
    // The overlay's own redraws are not a re-render of the graph.
    if (pending || records.every((r) => overlayNode.contains(r.target))) { return; }
    pending = true;
    win.requestAnimationFrame(() => { pending = false; stage.refresh(); });
  }).observe(g.node(), { childList: true, subtree: true });
  win.stageApi = stage.api;
}

if (typeof window !== 'undefined' && typeof svg !== 'undefined' && typeof g !== 'undefined' && typeof state !== 'undefined') {
  bootStageApi(window);
}

if (typeof module !== 'undefined') {
  module.exports = { createStageApi, stageFitTransform, stageJoin, stageDirname, STAGE_API_VERSION, STAGE_CSS };
}
