import * as assert from 'assert';

// clustering.js lives under src/webview/ (excluded from TS compilation).
// At runtime this compiled file is at out/test/suite/, so three levels up
// lands at the project root, then down to src/webview/clustering.js.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  UnionFind,
  computeImportanceScores,
  computeClusters,
  computeStructuralClusters,
  buildClusteredElements,
  inferProjectName,
} = require('../../../src/webview/clustering.js');

// ---------------------------------------------------------------------------
// UnionFind
// ---------------------------------------------------------------------------

suite('UnionFind', () => {
  test('find returns self for singleton', () => {
    const uf = new UnionFind(['a']);
    assert.strictEqual(uf.find('a'), 'a');
  });

  test('union merges two components and returns true', () => {
    const uf = new UnionFind(['a', 'b']);
    const merged = uf.union('a', 'b');
    assert.strictEqual(merged, true);
    assert.strictEqual(uf.find('a'), uf.find('b'));
  });

  test('second union of already merged pair returns false', () => {
    const uf = new UnionFind(['a', 'b']);
    uf.union('a', 'b');
    assert.strictEqual(uf.union('a', 'b'), false);
  });

  test('path compression: repeated find returns canonical root', () => {
    const uf = new UnionFind(['a', 'b', 'c']);
    uf.union('a', 'b');
    uf.union('b', 'c');
    const root = uf.find('a');
    assert.strictEqual(uf.find('c'), root);
    assert.strictEqual(uf.find('a'), root);
  });

  test('rank-based union: higher-rank root absorbs lower-rank tree', () => {
    const uf = new UnionFind(['a', 'b', 'c', 'd']);
    // union(a,b): both rank 0 → b under a, rank(a)=1
    uf.union('a', 'b');
    // union(a,c): rank(a)=1 > rank(c)=0 → c under a
    uf.union('a', 'c');
    // union(a,d): rank(a)=1 > rank(d)=0 → d under a
    uf.union('a', 'd');
    assert.strictEqual(uf.find('d'), uf.find('a'));
    assert.strictEqual(uf.find('b'), uf.find('a'));
  });
});

// ---------------------------------------------------------------------------
// inferProjectName
// ---------------------------------------------------------------------------

suite('inferProjectName', () => {
  test('empty nodes → "Project"', () => {
    assert.strictEqual(inferProjectName({ nodes: [] }), 'Project');
  });

  test('single file returns the filename as the last common segment', () => {
    const result = inferProjectName({ nodes: [{ file: 'some/path/main.py' }] });
    assert.strictEqual(result, 'main.py');
  });

  test('multiple files sharing a common directory → returns that directory name', () => {
    const result = inferProjectName({
      nodes: [
        { file: '/home/user/myproject/a.py' },
        { file: '/home/user/myproject/b.py' },
      ],
    });
    assert.strictEqual(result, 'myproject');
  });

  test('files with no common prefix (relative paths) → "Project"', () => {
    const result = inferProjectName({
      nodes: [
        { file: 'alpha/foo.py' },
        { file: 'beta/bar.py' },
      ],
    });
    assert.strictEqual(result, 'Project');
  });

  test('Windows backslash paths → returns common directory name', () => {
    const result = inferProjectName({
      nodes: [
        { file: 'C:\\Users\\user\\myproject\\a.py' },
        { file: 'C:\\Users\\user\\myproject\\b.py' },
      ],
    });
    assert.strictEqual(result, 'myproject');
  });

  test('mixed forward/backslash paths → returns common directory name', () => {
    const result = inferProjectName({
      nodes: [
        { file: 'C:\\Users\\user\\myproject\\a.py' },
        { file: 'C:/Users/user/myproject/b.py' },
      ],
    });
    assert.strictEqual(result, 'myproject');
  });
});

// ---------------------------------------------------------------------------
// computeImportanceScores
// ---------------------------------------------------------------------------

