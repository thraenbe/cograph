import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sc = require('../../../src/webview/scope.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fr = require('../../../src/webview/frames.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

// Round 3 W1: one pure predicate family decides which folders/files EXIST in
// the layout — Hide entirely, Only show, and (W4) the subgraph scope.

function scope(over: Record<string, any> = {}) {
  return sc.buildScope({
    hiddenFolders: new Set<string>(), onlyShowFolder: null,
    hiddenFiles: new Set<string>(), onlyShowFile: null, scope: null,
    ...over,
  });
}

suite('scope — pathUnder', () => {
  test('equal, child, separator-aware, no false prefix', () => {
    assert.ok(sc.pathUnder('/a/b', '/a/b'));
    assert.ok(sc.pathUnder('/a/b/c.ts', '/a/b'));
    assert.ok(sc.pathUnder('C:\\a\\b\\c.ts', 'C:\\a\\b'));
    assert.ok(!sc.pathUnder('/a/bx/c.ts', '/a/b'), 'sibling with the prefix as a name prefix');
    assert.ok(!sc.pathUnder('/a', '/a/b'), 'parent is not under the child');
    assert.ok(!sc.pathUnder(null, '/a') && !sc.pathUnder('/a', null));
  });
});

suite('scope — frame rule (hide entirely)', () => {
  test('a hidden folder and its whole subtree lose their frames', () => {
    const s = scope({ hiddenFolders: new Set(['/r/src']) });
    assert.ok(!sc.frameFolderVisible('/r/src', s));
    assert.ok(!sc.frameFolderVisible('/r/src/util', s));
    assert.ok(sc.frameFolderVisible('/r/test', s));
  });

  test('Only show keeps the subtree AND its ancestor containers', () => {
    const s = scope({ onlyShowFolder: '/r/src/util' });
    assert.ok(sc.frameFolderVisible('/r/src/util', s));
    assert.ok(sc.frameFolderVisible('/r/src/util/deep', s));
    assert.ok(sc.frameFolderVisible('/r/src', s), 'ancestor is the container');
    assert.ok(!sc.frameFolderVisible('/r/test', s));
    assert.ok(!sc.frameFolderVisible('/r/src/other', s), 'sibling inside the ancestor');
  });

  test('subgraph: folders intersecting an include stay, exclude carves out', () => {
    const s = scope({ scope: { include: new Set(['/r/src']), exclude: new Set(['/r/src/gen']) } });
    assert.ok(sc.frameFolderVisible('/r/src', s));
    assert.ok(sc.frameFolderVisible('/r/src/util', s));
    assert.ok(sc.frameFolderVisible('/r', s), 'ancestor of an include');
    assert.ok(!sc.frameFolderVisible('/r/test', s));
    assert.ok(!sc.frameFolderVisible('/r/src/gen', s), 'exclude carve-out');
    assert.ok(!sc.scopeActive(scope()), 'empty scope is inactive');
    assert.ok(sc.scopeActive(s));
  });
});

suite('scope — member rule', () => {
  test('function/file nodes follow the folder rules on their file path', () => {
    const s = scope({ hiddenFolders: new Set(['/r/src']) });
    assert.ok(!sc.memberInScope({ id: '1', file: '/r/src/a.ts' }, s));
    assert.ok(!sc.memberInScope({ id: '2', isFileCluster: true, _filePath: '/r/src/a.ts' }, s));
    assert.ok(sc.memberInScope({ id: '3', file: '/r/test/b.ts' }, s));
  });

  test('collapsed folder glyphs use the strict subtree rule and ignore file filters', () => {
    const hidden = scope({ hiddenFolders: new Set(['/r/src']) });
    assert.ok(!sc.memberInScope({ isFolderCluster: true, _folderPath: '/r/src/util' }, hidden));
    const only = scope({ onlyShowFolder: '/r/src' });
    assert.ok(sc.memberInScope({ isFolderCluster: true, _folderPath: '/r/src/util' }, only));
    assert.ok(!sc.memberInScope({ isFolderCluster: true, _folderPath: '/r/test' }, only));
    const files = scope({ onlyShowFile: '/r/src/a.ts', hiddenFiles: new Set(['/r/src/b.ts']) });
    assert.ok(sc.memberInScope({ isFolderCluster: true, _folderPath: '/r/src/util' }, files),
      'file filters never remove folder glyphs (R2a)');
  });

  test('file filters remove exactly that slot; pathless synthetics stay', () => {
    const s = scope({ hiddenFiles: new Set(['/r/a.ts']) });
    assert.ok(!sc.memberInScope({ id: '1', file: '/r/a.ts' }, s));
    assert.ok(sc.memberInScope({ id: '2', file: '/r/b.ts' }, s));
    const only = scope({ onlyShowFile: '/r/a.ts' });
    assert.ok(sc.memberInScope({ id: '1', file: '/r/a.ts' }, only));
    assert.ok(!sc.memberInScope({ id: '2', file: '/r/b.ts' }, only));
    assert.ok(sc.memberInScope({ id: 's', isSynthetic: true }, only), 'no path → stays');
  });
});

suite('scope — frames integration (hide removes the frame/slot)', () => {
  const tree = {
    root: '/r',
    folders: {
      '/r': { parent: null },
      '/r/src': { parent: '/r' },
      '/r/test': { parent: '/r' },
    },
  };
  const nodes = [
    { id: 'f1', file: '/r/src/a.ts', _size: 8 },
    { id: 'f2', file: '/r/src/b.ts', _size: 8 },
    { id: 'f3', file: '/r/test/t.ts', _size: 8 },
  ];
  const expanded = new Set(['/r', '/r/src', '/r/test']);

  test('a hidden folder has no frame and the build stays consistent', () => {
    const s = scope({ hiddenFolders: new Set(['/r/src']) });
    const members = fr.collectMembers(nodes, tree, 2.5, (d: any) => sc.memberInScope(d, s));
    const fs = fr.buildFrames(tree, expanded, members, (p: string) => sc.frameFolderVisible(p, s));
    assert.ok(!fs.byPath.has('/r/src'), 'hidden frame gone');
    assert.ok(fs.byPath.has('/r/test'));
    assert.ok(!fs.byPath.get('/r').children.includes('/r/src'));
  });

  test('a hidden file loses its slot and the frame re-packs without it', () => {
    const s = scope({ hiddenFiles: new Set(['/r/src/a.ts']) });
    const members = fr.collectMembers(nodes, tree, 2.5, (d: any) => sc.memberInScope(d, s));
    const fs = fr.buildFrames(tree, expanded, members, (p: string) => sc.frameFolderVisible(p, s));
    const src = fs.byPath.get('/r/src');
    assert.ok(!src.slots.has('file:/r/src/a.ts'), 'hidden file has no slot');
    assert.ok(src.slots.has('file:/r/src/b.ts'));
    const full = fr.buildFrames(tree, expanded, fr.collectMembers(nodes, tree, 2.5));
    assert.ok(src.content.w <= full.byPath.get('/r/src').content.w,
      'content never grows when a slot is removed');
  });

  test('un-hide restores the frame via the normal update diff', () => {
    const s = scope({ hiddenFolders: new Set(['/r/src']) });
    const mHidden = fr.collectMembers(nodes, tree, 2.5, (d: any) => sc.memberInScope(d, s));
    const first = fr.buildFrames(tree, expanded, mHidden, (p: string) => sc.frameFolderVisible(p, s));
    const mAll = fr.collectMembers(nodes, tree, 2.5);
    const upd = fr.updateFrames(first, tree, expanded, mAll, {});
    assert.ok(upd.frames.byPath.has('/r/src'), 'frame returns after un-hide');
  });
});

suite('scope — wiring contracts', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsMod = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  const read = (f: string) =>
    fsMod.readFileSync(path.resolve(__dirname, '../../../src/webview/' + f), 'utf8');

  test('the render passes the scope into BOTH seams (frames and members)', () => {
    const src = read('frameRender.js');
    assert.ok(src.includes('collectMembers(state.currentNodes, tree, settings.nodeSize, allow)'));
    assert.ok(src.includes('updateFrames(state.frames, tree, state.expandedFolders, members, { folderOk })'));
  });

  test('every filter MUTATION triggers the structural re-render', () => {
    for (const f of ['frameRender.js', 'rendering.js', 'drilldown.js', 'folder.js', 'controls.js']) {
      const src = read(f);
      assert.ok(src.includes('applyStructuralFilters()'), `${f} uses applyStructuralFilters`);
      // No Hide/Only/Show-all action may still call the display-only pass.
      for (const m of src.matchAll(/(hiddenFolders\.(add|clear)|onlyShow\w+ = |hiddenFiles\.(add|clear|\?\.clear))[^\n]*\n?[^\n]*applyFilters\(\)/g)) {
        assert.fail(`${f}: filter mutation still calls applyFilters(): ${m[0].slice(0, 80)}`);
      }
    }
  });
});
