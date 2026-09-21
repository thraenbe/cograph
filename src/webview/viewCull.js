// viewCull.js — what is worth painting at the current zoom transform (W3).
//   · viewportRect: the visible part of graph space (+ padding) for a d3 zoom
//     transform, so frames can be tested with frames.js rect maths.
//   · createFrameCuller: diff of visible frame paths between two calls — the
//     caller flips `display` only on frames that entered/left the viewport.
//   · createLod: level of detail from the zoom factor with hysteresis, so a
//     zoom gesture hovering around a threshold does not flicker.
// Pure logic: no DOM, no d3, no globals.

/** Graph-space rect covered by a `width`×`height` viewport under transform t={x,y,k}. */
function viewportRect(t, width, height, padPx) {
  const k = t.k || 1;
  const pad = (padPx ?? 0) / k;
  return {
    x: (0 - t.x) / k - pad,
    y: (0 - t.y) / k - pad,
    w: width / k + 2 * pad,
    h: height / k + 2 * pad,
  };
}

function rectsTouch(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function createFrameCuller() {
  let visible = null; // Set of paths visible after the last update (null = everything)
  let known = new Set(); // paths seen by the last update (a new frame's <g> starts visible)
  return {
    /**
     * frames: iterable of { path, abs:{x,y,w,h} }. Returns the paths whose
     * visibility flipped since the previous call; first call reports only
     * what must be hidden (everything starts visible).
     */
    update(frames, view) {
      const next = new Set();
      const seen = new Set();
      const shown = [], hidden = [];
      for (const f of frames) {
        const on = rectsTouch(f.abs, view);
        if (on) { next.add(f.path); }
        seen.add(f.path);
        const was = (visible && known.has(f.path)) ? visible.has(f.path) : true;
        if (on && !was) { shown.push(f.path); } else if (!on && was) { hidden.push(f.path); }
      }
      visible = next;
      known = seen;
      return { shown, hidden };
    },
    isVisible(path) { return visible ? visible.has(path) : true; },
    visibleCount() { return visible ? visible.size : -1; },
    /** A re-render replaced the frame elements: everything is visible again. */
    reset() { visible = null; known = new Set(); },
  };
}

/**
 * Level of detail by zoom factor. `at` = { labels, links, nodes }: the zoom
 * factor at (and above) which each layer is drawn. Hysteresis: once shown, a
 * layer is only hidden again below threshold × (1 − band).
 */
function createLod(opts) {
  const band = (opts && opts.band) ?? 0.08;
  const LAYERS = ['labels', 'links', 'nodes'];
  let state = { labels: true, links: true, nodes: true };
  return {
    update(k, at) {
      const n = {};
      let changed = false;
      for (const layer of LAYERS) {
        const threshold = at[layer] ?? 0;
        n[layer] = state[layer] ? k >= threshold * (1 - band) : k >= threshold;
        if (n[layer] !== state[layer]) { changed = true; }
      }
      state = n;
      return { ...n, changed };
    },
    current() { return { ...state }; },
  };
}

/**
 * Element budget while a pan/zoom gesture is running: when more full-detail
 * content is on screen than the renderer can repaint per frame, labels and
 * then intra-frame links are dropped for the duration of the gesture (they
 * come back when it ends). `counts` = { nodes, links } currently in the viewport.
 */
function gestureBudget(counts, budget) {
  const b = { labels: 1500, links: 5000, ...(budget || {}) };
  return {
    labels: counts.nodes <= b.labels,
    links: counts.links <= b.links,
  };
}

if (typeof module !== 'undefined') {
  module.exports = { viewportRect, rectsTouch, createFrameCuller, createLod, gestureBudget };
}
