// frames.js — deterministic folder-frame packer for the frames layout engine.
//
// A pure function family from (structure tree, expanded set, member radii) to
// nested, non-overlapping rectangles: every visibly-open folder becomes a
// static frame inside its parent's frame; collapsed folders, files and
// functions are MEMBERS of the nearest open ancestor's content block. Frames
// never overlap siblings, children always lie inside the parent's inner rect,
// identical input yields identical output (no randomness, keyed sorts only),
// and incremental updates translate untouched siblings rigidly at most.
//
// No DOM, no d3, no `state` access — require()-able in Node unit tests.

const FRAME = {
  PAD: 40,               // == FOLDER_PADDING (folder.js)
  TITLE: 30,             // == FOLDER_TITLEBAR_HEIGHT (folder.js)
  NAME_H: 16,            // the folder name line inside the body (R4) — content starts below it
  GAP: 8,                // gap inside a content block between member slots
  K: 1.6,                // content packing slack: A = K · Σ(2r+GAP)²
  ITEM_GAP: 16,          // gap between shelf-packed items
  SLACK: 1.3,            // shelf target-area slack
  ASPECT: 1.4,           // preferred frame aspect (w/h)
  MIN_CONTENT_W: 120, MIN_CONTENT_H: 80,
  MIN_INNER_W: 120, MIN_INNER_H: 80,
  ANCHOR_R: 30,          // file anchors reserve a minimum file-circle radius
};

// Per-file slots inside a frame's content block ("shelf" look): each file's
// functions live in their own packed slot; loose members (folder glyphs,
// collapsed files without functions) get solo slots.
const SLOT = {
  K: 2.2,                // area slack inside a slot (roomier than frames)
  GAP: 8,                // spacing term per member in the area formula
  PAD: 10,               // interior padding inside a slot
  LABEL_H: 16,           // file-name strip at the slot top
  BETWEEN: 12,           // gap between slots in the shelf pack
  MIN_W: 70, MIN_H: 54,
};

// ── Path helper (local copy; handles / and \) ─────────────────────────────────
function frDirname(fp) {
  const idx = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'));
  return idx >= 0 ? fp.substring(0, idx) : '';
}

// ── Member collection ─────────────────────────────────────────────────────────
/** Owning folder path for a visible skeleton/function element (folder level —
 *  the per-file partition reassignment happens during sizing). Null → unframed. */
function ownerFolderOf(el, tree) {
  if (el.isLibrary) { return null; }
  if (el.isFolderCluster) {
    const info = tree.folders[el._folderPath];
    // A glyph is emitted exactly when its parent is open; the collapsed root
    // glyph belongs to the (invisible) root frame itself.
    return info && info.parent ? info.parent : tree.root;
  }
  const fp = el.isFileCluster ? el._filePath : el.file;
  return fp ? frDirname(fp) : null;
}

/** Group visible node elements into per-folder member lists {id, r, file, isFn}. */
function collectMembers(elements, tree, nodeSize) {
  const members = new Map();
  for (const e of elements) {
    const d = e.data ? e.data : e;
    if (d.source !== undefined) { continue; } // edge
    const owner = ownerFolderOf(d, tree);
    if (owner == null) { continue; }
    const r = d.isFileAnchor ? FRAME.ANCHOR_R : ((d._size ?? 8) / 2) * (nodeSize ?? 2.5);
    if (!members.has(owner)) { members.set(owner, []); }
    members.get(owner).push({
      id: d.id, r, file: d.file ?? d._filePath ?? null,
      isFn: !d.isCluster && !d.isSynthetic && !d.isFileAnchor && !d.isFolderCluster && !d.isFileCluster,
    });
  }
  return members;
}