suite('computeImportanceScores', () => {
  test('empty graph → empty Map', () => {
    const scores = computeImportanceScores({ nodes: [], edges: [] });
    assert.ok(scores instanceof Map);
    assert.strictEqual(scores.size, 0);
  });

  test('isolated nodes with no edges → all zero scores', () => {
    const data = { nodes: [{ id: 'a' }, { id: 'b' }], edges: [] };
    const scores = computeImportanceScores(data);
    assert.strictEqual(scores.get('a'), 0);
    assert.strictEqual(scores.get('b'), 0);
  });

  test('entry-point node scores higher than unreachable node', () => {
    const data = {
      nodes: [{ id: 'entry' }, { id: 'isolated' }],
      edges: [{ source: '::MAIN::0', target: 'entry' }],
    };
    const scores = computeImportanceScores(data);
    assert.ok(
      (scores.get('entry') as number) > (scores.get('isolated') as number),
      'entry point should score higher than isolated node'
    );
  });

  test('node with higher in-degree scores higher', () => {
    const data = {
      nodes: [
        { id: 'high' }, { id: 'low' },
        { id: 'caller1' }, { id: 'caller2' }, { id: 'caller3' },
      ],
      edges: [
        { source: 'caller1', target: 'high' },
        { source: 'caller2', target: 'high' },
        { source: 'caller3', target: 'high' },
        { source: 'caller1', target: 'low' },
      ],
    };
    const scores = computeImportanceScores(data);
    assert.ok(
      (scores.get('high') as number) > (scores.get('low') as number),
      'node with 3 in-edges should outscore node with 1 in-edge'
    );
  });

  test('MAIN node edges excluded from in-degree calculation', () => {
    const data = {
      nodes: [{ id: 'ep' }, { id: 'other' }],
      edges: [{ source: '::MAIN::0', target: 'ep' }],
    };
    const scores = computeImportanceScores(data);
    // ep is an entry point (depth boost) but its in-degree should be 0,
    // not 1. Score comes from depth only (0.4), not in-degree (which
    // would add 0.6 if MAIN edges were incorrectly counted).
    assert.ok(
      (scores.get('ep') as number) < 0.5,
      'ep score should reflect depth only, not a false in-degree from MAIN'
    );
    assert.ok(
      (scores.get('ep') as number) > (scores.get('other') as number),
      'ep still beats unreachable other via depth score'
    );
  });
});

// ---------------------------------------------------------------------------
// computeClusters
// ---------------------------------------------------------------------------

suite('computeClusters', () => {
  test('level = 1.0 → every node in its own cluster', () => {
    const data = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [{ source: 'a', target: 'b' }],
    };
    const scores = new Map([['a', 0.5], ['b', 0.3], ['c', 0.1]]);
    const result = computeClusters(data, scores, 1.0);
    assert.strictEqual(result.clusterMembers.size, 3, 'no merges at level 1.0');
  });

  test('level = 0.5 → neighbour-merge phase produces fewer clusters than nodes', () => {
    const data = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
        { source: 'c', target: 'd' },
      ],
    };
    const scores = new Map([['a', 0.1], ['b', 0.2], ['c', 0.3], ['d', 0.4]]);
    const result = computeClusters(data, scores, 0.5);
    assert.ok(result.clusterMembers.size < 4, 'some merges should have occurred at level 0.5');
  });

  test('level = 0.001 → all nodes collapsed into one cluster', () => {
    const data = {
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      edges: [{ source: 'a', target: 'b' }],
    };
    const scores = new Map([['a', 0.5], ['b', 0.3], ['c', 0.1]]);
    const result = computeClusters(data, scores, 0.001);
    assert.strictEqual(result.clusterMembers.size, 1, 'project phase should merge everything');
  });

  test('MAIN node is excluded from the node list', () => {
    const data = {
      nodes: [{ id: '::MAIN::0' }, { id: 'a' }, { id: 'b' }],
      edges: [{ source: '::MAIN::0', target: 'a' }],
    };
    const scores = new Map([['a', 0.5], ['b', 0.3]]);
    const result = computeClusters(data, scores, 1.0);
    assert.ok(!result.nodeToCluster.has('::MAIN::0'), '::MAIN::0 must not appear in nodeToCluster');
  });
});

// ---------------------------------------------------------------------------
// buildClusteredElements
// ---------------------------------------------------------------------------

