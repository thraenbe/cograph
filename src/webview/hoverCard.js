// hoverCard.js — the graph's only tooltip layer: a card for folders and files with
// static facts (files · functions · languages) and, once generated, the AI summary
// from "Annotate Graph". Loaded last; all functions are globals.
//
// It never edits another module. One delegated listener set on #graph resolves the
// hovered element to a folder/file path through the d3 datum, so a renamed class in
// frameRender/folder/drilldown is one more row in HOVER_TARGETS. Nothing here runs in
// a tick path, and layout is read once per card open (to clamp it to the viewport).
//
// Summaries are model output built from repository text, i.e. untrusted: every string
// is written with textContent, never innerHTML.

const HOVER_DELAY_MS = 300;      // headers, labels, collapsed glyphs
const HOVER_BG_DELAY_MS = 600;   // empty background of a file slot / file circle
const HOVER_OFFSET = 14;
const HOVER_MARGIN = 8;
// A mouseout only counts as leaving if the pointer is not back on the same target within
// this time. Hovering a collapsed glyph makes rendering.js draw cross-folder links that start
// under the pointer and removes them again on its own mouseout: a ~30 ms out/over flicker for
// as long as the pointer rests there (seen live on `click`, src/click). Without the grace
// period every flicker cancelled the open timer and the card never appeared.
const HOVER_LEAVE_GRACE_MS = 80;

// Hit element class → which ancestor group carries the datum, which datum field holds
// the path, and whether it is a background (slow) target. Frame and folder-box BODIES
// are deliberately absent: a card wherever the pointer rests would be noise.
// As built by the ux work, g.frame-tab is pointer-events:none and the transparent
// .folder-bubble-titlebar strip over it takes the hit; the frame-tab row stays so the card
// keeps working if the tab ever becomes hittable. Checked live in Chromium (uxtest lab).
const HOVER_TARGETS = [
  { cls: 'frame-tab',              group: 'g.frame',         field: 'path',       kind: 'folder', background: false },
  { cls: 'folder-bubble-titlebar', group: 'g.frame',         field: 'path',       kind: 'folder', background: false },
  { cls: 'folder-bubble-label',    group: 'g.frame',         field: 'path',       kind: 'folder', background: false },
  { cls: 'folder-bubble-titlebar', group: 'g.folder-bubble', field: 'folderPath', kind: 'folder', background: false },
  { cls: 'folder-bubble-label',    group: 'g.folder-bubble', field: 'folderPath', kind: 'folder', background: false },
  { cls: 'file-slot-label',        group: 'g.file-slot',     field: 'file',       kind: 'file',   background: false },
  // The R2b drag handle covers the label band and is the topmost element
  // there — without this row no slot label ever hovers (F18).
  { cls: 'file-slot-handle',       group: 'g.file-slot',     field: 'file',       kind: 'file',   background: false },
  { cls: 'file-slot-shape',        group: 'g.file-slot',     field: 'file',       kind: 'file',   background: true },
  { cls: 'file-circle-label',      group: 'g.file-bubble',   field: 'filePath',   kind: 'file',   background: false },
  { cls: 'file-circle-subtitle',   group: 'g.file-bubble',   field: 'filePath',   kind: 'file',   background: false },
  { cls: 'file-circle-shape',      group: 'g.file-bubble',   field: 'filePath',   kind: 'file',   background: true },
];

function hcNorm(p) { return String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''); }

/** Absolute path → the workspace-relative POSIX key used by the annotations message. */
function hcRelPath(root, abs) {
  const r = hcNorm(root), a = hcNorm(abs);
  if (!r || a === r) { return a === r ? '.' : a; }
  return a.startsWith(r + '/') ? a.slice(r.length + 1) : a;
}

function hcBasename(p) { const n = hcNorm(p); return n.slice(n.lastIndexOf('/') + 1) || n; }

/**
 * Resolve a DOM element under #graph to { kind, path, background } or null.
 * Collapsed folder/file glyphs (and their labels) carry the node datum themselves;
 * everything else goes through HOVER_TARGETS.
 */
function hcResolveTarget(el) {
  if (!el || !el.classList) { return null; }
  const own = el.__data__;
  // U3: a function node (funcCard.js). Only the circle itself, never its label.
  if (own && el.classList.contains('regular-node') && typeof fcIsFunctionNode === 'function' && fcIsFunctionNode(own)) {
    return { kind: 'function', path: own.file, node: own, background: false };
  }
  if (own && own.isFolderCluster && own._folderPath) { return { kind: 'folder', path: own._folderPath, background: false }; }
  if (own && own.isFileCluster && own._filePath) { return { kind: 'file', path: own._filePath, background: false }; }
  // .frame-tab may be a group: accept a hit on any of its children.
  const tab = el.closest && el.closest('.frame-tab');
  for (const t of HOVER_TARGETS) {
    const hit = el.classList.contains(t.cls) || (t.cls === 'frame-tab' && tab);
    if (!hit) { continue; }
    const group = el.closest(t.group);
    const d = group && group.__data__;
    if (d && typeof d[t.field] === 'string' && d[t.field]) {
      return { kind: t.kind, path: d[t.field], background: t.background };
    }
  }
  return null;
}