// ── Geometry ──────────────────────────────────────────────────────────────────
function contentBlockSize(members) {
  if (!members.length) { return { w: 0, h: 0 }; }
  let area = 0, maxR = 0;
  for (const m of members) {
    const s = 2 * m.r + FRAME.GAP;
    area += s * s;
    if (m.r > maxR) { maxR = m.r; }
  }
  area *= FRAME.K;
  const floor = 2 * maxR + 2 * FRAME.GAP;
  const w = Math.max(FRAME.MIN_CONTENT_W, floor, Math.round(Math.sqrt(area * FRAME.ASPECT)));
  const h = Math.max(FRAME.MIN_CONTENT_H, floor, Math.round(area / w));
  return { w, h };
}

/** Slot key for a member: its file, or a solo slot for file-less glyphs. */
function slotKeyOf(m) {
  return m.file ? 'file:' + m.file : 'solo:' + m.id;
}

/**
 * Pack a frame's members into per-file slots (the "shelf" interior).
 * Returns {w, h, slots: Map<key, {x,y,w,h,file,count}>, slotOf: Map<id, key>}
 * with slot rects local to the content-block origin. Deterministic.
 */
function packContentSlots(members, pins) {
  if (!members.length) { return { w: 0, h: 0, slots: new Map(), slotOf: new Map() }; }
  const groups = new Map();
  for (const m of members) {
    const key = slotKeyOf(m);
    if (!groups.has(key)) { groups.set(key, []); }
    groups.get(key).push(m);
  }
  const items = [];
  const meta = new Map();
  for (const key of [...groups.keys()].sort()) {
    const mems = groups.get(key);
    let area = 0, maxR = 0, fns = 0;
    for (const m of mems) {
      const s = 2 * m.r + SLOT.GAP;
      area += s * s;
      if (m.r > maxR) { maxR = m.r; }
      if (m.isFn) { fns++; }
    }
    area *= SLOT.K;
    const floor = 2 * maxR + 2 * SLOT.PAD;
    const w = Math.max(SLOT.MIN_W, floor, Math.round(Math.sqrt(area * FRAME.ASPECT)));
    const h = Math.max(SLOT.MIN_H, floor, Math.round(area / w)) + SLOT.LABEL_H;
    items.push({ key, w, h });
    meta.set(key, { file: mems[0].file || null, count: fns });
  }
  // User-pinned slots (R2b) become fixed obstacles: they keep their dragged
  // position (clamped >= 0), the rest shelf-packs around them.
  const fixedRects = [];
  const freeItems = [];
  const pinnedAt = new Map();
  for (const it of items) {
    const pin = pins && pins.get(it.key);
    if (pin) {
      const px = Math.max(0, Math.round(pin.x)), py = Math.max(0, Math.round(pin.y));
      pinnedAt.set(it.key, { x: px, y: py });
      fixedRects.push({ x: px, y: py, w: it.w, h: it.h });
    } else {
      freeItems.push(it);
    }
  }
  const p = shelfPack(freeItems, { gap: SLOT.BETWEEN, fixed: fixedRects });
  const slots = new Map();
  const slotOf = new Map();
  for (const it of items) {
    const pos = pinnedAt.get(it.key) ?? p.pos[it.key];
    slots.set(it.key, { x: pos.x, y: pos.y, w: it.w, h: it.h, ...meta.get(it.key) });
  }
  for (const m of members) { slotOf.set(m.id, slotKeyOf(m)); }
  return { w: p.w, h: p.h, slots, slotOf };
}

/** Usable interior of a member's slot, local to the frame's INNER origin
 *  (below the label strip, inside the padding). Null when unknown. */
function slotInteriorFor(f, memberId) {
  if (!f.slots || !f.slotOf) { return null; }
  const key = f.slotOf.get(memberId);
  const s = key && f.slots.get(key);
  if (!s) { return null; }
  return {
    x: f.contentPos.x + s.x + 2,
    y: f.contentPos.y + s.y + SLOT.LABEL_H,
    w: Math.max(8, s.w - 4),
    h: Math.max(8, s.h - SLOT.LABEL_H - 2),
  };
}

/**
 * Deterministic row-major grid of member centres inside a rect (the static
 * placement for Shelf + Static, and the seed for Shelf + Dynamic). Input
 * order is preserved (members arrive in file/line order), so the grid reads
 * like the source. Returns Map<id, {x,y}> in the rect's coordinate space.
 */
