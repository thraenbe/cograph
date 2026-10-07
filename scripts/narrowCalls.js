// narrowCalls.js — resolution of ambiguous call names (decision D6), shared by
// the node analyzers and mirrored 1:1 in analyze.py (_narrow_candidates).
//
// A bare-name call (`get()`, `this.size()`) used to be linked to EVERY
// definition with that name in the workspace. On large repos that is mostly
// noise (guava: 2.65 M edges, one call site → 1 926 targets) and it costs
// analysis, transport, layout and cross-folder bundling downstream.
//
// Rule: up to MAX_CANDIDATES (8) definitions → unchanged (small and medium
// repos keep byte-identical graphs). Above that the candidates are narrowed,
// stage by stage, to those in the caller's file → directory → top-level
// package (first path segment under the workspace root). A stage that matches
// nothing is skipped; as soon as the pool is ≤ 8 it is used. Still more than 8
// after all stages → the call is dropped as unresolvable.
'use strict';

const path = require('path');

// COGRAPH_MAX_CANDIDATES overrides the limit (tests use a huge value to prove that an
// inactive narrowing leaves the output byte-identical).
const MAX_CANDIDATES = Number(process.env.COGRAPH_MAX_CANDIDATES) || 8;

function topLevelOf(file, root) {
  const rel = path.relative(root || '', file || '');
  if (!rel || rel.startsWith('..')) { return ''; }
  const seg = rel.split(/[\\/]+/);
  return seg.length > 1 ? seg[0] : '';        // files directly in the root share ''
}

/**
 * fileOf(id) → absolute file of a definition. Returns { narrow, stats }.
 * narrow(ids, callerFile) → the ids to link (the same array when nothing changed).
 */
function createNarrower(fileOf, root, maxCandidates) {
  const max = maxCandidates || MAX_CANDIDATES;
  const stats = { ambiguousNarrowed: 0, ambiguousDropped: 0 };
  const stages = [
    (f, caller) => f === caller,
    (f, caller) => path.dirname(f) === path.dirname(caller),
    (f, caller) => topLevelOf(f, root) === topLevelOf(caller, root),
  ];
  function narrow(ids, callerFile) {
    if (!ids || ids.length <= max) { return ids; }
    let pool = ids;
    for (const same of stages) {
      const subset = pool.filter(id => { const f = fileOf(id); return !!f && same(f, callerFile); });
      if (!subset.length) { continue; }
      pool = subset;
      if (pool.length <= max) { stats.ambiguousNarrowed++; return pool; }
    }
    stats.ambiguousDropped++;
    return [];
  }
  return { narrow, stats };
}

const MAX_EXTENDS_DEPTH = 6;
const extendsCache = new WeakMap();

/** className → classExtends, built once per definitions object. */
function extendsMap(definitions) {
  let m = extendsCache.get(definitions);
  if (!m) {
    m = new Map();
    for (const d of Object.values(definitions)) {
      if (d && d.className && d.classExtends && !m.has(d.className)) { m.set(d.className, d.classExtends); }
    }
    extendsCache.set(definitions, m);
  }
  return m;
}

/**
 * Targets of a `this.name()` call. `this` is the caller's own object, so prefer, in order:
 * 1. methods of the caller's class in the caller's file;
 * 2. methods of its base classes, walking `classExtends` by class name (nearest first).
 * Inside a class nothing else can be `this.name` (an unrelated class's method or a free
 * function would be a guess; an external base class's method is not in the graph), so
 * a class caller with no hit gets no edge. Outside a class (object literals, prototype
 * code) every definition named `name` is a candidate. Pools after step 1 go through `narrow`.
 */
function resolveThisCall(ids, callerDef, definitions, narrow, callerFile) {
  if (!ids || !ids.length) { return []; }
  const cls = callerDef && callerDef.className;
  if (cls) {
    const own = ids.filter(id => definitions[id] && definitions[id].className === cls
      && definitions[id].file === callerDef.file);
    if (own.length) { return own; }
    let base = callerDef.classExtends || extendsMap(definitions).get(cls);
    for (let depth = 0; base && depth < MAX_EXTENDS_DEPTH; depth++) {
      const name = base;
      const inherited = ids.filter(id => definitions[id] && definitions[id].className === name);
      if (inherited.length) { return narrow(inherited, callerFile); }
      base = extendsMap(definitions).get(name);
    }
    return [];
  }
  return narrow(ids, callerFile);
}

/** Attach the counters to the output graph — only when something happened, so
 *  graphs without an ambiguous name stay byte-identical to the previous format. */
function withStats(graph, stats) {
  if (!stats || (!stats.ambiguousNarrowed && !stats.ambiguousDropped)) { return graph; }
  return { ...graph, stats: { ...stats } };
}

module.exports = { createNarrower, withStats, topLevelOf, resolveThisCall, MAX_CANDIDATES };
