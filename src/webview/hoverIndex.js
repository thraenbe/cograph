// hoverIndex.js — O(degree) hover highlighting. The hover handlers used to
// re-attribute EVERY link three times per mouseover/mouseout; now one class on
// the root <g> dims all links (CSS, see the perf block at the end of
// styles.css) and only the hovered node's own links get the highlight class.
// The index is rebuilt lazily when the link/label selections change (a render
// replaces state.svgLinks / state.svgLabels with new selection objects).

const HI_ROOT_CLASS = 'cg-hovering';
const HI_LINK_CLASS = 'cg-hl';
const HI_WIDE_CLASS = 'cg-hl-w';   // also thicken (node hover; library hover keeps widths)
// fb14 D4 hover focus (function hover): the hovered node and its callers/callees carry
// cg-nb, the hovered node's own lines are LIFTED above the nodes (moved, not copied, so
// position writes keep reaching them) and put back exactly where they were on clear;
// dim() then adds cg-focus on the root (CSS dims every node without cg-nb to 0.2).
const HI_FOCUS_CLASS = 'cg-focus';
const HI_NB_CLASS = 'cg-nb';

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

/** node id → [elements] over several selections (circles, glyphs); null selections skipped. */
function buildNodeIndex(sels) {
  const byNode = new Map();
  for (const sel of sels) {
    if (!sel) { continue; }
    for (const el of sel.nodes()) {
      const d = el && el.__data__;
      if (!d || d.id === undefined) { continue; }
      const arr = byNode.get(d.id);
      if (arr) { arr.push(el); } else { byNode.set(d.id, [el]); }
    }
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
  let linkSel = null, labelSel = null, nodeSels = [];
  let links = new Map(), labels = new Map(), nodes = new Map();
  let lit = [];
  let root = null;
  let marked = [];   // elements carrying cg-nb
  let lifted = [];   // { el, parent, next } in lift order
  const unlift = () => {
    // reverse order: each element's remembered next sibling is back in place first
    for (let i = lifted.length - 1; i >= 0; i--) {
      const p = lifted[i];
      if (p.el.parentNode && p.parent) {
        p.parent.insertBefore(p.el, p.next && p.next.parentNode === p.parent ? p.next : null);
      }
    }
    lifted = [];
  };
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
    /** Node elements, re-indexed only when one of the selection objects changed (lazy: first focus after a render). */
    syncNodes(sels) {
      if (sels.length !== nodeSels.length || sels.some((x, i) => x !== nodeSels[i])) {
        nodeSels = sels.slice();
        nodes = buildNodeIndex(sels);
      }
    },
    nodesOf(id) { return nodes.get(id) || []; },
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
    /**
     * Function hover: highlight, then mark the node + its neighbours (ends of its lines
     * plus `extraIds`, e.g. cross-frame partners) and lift its lines into liftTo(el)
     * (a parent element above the nodes, or null to leave a line where it is).
     * Returns the neighbour id set (hovered id included).
     */
    focus(rootEl, id, hlWidth, extraIds, liftTo) {
      this.highlight(rootEl, id, hlWidth);
      const ids = new Set([id]);
      for (const el of lit) {
        const d = el.__data__;
        ids.add(hiIdOf(d.source)); ids.add(hiIdOf(d.target));
      }
      for (const x of extraIds || []) { ids.add(x); }
      for (const nid of ids) {
        for (const el of this.nodesOf(nid)) { el.classList.add(HI_NB_CLASS); marked.push(el); }
      }
      if (liftTo) {
        for (const el of lit) {
          const target = liftTo(el);
          if (!target || target === el.parentNode) { continue; }
          lifted.push({ el, parent: el.parentNode, next: el.nextSibling });
          target.appendChild(el);
        }
      }
      return ids;
    },
    /**
     * Dim everything but the marked nodes (root class). Separate from focus(): the
     * caller applies it after a short dwell, because dimming repaints the whole view.
     */
    dim() { if (root && marked.length) { root.classList.add(HI_FOCUS_CLASS); } return !!root; },
    /** Lines currently lifted (test + debug hook). */
    liftedCount() { return lifted.length; },
    /** Put lifted lines back (before a re-render's joins); classes stay. */
    unlift,
    clear() {
      unlift();
      for (const el of marked) { el.classList.remove(HI_NB_CLASS); }
      marked = [];
      for (const el of lit) { el.classList.remove(HI_LINK_CLASS, HI_WIDE_CLASS); }
      lit = [];
      if (root) { root.classList.remove(HI_ROOT_CLASS, HI_FOCUS_CLASS); root = null; }
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    createHoverIndex, buildLinkIndex, buildLabelIndex, buildNodeIndex,
    HI_ROOT_CLASS, HI_LINK_CLASS, HI_WIDE_CLASS, HI_FOCUS_CLASS, HI_NB_CLASS,
  };
}
