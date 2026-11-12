// clickTrail.js — every clicked function keeps its edges lit, and each newer
// click fades the older ones a step (Bela, 2026-11-12). The newest click is at
// full strength, so the edges of each clicked node stay distinguishable.
//
// One class on the root <g> dims the links of no trail node (CSS, next to the
// hover rules in styles.css); each trail link carries its age's opacity in
// --cg-tr-o. A link between two trail nodes takes the newer node's strength.
// Hover still wins while the pointer rests on a node. Background click or
// Escape clears the trail.

const TR_ROOT_CLASS = 'cg-trail';
const TR_LINK_CLASS = 'cg-tr';
const TR_MAX = 5;                                  // older clicks drop off
const TR_OPACITY = [1, 0.7, 0.5, 0.35, 0.25];      // by age, newest first

/** Opacity for a click `age` steps old (0 = newest). */
function trailOpacity(age) {
  return TR_OPACITY[Math.min(Math.max(age, 0), TR_OPACITY.length - 1)];
}

function createClickTrail(max = TR_MAX) {
  let ids = [];        // newest first
  let lit = [];
  let root = null;
  return {
    /** A click: the node becomes the newest; returns true if the trail changed. */
    push(id) {
      if (id === undefined || id === null) { return false; }
      if (ids[0] === id) { return false; }
      ids = [id, ...ids.filter(x => x !== id)].slice(0, max);
      return true;
    },
    ids() { return ids.slice(); },
    size() { return ids.length; },
    /** Forget every click; returns true if there was one. */
    reset() {
      const had = ids.length > 0;
      ids = [];
      return had;
    },
    /** Paint the trail onto the current link elements (call after every render). */
    apply(rootEl, linksOf) {
      this.unpaint();
      if (ids.length === 0 || !rootEl) { return 0; }
      root = rootEl;
      root.classList.add(TR_ROOT_CLASS);
      const seen = new Set();
      ids.forEach((id, age) => {
        const o = String(trailOpacity(age));
        for (const el of linksOf(id)) {
          if (seen.has(el)) { continue; }      // a newer click already owns this link
          seen.add(el);
          el.classList.add(TR_LINK_CLASS);
          el.style.setProperty('--cg-tr-o', o);
          lit.push(el);
        }
      });
      return lit.length;
    },
    unpaint() {
      for (const el of lit) {
        el.classList.remove(TR_LINK_CLASS);
        el.style.removeProperty('--cg-tr-o');
      }
      lit = [];
      if (root) { root.classList.remove(TR_ROOT_CLASS); root = null; }
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createClickTrail, trailOpacity, TR_ROOT_CLASS, TR_LINK_CLASS, TR_MAX, TR_OPACITY };
}