function gridPositions(members, rect) {
  const out = new Map();
  if (!members.length) { return out; }
  let maxR = 0;
  for (const m of members) { if (m.r > maxR) { maxR = m.r; } }
  const cell = 2 * maxR + FRAME.GAP;
  const cols = Math.max(1, Math.floor(rect.w / cell));
  const rows = Math.ceil(members.length / cols);
  const cellY = Math.min(cell, rows > 0 ? rect.h / rows : cell);
  members.forEach((m, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = rect.x + Math.min(rect.w - m.r, cell / 2 + col * cell);
    const y = rect.y + Math.min(rect.h - m.r, cellY / 2 + row * cellY);
    out.set(m.id, { x: Math.max(rect.x + m.r, x), y: Math.max(rect.y + m.r, y) });
  });
  return out;
}

/** Map of member id → slot interior rect (inner-local) for a frame's sim. */
function slotInteriors(f, members) {
  const out = new Map();
  for (const m of members) {
    const r = slotInteriorFor(f, m.id);
    if (r) { out.set(m.id, r); }
  }
  return out;
}

function rectsOverlap(a, b, gap) {
  const g = gap ?? 0;
  return a.x < b.x + b.w + g && b.x < a.x + a.w + g
    && a.y < b.y + b.h + g && b.y < a.y + a.h + g;
}

/** Shelf-pack rigid rects. items: [{key,w,h}]; fixed: [{key,x,y,w,h}] obstacles.
 *  Deterministic: sort by height desc then key asc. Returns {w,h,pos}. */
function shelfPack(items, opts = {}) {
  const gap = opts.gap ?? FRAME.ITEM_GAP;
  const fixed = opts.fixed ?? [];
  const sorted = [...items].sort((a, b) => (b.h - a.h) || (a.key < b.key ? -1 : 1));
  let totalArea = 0, widest = 0;
  for (const it of sorted) { totalArea += it.w * it.h; widest = Math.max(widest, it.w); }
  for (const f of fixed) { totalArea += f.w * f.h; widest = Math.max(widest, f.x + f.w); }
  const targetW = Math.max(widest, Math.round(Math.sqrt(totalArea * FRAME.SLACK * FRAME.ASPECT)));
  const pos = {};
  let x = 0, y = 0, rowH = 0, W = 0, H = 0;
  for (const it of sorted) {
    let guard = 0;
    for (;;) {
      if (x > 0 && x + it.w > targetW) { x = 0; y += (rowH || gap) + gap; rowH = 0; }
      const hit = fixed.find(f => rectsOverlap({ x, y, w: it.w, h: it.h }, f, gap));
      if (!hit || guard++ > 400) { break; }
      x = hit.x + hit.w + gap;
    }
    pos[it.key] = { x, y };
    W = Math.max(W, x + it.w);
    rowH = Math.max(rowH, it.h);
    H = Math.max(H, y + it.h);
    x += it.w + gap;
  }
  for (const f of fixed) { W = Math.max(W, f.x + f.w); H = Math.max(H, f.y + f.h); }
  return { w: W, h: H, pos };
}

// ── Frame set construction ────────────────────────────────────────────────────
function newFrame(path, kind, parent) {
  return {
    path, kind, parent,
    children: [],
    content: { w: 0, h: 0 },
    contentPos: { x: 0, y: 0 },
    inner: { w: 0, h: 0 },
    local: { x: null, y: null, w: 0, h: 0 },
    abs: { x: 0, y: 0, w: 0, h: 0 },
    pinned: false,
    userSize: null,
    slotPins: new Map(),   // slotKey -> {x,y} content-local (R2b slot drags)
    memberCount: 0,
    slots: new Map(),      // per-file slot rects, local to the content block
    slotOf: new Map(),     // member id -> slot key
  };
}

