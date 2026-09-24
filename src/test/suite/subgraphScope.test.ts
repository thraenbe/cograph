import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanStructure } from '../../structureScanner';
import {
  NO_SCOPE, hasScope, toRel, toAbs, cleanRel, isIncluded, fileInScope, normalize, specForFolder,
  withFolderIncluded, withFolderExcluded, excludedTops, filesInScope, filterGraph, filterFileStatuses,
  filterFiles, buildSubgraphMessage, readSubgraphField,
} from '../../subgraphScope';
import type { GraphData } from '../../graphProvider';

const ROOT = path.join(os.tmpdir(), 'cograph-scope-root');

suite('subgraphScope — verdicts', () => {
  test('no include = whole project', () => {
    const spec = { include: [], exclude: [] };
    assert.strictEqual(isIncluded(spec, '.'), true);
    assert.strictEqual(isIncluded(spec, 'src/x'), true);
    assert.strictEqual(fileInScope(spec, 'src/a.ts'), true);
    assert.strictEqual(hasScope(NO_SCOPE), false);
  });

  test('include covers the folder and its descendants, nothing else', () => {
    const spec = { include: ['src/server'], exclude: [] };
    assert.strictEqual(isIncluded(spec, 'src/server'), true);
    assert.strictEqual(isIncluded(spec, 'src/server/db'), true);
    assert.strictEqual(isIncluded(spec, 'src/serverless'), false, 'prefix without a slash is a different folder');
    assert.strictEqual(isIncluded(spec, 'src'), false);
    assert.strictEqual(isIncluded(spec, '.'), false);
    assert.strictEqual(fileInScope(spec, 'src/server/x.ts'), true);
    assert.strictEqual(fileInScope(spec, 'src/x.ts'), false);
    assert.strictEqual(fileInScope(spec, 'top.ts'), false);
  });

  test('root include with a carve-out; carve-out with a re-include (nearest listed wins)', () => {
    const spec = { include: ['.', 'src/tests/keep'], exclude: ['src/tests'] };
    assert.strictEqual(isIncluded(spec, 'lib'), true);
    assert.strictEqual(isIncluded(spec, 'src/tests'), false);
    assert.strictEqual(isIncluded(spec, 'src/tests/unit'), false);
    assert.strictEqual(isIncluded(spec, 'src/tests/keep/deep'), true);
    assert.strictEqual(fileInScope(spec, 'root.ts'), true);
  });

  test('path helpers', () => {
    assert.strictEqual(toRel(ROOT, path.join(ROOT, 'src', 'a')), 'src/a');
    assert.strictEqual(toRel(ROOT, ROOT), '.');
    assert.strictEqual(toAbs(ROOT, 'src/a'), path.join(ROOT, 'src', 'a'));
    assert.strictEqual(toAbs(ROOT, '.'), ROOT);
    assert.strictEqual(cleanRel('./src\\a/'), 'src/a');
    assert.strictEqual(cleanRel(''), '.');
    assert.strictEqual(cleanRel('/'), '.');
  });
});

suite('subgraphScope — normalize and edits', () => {
  test('normalize sorts, dedupes, cleans and drops implied entries; idempotent', () => {
    const n = normalize({ include: ['src/b/', 'src/a', './src/a', 'src/a/inner'], exclude: ['lib', 'src/a/skip'] });
    assert.deepStrictEqual(n, { include: ['src/a', 'src/b'], exclude: ['src/a/skip'] });
    assert.deepStrictEqual(normalize(n), n);
  });

  test('normalize: no include means no scope at all, carve-outs dropped', () => {
    assert.deepStrictEqual(normalize({ include: [], exclude: ['x'] }), { include: [], exclude: [] });
    assert.deepStrictEqual(normalize(null), { include: [], exclude: [] });
    assert.deepStrictEqual(normalize({ include: ['.'], exclude: ['.'] }), { include: ['.'], exclude: [] });
  });

  test('specForFolder / withFolderIncluded / withFolderExcluded', () => {
    let spec = specForFolder('src/server');
    assert.deepStrictEqual(spec, { include: ['src/server'], exclude: [] });
    spec = withFolderIncluded(spec, 'src/ui');
    assert.deepStrictEqual(spec, { include: ['src/server', 'src/ui'], exclude: [] });
    spec = withFolderIncluded(spec, 'src'); // parent swallows both
    assert.deepStrictEqual(spec, { include: ['src'], exclude: [] });
    spec = withFolderExcluded(spec, 'src/ui'); // carve-out under an included parent
    assert.deepStrictEqual(spec, { include: ['src'], exclude: ['src/ui'] });
    assert.strictEqual(isIncluded(spec, 'src/ui/x'), false);
    spec = withFolderIncluded(spec, 'src/ui'); // re-including removes the carve-out
    assert.deepStrictEqual(spec, { include: ['src'], exclude: [] });
    spec = withFolderExcluded(spec, 'src'); // excluding the only include → no scope left
    assert.deepStrictEqual(spec, { include: [], exclude: [] });
  });

  test('excluding a directly included sibling just removes it (include-only v1 shape)', () => {
    const spec = withFolderExcluded({ include: ['a', 'b'], exclude: [] }, 'b');
    assert.deepStrictEqual(spec, { include: ['a'], exclude: [] });
  });
});

