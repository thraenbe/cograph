import * as assert from 'assert';
import {
  WORKFLOW_PROMPT,
  buildWorkflowPrompt,
  validateWorkflowModel,
  normalizeWorkflowModel,
} from '../../graphIntelligence/workflowPrompt';
import { extractCographResult } from '../../graphIntelligence/jsonRepair';
import type { GraphData } from '../../graphProvider';
import type { ProgressEvent } from '../../graphIntelligence/progressParser';

function node(id: string, file: string | null, wf?: Partial<NonNullable<GraphData['nodes'][number]['workflow']>>): GraphData['nodes'][number] {
  return { id, name: id, file, line: 1, ...(wf ? { workflow: wf as never } : {}) };
}

suite('workflowPrompt — prompt text', () => {
  test('prompt names every required workflow field', () => {
    for (const field of ['rank', 'stage', 'tier', 'cluster', 'clusterName', 'isEntry', 'isOutput', 'dividerStage', 'stageCount']) {
      assert.ok(WORKFLOW_PROMPT.includes(field), `prompt should mention "${field}"`);
    }
  });
  test('buildWorkflowPrompt appends the task', () => {
    const p = buildWorkflowPrompt('Do the thing.');
    assert.ok(p.startsWith(WORKFLOW_PROMPT));
    assert.ok(p.endsWith('Do the thing.'));
  });
});

suite('workflowPrompt — validateWorkflowModel', () => {
  test('rejects a graph without nodes/edges arrays', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(validateWorkflowModel({} as any).ok, false);
    assert.strictEqual(validateWorkflowModel(null).ok, false);
  });
  test('rejects a plain graph with no workflow annotations', () => {
    const g: GraphData = { nodes: [node('a', 'f.ts')], edges: [] };
    const v = validateWorkflowModel(g);
    assert.strictEqual(v.ok, false);
    assert.ok(v.errors.length > 0);
  });
  test('accepts a graph with at least one annotated node', () => {
    const g: GraphData = { nodes: [node('a', 'f.ts', { rank: 0, stage: 0, tier: 'backend', cluster: 'c', clusterName: 'C' })], edges: [] };
    assert.strictEqual(validateWorkflowModel(g).ok, true);
  });
});

suite('workflowPrompt — normalizeWorkflowModel', () => {
  test('fills missing fields and produces a clean 0..N-1 rank order', () => {
    const g: GraphData = {
      nodes: [
        node('a', 'a.ts', { stage: 0, tier: 'backend', cluster: 'core', clusterName: 'Core' }),
        node('b', 'a.ts'),               // no workflow at all
        node('c', 'ui/x.ts', { tier: 'frontend' }),
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
      ],
    };
    const out = normalizeWorkflowModel(g);
    const ranks = out.nodes.map(n => n.workflow!.rank).sort((x, y) => x - y);
    assert.deepStrictEqual(ranks, [0, 1, 2], 'ranks form a contiguous 0..N-1 set');
    // every internal node has a complete workflow object
    for (const n of out.nodes) {
      assert.ok(n.workflow, `node ${n.id} should be annotated`);
      assert.ok(['backend', 'frontend', 'shared'].includes(n.workflow!.tier));
      assert.ok(n.workflow!.cluster.length > 0);
      assert.ok(n.workflow!.clusterName.length > 0);
    }
  });

  test('clamps stage into range and defaults tier to shared', () => {
    const g: GraphData = {
      nodes: [
        node('a', 'a.ts', { stage: 0, tier: 'backend', cluster: 'c', clusterName: 'C' }),
        node('b', 'b.ts', { stage: 99 }),   // out of range, no tier
      ],
      edges: [],
    };
    const out = normalizeWorkflowModel(g);
    const b = out.nodes.find(n => n.id === 'b')!;
    assert.ok(b.workflow!.stage < out.workflow!.stageCount);
    assert.strictEqual(b.workflow!.tier, 'shared');
  });

  test('infers edge scope from endpoint files and defaults kind to static', () => {
    const g: GraphData = {
      nodes: [node('a', 'same.ts', { tier: 'backend' }), node('b', 'same.ts'), node('c', 'other.ts')],
      edges: [
        { source: 'a', target: 'b' },           // same file → intra-file
        { source: 'a', target: 'c' },           // diff file → inter-file
      ],
    };
    const out = normalizeWorkflowModel(g);
    assert.strictEqual(out.edges[0].workflow!.scope, 'intra-file');
    assert.strictEqual(out.edges[1].workflow!.scope, 'inter-file');
    assert.strictEqual(out.edges[0].workflow!.kind, 'static');
  });

  test('preserves AI-provided dynamic edges and labels', () => {
    const g: GraphData = {
      nodes: [node('a', 'a.ts', { tier: 'backend' }), node('b', 'b.ts')],
      edges: [{ source: 'a', target: 'b', workflow: { kind: 'dynamic', scope: 'inter-file', label: 'emits event', confidence: 0.6 } }],
    };
    const out = normalizeWorkflowModel(g);
    assert.strictEqual(out.edges[0].workflow!.kind, 'dynamic');
    assert.strictEqual(out.edges[0].workflow!.label, 'emits event');
    assert.strictEqual(out.edges[0].workflow!.confidence, 0.6);
  });

  test('builds graph-level workflow metadata with a divider at the first frontend stage', () => {
    const g: GraphData = {
      nodes: [
        node('a', 'a.ts', { stage: 0, tier: 'backend', cluster: 'be', clusterName: 'Backend' }),
        node('b', 'b.ts', { stage: 1, tier: 'shared', cluster: 'mid', clusterName: 'Middle' }),
        node('c', 'ui.ts', { stage: 2, tier: 'frontend', cluster: 'fe', clusterName: 'Frontend' }),
      ],
      edges: [],
    };
    const out = normalizeWorkflowModel(g);
    assert.strictEqual(out.workflow!.stageCount, 3);
    assert.strictEqual(out.workflow!.dividerStage, 2);
    assert.strictEqual(out.workflow!.clusters.length, 3);
  });

  test('does not mutate the input graph', () => {
    const g: GraphData = { nodes: [node('a', 'a.ts')], edges: [{ source: 'a', target: 'a' }] };
    normalizeWorkflowModel(g);
    assert.strictEqual(g.nodes[0].workflow, undefined);
    assert.strictEqual(g.edges[0].workflow, undefined);
  });
});

suite('workflowPrompt — extra fields survive extractCographResult', () => {
  test('workflow annotations pass through the result extractor untouched', () => {
    const model = {
      text: '## Workflow\nAll good.',
      graph: {
        nodes: [{ id: 'a', name: 'a', file: 'a.ts', line: 1, workflow: { rank: 0, stage: 0, tier: 'backend', cluster: 'c', clusterName: 'C' } }],
        edges: [{ source: 'a', target: 'a', workflow: { kind: 'static', scope: 'intra-file' } }],
        workflow: { stageCount: 2, dividerStage: 1, clusters: [] },
      },
    };
    const ev = { kind: 'result', text: JSON.stringify(model), structured: null } as unknown as ProgressEvent & { kind: 'result' };
    const out = extractCographResult(ev);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = out.graph as any;
    assert.strictEqual(g.nodes[0].workflow.tier, 'backend');
    assert.strictEqual(g.edges[0].workflow.scope, 'intra-file');
    assert.strictEqual(g.workflow.dividerStage, 1);
  });
});