/** Folders that are open AND whose whole ancestor chain is open (visible-open). */
function visiblyOpenFolders(tree, expanded) {
  const out = [];
  for (const p in tree.folders) {
    if (!expanded.has(p)) { continue; }
    let cur = tree.folders[p].parent, ok = true;
    while (cur) {
      if (!expanded.has(cur)) { ok = false; break; }
      cur = tree.folders[cur].parent;
    }
    if (ok) { out.push(p); }
  }
  return out.sort();
}

function outerOf(f) {
  if (f.kind === 'root') { return { w: f.inner.w, h: f.inner.h }; }
  let w = f.inner.w + 2 * FRAME.PAD;
  let h = f.inner.h + 2 * FRAME.PAD + FRAME.TITLE + FRAME.NAME_H;
  if (f.userSize) { w = Math.max(w, f.userSize.w); h = Math.max(h, f.userSize.h); }
  return { w, h };
}

/** Pack a frame's already-sized items (content block + children) with shelves.
 *  Re-packing is the one operation allowed to shrink a frame. */
function packItems(fs, f) {
  const items = [];
  const fixed = [];
  if (f.content.w > 0) { items.push({ key: '#content', w: f.content.w, h: f.content.h }); }
  for (const c of f.children) {
    const cf = fs.byPath.get(c);
    if (cf.pinned && cf.local.x != null) {
      fixed.push({ key: c, x: Math.max(0, cf.local.x), y: Math.max(0, cf.local.y), w: cf.local.w, h: cf.local.h });
    } else {
      items.push({ key: c, w: cf.local.w, h: cf.local.h });
    }
  }
  const p = shelfPack(items, { fixed });
  f.inner = { w: Math.max(FRAME.MIN_INNER_W, p.w), h: Math.max(FRAME.MIN_INNER_H, p.h) };
  f.contentPos = p.pos['#content'] ?? { x: 0, y: 0 };
  for (const c of f.children) {
    const cf = fs.byPath.get(c);
    if (p.pos[c]) { cf.local.x = p.pos[c].x; cf.local.y = p.pos[c].y; }
  }
  const o = outerOf(f);
  f.local.w = o.w; f.local.h = o.h;
}

/** Full pack of one frame: pack members into file slots, then pack items. */
function packFrame(fs, f, members) {
  const mem = members.get(f.path) ?? [];
  f.memberCount = mem.length;
  const slotted = packContentSlots(mem, f.slotPins);
  f.slots = slotted.slots;
  f.slotOf = slotted.slotOf;
  f.content = { w: slotted.w, h: slotted.h };
  packItems(fs, f);
}

function innerOrigin(f) {
  if (f.kind === 'root') { return { x: f.abs.x, y: f.abs.y }; }
  return { x: f.abs.x + FRAME.PAD, y: f.abs.y + FRAME.PAD + FRAME.TITLE + FRAME.NAME_H };
}

function resolveAbs(fs) {
  const visit = (path, origin) => {
    const f = fs.byPath.get(path);
    f.abs = { x: origin.x + (f.local.x ?? 0), y: origin.y + (f.local.y ?? 0), w: f.local.w, h: f.local.h };
    const io = innerOrigin(f);
    for (const c of f.children) { visit(c, io); }
  };
  if (fs.byPath.has(fs.root)) { visit(fs.root, { x: 0, y: 0 }); }
}

function postOrder(fs, path, fn) {
  const f = fs.byPath.get(path);
  for (const c of [...f.children]) { postOrder(fs, c, fn); }
  fn(f);
}

/** Build a FrameSet from scratch. `members` from collectMembers (mutated by
 *  the per-file partition). */
function buildFrames(tree, expanded, members) {
  const fs = { root: tree.root, byPath: new Map(), gen: 0 };
  if (!tree.root) { return fs; }
  fs.byPath.set(tree.root, newFrame(tree.root, 'root', null));
  for (const p of visiblyOpenFolders(tree, expanded)) {
    if (p === tree.root) { continue; }
    fs.byPath.set(p, newFrame(p, 'folder', tree.folders[p].parent));
  }
  for (const [p, f] of fs.byPath) {
    if (f.parent && fs.byPath.has(f.parent)) { fs.byPath.get(f.parent).children.push(p); }
  }
  for (const f of fs.byPath.values()) { f.children.sort(); }
  postOrder(fs, fs.root, f => packFrame(fs, f, members));
  const root = fs.byPath.get(fs.root);
  root.local.x = 0; root.local.y = 0;
  resolveAbs(fs);
  return fs;
}

