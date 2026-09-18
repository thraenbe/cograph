import * as assert from 'assert';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require('jsdom');

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div id="panel-forces">
    <p id="forces-hint" style="display:none"></p>
    <div id="row-center-force"></div>
    <div id="row-repel-force"></div>
    <div id="row-link-force"></div>
    <div id="row-file-cluster"><label id="label-file-cluster">File Cluster Force</label></div>
    <div id="row-folder-repel"></div>
    <div id="row-file-repel"></div>
    <button id="btn-show-more-forces"></button>
    <div id="forces-advanced">
      <div id="row-link-distance"></div>
      <div id="row-velocity-decay"></div>
      <div id="row-collide-pad"></div>
      <div id="row-slot-pad"></div>
    </div>
  </div>
</body></html>`);

// Test files share one Node context: capture whatever document/state other
// spec files installed, use our own during this file's suites, and restore.
const prevDocument = (global as any).document;
const prevState = (global as any).state;
(global as any).document = dom.window.document;
(global as any).state = { layoutEngine: 'shelf', layoutMode: 'static' };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fp = require('../../../src/webview/forcesPanel.js');

// Module load ran the self-init against our DOM; hand the globals back until
// our suites actually run.
const bootHintShown = dom.window.document.getElementById('forces-hint')!.style.display !== 'none';
const bootRepelShown = dom.window.document.getElementById('row-repel-force')!.style.display !== 'none';
(global as any).document = prevDocument;
(global as any).state = prevState;

const shown = (id: string) =>
  dom.window.document.getElementById(id)!.style.display !== 'none';

suite('forcesPanel — updateForcesPanel()', () => {
  let savedDocument: any;
  let savedState: any;

  suiteSetup(() => {
    savedDocument = (global as any).document;
    savedState = (global as any).state;
    (global as any).document = dom.window.document;
    (global as any).state = { layoutEngine: 'shelf', layoutMode: 'static' };
  });

  suiteTeardown(() => {
    (global as any).document = savedDocument;
    (global as any).state = savedState;
  });

  test('module load synced the panel to the boot state (shelf+static)', () => {
    assert.ok(bootHintShown, 'static boot shows the hint');
    assert.ok(!bootRepelShown, 'sliders hidden while static');
  });

  test('static hides every slider and the expander, shows the hint', () => {
    fp.updateForcesPanel('global', 'static');
    assert.ok(shown('forces-hint'));
    for (const id of fp.FP_ALL) { assert.ok(!shown(id), `${id} hidden`); }
    assert.ok(!shown('btn-show-more-forces'));
    assert.ok(!shown('forces-advanced'));
  });

  test('shelf+dynamic: repel/link/keep-near-file only; slot padding in advanced', () => {
    fp.updateForcesPanel('shelf', 'dynamic');
    assert.ok(!shown('forces-hint'));
    assert.ok(shown('row-repel-force'));
    assert.ok(shown('row-link-force'));
    assert.ok(shown('row-file-cluster'));
    assert.ok(!shown('row-center-force'), 'no Center in the shelf');
    assert.ok(!shown('row-folder-repel'));
    assert.ok(!shown('row-file-repel'));
    assert.ok(shown('row-slot-pad'), 'slot padding is a shelf force');
    assert.strictEqual(
      dom.window.document.getElementById('label-file-cluster')!.textContent,
      'Keep near file',
    );
  });

  test('global+dynamic: all six basic sliders, no slot padding', () => {
    fp.updateForcesPanel('global', 'dynamic');
    for (const id of fp.FP_BASIC.global) { assert.ok(shown(id), `${id} shown`); }
    assert.ok(!shown('row-slot-pad'), 'slot padding is shelf-only');
    assert.ok(shown('btn-show-more-forces'));
    assert.strictEqual(
      dom.window.document.getElementById('label-file-cluster')!.textContent,
      'File Cluster Force',
    );
  });

  test('falls back to state when called without arguments', () => {
    (global as any).state.layoutEngine = 'global';
    (global as any).state.layoutMode = 'dynamic';
    fp.updateForcesPanel();
    assert.ok(shown('row-center-force'));
    assert.ok(!shown('forces-hint'));
  });

  test('unknown engine falls back to the global row set', () => {
    fp.updateForcesPanel('martian', 'dynamic');
    assert.ok(shown('row-center-force'));
    assert.ok(!shown('row-slot-pad'));
  });
});
