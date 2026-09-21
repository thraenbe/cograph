// frameCull.js — DOM side of viewport culling + level of detail (W3).
//
// Measured (Chrome 153, 10k fixture, zoom gesture): frames hidden with
// display:none still cost ~120 ms per frame — Blink walks hidden SVG subtrees
// on every scale change — while DETACHED subtrees cost nothing (7.6 → 48 fps).
// So culled frames and dropped LOD layers are removed from the document and
// re-inserted at their original place when needed. d3 selections keep working
// on detached elements (attribute writes, class toggles), so filters, hover
// indexes and position writes need no special casing.
//
// No d3, no globals; elements in, DOM moves out (unit-tested with jsdom).

const FC_LAYERS = {
  labels: (frameEl) => childrenMatching(frameEl, 'g', 'f-labels'),
  links: (frameEl) => childrenMatching(frameEl, 'g', 'f-links'),
  // file names inside the slots: unreadable long before the slots themselves
  slotLabels: (frameEl) => {
    const out = [];
    for (const holder of childrenMatching(frameEl, 'g', 'f-slots')) {
      for (const slot of childrenMatching(holder, 'g', 'file-slot')) { out.push(...childrenMatching(slot, 'text', 'file-slot-label')); }
    }
    return out;
  },
  // function nodes only — folder/file glyphs (path.cloud-node) stay clickable
  nodes: (frameEl) => {
    const holder = childrenMatching(frameEl, 'g', 'f-nodes')[0];
    return holder ? childrenMatching(holder, 'circle', 'regular-node') : [];
  },
};

function childrenMatching(parent, tag, cls) {
  const out = [];
  for (const el of parent.children) {
    if (el.tagName.toLowerCase() === tag && el.classList.contains(cls)) { out.push(el); }
  }
  return out;
}

function createDomCuller() {
  let parent = null;
  let order = [];                 // frame paths in DOM (paint) order
  let els = new Map();            // path -> <g.frame>
  const parked = new Map();       // path -> { labels|links|nodes: [{ el, parent, next }] }

  function nextAttachedSibling(path) {
    for (let i = order.indexOf(path) + 1; i < order.length; i++) {
      const el = els.get(order[i]);
      if (el && el.parentNode === parent) { return el; }
    }
    return null;
  }

  return {
    /** New render: `entries` = [path, frameElement] in DOM order, all attached, full detail. */
    reset(parentEl, entries) {
      parent = parentEl;
      order = entries.map(e => e[0]);
      els = new Map(entries);
      parked.clear();
    },
    isAttached(path) { const el = els.get(path); return !!el && el.parentNode === parent; },
    hide(path) {
      const el = els.get(path);
      if (el && el.parentNode === parent) { parent.removeChild(el); }
    },
    show(path) {
      const el = els.get(path);
      if (!el || !parent || el.parentNode === parent) { return false; }
      parent.insertBefore(el, nextAttachedSibling(path));
      return true;
    },
    /** Make one frame's layers match `want` = { labels, links, nodes, slotLabels } (true = drawn). */
    applyLod(path, want) {
      const frameEl = els.get(path);
      if (!frameEl) { return 0; }
      let st = parked.get(path);
      if (!st) { st = {}; parked.set(path, st); }
      let moved = 0;
      for (const layer of Object.keys(FC_LAYERS)) {
        if (want[layer] === false && !st[layer]) {
          st[layer] = FC_LAYERS[layer](frameEl).map(el => ({ el, parent: el.parentNode, next: el.nextSibling }));
          for (const p of st[layer]) { p.parent.removeChild(p.el); moved++; }
        } else if (want[layer] !== false && st[layer]) {
          // reverse order: each element's remembered next sibling is back in place first
          for (const p of st[layer].slice().reverse()) {
            p.parent.insertBefore(p.el, p.next && p.next.parentNode === p.parent ? p.next : null);
            moved++;
          }
          st[layer] = null;
        }
      }
      return moved;
    },
    /**
     * Put every frame and layer back. MUST run before a re-render: d3's joins
     * look elements up through the document, so a parked <g.f-labels> would be
     * treated as missing and its frame re-rendered without labels.
     */
    restoreAll() {
      const full = { labels: true, links: true, nodes: true, slotLabels: true };
      for (const path of order) { this.applyLod(path, full); }
      for (const path of order) { this.show(path); }
    },
    /** Layer currently parked (detached) for this frame? */
    isParked(path, layer) { const st = parked.get(path); return !!(st && st[layer]); },
    paths() { return order; },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createDomCuller, childrenMatching };
}
