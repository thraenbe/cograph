// pinnedCards.js — pinned function cards (Bela, 2026-11-10). Following a line to its other
// end ended the hover, the lines vanished and the partner was hard to find. A click on a
// function now keeps the card hover shows (funcCard.js content), with three buttons: close,
// open function (the source popup a click opened before) and open file (the editor at the
// function's line, like the popup's "Open File"). Several functions can be pinned at once.
//
// Decisions (PR body, P1-P5): a pinned function keeps the hover focus (rendering.js reads
// state.pinnedFns: lines lifted, callers/callees full, the rest dimmed; several pins = union).
// Cards sit next to their node and follow pan, zoom and simulation through one
// requestAnimationFrame loop that runs only while something is pinned; they never cover
// their own node, stay inside the canvas and clear of the panels, and a later card moves
// off an earlier one. Cards take no pointer except on their buttons. The node wears a ring
// (.cg-pinned). Close, a second click on the node, or Escape unpin; a re-render keeps pins
// whose node still exists. Pins live in this webview only (not saved across sessions).
//
// Repository text goes in through hcFill (textContent). Globals used in the webview:
// state, settings, vscode, showFuncPopup, fnNameOn, hcBuildElement, hcFill, hcRelPath,
// fcContent, fcCallIndex, fcNameOf, fcHiddenText, fcIsFunctionNode, FN_PEEK_LINES.

const PC_GAP = 10;          // px between a node's rim and its card
const PC_MARGIN = 8;        // px kept free at the canvas edge
const PC_STACK_GAP = 6;     // px between two cards
const PC_HEAD = 16;         // px from a card's top to the middle of its name row
const PC_CASCADE = 24;      // px per card when nothing is free (fallback)
const PC_REQUERY_MS = 400;  // a pin whose node element left the DOM looks again at most this often
const PC_MAX_LINES = 40;    // lines per pinned function a card keeps clear of
// Fixed chrome over the canvas: a card never sits under it (its buttons would be unreachable).
const PC_CHROME = ['#top-left-controls', '#settings-panel', '#settings-btn'];

// ── Pin set (pure) ───────────────────────────────────────────────────────────
/** Pinned function ids in pin order (= placement order). `ids` is the live Set (state.pinnedFns). */
function createPinSet() {
  const ids = new Set();
  return {
    ids,
    has: (id) => ids.has(id),
    /** True when newly pinned. */
    add(id) { if (ids.has(id)) { return false; } ids.add(id); return true; },
    remove: (id) => ids.delete(id),
    /** Pinned afterwards? */
    toggle(id) { if (ids.delete(id)) { return false; } ids.add(id); return true; },
    /** True when anything was pinned. */
    clear() { const had = ids.size > 0; ids.clear(); return had; },
    /** Keep the ids `alive(id)` accepts; returns the dropped ones. */
    retain(alive) {
      const dropped = [];
      for (const id of [...ids]) { if (!alive(id)) { ids.delete(id); dropped.push(id); } }
      return dropped;
    },
  };
}

// ── Click trail (pure, Bela 2026-11-12) ─────────────────────────────────────
// "Every time I click a new node make sure that the connections from the older clicked nodes
// fade a bit." The pin order is the trail: the newest pin's lines are full, each older pin's a
// step fainter, down to a floor that stays above the dimmed rest (0.15 lines, 0.2 nodes).
// Unpinning closes the trail up; a line of two pins takes the stronger; the hovered function's
// lines are full (hoverIndex.js / crossLinks.js read the weights, styles.css --cg-tr-o).
const PC_TRAIL = [1, 0.7, 0.5, 0.35];   // by rank, 0 = newest pin
const PC_TRAIL_FLOOR = 0.3;             // rank 4 and older

/** Line strength of a pin `rank` steps older than the newest (0 = newest). */
function pcTrailOpacity(rank) {
  return rank < PC_TRAIL.length ? PC_TRAIL[Math.max(0, rank)] : PC_TRAIL_FLOOR;
}