/** Links are drawn over and under folders and files; they never own the hover. */
function hcIsLink(el) {
  if (!el || !el.closest) { return false; }
  return el.tagName === 'line' || !!el.closest('g.links, g.f-links');
}

/**
 * Target for a pointer event. A link lying on top of a glyph or header must not hide what
 * is underneath, so for a link hit the stack at the pointer is searched past the links.
 * elementsFromPoint is a hit test, used only for link hits and never in a tick path.
 */
function hcResolveAt(el, x, y, doc) {
  const direct = hcResolveTarget(el);
  if (direct || !hcIsLink(el) || !doc || typeof doc.elementsFromPoint !== 'function') { return direct; }
  for (const under of doc.elementsFromPoint(x, y)) {
    if (hcIsLink(under)) { continue; }
    return hcResolveTarget(under); // the first non-link element decides, even if it is not a target
  }
  return null;
}

/** Per-file function counts from the graph; rebuilt lazily after `graph` / `graph-patch`. */
function hcFunctionCounts(graphData) {
  const counts = new Map();
  for (const n of (graphData && graphData.nodes) || []) {
    if (n.isLibrary || !n.file) { continue; }
    const f = hcNorm(n.file);
    counts.set(f, (counts.get(f) || 0) + 1);
  }
  return counts;
}

function hcPlural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

/** "12 files · 85 functions · TypeScript, JavaScript" — from data the webview already has. */
function hcFacts(target, st, counts) {
  const tree = st && st.structureTree;
  const abs = hcNorm(target.path);
  const files = ((tree && tree.files) || []).filter(f => {
    const p = hcNorm(f.path);
    return target.kind === 'file' ? p === abs : p.startsWith(abs + '/');
  });
  const functions = files.reduce((sum, f) => sum + (counts.get(hcNorm(f.path)) || 0), 0);
  const langs = [...new Set(files.map(f => f.language).filter(Boolean))].slice(0, 3);
  const parts = [];
  if (target.kind === 'folder') { parts.push(hcPlural(files.length, 'file')); }
  // A file that was never parsed has no count yet — say nothing rather than "0 functions".
  if (functions > 0 || target.kind === 'folder') { parts.push(hcPlural(functions, 'function')); }
  if (langs.length) { parts.push(langs.join(', ')); }
  return parts.join(' · ');
}

/** Everything the card shows for a target. Pure, so it is testable without a DOM. */
function hcContent(target, ann, st, counts) {
  const rel = hcRelPath(ann.root, target.path);
  const entry = (target.kind === 'file' ? ann.files : ann.folders)[rel];
  let hint = '';
  if (!entry && ann.aiEnabled) { hint = 'No AI summary yet — use “Annotate graph” in the CoGraph sidebar.'; }
  return {
    name: hcBasename(target.path) + (target.kind === 'folder' ? '/' : ''),
    path: rel,
    summary: entry ? entry.summary : '',
    role: entry && entry.role ? entry.role : '',
    outdated: !!entry && ann.stale.has(rel),
    facts: hcFacts(target, st, counts),
    hint,
  };
}

/** Top-left position for a card of size w×h near the pointer, kept inside the viewport. */
function hcPlace(x, y, w, h, vw, vh) {
  let left = x + HOVER_OFFSET;
  let top = y + HOVER_OFFSET;
  if (left + w + HOVER_MARGIN > vw) { left = x - HOVER_OFFSET - w; }
  if (top + h + HOVER_MARGIN > vh) { top = y - HOVER_OFFSET - h; }
  return { left: Math.max(HOVER_MARGIN, Math.round(left)), top: Math.max(HOVER_MARGIN, Math.round(top)) };
}

/** The card's DOM: built once, filled with textContent on every open. */
function hcBuildElement(doc) {
  const card = doc.createElement('div');
  card.className = 'hover-card';
  card.setAttribute('role', 'tooltip');
  const parts = {};
  for (const name of ['name', 'badge', 'sig', 'path', 'role', 'summary', 'hint', 'doc', 'code', 'more', 'calls', 'facts']) {
    const node = doc.createElement(name === 'code' ? 'pre' : 'div');
    node.className = 'hc-' + name;
    parts[name] = node;
  }
  const head = doc.createElement('div');
  head.className = 'hc-head';
  head.append(parts.name, parts.badge);
  card.append(head, parts.sig, parts.path, parts.role, parts.summary, parts.hint, parts.doc, parts.code, parts.more, parts.calls, parts.facts);
  parts.badge.textContent = 'outdated';
  doc.body.appendChild(card);
  return { card, parts };
}