// ── Incremental update ────────────────────────────────────────────────────────
function carryFrame(prev, path) {
  const old = prev.byPath.get(path);
  if (!old) { return null; }
  return {
    ...old,
    children: [],
    content: { ...old.content },
    contentPos: { ...old.contentPos },
    inner: { ...old.inner },
    local: { ...old.local },
    abs: { ...old.abs },
    userSize: old.userSize ? { ...old.userSize } : null,
    slots: new Map(old.slots || []),
    slotOf: new Map(old.slotOf || []),
    slotPins: new Map(old.slotPins || []),
  };
}

/** Place unplaced/overlapping children; re-pack the parent only when needed. */
function placeChildren(fs, f, repacked) {
  const rectOf = (key) => {
    if (key === '#content') {
      return f.content.w > 0 ? { x: f.contentPos.x, y: f.contentPos.y, w: f.content.w, h: f.content.h } : null;
    }
    const cf = fs.byPath.get(key);
    return cf.local.x == null ? null : { x: cf.local.x, y: cf.local.y, w: cf.local.w, h: cf.local.h };
  };
  const keys = ['#content', ...f.children];
  let overlap = false;
  for (let i = 0; i < keys.length && !overlap; i++) {
    const a = rectOf(keys[i]);
    if (!a) { if (keys[i] !== '#content') { overlap = true; } continue; } // unplaced child
    for (let j = i + 1; j < keys.length; j++) {
      const b = rectOf(keys[j]);
      if (b && rectsOverlap(a, b, 0)) { overlap = true; break; }
    }
  }
  if (!overlap) { return; }
  packItems(fs, f);
  repacked.add(f.path);
}

/**
 * Recompute frames for new (expanded, members) keeping the previous geometry
 * where possible: a frame that still fits keeps its place; one that grew stays
 * put if it fits, else only its parent re-packs (siblings translate rigidly);
 * frames never shrink in place. Returns {frames, changed, repacked}.
 */
function updateFrames(prev, tree, expanded, members, opts = {}) {
  if (!prev || !prev.byPath || prev.byPath.size === 0 || prev.root !== tree.root) {
    const frames = buildFrames(tree, expanded, members);
    frames.gen = (prev && prev.gen != null ? prev.gen : -1) + 1;
    return { frames, changed: new Set(frames.byPath.keys()), repacked: new Set() };
  }
  const fs = { root: tree.root, byPath: new Map(), gen: prev.gen + 1 };
  fs.byPath.set(tree.root, carryFrame(prev, tree.root) || newFrame(tree.root, 'root', null));
  for (const p of visiblyOpenFolders(tree, expanded)) {
    if (p === tree.root) { continue; }
    fs.byPath.set(p, carryFrame(prev, p) || newFrame(p, 'folder', tree.folders[p].parent));
  }
  for (const [p, f] of fs.byPath) {
    if (f.parent && fs.byPath.has(f.parent)) { fs.byPath.get(f.parent).children.push(p); }
  }
  for (const f of fs.byPath.values()) { f.children.sort(); }

  const repacked = new Set();
  postOrder(fs, fs.root, f => {
    const isNew = !prev.byPath.has(f.path);
    if (isNew) {
      packFrame(fs, f, members);
      const seed = opts.seedPos && opts.seedPos[f.path];
      if (seed) {
        f.local.x = Math.max(0, Math.round(seed.x - f.local.w / 2));
        f.local.y = Math.max(0, Math.round(seed.y - f.local.h / 2));
      }
      return;
    }
    // Existing frame: grow sizes in place, never shrink; keep child positions.
    // Slots are cheap and deterministic — recompute them every update.
    const mem = members.get(f.path) ?? [];
    f.memberCount = mem.length;
    const slotted = packContentSlots(mem, f.slotPins);
    f.slots = slotted.slots;
    f.slotOf = slotted.slotOf;
    f.content = { w: Math.max(f.content.w, slotted.w), h: Math.max(f.content.h, slotted.h) };
    let needW = f.content.w > 0 ? f.contentPos.x + f.content.w : 0;
    let needH = f.content.w > 0 ? f.contentPos.y + f.content.h : 0;
    for (const ch of f.children) {
      const cf = fs.byPath.get(ch);
      if (cf.local.x == null) { continue; } // placed below
      needW = Math.max(needW, cf.local.x + cf.local.w);
      needH = Math.max(needH, cf.local.y + cf.local.h);
    }
    f.inner = {
      w: Math.max(f.inner.w, needW, FRAME.MIN_INNER_W),
      h: Math.max(f.inner.h, needH, FRAME.MIN_INNER_H),
    };
    const o = outerOf(f);
    f.local.w = Math.max(f.local.w, o.w);
    f.local.h = Math.max(f.local.h, o.h);
    placeChildren(fs, f, repacked);
  });
  const root = fs.byPath.get(fs.root);
  root.local.x = 0; root.local.y = 0;
  resolveAbs(fs);

  const changed = new Set();
  for (const [p, f] of fs.byPath) {
    const old = prev.byPath.get(p);
    if (!old || old.abs.x !== f.abs.x || old.abs.y !== f.abs.y
      || old.abs.w !== f.abs.w || old.abs.h !== f.abs.h) { changed.add(p); }
  }
  for (const p of prev.byPath.keys()) { if (!fs.byPath.has(p)) { changed.add(p); } }
  return { frames: fs, changed, repacked };
}

