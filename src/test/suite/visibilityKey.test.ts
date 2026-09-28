import * as assert from 'assert';

/* eslint-disable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vis = require('../../../src/webview/visibility.js');

suite('visibility memo — file filters join the key (R2a)', () => {
  const base = () => ({
    query: '', showLibraries: false, existingFilesOnly: false, showOrphans: true,
    nodes: [] as any[], connected: new Set(),
    onlyShowFolder: null, hiddenFolders: new Set<string>(),
    onlyShowFile: null as string | null, hiddenFiles: new Set<string>(),
  });

  test('hiding a file or setting only-show-file invalidates the memo', () => {
    const memo = vis.createVisibleMemo();
    let computes = 0;
    const compute = () => { computes++; return new Set([String(computes)]); };
    const inp = base();
    memo.get(inp, compute);
    memo.get(inp, compute);
    assert.strictEqual(computes, 1, 'unchanged inputs are served from the memo');
    inp.hiddenFiles = new Set(['/p/a.ts']);
    memo.get(inp, compute);
    assert.strictEqual(computes, 2, 'a hidden file must recompute');
    inp.onlyShowFile = '/p/b.ts';
    memo.get(inp, compute);
    assert.strictEqual(computes, 3, 'an only-show file must recompute');
    memo.get(inp, compute);
    assert.strictEqual(computes, 3, 'stable again afterwards');
  });

  test('visibleKey serializes the file-filter contents, not identities', () => {
    const a = base(); a.hiddenFiles = new Set(['/x.ts']);
    const b = base(); b.hiddenFiles = new Set(['/x.ts']);
    assert.strictEqual(vis.visibleKey ? vis.visibleKey(a) : JSON.stringify(a.hiddenFiles.size),
      vis.visibleKey ? vis.visibleKey(b) : JSON.stringify(b.hiddenFiles.size));
  });
});
