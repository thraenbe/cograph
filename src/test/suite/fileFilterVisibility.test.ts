import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

// The regression perf found on the integrated branch: visibleKey knew the
// file filters, but getVisibleNodeIds never PASSED them into the memo input,
// so Hide file / Show only this file changed nothing on screen. This test
// runs the REAL getVisibleNodeIds + computeVisibleNodeIds source from
// main.js against the REAL memo from visibility.js — through the memo, not
// through visibleKey.
const mainSrc = fs.readFileSync(
  path.resolve(__dirname, '../../../src/webview/main.js'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vis = require('../../../src/webview/visibility.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fileFilterAllows } = require('../../../src/webview/controls.js');

function buildGetter(env: any) {
  const g = mainSrc.match(/function getVisibleNodeIds\(\) \{[\s\S]*?\n\}/);
  const c = mainSrc.match(/function computeVisibleNodeIds\([\s\S]*?\n\}/);
  assert.ok(g && c, 'both functions found in main.js');
  const sc = mainSrc.match(/function __scanScope\(\) \{[\s\S]*?\n\}/);
  assert.ok(sc, '__scanScope found in main.js');
  return new Function(
    'state', 'settings', 'document', 'createVisibleMemo', 'fileFilterAllows', 'pathDirname',
    'memberInScope',
    `let __visMemo = createVisibleMemo(); let __searchEl; let __scanScopeCache = null;
     ${g![0]}
     ${c![0]}
     ${sc![0]}
     return getVisibleNodeIds;`,
  )(env.state, env.settings, env.document, vis.createVisibleMemo, fileFilterAllows,
    (fp: string) => fp.slice(0, fp.lastIndexOf('/')),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('../../../src/webview/scope.js').memberInScope);
}

function makeEnv() {
  const nodes = [
    { id: 'a1', label: 'a1', file: '/p/a.ts' },
    { id: 'a2', label: 'a2', file: '/p/a.ts' },
    { id: 'b1', label: 'b1', file: '/p/b.ts' },
    { id: 'fileB', label: 'b.ts', isCluster: true, isFileCluster: true, _filePath: '/p/b.ts' },
    { id: 'folderP', label: 'p', isCluster: true, isFolderCluster: true, _folderPath: '/p' },
  ];
  const state = {
    currentNodes: nodes, connectedNodeIds: new Set(nodes.map(n => n.id)),
    hiddenFolders: new Set(), onlyShowFolder: null,
    hiddenFiles: new Set<string>(), onlyShowFile: null as string | null,
    timeline: null,
  };
  const settings = { showLibraries: false, existingFilesOnly: false, showOrphans: true };
  const document = { getElementById: () => null };
  return { state, settings, document };
}

suite('file filters flow through the MEMOISED visibility scan (R2a fix)', () => {
  test('Hide file drops its functions and its collapsed node, even on the second call', () => {
    const env = makeEnv();
    const getVisible = buildGetter(env);
    assert.strictEqual(getVisible().size, 5, 'all visible initially');
    getVisible(); // memo warm
    env.state.hiddenFiles.add('/p/a.ts');
    const after = getVisible();
    assert.ok(!after.has('a1') && !after.has('a2'), 'hidden file functions gone');
    assert.ok(after.has('b1') && after.has('folderP'), 'others stay');
    assert.strictEqual(after.size, 3);
  });

  test('Show only this file keeps only its nodes (folder glyphs stay)', () => {
    const env = makeEnv();
    const getVisible = buildGetter(env);
    getVisible();
    env.state.onlyShowFile = '/p/b.ts';
    const after = getVisible();
    assert.ok(after.has('b1') && after.has('fileB'), 'the chosen file stays');
    assert.ok(!after.has('a1') && !after.has('a2'), 'other files gone');
    assert.ok(after.has('folderP'), 'folder glyphs unaffected');
  });

  test('Show all restores everything (memo re-keys back)', () => {
    const env = makeEnv();
    const getVisible = buildGetter(env);
    env.state.hiddenFiles.add('/p/a.ts');
    getVisible();
    env.state.hiddenFiles.clear();
    env.state.onlyShowFile = null;
    assert.strictEqual(getVisible().size, 5, 'back to all visible');
  });

  test('a subgraph scope change flows through the memo too (W4)', () => {
    const env = makeEnv();
    (env.state as any).scope = null;
    const getVisible = buildGetter(env);
    assert.strictEqual(getVisible().size, 5);
    getVisible(); // memo warm
    (env.state as any).scope = { include: new Set(['/p']), exclude: new Set(['/p']) };
    // include /p but exclude /p == everything out of scope except pathless nodes
    const after = getVisible();
    assert.ok(!after.has('a1') && !after.has('b1') && !after.has('fileB') && !after.has('folderP'),
      'scoped-out nodes leave on the next call — no stale memo set');
    (env.state as any).scope = null;
    assert.strictEqual(getVisible().size, 5, 'clearing the scope re-keys back');
  });

  test('the memo inputs carry the file filters (the exact develop gap)', () => {
    const call = mainSrc.slice(mainSrc.indexOf('__visMemo.get({'),
      mainSrc.indexOf('computeVisibleNodeIds(query, tlPredicate));'));
    assert.ok(call.includes('onlyShowFile: state.onlyShowFile'),
      'onlyShowFile must be a memo input');
    assert.ok(call.includes('hiddenFiles: state.hiddenFiles'),
      'hiddenFiles must be a memo input');
    assert.ok(call.includes('scope: state.scope'), 'the subgraph scope must be a memo input (W4)');
  });
});