suite('buildClusteredElements', () => {
  test('single-member cluster → node label equals function name', () => {
    const data = {
      nodes: [{ id: 'mod::fn::1', name: 'fn', file: 'mod.py', line: 1 }],
      edges: [],
    };
    const scores = computeImportanceScores(data);
    const clusterResult = computeClusters(data, scores, 1.0);
    const elements = buildClusteredElements(data, clusterResult, 1.0, scores);
    const el = elements.find((e: any) => e.data.id === 'mod::fn::1');
    assert.ok(el, 'element should exist');
    assert.strictEqual(el.data.label, 'fn');
  });

  test('multi-member cluster → label is "<topName> +N"', () => {
    const data = {
      nodes: [
        { id: 'a', name: 'alpha', file: 'a.py', line: 1 },
        { id: 'b', name: 'beta', file: 'b.py', line: 1 },
      ],
      edges: [{ source: 'a', target: 'b' }],
    };
    const scores = new Map([['a', 0.9], ['b', 0.1]]);
    // Manually construct a cluster that groups a and b under representative 'a'
    const nodeToCluster = new Map([['a', 'a'], ['b', 'a']]);
    const clusterMembers = new Map([['a', ['a', 'b']]]);
    const clusterResult = { nodeToCluster, clusterMembers };

    const elements = buildClusteredElements(data, clusterResult, 0.5, scores);
    const el = elements.find((e: any) => e.data.id === 'a');
    assert.ok(el, 'cluster element should exist');
    assert.strictEqual(el.data.label, 'alpha +1');
  });

  test('project-level cluster (level ≤ 0.001) → label uses inferProjectName', () => {
    const data = {
      nodes: [
        { id: 'a', name: 'alpha', file: '/home/user/myproject/a.py', line: 1 },
        { id: 'b', name: 'beta', file: '/home/user/myproject/b.py', line: 1 },
      ],
      edges: [{ source: 'a', target: 'b' }],
    };
    const scores = new Map([['a', 0.5], ['b', 0.5]]);
    const nodeToCluster = new Map([['a', 'a'], ['b', 'a']]);
    const clusterMembers = new Map([['a', ['a', 'b']]]);
    const clusterResult = { nodeToCluster, clusterMembers };

    const elements = buildClusteredElements(data, clusterResult, 0.001, scores);
    const el = elements.find((e: any) => e.data.id === 'a');
    assert.ok(el, 'cluster element should exist');
    assert.strictEqual(el.data.label, 'myproject');
  });

  test('edges within the same cluster are filtered out (src === tgt)', () => {
    const data = {
      nodes: [
        { id: 'a', name: 'alpha', file: 'a.py', line: 1 },
        { id: 'b', name: 'beta', file: 'b.py', line: 1 },
        { id: 'c', name: 'gamma', file: 'c.py', line: 1 },
      ],
      edges: [
        { source: 'a', target: 'b' }, // within the cluster → collapsed
        { source: 'a', target: 'c' }, // cross-cluster → kept
      ],
    };
    const scores = new Map([['a', 0.9], ['b', 0.5], ['c', 0.1]]);
    // a and b share cluster 'a'; c is alone
    const nodeToCluster = new Map([['a', 'a'], ['b', 'a'], ['c', 'c']]);
    const clusterMembers = new Map([['a', ['a', 'b']], ['c', ['c']]]);
    const clusterResult = { nodeToCluster, clusterMembers };

    const elements = buildClusteredElements(data, clusterResult, 0.5, scores);
    const edges = elements.filter((e: any) => e.data.source !== undefined);
    assert.strictEqual(edges.length, 1, 'intra-cluster edge should be dropped');
    assert.strictEqual(edges[0].data.source, 'a');
    assert.strictEqual(edges[0].data.target, 'c');
  });

  test('duplicate inter-cluster edges are deduplicated', () => {
    const data = {
      nodes: [
        { id: 'a', name: 'alpha', file: 'a.py', line: 1 },
        { id: 'b', name: 'beta', file: 'b.py', line: 1 },
        { id: 'c', name: 'gamma', file: 'c.py', line: 1 },
      ],
      edges: [
        { source: 'a', target: 'c' }, // cluster 'a' → 'c'
        { source: 'b', target: 'c' }, // also cluster 'a' → 'c' (duplicate after clustering)
      ],
    };
    const scores = new Map([['a', 0.9], ['b', 0.5], ['c', 0.1]]);
    const nodeToCluster = new Map([['a', 'a'], ['b', 'a'], ['c', 'c']]);
    const clusterMembers = new Map([['a', ['a', 'b']], ['c', ['c']]]);
    const clusterResult = { nodeToCluster, clusterMembers };

    const elements = buildClusteredElements(data, clusterResult, 0.5, scores);
    const edges = elements.filter((e: any) => e.data.source !== undefined);
    assert.strictEqual(edges.length, 1, 'duplicate edges must be deduplicated');
  });

  test('multi-member cluster has languageBreakdown array with fractions summing to 1', () => {
    const data = {
      nodes: [
        { id: 'a', name: 'alpha', file: 'a.py', line: 1, language: 'python' },
        { id: 'b', name: 'beta', file: 'b.ts', line: 1, language: 'typescript' },
      ],
      edges: [{ source: 'a', target: 'b' }],
    };
    const scores = new Map([['a', 0.9], ['b', 0.1]]);
    const nodeToCluster = new Map([['a', 'a'], ['b', 'a']]);
    const clusterMembers = new Map([['a', ['a', 'b']]]);
    const clusterResult = { nodeToCluster, clusterMembers };

    const elements = buildClusteredElements(data, clusterResult, 0.5, scores);
    const el = elements.find((e: any) => e.data.id === 'a');
    assert.ok(el, 'cluster element should exist');
    assert.ok(Array.isArray(el.data.languageBreakdown), 'languageBreakdown should be an array');
    const total = el.data.languageBreakdown.reduce((s: number, x: any) => s + x.fraction, 0);
    assert.ok(Math.abs(total - 1) < 0.001, 'fractions should sum to 1');
  });

  test('single-language cluster has one-entry languageBreakdown', () => {
    const data = {
      nodes: [
        { id: 'a', name: 'alpha', file: 'a.py', line: 1, language: 'python' },
        { id: 'b', name: 'beta', file: 'b.py', line: 1, language: 'python' },
      ],
      edges: [{ source: 'a', target: 'b' }],
    };
    const scores = new Map([['a', 0.9], ['b', 0.1]]);
    const nodeToCluster = new Map([['a', 'a'], ['b', 'a']]);
    const clusterMembers = new Map([['a', ['a', 'b']]]);
    const clusterResult = { nodeToCluster, clusterMembers };

    const elements = buildClusteredElements(data, clusterResult, 0.5, scores);
    const el = elements.find((e: any) => e.data.id === 'a');
    assert.ok(el, 'cluster element should exist');
    assert.strictEqual(el.data.languageBreakdown.length, 1, 'should have one language entry');
    assert.strictEqual(el.data.languageBreakdown[0].lang, 'python');
    assert.strictEqual(el.data.languageBreakdown[0].fraction, 1);
  });

  test('single-member cluster has null languageBreakdown', () => {
    const data = {
      nodes: [{ id: 'a', name: 'alpha', file: 'a.py', line: 1, language: 'python' }],
      edges: [],
    };
    const scores = computeImportanceScores(data);
    const clusterResult = computeClusters(data, scores, 1.0);
    const elements = buildClusteredElements(data, clusterResult, 1.0, scores);
    const el = elements.find((e: any) => e.data.id === 'a');
    assert.ok(el, 'element should exist');
    assert.strictEqual(el.data.languageBreakdown, null, 'single-member cluster should have null languageBreakdown');
  });

  test('file-affinity: same-file pair merges before cross-file pair at equal importance', () => {
    // A and B are in the same file; C and D are in different files.
    // All importance scores are equal so sort order is driven by file-affinity only.
    // At mergeCount=1, A-B should merge first.
    const data = {
      nodes: [
        { id: 'A', name: 'A', file: 'same.py', line: 1 },
        { id: 'B', name: 'B', file: 'same.py', line: 2 },
        { id: 'C', name: 'C', file: 'c.py',    line: 1 },
        { id: 'D', name: 'D', file: 'd.py',    line: 1 },
      ],
      edges: [
        { source: 'A', target: 'B' }, // same file
        { source: 'C', target: 'D' }, // different files
      ],
    };
    // Equal importance scores — file-affinity is the only differentiator.
    const scores = new Map([['A', 0.5], ['B', 0.5], ['C', 0.5], ['D', 0.5]]);
    // level 0.8 → fraction ≈ 0.199/0.998 ≈ 0.199, maxMerges=3, mergeCount=floor(0.199*3)=0
    // We need mergeCount=1 exactly: fraction = 1/3, level = 0.999 - 0.998*(1/3) ≈ 0.6657
    const result = computeClusters(data, scores, 0.666);
    assert.strictEqual(
      result.nodeToCluster.get('A'),
      result.nodeToCluster.get('B'),
      'A and B (same file) should be merged first'
    );
    assert.notStrictEqual(
      result.nodeToCluster.get('C'),
      result.nodeToCluster.get('D'),
      'C and D (different files) should not be merged when only one merge occurs'
    );
  });

  test('expanded cluster shows individual member nodes instead of cluster node', () => {
    const data = {
      nodes: [
        { id: 'a', name: 'alpha', file: 'a.py', line: 1 },
        { id: 'b', name: 'beta', file: 'b.py', line: 1 },
      ],
      edges: [{ source: 'a', target: 'b' }],
    };
    const scores = new Map([['a', 0.9], ['b', 0.1]]);
    const nodeToCluster = new Map([['a', 'a'], ['b', 'a']]);
    const clusterMembers = new Map([['a', ['a', 'b']]]);
    const clusterResult = { nodeToCluster, clusterMembers };

    const expandedClusters = new Set(['a']);
    const elements = buildClusteredElements(data, clusterResult, 0.5, scores, expandedClusters);
    const nodeIds = elements
      .filter((e: any) => e.data.source === undefined)
      .map((e: any) => e.data.id);
    assert.ok(nodeIds.includes('a'), 'individual node a should be visible');
    assert.ok(nodeIds.includes('b'), 'individual node b should be visible');
    assert.strictEqual(nodeIds.length, 2, 'should show 2 individual nodes, not a cluster node');
  });
});

