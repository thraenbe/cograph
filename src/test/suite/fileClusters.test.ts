import * as assert from 'assert';

// fileClusters.js is a browser global module with a module.exports guard; the
// pure builders are require()-able directly (no DOM/D3 needed).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fc = require('../../../src/webview/fileClusters.js');
const { buildSkeletonElements } = fc;

// A small two-level tree: root /p with a direct file and a child folder /p/src.
function makeTree() {
  return {
    root: '/p',
    folders: {
      '/p': { path: '/p', depth: 0, parent: null, childFolders: ['/p/src'], files: ['/p/main.py'], fileCount: 3 },
      '/p/src': { path: '/p/src', depth: 1, parent: '/p', childFolders: [], files: ['/p/src/a.ts', '/p/src/b.ts'], fileCount: 2 },
    },
    files: [],
    totalFiles: 3,
  };
}

const ids = (els: any[]) => els.map(e => e.data.id);

suite('fileClusters.buildSkeletonElements', () => {
  test('level 0 (nothing expanded) → a single root folder node', () => {
    const els = buildSkeletonElements(makeTree(), new Set(), new Set(), null);
    assert.strictEqual(els.length, 1);
    assert.strictEqual(els[0].data.id, 'folder::/p');
    assert.strictEqual(els[0].data.isFolderCluster, true);
    assert.strictEqual(els[0].data.isCluster, true);
    assert.strictEqual(els[0].data.isSynthetic, false, 'must be clickable (cloud handler skips synthetic)');
    assert.strictEqual(els[0].data.memberCount, 3);
    assert.strictEqual(els[0].data.label, 'p');
  });

  test('expanding the root → its child folders + direct files', () => {
    const els = buildSkeletonElements(makeTree(), new Set(['/p']), new Set(), null);
    assert.deepStrictEqual(ids(els).sort(), ['file::/p/main.py', 'folder::/p/src'].sort());
    const child = els.find((e: any) => e.data.id === 'folder::/p/src');
    assert.strictEqual(child.data.isFolderCluster, true);
    const file = els.find((e: any) => e.data.id === 'file::/p/main.py');
    assert.strictEqual(file.data.isFileCluster, true);
    assert.strictEqual(file.data.language, 'python');
  });

  test('expanding a sub-folder → reveals its files (descendant drill-down)', () => {
    const els = buildSkeletonElements(makeTree(), new Set(['/p', '/p/src']), new Set(), null);
    assert.deepStrictEqual(
      ids(els).sort(),
      ['file::/p/main.py', 'file::/p/src/a.ts', 'file::/p/src/b.ts'].sort(),
    );
  });

  test('collapsing a folder drops its descendants', () => {
    // /p expanded but /p/src collapsed → src shown as one node, its files hidden
    const els = buildSkeletonElements(makeTree(), new Set(['/p']), new Set(), null);
    assert.ok(!ids(els).some(id => id.startsWith('file::/p/src/')), 'sub-folder files hidden when collapsed');
  });

  test('a parsed file shows its function count; expanding it reveals function nodes', () => {
    const graphData = {
      nodes: [
        { id: 'fa1', name: 'alpha', file: '/p/src/a.ts', line: 1, language: 'typescript' },
        { id: 'fa2', name: 'beta', file: '/p/src/a.ts', line: 9, language: 'typescript' },
      ],
      edges: [],
    };
    const parsed = new Set(['/p/src']);

    // a.ts parsed but collapsed → file node carries memberCount = 2, parsed = true
    const collapsed = buildSkeletonElements(makeTree(), new Set(['/p', '/p/src']), parsed, graphData);
    const aFile = collapsed.find((e: any) => e.data.id === 'file::/p/src/a.ts');
    assert.strictEqual(aFile.data.parsed, true);
    assert.strictEqual(aFile.data.memberCount, 2);

    // a.ts expanded → its function nodes appear instead of the file node
    const expanded = buildSkeletonElements(
      makeTree(), new Set(['/p', '/p/src', '/p/src/a.ts']), parsed, graphData,
    );
    assert.ok(ids(expanded).includes('fa1') && ids(expanded).includes('fa2'), 'function nodes emitted');
    assert.ok(!ids(expanded).includes('file::/p/src/a.ts'), 'file node replaced by its functions');
    const fn = expanded.find((e: any) => e.data.id === 'fa1');
    assert.strictEqual(fn.data.isCluster, false);
    assert.strictEqual(fn.data.label, 'alpha');
  });

  test('an un-parsed file cannot expand to functions (stays a file node)', () => {
    const graphData = { nodes: [{ id: 'z', name: 'z', file: '/p/src/a.ts', line: 1 }], edges: [] };
    // a.ts "expanded" but its folder is NOT parsed → still a file node
    const els = buildSkeletonElements(makeTree(), new Set(['/p', '/p/src', '/p/src/a.ts']), new Set(), graphData);
    assert.ok(ids(els).includes('file::/p/src/a.ts'));
    assert.ok(!ids(els).includes('z'));
  });

  test('empty / missing tree → no elements (no throw)', () => {
    assert.deepStrictEqual(buildSkeletonElements(null, new Set(), new Set(), null), []);
    assert.deepStrictEqual(buildSkeletonElements({ root: '', folders: {} }, new Set(), new Set(), null), []);
  });
});
