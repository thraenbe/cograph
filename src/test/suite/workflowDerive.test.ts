import * as assert from 'assert';

// workflow.js is a browser global module with a Node `module.exports` guard
// (mirrors clustering.js). It is excluded from TS compilation, so — like
// clustering.test.ts — we reach the source file: out/test/suite → project root
// → src/webview/workflow.js.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deriveWorkflowView, computeColumnX, WORKFLOW_LEVELS } = require('../../../src/webview/workflow.js');

interface WfNode { id: string; name: string; file: string | null; line: number; isLibrary?: boolean; workflow?: Record<string, unknown>; }

function n(id: string, file: string | null, stage: number, tier: string, rank: number, cluster: string): WfNode {
  return { id, name: id, file, line: 1, workflow: { rank, stage, tier, cluster, clusterName: cluster.toUpperCase() } };
}

// 6 internal nodes across 3 stages / 2 tiers + a library node + a ::MAIN::0 entry edge.
function fixture() {
  return {
    nodes: [
      n('a', 'be1.ts', 0, 'backend', 0, 'auth'),
      n('b', 'be1.ts', 0, 'backend', 3, 'auth'),
      n('c', 'svc.ts', 1, 'shared', 1, 'pipeline'),
      n('d', 'svc.ts', 1, 'shared', 4, 'pipeline'),
      n('e', 'ui.tsx', 2, 'frontend', 2, 'render'),
      n('f', 'ui.tsx', 2, 'frontend', 5, 'render'),
      { id: 'lib::x', name: 'x', file: null, line: 0, isLibrary: true },
    ],
    edges: [
      { source: '::MAIN::0', target: 'a' },
      { source: 'a', target: 'c' },
      { source: 'c', target: 'e' },
      { source: 'b', target: 'd' },
    ],
    workflow: { stageCount: 3, dividerStage: 2 },
  };
}

suite('workflow.js — deriveWorkflowView', () => {
  test('level 9 is the identity view (every internal node individual)', () => {
    const v = deriveWorkflowView(fixture(), WORKFLOW_LEVELS - 1);
    assert.strictEqual(v.clusterMembers.size, 6, 'all 6 internal nodes shown individually');
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      assert.strictEqual(v.nodeToCluster.get(id), id, `${id} maps to itself`);
    }
    // library + ::MAIN::0 excluded
    assert.ok(!v.nodeToCluster.has('lib::x'));
    assert.ok(!v.nodeToCluster.has('::MAIN::0'));
  });

  test('level 0 collapses to (stage,tier) cells, surfacing the top-rank function per cell', () => {
    // A 3-node backend cell so the collapse of the remainder is observable.
    const g = {
      nodes: [
        n('a', 'be.ts', 0, 'backend', 0, 'auth'),
        n('b', 'be.ts', 0, 'backend', 3, 'auth'),
        n('h', 'be.ts', 0, 'backend', 6, 'auth'),
        n('c', 'svc.ts', 1, 'shared', 1, 'pipeline'),
        n('e', 'ui.tsx', 2, 'frontend', 2, 'render'),
      ],
      edges: [],
      workflow: { stageCount: 3, dividerStage: 2 },
    };
    const v = deriveWorkflowView(g, 0);
    // Top-rank of the 3-node backend cell is surfaced individually…
    assert.strictEqual(v.nodeToCluster.get('a'), 'a');
    // …and its two lower-ranked cell-mates collapse together into one cell cluster.
    const repB = v.nodeToCluster.get('b');
    assert.notStrictEqual(repB, 'b');
    assert.strictEqual(v.nodeToCluster.get('h'), repB, 'b and h share the collapsed cell cluster');
    // Single-node cells just show their node.
    assert.strictEqual(v.nodeToCluster.get('c'), 'c');
    assert.strictEqual(v.nodeToCluster.get('e'), 'e');
  });

  test('visible cluster count is monotonic non-decreasing for levels 1..9', () => {
    let prev = -1;
    for (let lvl = 1; lvl < WORKFLOW_LEVELS; lvl++) {
      const size = deriveWorkflowView(fixture(), lvl).clusterMembers.size;
      assert.ok(size >= prev, `level ${lvl} count ${size} >= previous ${prev}`);
      prev = size;
    }
  });

  test('layout assigns a stage and tier to every rendered node/cluster', () => {
    const v = deriveWorkflowView(fixture(), WORKFLOW_LEVELS - 1);
    for (const [rep] of v.clusterMembers) {
      const lay = v.layout.get(rep);
      assert.ok(lay, `layout exists for ${rep}`);
      assert.ok(Number.isFinite(lay.stage));
      assert.ok(['backend', 'frontend', 'shared'].includes(lay.tier));
    }
    assert.strictEqual(v.stageCount, 3);
    assert.strictEqual(v.dividerStage, 2);
  });

  test('clamps out-of-range levels', () => {
    const lo = deriveWorkflowView(fixture(), -5);
    const hi = deriveWorkflowView(fixture(), 99);
    assert.ok(lo.clusterMembers.size >= 1);
    assert.strictEqual(hi.clusterMembers.size, 6);
  });

  test('derives a stage count when graph.workflow metadata is absent', () => {
    const g = fixture();
    delete (g as { workflow?: unknown }).workflow;
    const v = deriveWorkflowView(g, 9);
    assert.strictEqual(v.stageCount, 3, 'max stage 2 → stageCount 3');
    assert.strictEqual(v.dividerStage, 2, 'first frontend stage');
  });
});

suite('workflow.js — computeColumnX', () => {
  const W = 1000, M = 100; // usable = 800
  test('stage 0 sits at the left margin', () => {
    assert.strictEqual(computeColumnX(0, 3, W, M), 100);
  });
  test('last stage sits at the right edge', () => {
    assert.strictEqual(computeColumnX(2, 3, W, M), 900);
  });
  test('middle stage is centered between', () => {
    assert.strictEqual(computeColumnX(1, 3, W, M), 500);
  });
  test('single-stage graphs center the column', () => {
    assert.strictEqual(computeColumnX(0, 1, W, M), 500);
  });
  test('clamps out-of-range stage', () => {
    assert.strictEqual(computeColumnX(99, 3, W, M), 900);
    assert.strictEqual(computeColumnX(-1, 3, W, M), 100);
  });
});
