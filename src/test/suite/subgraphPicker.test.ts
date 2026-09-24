import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { scanStructure } from '../../structureScanner';
import { buildPickerFolders, SUBGRAPH_PICKER_CSS, SUBGRAPH_PICKER_MARKUP, SUBGRAPH_PICKER_SCRIPT } from '../../subgraphPicker';

/* eslint-disable @typescript-eslint/no-explicit-any */

const FOLDERS = [
  { rel: '.', name: '.', depth: 0, parent: null, fileCount: 7, hasChildren: true },
  { rel: 'src', name: 'src', depth: 1, parent: '.', fileCount: 5, hasChildren: true },
  { rel: 'src/server', name: 'server', depth: 2, parent: 'src', fileCount: 3, hasChildren: true },
  { rel: 'src/server/db', name: 'db', depth: 3, parent: 'src/server', fileCount: 1, hasChildren: false },
  { rel: 'src/ui', name: 'ui', depth: 2, parent: 'src', fileCount: 1, hasChildren: false },
  { rel: 'tools', name: 'tools', depth: 1, parent: '.', fileCount: 1, hasChildren: false },
];

interface Page {
  doc: Document;
  posted: Array<Record<string, unknown>>;
  rows(): string[];
  row(rel: string): HTMLElement;
  box(rel: string): HTMLInputElement;
  click(el: Element): void;
  key(el: Element, key: string): void;
  picking(): boolean;
  hint(): string;
}

function makePage(): Page {
  const dom = new JSDOM(`<div id="body-graphs"><button id="btn-new-graph"></button>${SUBGRAPH_PICKER_MARKUP}<input id="search"/><div id="graph-list"></div></div>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  w.eval(`var __posted = []; var vscode = { postMessage: function (m) { __posted.push(m); } };`);
  w.eval(SUBGRAPH_PICKER_SCRIPT);
  w.eval('wireSubgraphPicker();');
  w.eval(`spOpen(${JSON.stringify({ folders: FOLDERS, defaultName: 'Subgraph 1' })})`);
  const doc = w.document as Document;
  return {
    doc,
    get posted() { return JSON.parse(JSON.stringify(w.__posted)); },
    rows: () => Array.from(doc.querySelectorAll('.sp-row')).map(r => (r as HTMLElement).dataset.rel!),
    row: (rel) => doc.querySelector(`.sp-row[data-rel="${rel}"]`) as HTMLElement,
    box: (rel) => doc.querySelector(`.sp-row[data-rel="${rel}"] .sp-check`) as HTMLInputElement,
    click: (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    key: (el, key) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true })),
    picking: () => doc.getElementById('body-graphs')!.classList.contains('picking'),
    hint: () => doc.getElementById('sp-hint')!.textContent ?? '',
  };
}

suite('subgraphPicker — host rows', () => {
  test('buildPickerFolders: relative rows sorted by path with parent links and recursive counts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-sp-'));
    try {
      for (const rel of ['top.ts', 'src/a.ts', 'src/server/b.ts']) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), 'export const x = 1;\n');
      }
      const rows = buildPickerFolders(scanStructure(root), root);
      assert.deepStrictEqual(rows, [
        { rel: '.', name: '.', depth: 0, parent: null, fileCount: 3, hasChildren: true },
        { rel: 'src', name: 'src', depth: 1, parent: '.', fileCount: 2, hasChildren: true },
        { rel: 'src/server', name: 'server', depth: 2, parent: 'src', fileCount: 1, hasChildren: false },
      ]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('the embedded strings cannot break the host template', () => {
    for (const s of [SUBGRAPH_PICKER_SCRIPT, SUBGRAPH_PICKER_MARKUP, SUBGRAPH_PICKER_CSS]) {
      assert.ok(!s.includes('`') && !s.includes('${'));
    }
  });
});