suite('subgraphScope — tree and graph filtering', () => {
  let root: string;
  const files = ['src/main.ts', 'src/server/api.ts', 'src/server/db/q.ts', 'src/ui/view.ts', 'tools/gen.ts'];

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-scope-'));
    for (const rel of files) {
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `export const x = 1; // ${rel}\n`);
    }
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  const abs = (rel: string) => path.join(root, ...rel.split('/'));

  test('excludedTops lists the shortest excluded folders with recursive counts', () => {
    const tree = scanStructure(root);
    const tops = excludedTops({ include: ['src/server'], exclude: [] }, tree, root);
    assert.deepStrictEqual(tops.map(t => [toRel(root, t.path), t.fileCount]), [['.', 5]],
      'the root itself is excluded (only src/server is in), so it is the single top');
    const tops2 = excludedTops({ include: ['.'], exclude: ['src/server', 'tools'] }, tree, root);
    assert.deepStrictEqual(tops2.map(t => [toRel(root, t.path), t.fileCount]), [['src/server', 2], ['tools', 1]]);
    assert.deepStrictEqual(excludedTops({ include: [], exclude: [] }, tree, root), []);
  });

  test('filesInScope and filterFiles', () => {
    const tree = scanStructure(root);
    const spec = { include: ['src/server'], exclude: ['src/server/db'] };
    assert.deepStrictEqual(filesInScope(spec, tree, root).map(f => toRel(root, f)), ['src/server/api.ts']);
    assert.deepStrictEqual(filterFiles([abs('src/ui/view.ts'), abs('src/server/api.ts')], spec, root), [abs('src/server/api.ts')]);
    assert.strictEqual(filesInScope({ include: [], exclude: [] }, tree, root).length, 5);
  });

  test('filterGraph keeps in-scope nodes, referenced libraries and edges with both ends', () => {
    const graph: GraphData = {
      nodes: [
        { id: 'main', name: 'main', file: abs('src/main.ts'), line: 1 },
        { id: 'api', name: 'api', file: abs('src/server/api.ts'), line: 1 },
        { id: 'q', name: 'q', file: abs('src/server/db/q.ts'), line: 1 },
        { id: 'lib-used', name: 'post', file: null, line: 0, isLibrary: true, libraryName: 'axios' },
        { id: 'lib-unused', name: 'fmt', file: null, line: 0, isLibrary: true, libraryName: 'chalk' },
      ],
      edges: [
        { source: 'main', target: 'api' },
        { source: 'api', target: 'q' },
        { source: 'api', target: 'lib-used', isLibraryEdge: true },
        { source: 'main', target: 'lib-unused', isLibraryEdge: true },
      ],
      files: [abs('src/main.ts'), abs('src/server/api.ts'), abs('src/server/db/q.ts')],
    };
    const out = filterGraph(graph, { include: ['src/server'], exclude: [] }, root);
    assert.deepStrictEqual(out.nodes.map(n => n.id), ['api', 'q', 'lib-used']);
    assert.deepStrictEqual(out.edges.map(e => `${e.source}>${e.target}`), ['api>q', 'api>lib-used']);
    assert.deepStrictEqual(out.files!.map(f => toRel(root, f)), ['src/server/api.ts', 'src/server/db/q.ts']);
    assert.strictEqual(filterGraph(graph, { include: [], exclude: [] }, root), graph, 'no scope returns the same object');
  });

  test('filterFileStatuses keeps in-scope files only', () => {
    const statuses = { [abs('src/ui/view.ts')]: 'M', [abs('src/server/api.ts')]: 'A' };
    assert.deepStrictEqual(filterFileStatuses(statuses, { include: ['src/server'], exclude: [] }, root), { [abs('src/server/api.ts')]: 'A' });
    assert.strictEqual(filterFileStatuses(statuses, { include: [], exclude: [] }, root), statuses);
  });
});

suite('subgraphScope — wire and file shapes', () => {
  test('buildSubgraphMessage is normalized and always carries exclude', () => {
    const msg = buildSubgraphMessage({ spec: { include: ['b', 'a', 'a/x'], exclude: [] }, source: 'subgraph', name: 'backend' }, ROOT);
    assert.deepStrictEqual(msg, { type: 'subgraph', name: 'backend', root: ROOT, include: ['a', 'b'], exclude: [] });
    const none = buildSubgraphMessage(NO_SCOPE, ROOT);
    assert.deepStrictEqual(none, { type: 'subgraph', name: null, root: ROOT, include: [], exclude: [] });
  });

  test('readSubgraphField tolerates absent, malformed and legacy shapes', () => {
    assert.deepStrictEqual(readSubgraphField({ subgraph: { include: ['src/a'] } }), { include: ['src/a'], exclude: [] });
    assert.deepStrictEqual(readSubgraphField({ subgraph: { include: ['src/a'], exclude: ['src/a/t', 7] } }), { include: ['src/a'], exclude: ['src/a/t'] });
    assert.strictEqual(readSubgraphField({ name: 'plain layout' }), null);
    assert.strictEqual(readSubgraphField({ subgraph: { include: [] } }), null, 'empty include is not a subgraph');
    assert.strictEqual(readSubgraphField({ subgraph: { include: 'src' } }), null);
    assert.strictEqual(readSubgraphField(null), null);
  });
});
