// Pure size-based tuning decisions for the force layout (issues #52, #27).
// No DOM, no d3 — keep it require()-able from Node tests (see aggregate.js).

// Above this rendered-node count the simulation gets the "large graph"
// treatment: faster settle, no collide force, no global reheat on drag.
const LARGE_GRAPH_NODE_THRESHOLD = 800;
// computeForceDefaults interpolates between these two sizes.
const FORCE_SCALE_MIN_NODES = 500;
const FORCE_SCALE_MAX_NODES = 3000;
// Large graphs stop simulating below this alpha (d3 default alphaMin is
// 0.001 — stopping at 0.05 saves the long low-energy tail of ticks).
const SETTLE_ALPHA_LARGE = 0.05;
const ALPHA_DECAY_SMALL = 0.02; // current value in startSimulation
const ALPHA_DECAY_LARGE = 0.05;
// Cap on rendered workflow-view nodes (issue #52 item 2).
const WORKFLOW_MAX_NODES = 400;

function isLargeGraph(nodeCount) {
  return nodeCount >= LARGE_GRAPH_NODE_THRESHOLD;
}

// Dynamic per-repo force defaults (issue #27): small graphs keep today's
// values; large graphs get stronger centering and weaker repel so the
// layout stays compact instead of exploding.
function computeForceDefaults(nodeCount) {
  const span = FORCE_SCALE_MAX_NODES - FORCE_SCALE_MIN_NODES;
  const t = Math.max(0, Math.min(1, (nodeCount - FORCE_SCALE_MIN_NODES) / span));
  return {
    centerForce: Math.round((0.05 + t * 0.10) * 1000) / 1000,
    repelForce: Math.round(250 - t * 170),
    linkForce: 1,
  };
}

function alphaDecayFor(nodeCount) {
  return isLargeGraph(nodeCount) ? ALPHA_DECAY_LARGE : ALPHA_DECAY_SMALL;
}

function useCollide(nodeCount) {
  return !isLargeGraph(nodeCount);
}

function dragShouldReheat(nodeCount) {
  return !isLargeGraph(nodeCount);
}

function shouldFreeze(alpha, nodeCount) {
  return isLargeGraph(nodeCount) && alpha < SETTLE_ALPHA_LARGE;
}

if (typeof module !== 'undefined') {
  module.exports = {
    LARGE_GRAPH_NODE_THRESHOLD,
    WORKFLOW_MAX_NODES,
    isLargeGraph,
    computeForceDefaults,
    alphaDecayFor,
    useCollide,
    dragShouldReheat,
    shouldFreeze,
  };
}