suite('subgraphPicker — client script', () => {
  test('opens in picking mode with the root expanded one level and the default name', () => {
    const p = makePage();
    assert.strictEqual(p.picking(), true);
    assert.deepStrictEqual(p.rows(), ['.', 'src', 'tools']);
    assert.strictEqual((p.doc.getElementById('sp-name') as HTMLInputElement).value, 'Subgraph 1');
    assert.match(p.hint(), /Check the folders/);
  });

  test('expand/collapse via twisty, row click on a folder with children, and arrow keys', () => {
    const p = makePage();
    p.click(p.row('src').querySelector('.sp-twisty')!);
    assert.deepStrictEqual(p.rows(), ['.', 'src', 'src/server', 'src/ui', 'tools']);
    p.click(p.row('src').querySelector('.sp-name')!); // row click toggles too
    assert.deepStrictEqual(p.rows(), ['.', 'src', 'tools']);
    const tree = p.doc.getElementById('sp-tree')!;
    assert.ok(p.row('src').classList.contains('focused'), 'the click moved keyboard focus to src');
    p.key(tree, 'ArrowUp'); // root
    p.key(tree, 'ArrowDown'); // back to src
    p.key(tree, 'ArrowRight');
    assert.ok(p.rows().includes('src/server'));
    p.key(tree, 'ArrowLeft');
    assert.ok(!p.rows().includes('src/server'));
  });

  test('tri-state: checking a parent locks its descendants, some checked children make the parent indeterminate', () => {
    const p = makePage();
    p.click(p.row('src').querySelector('.sp-twisty')!);
    p.click(p.box('src/ui'));
    assert.strictEqual(p.box('src/ui').checked, true);
    assert.strictEqual(p.box('src').indeterminate, true, 'one of two children checked');
    assert.strictEqual(p.box('.').indeterminate, true);
    assert.match(p.hint(), /1 folder selected/);

    p.click(p.box('src'));
    assert.strictEqual(p.box('src').checked, true);
    assert.strictEqual(p.box('src').indeterminate, false);
    assert.strictEqual(p.box('src/ui').checked, true);
    assert.strictEqual(p.box('src/ui').disabled, true, 'locked: included via src');
    assert.ok(p.row('src/ui').classList.contains('locked'));
    assert.match(p.row('src/ui').title, /Included via src/);
    p.click(p.box('src/ui')); // locked: no effect
    assert.strictEqual(p.box('src').checked, true);

    p.click(p.box('src')); // uncheck the parent: the earlier explicit child is gone too (it was absorbed)
    assert.strictEqual(p.box('src').checked, false);
    assert.strictEqual(p.box('src/ui').checked, false);
    assert.strictEqual(p.box('src/ui').disabled, false);
  });

  test('search keeps ancestors of matches and forces them open; clearing restores the expansion', () => {
    const p = makePage();
    const search = p.doc.getElementById('sp-search') as HTMLInputElement;
    search.value = 'db';
    search.dispatchEvent(new (p.doc.defaultView as any).Event('input', { bubbles: true }));
    assert.deepStrictEqual(p.rows(), ['.', 'src', 'src/server', 'src/server/db']);
    search.value = 'zzz';
    search.dispatchEvent(new (p.doc.defaultView as any).Event('input', { bubbles: true }));
    assert.deepStrictEqual(p.rows(), []);
    assert.ok(p.doc.getElementById('sp-tree')!.textContent!.includes('No folder matches'));
    search.value = '';
    search.dispatchEvent(new (p.doc.defaultView as any).Event('input', { bubbles: true }));
    assert.deepStrictEqual(p.rows(), ['.', 'src', 'tools']);
  });

  test('Create posts the checked folders whose ancestors are not checked, then closes', () => {
    const p = makePage();
    p.click(p.row('src').querySelector('.sp-twisty')!);
    p.click(p.row('src/server').querySelector('.sp-twisty')!);
    p.click(p.box('src/server/db'));
    p.click(p.box('src/server')); // absorbs db
    p.click(p.box('tools'));
    (p.doc.getElementById('sp-name') as HTMLInputElement).value = ' backend ';
    p.click(p.doc.getElementById('sp-create')!);
    assert.deepStrictEqual(p.posted, [{ type: 'subgraph-create', name: 'backend', include: ['src/server', 'tools'] }]);
    assert.strictEqual(p.picking(), false);
  });

  test('space toggles the focused row and Enter creates from the tree', () => {
    const p = makePage();
    const tree = p.doc.getElementById('sp-tree')!;
    p.key(tree, 'ArrowDown'); p.key(tree, 'ArrowDown'); // tools
    p.key(tree, ' ');
    assert.strictEqual(p.box('tools').checked, true);
    p.key(tree, 'Enter');
    assert.deepStrictEqual(p.posted[0], { type: 'subgraph-create', name: 'Subgraph 1', include: ['tools'] });
  });

  test('refuses an empty name, nothing checked, and the whole project; Cancel and Escape close without posting', () => {
    const p = makePage();
    p.click(p.doc.getElementById('sp-create')!);
    assert.match(p.hint(), /at least one folder/);
    p.click(p.box('.'));
    p.click(p.doc.getElementById('sp-create')!);
    assert.match(p.hint(), /whole project/);
    p.click(p.box('.'));
    p.click(p.box('tools'));
    (p.doc.getElementById('sp-name') as HTMLInputElement).value = '   ';
    p.click(p.doc.getElementById('sp-create')!);
    assert.match(p.hint(), /name/);
    assert.deepStrictEqual(p.posted, []);
    assert.strictEqual(p.picking(), true);
    p.click(p.doc.getElementById('sp-cancel')!);
    assert.strictEqual(p.picking(), false);
    (p.doc.defaultView as any).eval(`spOpen(${JSON.stringify({ folders: FOLDERS, defaultName: 'S' })})`);
    p.key(p.doc.getElementById('sp-tree')!, 'Escape');
    assert.strictEqual(p.picking(), false);
    assert.deepStrictEqual(p.posted, []);
  });

  test('folder names are rendered as text', () => {
    const p = makePage();
    (p.doc.defaultView as any).eval(`spOpen(${JSON.stringify({ folders: [{ rel: '.', name: '.', depth: 0, parent: null, fileCount: 1, hasChildren: true }, { rel: 'x<img src=x onerror=alert(1)>', name: 'x<img src=x onerror=alert(1)>', depth: 1, parent: '.', fileCount: 1, hasChildren: false }], defaultName: 'S' })})`);
    assert.strictEqual(p.doc.querySelector('img'), null);
    assert.ok(p.doc.querySelector('.sp-name')!.parentElement!.parentElement!.textContent!.includes('<img'));
  });
});
