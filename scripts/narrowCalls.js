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

/** Attach the counters to the output graph — only when something happened, so
 *  graphs without an ambiguous name stay byte-identical to the previous format. */
function withStats(graph, stats) {
  if (!stats || (!stats.ambiguousNarrowed && !stats.ambiguousDropped)) { return graph; }
  return { ...graph, stats: { ...stats } };
}

module.exports = { createNarrower, withStats, topLevelOf, MAX_CANDIDATES };