// ── User interaction ──────────────────────────────────────────────────────────
/** Clamp a frame's desired parent-local position so it stays inside its
 *  parent's inner rect on all four sides (drag containment — R1). Children of
 *  the root keep the classic >=0 clamp (the root canvas grows freely), as
 *  does any child larger than its parent's inner rect. */
function clampFrameLocal(fs, path, pos) {
  const f = fs.byPath.get(path);
  if (!f || !pos) { return pos; }
  const parent = fs.byPath.get(f.parent);
  if (!parent || parent.kind === 'root') {
    return { x: Math.max(0, pos.x), y: Math.max(0, pos.y) };
  }
  const maxX = parent.inner.w - f.local.w;
  const maxY = parent.inner.h - f.local.h;
  return {
    x: maxX >= 0 ? Math.max(0, Math.min(maxX, pos.x)) : Math.max(0, pos.x),
    y: maxY >= 0 ? Math.max(0, Math.min(maxY, pos.y)) : Math.max(0, pos.y),
  };
}

function pinFrame(fs, path, localPos, size) {
  const f = fs.byPath.get(path);
  if (!f || f.kind === 'root') { return; }
  f.pinned = true;
  if (localPos) {
    f.local.x = Math.max(0, Math.round(localPos.x));
    f.local.y = Math.max(0, Math.round(localPos.y));
  }
  if (size) {
    f.userSize = { w: Math.round(size.w), h: Math.round(size.h) };
    const o = outerOf(f);
    f.local.w = o.w; f.local.h = o.h;
  }
  // The parent may need to grow to contain the pinned rect.
  const parent = fs.byPath.get(f.parent);
  if (parent) {
    parent.inner.w = Math.max(parent.inner.w, f.local.x + f.local.w);
    parent.inner.h = Math.max(parent.inner.h, f.local.y + f.local.h);
    const o = outerOf(parent);
    parent.local.w = Math.max(parent.local.w, o.w);
    parent.local.h = Math.max(parent.local.h, o.h);
  }
  resolveAbs(fs);
}

function unpinFrame(fs, path) {
  const f = fs.byPath.get(path);
  if (f) { f.pinned = false; f.userSize = null; }
}

// ── Queries ───────────────────────────────────────────────────────────────────
function toAbs(f, p) { const o = innerOrigin(f); return { x: o.x + p.x, y: o.y + p.y }; }
function toLocal(f, p) { const o = innerOrigin(f); return { x: p.x - o.x, y: p.y - o.y }; }

