// visibility.js — cheap visibility bookkeeping for the filter path.
//   · createVisibleMemo: getVisibleNodeIds ran an O(N) scan on every call
//     (1-2× per simulation tick in drill-down); the memo returns the previous
//     Set while every input it depends on is unchanged.
//   · createFilterApplier: a keystroke used to rewrite `display` on every
//     node, label and link; now only elements whose visibility flipped are
//     touched (full pass kept as fallback for big flips / fresh renders).
//   · createBurstGate: first call in an animation frame runs synchronously,
//     further calls in the same frame collapse into one trailing run.
// Pure logic + element style writes; no d3, no globals.

/** Inputs → comparable key. Reference inputs are compared by identity. */
function visibleKey(inp) {
  return JSON.stringify([
    inp.query, !!inp.showLibraries, !!inp.existingFilesOnly, !!inp.showOrphans,
    inp.nodes ? inp.nodes.length : 0, inp.connected ? inp.connected.size : 0,
    inp.onlyShowFolder ?? null, inp.hiddenFolders ? [...inp.hiddenFolders] : [],
  ]);
}

function createVisibleMemo() {
  let last = null; // { key, nodes, connected, set }
  return {
    /** `inp.volatile` (e.g. a timeline predicate with internal state) bypasses the memo. */
    get(inp, compute) {
      if (inp.volatile) { last = null; return compute(); }
      const key = visibleKey(inp);
      if (last && last.key === key && last.nodes === inp.nodes && last.connected === inp.connected) {
        return last.set;
      }
      const set = compute();
      last = { key, nodes: inp.nodes, connected: inp.connected, set };
      return set;
    },
    invalidate() { last = null; },
  };
}

const visIdOf = (e) => (e && typeof e === 'object' ? e.id : e);

function setDisplay(el, visible) {
  if (visible) { el.style.removeProperty('display'); }
  else { el.style.setProperty('display', 'none'); }
}

function pushTo(map, id, el) {
  const arr = map.get(id);
  if (arr) { arr.push(el); } else { map.set(id, [el]); }
}

function symmetricDiff(a, b) {
  const out = [];
  for (const id of a) { if (!b.has(id)) { out.push(id); } }
  for (const id of b) { if (!a.has(id)) { out.push(id); } }
  return out;
}

/** Index of node-ish and link elements by node id (elements carry d3's __data__). */
function indexElements(sels) {
  const idx = { elsById: new Map(), linksById: new Map(), all: [], allLinks: [] };
  for (const sel of sels.nodes) {
    if (!sel) { continue; }
    for (const el of sel.nodes()) {
      const d = el.__data__;
      if (!d || d.id === undefined) { continue; }
      idx.all.push(el);
      pushTo(idx.elsById, d.id, el);
    }
  }
  for (const el of (sels.links ? sels.links.nodes() : [])) {
    const d = el.__data__;
    if (!d) { continue; }
    idx.allLinks.push(el);
    const s = visIdOf(d.source), t = visIdOf(d.target);
    pushTo(idx.linksById, s, el);
    if (t !== s) { pushTo(idx.linksById, t, el); }
  }
  return idx;
}

function linkVisible(el, vis) {
  const d = el.__data__;
  return vis.has(visIdOf(d.source)) && vis.has(visIdOf(d.target));
}

/**
 * Applies a visible-id Set to element groups, touching only what changed.
 * `sels` = { nodes: [selection|null…], links: selection|null } (d3-like:
 * identity changes on re-render, `.nodes()` lists elements with `__data__`).
 */
function createFilterApplier(opts) {
  const maxDiffRatio = (opts && opts.maxDiffRatio) ?? 0.25;
  let seen = null;   // selection identities of the last apply
  let prev = null;   // Set applied last time
  let idx = indexElements({ nodes: [], links: null });

  function sameSels(sels) {
    return !!seen && seen.links === sels.links && seen.nodes.length === sels.nodes.length
      && seen.nodes.every((s, i) => s === sels.nodes[i]);
  }

  function full(vis) {
    for (const el of idx.all) { setDisplay(el, vis.has(el.__data__.id)); }
    for (const el of idx.allLinks) { setDisplay(el, linkVisible(el, vis)); }
    return idx.all.length + idx.allLinks.length;
  }

  function diff(changed, vis) {
    let written = 0;
    const touchedLinks = new Set();
    for (const id of changed) {
      const on = vis.has(id);
      for (const el of idx.elsById.get(id) || []) { setDisplay(el, on); written++; }
      for (const el of idx.linksById.get(id) || []) { touchedLinks.add(el); }
    }
    for (const el of touchedLinks) { setDisplay(el, linkVisible(el, vis)); written++; }
    return written;
  }

  return {
    /** Returns the number of elements written (full pass or diff). */
    apply(sels, vis) {
      const fresh = !sameSels(sels);
      if (fresh) {
        idx = indexElements(sels);
        seen = { links: sels.links, nodes: [...sels.nodes] };
      }
      const changed = (fresh || !prev) ? null : symmetricDiff(prev, vis);
      const tooMany = changed && changed.length > maxDiffRatio * Math.max(1, idx.elsById.size);
      const written = (!changed || tooMany) ? full(vis) : diff(changed, vis);
      prev = vis;
      return written;
    },
    reset() { seen = null; prev = null; },
  };
}

/**
 * Burst gate: run(fn) executes fn immediately unless it already ran in this
 * animation frame — then one trailing run is scheduled (last call wins).
 */
function createBurstGate(raf) {
  let ranThisFrame = false, trailing = null, armed = false;
  function arm() {
    if (armed) { return; }
    armed = true;
    raf(() => {
      armed = false;
      ranThisFrame = false;
      if (!trailing) { return; }
      const fn = trailing;
      trailing = null;
      ranThisFrame = true;
      arm();
      fn();
    });
  }
  return {
    run(fn) {
      if (typeof raf !== 'function') { fn(); return; }
      if (ranThisFrame) { trailing = fn; return; }
      ranThisFrame = true;
      arm();
      fn();
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    visibleKey, createVisibleMemo, createFilterApplier, symmetricDiff, indexElements, createBurstGate,
  };
}