// ---------------------------------------------------------------------------
// computeStructuralClusters
// ---------------------------------------------------------------------------

function makeStructuralData(nodes: { id: string; file?: string; className?: string }[]) {
  return { nodes: nodes.map(n => ({ ...n })), edges: [] };
}

suite('computeStructuralClusters', () => {

  // ── class mode ─────────────────────────────────────────────────────────────

  test('class mode: same file+class → same cluster', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/p/f.ts', className: 'Dog' },
      { id: 'b', file: '/p/f.ts', className: 'Dog' },
    ]);
    const { nodeToCluster } = computeStructuralClusters(data, 'class', 0.5);
    assert.strictEqual(nodeToCluster.get('a'), nodeToCluster.get('b'));
  });

  test('class mode: different class → different cluster', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/p/f.ts', className: 'Dog' },
      { id: 'b', file: '/p/f.ts', className: 'Cat' },
    ]);
    const { nodeToCluster } = computeStructuralClusters(data, 'class', 0.5);
    assert.notStrictEqual(nodeToCluster.get('a'), nodeToCluster.get('b'));
  });

  test('class mode: no className → own singleton (different from class cluster)', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/p/f.ts', className: 'Dog' },
      { id: 'b', file: '/p/f.ts' },
    ]);
    const { nodeToCluster, clusterMembers } = computeStructuralClusters(data, 'class', 0.5);
    assert.notStrictEqual(nodeToCluster.get('a'), nodeToCluster.get('b'));
    assert.strictEqual(clusterMembers.get(nodeToCluster.get('b'))!.length, 1);
  });

  test('class mode: clusterLabels has class name for multi-member group', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/p/f.ts', className: 'Dog' },
      { id: 'b', file: '/p/f.ts', className: 'Dog' },
    ]);
    const { nodeToCluster, clusterLabels } = computeStructuralClusters(data, 'class', 0.5);
    const key = nodeToCluster.get('a')!;
    assert.strictEqual(clusterLabels!.get(key), 'Dog');
  });

  // ── file mode ──────────────────────────────────────────────────────────────

  test('file mode: same file → same cluster', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/p/utils.ts' },
      { id: 'b', file: '/p/utils.ts' },
    ]);
    const { nodeToCluster } = computeStructuralClusters(data, 'file', 0.5);
    assert.strictEqual(nodeToCluster.get('a'), nodeToCluster.get('b'));
  });

  test('file mode: different files → different clusters', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/p/a.ts' },
      { id: 'b', file: '/p/b.ts' },
    ]);
    const { nodeToCluster } = computeStructuralClusters(data, 'file', 0.5);
    assert.notStrictEqual(nodeToCluster.get('a'), nodeToCluster.get('b'));
  });

  test('file mode: no file → own singleton', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/p/f.ts' },
      { id: 'b' },
    ]);
    const { nodeToCluster, clusterMembers } = computeStructuralClusters(data, 'file', 0.5);
    assert.notStrictEqual(nodeToCluster.get('a'), nodeToCluster.get('b'));
    assert.strictEqual(clusterMembers.get(nodeToCluster.get('b'))!.length, 1);
  });

  test('file mode: clusterLabels has basename for multi-member group', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/proj/src/utils.ts' },
      { id: 'b', file: '/proj/src/utils.ts' },
    ]);
    const { nodeToCluster, clusterLabels } = computeStructuralClusters(data, 'file', 0.5);
    const key = nodeToCluster.get('a')!;
    assert.strictEqual(clusterLabels!.get(key), 'utils.ts');
  });

  // ── folder mode ────────────────────────────────────────────────────────────

  test('folder mode: same directory → same cluster', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/p/src/a.ts' },
      { id: 'b', file: '/p/src/b.ts' },
    ]);
    const { nodeToCluster } = computeStructuralClusters(data, 'folder', 0.5);
    assert.strictEqual(nodeToCluster.get('a'), nodeToCluster.get('b'));
  });

  test('folder mode: different directories → different clusters', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/p/src/a.ts' },
      { id: 'b', file: '/p/lib/b.ts' },
    ]);
    const { nodeToCluster } = computeStructuralClusters(data, 'folder', 0.5);
    assert.notStrictEqual(nodeToCluster.get('a'), nodeToCluster.get('b'));
  });

  test('folder mode: clusterLabels has folder name for multi-member group', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/proj/src/a.ts' },
      { id: 'b', file: '/proj/src/b.ts' },
    ]);
    const { nodeToCluster, clusterLabels } = computeStructuralClusters(data, 'folder', 0.5);
    const key = nodeToCluster.get('a')!;
    assert.strictEqual(clusterLabels!.get(key), 'src');
  });

  // ── level boundary conditions ───────────────────────────────────────────────

  test('level >= 0.999 → all individual singletons', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/p/f.ts', className: 'Dog' },
      { id: 'b', file: '/p/f.ts', className: 'Dog' },
    ]);
    const { nodeToCluster } = computeStructuralClusters(data, 'class', 0.999);
    assert.notStrictEqual(nodeToCluster.get('a'), nodeToCluster.get('b'));
  });

  test('level <= 0.001 → single cluster for all nodes', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/p/a.ts' },
      { id: 'b', file: '/p/b.ts' },
      { id: 'c', file: '/p/c.ts' },
    ]);
    const { clusterMembers } = computeStructuralClusters(data, 'file', 0.001);
    assert.strictEqual(clusterMembers.size, 1, 'all nodes in one cluster at level 0');
    assert.strictEqual([...clusterMembers.values()][0].length, 3);
  });

  test('level <= 0.001 → clusterLabels is null', () => {
    const data = makeStructuralData([
      { id: 'a', file: '/p/a.ts' },
      { id: 'b', file: '/p/b.ts' },
    ]);
    const { clusterLabels } = computeStructuralClusters(data, 'file', 0.0);
    assert.strictEqual(clusterLabels, null);
  });
});