function frameBounds(fs) {
  const root = fs.byPath.get(fs.root);
  return root ? { ...root.abs } : { x: 0, y: 0, w: 0, h: 0 };
}

function titleBarRect(f) {
  return { x: f.abs.x, y: f.abs.y, w: f.abs.w, h: FRAME.TITLE };
}

function intersectsViewport(f, view) {
  return rectsOverlap(f.abs, view, 0);
}

/** Deepest frame containing (ax, ay); null when outside the root. */
function hitTest(fs, ax, ay) {
  let best = null;
  const visit = (path, depth) => {
    const f = fs.byPath.get(path);
    const inside = ax >= f.abs.x && ax <= f.abs.x + f.abs.w && ay >= f.abs.y && ay <= f.abs.y + f.abs.h;
    if (!inside) { return; }
    if (!best || depth >= best.depth) { best = { f, depth }; }
    for (const c of f.children) { visit(c, depth + 1); }
  };
  if (fs.byPath.has(fs.root)) { visit(fs.root, 0); }
  return best ? best.f : null;
}

// ── Persistence ───────────────────────────────────────────────────────────────
function serializeFrames(fs) {
  const out = {};
  for (const p of [...fs.byPath.keys()].sort()) {
    const f = fs.byPath.get(p);
    if (f.kind === 'root') { continue; }
    // cx/cy: the content block's offset inside the frame. It depends on pack
    // HISTORY (grow-in-place never re-centres), so a fresh build after reload
    // derives a different one — saving it makes the slot geometry, and with
    // it every node's slot-interior check, reproducible from the payload
    // alone (F15).
    out[p] = {
      x: f.local.x ?? 0, y: f.local.y ?? 0, w: f.local.w, h: f.local.h,
      pinned: !!f.pinned,
      cx: f.contentPos.x ?? 0, cy: f.contentPos.y ?? 0,
    };
    if (f.slotPins && f.slotPins.size) {
      const sp = {};
      for (const [k, v] of f.slotPins) { sp[k] = [Math.round(v.x), Math.round(v.y)]; }
      out[p].sp = sp; // additive (R2b): dragged slot positions
    }
  }
  return out;
}

/** Apply saved rects onto a built set; returns the paths actually applied. */
function deserializeFrames(saved, fs) {
  const applied = [];
  for (const p in saved) {
    const f = fs.byPath.get(p);
    if (!f || f.kind === 'root') { continue; }
    const r = saved[p];
    f.local.x = Math.max(0, r.x); f.local.y = Math.max(0, r.y);
    f.local.w = r.w; f.local.h = r.h;
    f.inner = {
      w: Math.max(FRAME.MIN_INNER_W, r.w - 2 * FRAME.PAD),
      h: Math.max(FRAME.MIN_INNER_H, r.h - 2 * FRAME.PAD - FRAME.TITLE - FRAME.NAME_H),
    };
    if (r.cx != null) { f.contentPos = { x: r.cx, y: r.cy ?? 0 }; }
    if (r.sp) {
      f.slotPins = new Map(Object.entries(r.sp).map(([k, v]) => [k, { x: v[0], y: v[1] }]));
    }
    f.pinned = !!r.pinned;
    applied.push(p);
  }
  resolveAbs(fs);
  return applied;
}

if (typeof module !== 'undefined') {
  module.exports = {
    FRAME, SLOT, frDirname, ownerFolderOf, collectMembers, contentBlockSize,
    slotKeyOf, packContentSlots, slotInteriorFor, slotInteriors, gridPositions, clampFrameLocal,
    rectsOverlap, shelfPack, buildFrames, updateFrames, packFrame, packItems,
    pinFrame, unpinFrame, resolveAbs, innerOrigin, toAbs, toLocal,
    frameBounds, hitTest, titleBarRect, intersectsViewport,
    serializeFrames, deserializeFrames, visiblyOpenFolders,
  };
}
