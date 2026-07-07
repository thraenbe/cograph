// workflow.js — deterministic derivation of the AI Workflow Graph's 10 detail
// levels from a single AI-generated workflow model, plus left→right column math.
// All functions are globals; loaded after clustering.js, before main.js.
//
// The AI annotates each node with `node.workflow = {rank, stage, tier, cluster,
// clusterName, isEntry?, isOutput?}`. We turn that model into the same
// `{nodeToCluster, clusterMembers, clusterLabels}` shape that
// computeStructuralClusters returns, so the existing buildClusteredElements can
// render it unchanged. Detail level 0..9 controls how many of the most-important
// functions are surfaced individually vs. collapsed into their topic cluster.

const WORKFLOW_LEVELS = 10; // slider has 10 discrete detail levels (0..9)

function wfStage(n) { const s = n && n.workflow ? n.workflow.stage : 0; return Number.isFinite(s) ? s : 0; }
function wfTier(n) { return (n && n.workflow && n.workflow.tier) || 'shared'; }
function wfRank(n) { const r = n && n.workflow ? n.workflow.rank : Infinity; return Number.isFinite(r) ? r : Infinity; }
function wfCluster(n) { return (n && n.workflow && n.workflow.cluster) || 'misc'; }
function wfClusterName(n) { return (n && n.workflow && n.workflow.clusterName) || wfCluster(n); }

/**
 * Derive a cluster view for a given detail level (0 = most collapsed, 9 = all
 * individual). Returns { nodeToCluster, clusterMembers, clusterLabels, layout,
 * stageCount, dividerStage } — the first three drop straight into
 * buildClusteredElements; `layout` maps each rendered node/cluster id to its
 * { stage, tier } so the left→right layout can place it.
 */
function deriveWorkflowView(data, level) {
  const internal = data.nodes.filter(n => !n.isLibrary && n.id !== '::MAIN::0');
  const lvl = Math.max(0, Math.min(WORKFLOW_LEVELS - 1, Math.round(level)));
  const N = internal.length;

  let stageCount = (data.workflow && data.workflow.stageCount) || 0;
  for (const n of internal) { stageCount = Math.max(stageCount, wfStage(n) + 1); }
  if (stageCount < 1) { stageCount = 1; }

  // Which nodes are shown as individual (un-clustered) at this level.
  const individual = new Set();
  if (lvl <= 0) {
    // Most collapsed: surface only the single most-important function per
    // (stage, tier) cell; everything else collapses into that cell.
    const bestPerCell = new Map();
    for (const n of internal) {
      const key = cellKey(n);
      const cur = bestPerCell.get(key);
      if (!cur || wfRank(n) < wfRank(cur)) { bestPerCell.set(key, n); }
    }
    for (const n of bestPerCell.values()) { individual.add(n.id); }
  } else if (lvl >= WORKFLOW_LEVELS - 1) {
    for (const n of internal) { individual.add(n.id); }
  } else {
    const ranked = [...internal].sort((a, b) => wfRank(a) - wfRank(b));
    const revealCount = Math.ceil((N * lvl) / (WORKFLOW_LEVELS - 1));
    for (let i = 0; i < revealCount && i < ranked.length; i++) { individual.add(ranked[i].id); }
  }

  // Group the non-individual nodes: by (stage,tier) cell at level 0, by topic
  // cluster otherwise.
  const groups = new Map();
  for (const n of internal) {
    if (individual.has(n.id)) { continue; }
    const key = lvl <= 0 ? cellKey(n) : 'topic|' + wfCluster(n);
    if (!groups.has(key)) { groups.set(key, []); }
    groups.get(key).push(n.id);
  }

  const nodeById = new Map(internal.map(n => [n.id, n]));
  const nodeToCluster = new Map();
  const clusterMembers = new Map();
  const clusterLabels = new Map();

  const addSingleton = (id) => { nodeToCluster.set(id, id); clusterMembers.set(id, [id]); };
  for (const id of individual) { addSingleton(id); }

  for (const [key, members] of groups) {
    if (members.length === 1) { addSingleton(members[0]); continue; }
    for (const id of members) { nodeToCluster.set(id, key); }
    clusterMembers.set(key, members);
    clusterLabels.set(key, groupLabel(key, members, nodeById, lvl));
  }

  // Per-rendered-node layout: stage (earliest member) + dominant tier.
  const layout = new Map();
  for (const [rep, members] of clusterMembers) {
    let minStage = Infinity;
    const tierCount = {};
    for (const id of members) {
      const n = nodeById.get(id);
      minStage = Math.min(minStage, wfStage(n));
      const t = wfTier(n);
      tierCount[t] = (tierCount[t] || 0) + 1;
    }
    const tier = Object.keys(tierCount).sort((a, b) => tierCount[b] - tierCount[a])[0] || 'shared';
    layout.set(rep, { stage: Number.isFinite(minStage) ? minStage : 0, tier });
  }

  const dividerStage = (data.workflow && Number.isFinite(data.workflow.dividerStage))
    ? data.workflow.dividerStage
    : defaultDividerStage(internal, stageCount);

  return { nodeToCluster, clusterMembers, clusterLabels, layout, stageCount, dividerStage };
}

/**
 * Largest detail level <= `level` whose derived view renders at most `maxNodes`
 * rendered nodes (issue #52 item 2: the workflow view must stay bounded on huge
 * repos, since the >=500-node complexity auto-cap excludes it). The rendered-node
 * count is `clusterMembers.size` — the distinct nodes buildClusteredElements
 * draws. Level 0 is always allowed (there is no lower level), so the loop
 * terminates; small graphs whose highest level already fits are left untouched.
 */
function clampWorkflowLevel(data, level, maxNodes) {
  let lvl = level;
  while (lvl > 0) {
    if (deriveWorkflowView(data, lvl).clusterMembers.size <= maxNodes) { break; }
    lvl -= 1;
  }
  return lvl;
}

function cellKey(n) { return 'cell|' + wfStage(n) + '|' + wfTier(n); }

function groupLabel(key, members, nodeById, lvl) {
  if (lvl > 0) {
    // Topic cluster: members share an AI cluster name.
    return wfClusterName(nodeById.get(members[0]));
  }
  // Level-0 cell: dominant cluster name among members, else "Stage N".
  const nameCount = {};
  let stage = 0;
  for (const id of members) {
    const n = nodeById.get(id);
    stage = wfStage(n);
    const nm = wfClusterName(n);
    nameCount[nm] = (nameCount[nm] || 0) + 1;
  }
  const best = Object.keys(nameCount).sort((a, b) => nameCount[b] - nameCount[a])[0];
  return best || ('Stage ' + (stage + 1));
}

function defaultDividerStage(internal, stageCount) {
  const frontStages = internal.filter(n => wfTier(n) === 'frontend').map(wfStage);
  return frontStages.length ? Math.min(...frontStages) : stageCount - 1;
}

/** X coordinate for a pipeline column (0 = far left, stageCount-1 = far right). */
function computeColumnX(stage, stageCount, width, marginX) {
  const usable = Math.max(0, width - 2 * marginX);
  if (stageCount <= 1) { return marginX + usable / 2; }
  const clamped = Math.max(0, Math.min(stageCount - 1, stage));
  return marginX + (clamped * usable) / (stageCount - 1);
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
if (typeof module !== 'undefined') {
  module.exports = { deriveWorkflowView, clampWorkflowLevel, computeColumnX, WORKFLOW_LEVELS };
}