/**
 * Wire the card to a document. `env` = { doc, win, getState, post } so tests can
 * inject jsdom; the webview calls it once with its globals (see bottom).
 */
function createHoverCard(env) {
  const doc = env.doc, win = env.win;
  const ann = { root: '', aiEnabled: false, files: {}, folders: {}, stale: new Set() };
  let counts = null, timer = null, leaveTimer = null, pendingKey = null, shownKey = null;
  let pendingTarget = null, shownTarget = null, suppressKey = null, dwellX = 0, dwellY = 0;
  let callIdx = null, nameOf = null, briefSeq = 0;
  const briefs = new Map();      // node id → func-source reply (cached until graph / graph-patch)
  const briefReqs = new Map();   // reqId → node id, in flight
  let px = 0, py = 0;

  const { card, parts } = hcBuildElement(doc);

  function cancelLeave() {
    if (leaveTimer) { win.clearTimeout(leaveTimer); leaveTimer = null; }
  }

  function hide() {
    cancelLeave();
    if (timer) { win.clearTimeout(timer); timer = null; }
    pendingKey = null; pendingTarget = null;
    if (shownKey) { shownKey = null; shownTarget = null; card.classList.remove('visible'); }
  }

  function fill(c) {
    parts.name.textContent = c.name;
    parts.path.textContent = c.path;
    parts.role.textContent = c.role || '';
    parts.summary.textContent = c.summary || c.error || '';
    parts.hint.textContent = c.hint || '';
    parts.facts.textContent = c.facts || '';
    parts.sig.textContent = c.sig || '';
    parts.doc.textContent = c.doc || '';
    parts.more.textContent = c.more || '';
    parts.calls.textContent = c.calls || '';
    parts.code.textContent = '';
    if (c.code) { parts.code.appendChild(fcCodeNodes(doc, c.code, c.file)); }
    parts.badge.style.display = c.outdated ? '' : 'none';
    for (const name of ['role', 'hint', 'facts', 'sig', 'doc', 'code', 'more', 'calls']) { parts[name].style.display = c[name] ? '' : 'none'; }
    parts.summary.style.display = (c.summary || c.error) ? '' : 'none';
  }

  function place() {
    const box = card.getBoundingClientRect(); // one layout read per open (and per late fill)
    const pos = hcPlace(px, py, box.width, box.height, win.innerWidth, win.innerHeight);
    card.style.transform = 'translate(' + pos.left + 'px,' + pos.top + 'px)';
  }

  function show(target, key) {
    timer = null; pendingKey = null;
    const st = env.getState();
    if (target.kind === 'function') {
      // The editable source popup for this node is open: it already shows everything.
      if (st && st.funcPopups && st.funcPopups.has(target.node.id)) { return; }
      fill(fnContent(target.node, st));
      requestBrief(target.node);
    } else {
      if (!counts) { counts = hcFunctionCounts(st && st.graphData); }
      fill(hcContent(target, ann, st, counts));
    }
    card.classList.toggle('hc-function', target.kind === 'function');
    place();
    card.classList.add('visible');
    shownKey = key;
    shownTarget = target;
  }

  // ── Function cards (U3): graph facts now, source once per function from the host ──
  function fnContent(d, st) {
    if (!callIdx) { callIdx = fcCallIndex(st && st.graphData); nameOf = fcNameOf(st && st.graphData); }
    const c = fcContent(d, briefs.get(d.id) || null, hcRelPath(ann.root, d.file), callIdx, nameOf);
    c.file = d.file;
    return c;
  }

  function requestBrief(d) {
    if (briefs.has(d.id) || [...briefReqs.values()].includes(d.id)) { return; }
    const reqId = 'hc-' + (++briefSeq);
    briefReqs.set(reqId, d.id);
    env.post({ type: 'get-func-source', file: d.file, line: d.line, maxLines: FN_PEEK_LINES, reqId });
  }

  function keyOf(target) {
    if (!target) { return null; }
    return target.kind === 'function' ? 'function:' + target.node.id : target.kind + ':' + target.path;
  }

  function onOver(event) {
    const target = hcResolveAt(event.target, event.clientX, event.clientY, doc);
    const key = keyOf(target);
    if (key && (key === shownKey || key === pendingKey)) { cancelLeave(); return; } // still on the same thing
    hide();
    if (key !== suppressKey) { suppressKey = null; }
    if (!target || event.buttons || key === suppressKey) { return; } // drag in progress / just clicked
    pendingKey = key;
    pendingTarget = target;
    dwellX = event.clientX; dwellY = event.clientY;
    timer = win.setTimeout(() => show(target, key), delayOf(target));
  }

  function delayOf(target) {
    if (target.kind === 'function') { return HOVER_FN_DELAY_MS; }
    return target.background ? HOVER_BG_DELAY_MS : HOVER_DELAY_MS;
  }

  function onOut(event) {
    const key = keyOf(hcResolveAt(event.relatedTarget, event.clientX, event.clientY, doc));
    if (key && (key === shownKey || key === pendingKey)) { return; }
    scheduleLeave();
  }

  // Not an immediate hide: see HOVER_LEAVE_GRACE_MS. A mouseover on another element hides at
  // once anyway (onOver), so the grace only bridges re-renders under a resting pointer. Also
  // used for mouseleave of #graph: when the element under the pointer is REMOVED (the cross
  // links above), Chromium fires mouseleave up the whole ancestor chain, #graph included.
  function scheduleLeave() {
    if ((shownKey || pendingKey) && !leaveTimer) { leaveTimer = win.setTimeout(hide, HOVER_LEAVE_GRACE_MS); }
  }

  function onMove(event) {
    px = event.clientX; py = event.clientY;
    // Function nodes are small and dense: the card waits for the pointer to REST.
    if (timer && pendingTarget && pendingTarget.kind === 'function'
      && Math.abs(px - dwellX) + Math.abs(py - dwellY) > HOVER_FN_DWELL_PX) {
      dwellX = px; dwellY = py;
      win.clearTimeout(timer);
      const target = pendingTarget, key = pendingKey;
      timer = win.setTimeout(() => show(target, key), HOVER_FN_DELAY_MS);
    }
  }

  // Mouse down hides at once, and a click on a function (which opens its popup) must
  // not bring the card back while the pointer is still on that node.
  function onDown() {
    suppressKey = shownKey || pendingKey;
    hide();
  }

  function onMessage(event) {
    const m = event.data;
    if (!m) { return; }
    if (m.type === 'graph' || m.type === 'graph-patch') { counts = null; callIdx = null; briefs.clear(); briefReqs.clear(); return; }
    if (m.type === 'func-source' && typeof m.reqId === 'string' && briefReqs.has(m.reqId)) {
      const id = briefReqs.get(m.reqId);
      briefReqs.delete(m.reqId);
      briefs.set(id, m);
      if (shownKey === 'function:' + id && shownTarget) { fill(fnContent(shownTarget.node, env.getState())); place(); }
      return;
    }
    if (m.type !== 'annotations') { return; }
    ann.root = m.root || '';
    ann.aiEnabled = !!m.aiEnabled;
    ann.files = m.files || {};
    ann.folders = m.folders || {};
    ann.stale = new Set(m.stale || []);
  }

  function onKey(event) { if (event.key === 'Escape') { hide(); } }

  const root = env.root;
  root.addEventListener('mouseover', onOver);
  root.addEventListener('mouseout', onOut);
  root.addEventListener('mousemove', onMove, { passive: true });
  root.addEventListener('mousedown', onDown, true);      // drag, pan or click starts
  root.addEventListener('wheel', hide, { passive: true, capture: true }); // zoom
  root.addEventListener('mouseleave', scheduleLeave);
  win.addEventListener('message', onMessage);
  win.addEventListener('blur', hide);
  doc.addEventListener('keydown', onKey);
  // Ask once we can listen, so the reply can never race the `graph`/`structure` messages.
  env.post({ type: 'get-annotations' });

  return {
    element: card,
    hide,
    isVisible: () => !!shownKey,
    annotations: ann,
    destroy() {
      hide();
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      root.removeEventListener('mousemove', onMove);
      root.removeEventListener('mousedown', onDown, true);
      root.removeEventListener('wheel', hide, { capture: true });
      root.removeEventListener('mouseleave', scheduleLeave);
      win.removeEventListener('message', onMessage);
      win.removeEventListener('blur', hide);
      doc.removeEventListener('keydown', onKey);
      card.remove();
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    createHoverCard, hcResolveTarget, hcRelPath, hcContent, hcFacts, hcFunctionCounts, hcPlace,
    hcResolveAt, hcIsLink, HOVER_DELAY_MS, HOVER_BG_DELAY_MS, HOVER_LEAVE_GRACE_MS, HOVER_TARGETS,
  };
} else if (typeof document !== 'undefined' && document.getElementById('graph')) {
  createHoverCard({
    doc: document,
    win: window,
    root: document.getElementById('graph'),
    getState: () => state,
    post: (m) => vscode.postMessage(m),
  });
}
