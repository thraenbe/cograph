// hoverIndex.js — O(degree) hover highlighting. The hover handlers used to
// re-attribute EVERY link three times per mouseover/mouseout; now one class on
// the root <g> dims all links (CSS, see the perf block at the end of
// styles.css) and only the hovered node's own links get the highlight class.
// The index is rebuilt lazily when the link/label selections change (a render
// replaces state.svgLinks / state.svgLabels with new selection objects).

const HI_ROOT_CLASS = 'cg-hovering';
const HI_LINK_CLASS = 'cg-hl';
const HI_WIDE_CLASS = 'cg-hl-w';   // also thicken (node hover; library hover keeps widths)

const hiIdOf = (e) => (e && typeof e === 'object' ? e.id : e);

/** node id → [link elements]; elements carry their datum as d3's __data__. */
function buildLinkIndex(linkEls) {
  const byNode = new Map();
  const add = (id, el) => {
    const arr = byNode.get(id);
    if (arr) { arr.push(el); } else { byNode.set(id, [el]); }
  };
  for (const el of linkEls) {
    const d = el && el.__data__;
    if (!d) { continue; }
    const s = hiIdOf(d.source);
    const t = hiIdOf(d.target);
    add(s, el);
    if (t !== s) { add(t, el); }
  }
  return byNode;
}

/** node id → label element. */
function buildLabelIndex(labelEls) {
  const byNode = new Map();
  for (const el of labelEls) {
    const d = el && el.__data__;
    if (d && d.id !== undefined) { byNode.set(d.id, el); }
  }
  return byNode;
}

function createHoverIndex() {
  let linkSel = null, labelSel = null;
  let links = new Map(), labels = new Map();
  let lit = [];
  let root = null;
  return {
    /** Re-index only when a render swapped the selection objects. */
    sync(nextLinkSel, nextLabelSel) {
      if (nextLinkSel !== linkSel) {
        linkSel = nextLinkSel;
        links = buildLinkIndex(nextLinkSel ? nextLinkSel.nodes() : []);
      }
      if (nextLabelSel !== labelSel) {
        labelSel = nextLabelSel;
        labels = buildLabelIndex(nextLabelSel ? nextLabelSel.nodes() : []);
      }
    },
    linksOf(id) { return links.get(id) || []; },
    labelOf(id) { return labels.get(id) || null; },
    /** Dim everything via the root class, light the node's own links. */
    highlight(rootEl, id, hlWidth) {
      this.clear();
      root = rootEl;
      const wide = hlWidth != null;
      if (root) {
        root.classList.add(HI_ROOT_CLASS);
        if (wide) { root.style.setProperty('--cg-hl-width', String(hlWidth)); }
      }
      lit = this.linksOf(id);
      for (const el of lit) {
        el.classList.add(HI_LINK_CLASS);
        if (wide) { el.classList.add(HI_WIDE_CLASS); }
      }
      return lit.length;
    },
    clear() {
      for (const el of lit) { el.classList.remove(HI_LINK_CLASS, HI_WIDE_CLASS); }
      lit = [];
      if (root) { root.classList.remove(HI_ROOT_CLASS); root = null; }
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { createHoverIndex, buildLinkIndex, buildLabelIndex, HI_ROOT_CLASS, HI_LINK_CLASS, HI_WIDE_CLASS };
}