/** id → line strength for the pins (pin order, newest last) and the hovered id (full). */
function pcTrailWeights(pinIds, hoverId) {
  const ids = [...(pinIds || [])];
  const w = new Map();
  ids.forEach((id, i) => w.set(id, pcTrailOpacity(ids.length - 1 - i)));
  if (hoverId != null) { w.set(hoverId, 1); }
  return w;
}

// ── Placement (pure) ─────────────────────────────────────────────────────────
function pcRect(left, top, w, h) { return { left, top, right: left + w, bottom: top + h }; }
function pcOverlap(a, b) { return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }

/** Does the segment (x1,y1)-(x2,y2) cross the rect? (Liang-Barsky clip) */
function pcSegHitsRect(sg, r) {
  let t0 = 0, t1 = 1;
  const dx = sg.x2 - sg.x1, dy = sg.y2 - sg.y1;
  const edges = [[-dx, sg.x1 - r.left], [dx, r.right - sg.x1], [-dy, sg.y1 - r.top], [dy, r.bottom - sg.y1]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) { return false; } continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) { return false; } if (t > t0) { t0 = t; } }
    else { if (t < t0) { return false; } if (t < t1) { t1 = t; } }
  }
  return true;
}

/**
 * Top-left of a w×h card for a node at (x, y) with on-screen radius r, inside `canvas`,
 * clear of the node and of `obstacles` (rects: other pinned nodes, earlier cards, chrome).
 * Tried in order: right of the node, left, below, above; on each side level with the node
 * first, then slid past each obstacle (nearest first). `lines` (screen segments: the node's
 * own calls) are kept clear too when any place allows it — they are what the pin is for.
 * Nothing free: right of the node, cascaded by `index`, kept inside the canvas.
 */
function pcPlace(node, size, canvas, obstacles, index = 0, lines = []) {
  if (lines.length) {
    const p = pcPlaceOnce(node, size, canvas, obstacles, lines);
    if (p) { return p; }
  }
  return pcPlaceOnce(node, size, canvas, obstacles, []) || pcFallback(node, size, canvas, index);
}

function pcFallback(node, size, canvas, index) {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const minL = canvas.left + PC_MARGIN, maxL = canvas.right - PC_MARGIN - size.w;
  const minT = canvas.top + PC_MARGIN, maxT = canvas.bottom - PC_MARGIN - size.h;
  return {
    left: Math.round(clamp(node.x + node.r + PC_GAP, minL, Math.max(minL, maxL))),
    top: Math.round(clamp(node.y - PC_HEAD + index * PC_CASCADE, minT, Math.max(minT, maxT))),
  };
}

function pcPlaceOnce(node, size, canvas, obstacles, lines) {
  const { x, y, r } = node;
  const { w, h } = size;
  const minL = canvas.left + PC_MARGIN, maxL = canvas.right - PC_MARGIN - w;
  const minT = canvas.top + PC_MARGIN, maxT = canvas.bottom - PC_MARGIN - h;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const own = { left: x - r, top: y - r, right: x + r, bottom: y + r };
  const fits = (l, t) => {
    if (l < minL - 0.5 || l > maxL + 0.5 || t < minT - 0.5 || t > maxT + 0.5) { return false; }
    const c = pcRect(l, t, w, h);
    return !pcOverlap(c, own) && !obstacles.some(o => pcOverlap(c, o)) && !lines.some(sg => pcSegHitsRect(sg, c));
  };
  const out = (l, t) => ({ left: Math.round(l), top: Math.round(t) });
  const sides = [
    { l: x + r + PC_GAP, t: y - PC_HEAD, vertical: true },
    { l: x - r - PC_GAP - w, t: y - PC_HEAD, vertical: true },
    { l: x - w / 2, t: y + r + PC_GAP, vertical: false },
    { l: x - w / 2, t: y - r - PC_GAP - h, vertical: false },
  ];
  for (const s of sides) {
    const base = s.vertical ? clamp(s.t, minT, maxT) : clamp(s.l, minL, maxL);
    const tries = [base];
    for (const o of obstacles) {
      if (s.vertical) { tries.push(o.bottom + PC_STACK_GAP, o.top - PC_STACK_GAP - h); }
      else { tries.push(o.right + PC_STACK_GAP, o.left - PC_STACK_GAP - w); }
    }
    tries.sort((a, b) => Math.abs(a - base) - Math.abs(b - base));
    for (const v of tries) {
      const l = s.vertical ? s.l : v, t = s.vertical ? v : s.t;
      if (fits(l, t)) { return out(l, t); }
    }
  }
  return null;
}

/** A short line from the node's rim to the nearest point of its card, or null when they touch. */
function pcLeader(node, card) {
  const px = Math.max(card.left, Math.min(card.right, node.x));
  const py = Math.max(card.top, Math.min(card.bottom, node.y));
  const dx = px - node.x, dy = py - node.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const start = node.r + 2;
  if (dist <= start + PC_GAP) { return null; }
  return { x1: node.x + dx / dist * start, y1: node.y + dy / dist * start, x2: px, y2: py };
}

// ── Messages (pure) ──────────────────────────────────────────────────────────
/** "Open file": the editor at the function's line, as the popup's Open File does. */
function pcOpenFileMessage(d) { return { type: 'navigate', file: d.file, line: d.line }; }

// ── Cards ────────────────────────────────────────────────────────────────────
function pcButton(doc, cls, text, label) {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
}

/**
 * Wire pinned cards to a document. env = { doc, win, root (#graph), getState, post,
 * openFunction(d), focusChanged(), nameOn?(id, on), sameFileOnly?() } — tests inject jsdom.
 */
function createPinnedCards(env) {
  const doc = env.doc, win = env.win;
  const pins = createPinSet();
  const recs = new Map();          // id → { node, card, parts, el, elAt, size, pos }
  const briefs = new Map();        // id → func-source reply (until the next graph / graph-patch)
  const briefReqs = new Map();     // reqId → id
  let wsRoot = '', callIdx = null, nameOf = null, seq = 0, raf = 0, lastScan = 0;
  const st0 = env.getState();
  if (st0) { st0.pinnedFns = pins.ids; }

  const svgNs = 'http://www.w3.org/2000/svg';
  const leaders = doc.createElementNS(svgNs, 'svg');
  leaders.setAttribute('class', 'pc-leaders');
  leaders.setAttribute('aria-hidden', 'true');
  doc.body.appendChild(leaders);

  function content(rec) {
    const st = env.getState();
    if (!callIdx) { callIdx = fcCallIndex(st && st.graphData); nameOf = fcNameOf(st && st.graphData); }
    const d = rec.node;
    const c = fcContent(d, briefs.get(d.id) || null, hcRelPath(wsRoot, d.file), callIdx, nameOf, FC_MORE_PINNED);
    c.file = d.file;
    c.hidden = fcHiddenText(d.id, st && st.xfileCue, env.sameFileOnly ? env.sameFileOnly() : false);
    return c;
  }

  function fill(rec) {
    hcFill(doc, rec.parts, content(rec));
    const name = rec.node.name || rec.node.label || String(rec.node.id);
    rec.card.setAttribute('aria-label', 'Pinned card: ' + name);
    for (const b of rec.buttons) { b.setAttribute('aria-label', b.dataset.verb + ' ' + name); b.title = b.dataset.verb + ' ' + name; }
    rec.size = null;               // measured again in the next layout pass
  }

  function requestBrief(d) {
    if (briefs.has(d.id) || [...briefReqs.values()].includes(d.id)) { return; }
    const reqId = 'pc-' + (++seq);
    briefReqs.set(reqId, d.id);
    env.post({ type: 'get-func-source', file: d.file, line: d.line, maxLines: FN_PEEK_LINES, reqId });
  }

  function build(d) {
    const { card, parts } = hcBuildElement(doc);
    card.className = 'hover-card hc-function pinned-card visible';
    card.setAttribute('role', 'group');
    const close = pcButton(doc, 'pc-close', '✕', 'Unpin');
    close.dataset.verb = 'Unpin';
    parts.name.parentNode.appendChild(close);
    const openFn = pcButton(doc, 'pc-open-fn', 'Open function', 'Open function');
    openFn.dataset.verb = 'Open function';
    const openFile = pcButton(doc, 'pc-open-file', 'Open file', 'Open file');
    openFile.dataset.verb = 'Open file';
    const actions = doc.createElement('div');
    actions.className = 'pc-actions';
    actions.append(openFn, openFile);
    card.appendChild(actions);
    const rec = { node: d, card, parts, buttons: [close, openFn, openFile], el: null, elAt: 0, size: null, pos: null, line: null };
    const id = d.id;
    close.addEventListener('click', (e) => { e.stopPropagation(); unpin(id); });
    openFn.addEventListener('click', (e) => { e.stopPropagation(); const r = recs.get(id); if (r) { env.openFunction(r.node); } });
    openFile.addEventListener('click', (e) => { e.stopPropagation(); const r = recs.get(id); if (r) { env.post(pcOpenFileMessage(r.node)); } });
    rec.line = doc.createElementNS(svgNs, 'line');
    leaders.appendChild(rec.line);
    return rec;
  }

  function mark(rec, on) {
    if (rec.el) { rec.el.classList.toggle('cg-pinned', on); }
    if (env.nameOn) { env.nameOn(rec.node.id, on); }
  }

  /** One pass over the function circles finds every pinned node's element. */
  function scanEls() {
    lastScan = Date.now();
    const want = new Map();
    for (const [id, rec] of recs) { if (!rec.el || !rec.el.isConnected) { want.set(id, rec); } }
    if (!want.size) { return; }
    for (const el of env.root.querySelectorAll('circle.regular-node')) {
      const d = el.__data__;
      const rec = d && want.get(d.id);
      if (rec) { rec.el = el; el.classList.add('cg-pinned'); want.delete(d.id); if (!want.size) { break; } }
    }
  }

  function pin(d) {
    if (!pins.add(d.id)) { return; }
    const rec = build(d);
    recs.set(d.id, rec);
    fill(rec);
    requestBrief(d);
    scanEls();
    mark(rec, true);
    env.focusChanged();
    loop();
  }

  function drop(id) {
    const rec = recs.get(id);
    if (!rec) { return; }
    mark(rec, false);
    rec.card.remove();
    rec.line.remove();
    recs.delete(id);
  }

  function unpin(id) {
    if (!pins.remove(id)) { return false; }
    drop(id);
    env.focusChanged();
    return true;
  }

  function unpinAll() {
    const ids = [...pins.ids];
    if (!pins.clear()) { return false; }
    for (const id of ids) { drop(id); }
    env.focusChanged();
    return true;
  }

  /** Click on a function node. False = not a function card target (the caller falls back). */
  function toggle(d) {
    if (typeof fcIsFunctionNode === 'function' && !fcIsFunctionNode(d)) { return false; }
    if (pins.has(d.id)) { unpin(d.id); } else { pin(d); }
    return true;
  }

  /** After renderElements: keep pins whose node still exists (new objects), drop the rest silently. */
  function afterRender() {
    if (!pins.ids.size) { return; }
    const st = env.getState();
    const byId = new Map(((st && st.currentNodes) || []).map(n => [n.id, n]));
    for (const id of pins.retain(id => byId.has(id) && fcIsFunctionNode(byId.get(id)))) { drop(id); }
    for (const [id, rec] of recs) {
      const n = byId.get(id);
      const moved = n.line !== rec.node.line || n.file !== rec.node.file;
      rec.node = n;
      if (moved) {   // the peek of the old line is stale, and so is a reply still on its way
        briefs.delete(id);
        for (const [reqId, rid] of briefReqs) { if (rid === id) { briefReqs.delete(reqId); } }
      }
      if (rec.el && !rec.el.isConnected) { rec.el = null; }
      fill(rec);
      requestBrief(n);
    }
    // a join may have handed a pinned node a new element, or an old element to another node
    for (const el of env.root.querySelectorAll('circle.cg-pinned')) {
      const d = el.__data__;
      if (!d || !pins.has(d.id)) { el.classList.remove('cg-pinned'); }
    }
    for (const rec of recs.values()) { if (rec.el && rec.el.__data__ && rec.el.__data__.id !== rec.node.id) { rec.el = null; } }
    scanEls();
    for (const rec of recs.values()) { mark(rec, true); }
  }

  /** Node centre + radius on screen, or null when it is not drawn (filtered, culled or parked by the zoom level). */
  function nodeBox(rec) {
    if (!rec.el || !rec.el.isConnected) { return null; }
    const b = rec.el.getBoundingClientRect();
    if (!b.width && !b.height) { return null; }
    return { x: b.left + b.width / 2, y: b.top + b.height / 2, r: Math.max(b.width, b.height) / 2 };
  }

  function chromeRects() {
    const out = [];
    for (const sel of PC_CHROME) {
      const el = doc.querySelector(sel);
      if (!el) { continue; }
      const b = el.getBoundingClientRect();
      if (b.width && b.height) { out.push({ left: b.left, top: b.top, right: b.right, bottom: b.bottom }); }
    }
    return out;
  }

  /** A drawn line as a screen segment, or null (detached, hidden, no layout: jsdom). */
  function lineSeg(el) {
    if (!el || !el.isConnected || (el.style && el.style.display === 'none') || typeof el.getScreenCTM !== 'function') { return null; }
    const m = el.getScreenCTM();
    if (!m) { return null; }
    const at = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
    const a = at(+el.getAttribute('x1') || 0, +el.getAttribute('y1') || 0);
    const b = at(+el.getAttribute('x2') || 0, +el.getAttribute('y2') || 0);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }

  /** The pinned functions' own lines on screen; recomputed only when a pinned node moved. */
  let segKey = '', segs = [];
  function pinnedSegments(boxes) {
    if (!env.linesOf) { return []; }
    const key = [...boxes.values()].map(n => (n ? Math.round(n.x) + ',' + Math.round(n.y) + ',' + Math.round(n.r) : '-')).join(';');
    if (key === segKey) { return segs; }
    segKey = key;
    segs = [];
    for (const id of recs.keys()) {
      for (const el of env.linesOf(id).slice(0, PC_MAX_LINES)) { const sg = lineSeg(el); if (sg) { segs.push(sg); } }
    }
    return segs;
  }

  /** Place every card (pin order); write only what changed. */
  function layout() {
    if ([...recs.values()].some(r => !r.el || !r.el.isConnected) && Date.now() - lastScan > PC_REQUERY_MS) { scanEls(); }
    const c = env.root.getBoundingClientRect();
    const canvas = { left: c.left, top: c.top, right: c.right || win.innerWidth, bottom: c.bottom || win.innerHeight };
    const boxes = new Map();
    const obstacles = chromeRects();
    const inside = (n) => n && n.x >= canvas.left && n.x <= canvas.right && n.y >= canvas.top && n.y <= canvas.bottom;
    for (const [id, rec] of recs) {
      const n = nodeBox(rec);
      boxes.set(id, inside(n) ? n : null);   // off screen: the card waits (the pin and its focus stay)
      if (n) { obstacles.push({ left: n.x - n.r, top: n.y - n.r, right: n.x + n.r, bottom: n.y + n.r }); }
    }
    const lines = pinnedSegments(boxes);
    let i = 0;
    for (const [id, rec] of recs) {
      const n = boxes.get(id);
      if (!n) { rec.card.style.display = 'none'; rec.line.style.display = 'none'; rec.pos = null; continue; }
      if (rec.card.style.display === 'none') { rec.card.style.display = ''; rec.size = null; }
      if (!rec.size) { const b = rec.card.getBoundingClientRect(); rec.size = { w: b.width, h: b.height }; }
      const pos = pcPlace(n, rec.size, canvas, obstacles, i++, lines);
      if (!rec.pos || rec.pos.left !== pos.left || rec.pos.top !== pos.top) {
        rec.card.style.transform = 'translate(' + pos.left + 'px,' + pos.top + 'px)';
        rec.pos = pos;
      }
      const box = pcRect(pos.left, pos.top, rec.size.w, rec.size.h);
      obstacles.push(box);
      const l = pcLeader(n, box);
      rec.line.style.display = l ? '' : 'none';
      if (l) {
        rec.line.setAttribute('x1', l.x1.toFixed(1)); rec.line.setAttribute('y1', l.y1.toFixed(1));
        rec.line.setAttribute('x2', l.x2.toFixed(1)); rec.line.setAttribute('y2', l.y2.toFixed(1));
      }
    }
  }

  function loop() {
    if (raf || !recs.size) { return; }
    raf = win.requestAnimationFrame(function step() {
      raf = 0;
      if (!recs.size) { return; }
      layout();
      raf = win.requestAnimationFrame(step);
    });
  }

  function onMessage(event) {
    const m = event.data;
    if (!m) { return; }
    if (m.type === 'annotations') { wsRoot = m.root || ''; for (const rec of recs.values()) { fill(rec); } return; }
    if (m.type === 'graph' || m.type === 'graph-patch') {
      briefs.clear(); briefReqs.clear(); callIdx = null;
      for (const rec of recs.values()) { requestBrief(rec.node); }   // afterRender may have run already
      return;
    }
    if (m.type === 'func-source' && typeof m.reqId === 'string' && briefReqs.has(m.reqId)) {
      const id = briefReqs.get(m.reqId);
      briefReqs.delete(m.reqId);
      briefs.set(id, m);
      const rec = recs.get(id);
      if (rec) { fill(rec); }
    }
  }
  win.addEventListener('message', onMessage);

  return {
    pins, toggle, unpin, unpinAll, afterRender, layout,
    cardOf: (id) => (recs.get(id) || {}).card || null,
    destroy() {
      unpinAll();
      if (raf) { win.cancelAnimationFrame(raf); raf = 0; }
      win.removeEventListener('message', onMessage);
      leaders.remove();
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createPinSet, pcTrailOpacity, pcTrailWeights, PC_TRAIL, PC_TRAIL_FLOOR, pcPlace, pcLeader, pcOverlap, pcSegHitsRect, pcOpenFileMessage, createPinnedCards, PC_GAP, PC_MARGIN };
} else if (typeof document !== 'undefined' && document.getElementById('graph')) {
  const __pinned = createPinnedCards({
    doc: document,
    win: window,
    root: document.getElementById('graph'),
    getState: () => state,
    post: (m) => vscode.postMessage(m),
    openFunction: (d) => showFuncPopup(d),
    focusChanged: () => { if (typeof pinnedFocusChanged === 'function') { pinnedFocusChanged(); } },
    nameOn: (id, on) => { if (typeof fnNameOn === 'function') { fnNameOn(id, 'pin', on); } },
    sameFileOnly: () => typeof settings !== 'undefined' && !!settings.sameFileEdgesOnly,
    // its in-frame / Global lines (rendering.js hover index) and its Shelf cross-folder lines
    linesOf: (id) => {
      const own = (typeof __hover !== 'undefined' && __hover) ? __hover.linksOf(id) : [];
      const cross = [...document.querySelectorAll('#graph line.cross-hover')]
        .filter(l => l.__data__ && (l.__data__.source === id || l.__data__.target === id));
      return own.concat(cross);
    },
  });
  // eslint-disable-next-line no-unused-vars
  var togglePinnedCard = (d) => __pinned.toggle(d);
  // eslint-disable-next-line no-unused-vars
  var pinnedCardsAfterRender = () => __pinned.afterRender();
  // eslint-disable-next-line no-unused-vars
  var unpinAllCards = () => __pinned.unpinAll();
}
