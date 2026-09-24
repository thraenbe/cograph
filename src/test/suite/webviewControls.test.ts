import * as assert from 'assert';

// ---------------------------------------------------------------------------
// DOM setup via jsdom — must happen BEFORE requiring controls.js
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require('jsdom');

/** Build the minimal HTML that controls.js accesses at module load time. */
function makeDOM() {
  const html = `<!DOCTYPE html><html><body>
    <button id="settings-btn"></button>
    <div id="settings-panel"></div>
    <button id="btn-layout-dynamic"></button>
    <button id="btn-layout-static"></button>
    <button id="btn-engine-shelf"></button>
    <button id="btn-engine-global"></button>
    <input id="search" type="text" />
    <span id="btn-clear-search" style="display:none"></span>
    <div id="search-count"></div>
    <input id="toggle-orphans" type="checkbox" checked />
    <input id="toggle-libraries" type="checkbox" />
    <input id="toggle-arrows" type="checkbox" checked />
    <input id="slider-text-fade" type="range" value="0.5" /><span id="val-text-fade">0.5</span>
    <input id="slider-node-size" type="range" value="2.5" /><span id="val-node-size">2.5</span>
    <input id="slider-text-size" type="range" value="1" /><span id="val-text-size">1</span>
    <input id="slider-link-thickness" type="range" value="4" /><span id="val-link-thickness">4</span>
    <input id="slider-center-force" type="range" value="1" /><span id="val-center-force">1</span>
    <input id="slider-repel-force" type="range" value="50" /><span id="val-repel-force">50</span>
    <input id="slider-link-force" type="range" value="1" /><span id="val-link-force">1</span>
    <div id="toggle-git-legend"><span class="tl-chevron">▾</span></div>
    <div id="git-legend-body"></div>
    <div id="toggle-folder-filters"><span class="tl-chevron">▾</span></div>
    <div id="folder-filters-body"></div>
    <button id="btn-git-mode"></button>
    <button id="btn-language-mode"></button>
    <div id="language-legend"></div>
    <button id="lib-doc-close"></button>
    <div id="lib-doc-popup"></div>
    <button id="lib-doc-goto-btn"></button>
    <button id="func-popup-close"></button>
    <div id="func-popup"></div>
    <button id="func-open-file-btn"></button>
    <textarea id="func-source-textarea"></textarea>
    <button id="func-save-btn"></button>
    <div id="func-header"></div>
    <div id="func-card" style="left:100px;top:100px;width:400px;height:300px;"></div>
    <div id="func-card-inner"></div>
    <div class="func-resize-handle" data-dir="n"></div>
    <div class="func-resize-handle" data-dir="s"></div>
    <div class="func-resize-handle" data-dir="e"></div>
    <div class="func-resize-handle" data-dir="w"></div>
    <div class="func-resize-handle" data-dir="ne"></div>
    <div class="func-resize-handle" data-dir="nw"></div>
    <div class="func-resize-handle" data-dir="se"></div>
    <div class="func-resize-handle" data-dir="sw"></div>
    <input id="slider-complexity" type="range" value="0.99" />
    <span id="val-complexity">0.99</span>
    <button id="btn-folder-mode"></button>
    <button id="btn-class-mode"></button>
    <input id="slider-folder-repel" type="range" value="0.25" /><span id="val-folder-repel">0.25</span>
    <input id="slider-file-repel" type="range" value="0.25" /><span id="val-file-repel">0.25</span>
    <div id="panel-forces">
      <p id="forces-hint" style="display:none"></p>
      <div id="row-center-force"></div><div id="row-repel-force"></div><div id="row-link-force"></div>
      <div id="row-file-cluster"><label id="label-file-cluster">File Cluster Force</label></div>
      <div id="row-folder-repel"></div><div id="row-file-repel"></div>
      <button id="btn-show-more-forces">show more forces</button>
      <div id="forces-advanced">
        <div id="row-link-distance"><input id="slider-link-distance" type="range" value="40" /><span id="val-link-distance">40</span></div>
        <div id="row-velocity-decay"><input id="slider-velocity-decay" type="range" value="0.3" /><span id="val-velocity-decay">0.3</span></div>
        <div id="row-collide-pad"><input id="slider-collide-pad" type="range" value="1.5" /><span id="val-collide-pad">1.5</span></div>
        <div id="row-slot-pad"><input id="slider-slot-pad" type="range" value="0" /><span id="val-slot-pad">0</span></div>
        <div id="row-repel-range"><input id="slider-repel-range" type="range" min="100" max="2000" step="25" value="2000" /><span id="val-repel-range">∞</span></div>
      </div>
    </div>
    <input id="slider-file-cluster" type="range" value="0.2" /><span id="val-file-cluster">0.2</span>
    <button id="btn-reset-layout"></button>
    <button id="btn-save-graph"></button>
    <button id="btn-open-chat"></button>
  </body></html>`;
  return new JSDOM(html);
}

const dom = makeDOM();

// Install globals before requiring controls.js
(global as any).document = dom.window.document;
(global as any).window = dom.window;
(global as any).state = {
  gitMode: false,
  languageMode: false,
  folderMode: true,
  classMode: true,
  viewMode: 'cluster',
  clusterGroupBy: 'file',
  hasFitted: false,
  complexityLevel: 0.99,
  expandedClusters: new Set(),
  clusterTimer: null,
  activeLibNode: null,
  hiddenFolders: new Set(),
  onlyShowFolder: null,
  funcPopups: new Map(),
  funcPopupZCounter: 200,
};
(global as any).settings = {
  showOrphans: true, showLibraries: false, arrows: true,
  textFadeThreshold: 0.5, nodeSize: 2.5, textSize: 1.0, linkThickness: 4,
  centerForce: 1, repelForce: 50, linkForce: 1,
  folderRepelForce: 0.25, fileRepelForce: 0.25, fileClusterForce: 0.2,
  linkDistance: 40, velocityDecay: 0.3, collidePad: 1.5, slotPad: 0,
  repelRange: Infinity,
};
(global as any).vscode = { postMessage: () => {} };

// Cross-module function stubs — controls.js calls these on events
(global as any).setLayoutMode = () => {};
(global as any).applyFilters = () => {};
(global as any).applyComplexity = () => {};
(global as any).applyDisplaySettings = () => {};
// wireSlider captures its onInput callback by value at load time, so the stub
// counts calls into a module-level variable that suites can reset and read.
let rerunLayoutCallCount = 0;
(global as any).rerunLayout = () => { rerunLayoutCallCount++; };
(global as any).applyGitColors = () => {};
(global as any).fitToView = () => {};
(global as any).updateFuncHighlight = () => {};
(global as any).updateSaveBtn = () => {};
(global as any).highlightCode = () => '';

// Load controls.js (attaches all event listeners to existing DOM elements)
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../../src/webview/controls.js');

// Also get applyResizeDelta / applySavedViewSettings / buildSavePayload for direct testing
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyResizeDelta, applySavedViewSettings, applySavedDrilldownState, applySavedFileFilters, fileFilterAllows, buildSavePayload, clearSearch, updateSearchCount, updateFolderPanel } = require('../../../src/webview/controls.js');

// Load popups.js factory for textarea handler tests
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createFuncPopupInstance } = require('../../../src/webview/popups.js');

// ---------------------------------------------------------------------------
// Helper: dispatch a synthetic event on a DOM element
// ---------------------------------------------------------------------------
function dispatch(el: any, type: string, props: Record<string, any> = {}) {
  const event = Object.assign(dom.window.document.createEvent('Event'), props);
  event.initEvent(type, true, true);
  el.dispatchEvent(event);
}

function dispatchKey(el: any, type: string, key: string, extra: Record<string, any> = {}) {
  const EventCtor = (dom.window as any).KeyboardEvent;
  const event = new EventCtor(type, { bubbles: true, cancelable: true, key, ...extra });
  el.dispatchEvent(event);
  return event;
}

// ---------------------------------------------------------------------------
// Suite: applyResizeDelta — pure resize math
// ---------------------------------------------------------------------------

suite('applyResizeDelta()', () => {
  function makeCard(left: number, top: number, w: number, h: number) {
    return { style: { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` } };
  }

  test('east handle → increases width', () => {
    const card = makeCard(100, 100, 400, 300);
    applyResizeDelta(card, 'e', 50, 0, 100, 100, 400, 300);
    assert.strictEqual(parseFloat(card.style.width), 450);
    assert.strictEqual(parseFloat(card.style.left), 100, 'left should not change for east resize');
  });

  test('south handle → increases height', () => {
    const card = makeCard(100, 100, 400, 300);
    applyResizeDelta(card, 's', 0, 50, 100, 100, 400, 300);
    assert.strictEqual(parseFloat(card.style.height), 350);
    assert.strictEqual(parseFloat(card.style.top), 100, 'top should not change for south resize');
  });

  test('west handle → increases width and adjusts left', () => {
    const card = makeCard(100, 100, 400, 300);
    applyResizeDelta(card, 'w', -50, 0, 100, 100, 400, 300);
    assert.strictEqual(parseFloat(card.style.width), 450);
    assert.strictEqual(parseFloat(card.style.left), 50, 'left should decrease for west resize');
  });

  test('north handle → increases height and adjusts top', () => {
    const card = makeCard(100, 100, 400, 300);
    applyResizeDelta(card, 'n', 0, -50, 100, 100, 400, 300);
    assert.strictEqual(parseFloat(card.style.height), 350);
    assert.strictEqual(parseFloat(card.style.top), 50, 'top should decrease for north resize');
  });

  test('southeast handle → increases both width and height', () => {
    const card = makeCard(100, 100, 400, 300);
    applyResizeDelta(card, 'se', 30, 20, 100, 100, 400, 300);
    assert.strictEqual(parseFloat(card.style.width), 430);
    assert.strictEqual(parseFloat(card.style.height), 320);
  });

  test('width clamped to minimum 320px', () => {
    const card = makeCard(100, 100, 400, 300);
    // Dragging west by 200px would make width = 200, but should clamp to 320
    applyResizeDelta(card, 'e', -200, 0, 100, 100, 400, 300);
    assert.ok(parseFloat(card.style.width) >= 320, 'width should not go below 320');
  });

  test('height clamped to minimum 200px', () => {
    const card = makeCard(100, 100, 400, 300);
    // Dragging north by 200px would make height = 100, but should clamp to 200
    applyResizeDelta(card, 's', 0, -200, 100, 100, 400, 300);
    assert.ok(parseFloat(card.style.height) >= 200, 'height should not go below 200');
  });

  test('northwest handle → adjusts all four dimensions', () => {
    const card = makeCard(100, 100, 400, 300);
    applyResizeDelta(card, 'nw', -30, -20, 100, 100, 400, 300);
    assert.ok(parseFloat(card.style.width) > 400, 'width should increase for nw resize (dragging left)');
    assert.ok(parseFloat(card.style.height) > 300, 'height should increase for nw resize (dragging up)');
    assert.ok(parseFloat(card.style.left) < 100, 'left should decrease for nw resize');
    assert.ok(parseFloat(card.style.top) < 100, 'top should decrease for nw resize');
  });
});

// ---------------------------------------------------------------------------
// Suite: Legend toggle (wireLegendToggle)
// ---------------------------------------------------------------------------

suite('Legend toggle (wireLegendToggle)', () => {
  test('click toggle-folder-filters header → body collapses (display:none)', () => {
    const header = dom.window.document.getElementById('toggle-folder-filters')!;
    const body = dom.window.document.getElementById('folder-filters-body')!;
    body.style.display = '';  // start expanded

    header.click();

    assert.strictEqual(body.style.display, 'none', 'body should be hidden after click');
  });

  test('second click on toggle-folder-filters header → body expands again', () => {
    const header = dom.window.document.getElementById('toggle-folder-filters')!;
    const body = dom.window.document.getElementById('folder-filters-body')!;
    body.style.display = 'none';  // start collapsed

    header.click();

    assert.strictEqual(body.style.display, '', 'body should be visible after second click');
  });

  test('click collapses → chevron gets "collapsed" class', () => {
    const header = dom.window.document.getElementById('toggle-folder-filters')!;
    const body = dom.window.document.getElementById('folder-filters-body')!;
    const chevron = header.querySelector('.tl-chevron')!;
    body.style.display = '';

    header.click();

    assert.ok(chevron.classList.contains('collapsed'), 'chevron should gain collapsed class when body hides');
  });

  test('second click expands → chevron loses "collapsed" class', () => {
    const header = dom.window.document.getElementById('toggle-folder-filters')!;
    const body = dom.window.document.getElementById('folder-filters-body')!;
    const chevron = header.querySelector('.tl-chevron')!;
    body.style.display = 'none';
    chevron.classList.add('collapsed');

    header.click();

    assert.ok(!chevron.classList.contains('collapsed'), 'chevron should lose collapsed class when body shows');
  });
});

// ---------------------------------------------------------------------------
// Suite: Git / language legend visibility
// ---------------------------------------------------------------------------

suite('Git legend visibility (setGitLegendVisible)', () => {
  test('git legend elements start hidden (gitMode=false at load)', () => {
    const toggle = dom.window.document.getElementById('toggle-git-legend')!;
    const body = dom.window.document.getElementById('git-legend-body')!;
    // Both should be hidden since gitMode was false when controls.js was loaded
    assert.strictEqual(toggle.style.display, 'none');
    assert.strictEqual(body.style.display, 'none');
  });

  test('clicking btn-git-mode → makes git legend visible', () => {
    const btn = dom.window.document.getElementById('btn-git-mode')!;
    const toggle = dom.window.document.getElementById('toggle-git-legend')!;
    // Ensure state starts with gitMode=false
    (global as any).state.gitMode = false;
    toggle.style.display = 'none';

    btn.click();

    assert.strictEqual(toggle.style.display, '', 'git legend should be visible after enabling git mode');
    // Reset
    (global as any).state.gitMode = false;
  });
});

suite('Language legend visibility (setLangLegendVisible)', () => {
  test('language-legend starts hidden (languageMode=false at load)', () => {
    const legend = dom.window.document.getElementById('language-legend')!;
    assert.strictEqual(legend.style.display, 'none');
  });

  test('clicking btn-language-mode → makes language legend visible', () => {
    const btn = dom.window.document.getElementById('btn-language-mode')!;
    const legend = dom.window.document.getElementById('language-legend')!;
    (global as any).state.languageMode = false;
    legend.style.display = 'none';

    btn.click();

    assert.strictEqual(legend.style.display, '', 'language legend should be visible after enabling language mode');
    // Reset
    (global as any).state.languageMode = false;
  });
});

// ---------------------------------------------------------------------------
// Suite: Complexity slider
// ---------------------------------------------------------------------------

suite('Complexity slider', () => {
  test('input event → updates state.complexityLevel', () => {
    const slider = dom.window.document.getElementById('slider-complexity') as any;
    (global as any).state.complexityLevel = 0.99;
    slider.value = '0.5';

    dispatch(slider, 'input');

    assert.strictEqual((global as any).state.complexityLevel, 0.5);
  });

  test('input event → clears expandedClusters', () => {
    const slider = dom.window.document.getElementById('slider-complexity') as any;
    (global as any).state.expandedClusters = new Set(['cluster1', 'cluster2']);
    slider.value = '0.7';

    dispatch(slider, 'input');

    assert.strictEqual((global as any).state.expandedClusters.size, 0, 'expandedClusters should be cleared');
  });

  test('input event → updates val-complexity display', () => {
    const slider = dom.window.document.getElementById('slider-complexity') as any;
    const valEl = dom.window.document.getElementById('val-complexity')!;
    slider.value = '0.42';

    dispatch(slider, 'input');

    assert.ok(valEl.textContent!.startsWith('0.42'), `display should show 0.42, got: ${valEl.textContent}`);
  });
});

// ---------------------------------------------------------------------------
// Suite: Textarea keyboard handlers
// ---------------------------------------------------------------------------

suite('Textarea keyboard handlers', () => {
  const mockNode = { id: 'test-fn', name: 'testFunc', file: '/test.ts', line: 1, language: 'typescript' };
  let inst: any;

  setup(() => {
    inst = createFuncPopupInstance(mockNode);
    inst.textarea.readOnly = false;
  });

  teardown(() => {
    inst.element.remove();
  });

  test('Tab key in textarea → inserts \\t at cursor position', () => {
    inst.textarea.value = 'hello world';
    inst.textarea.selectionStart = 5;
    inst.textarea.selectionEnd = 5;
    const evt = dispatchKey(inst.textarea, 'keydown', 'Tab');
    assert.ok(inst.textarea.value.includes('\t') || evt.defaultPrevented,
      'Tab should insert a tab character or be prevented');
  });

  test('Ctrl+S in textarea → triggers save button click', () => {
    inst.saveBtn.disabled = false;
    let saveCalled = false;
    inst.saveBtn.addEventListener('click', () => { saveCalled = true; });
    const evt = dispatchKey(inst.textarea, 'keydown', 's', { ctrlKey: true });
    assert.ok(saveCalled || evt.defaultPrevented,
      'Ctrl+S should trigger save or prevent default');
  });
});

// ---------------------------------------------------------------------------
// Suite: Link Distance removal regression
// Regression for bug where settings.linkDistance was removed but rendering.js
// still read it, causing undefined → NaN distance and all nodes collapsing.
// ---------------------------------------------------------------------------

suite('Advanced forces (show more forces)', () => {
  const doc = dom.window.document;

  test('advanced sliders write their settings keys', () => {
    const cases: Array<[string, string, string, number]> = [
      ['slider-link-distance', 'linkDistance', '60', 60],
      ['slider-velocity-decay', 'velocityDecay', '0.5', 0.5],
      ['slider-collide-pad', 'collidePad', '4', 4],
      ['slider-slot-pad', 'slotPad', '6', 6],
    ];
    for (const [id, key, raw, expected] of cases) {
      const slider = doc.getElementById(id) as any;
      slider.value = raw;
      dispatch(slider, 'input');
      assert.strictEqual((global as any).settings[key], expected, key);
    }
  });

  test('show-more button toggles the advanced container open class', () => {
    const btn = doc.getElementById('btn-show-more-forces') as any;
    const adv = doc.getElementById('forces-advanced')!;
    adv.classList.remove('open');
    btn.click();
    assert.ok(adv.classList.contains('open'), 'first click opens');
    assert.ok(btn.textContent!.includes('fewer'), 'button flips its label');
    btn.click();
    assert.ok(!adv.classList.contains('open'), 'second click closes');
  });

  test('Node Size re-renders the shelf so the static grid re-packs (F16)', async () => {
    const savedUsesFrames = (global as any).usesFrames;
    const savedApplyFileClusters = (global as any).applyFileClusters;
    let rerenders = 0;
    (global as any).usesFrames = () => true;
    (global as any).applyFileClusters = () => { rerenders++; };
    try {
      const slider = doc.getElementById('slider-node-size') as any;
      slider.value = '5';
      dispatch(slider, 'input');
      dispatch(slider, 'input'); // drag fires many inputs — debounced to one
      assert.strictEqual(rerenders, 0, 'debounced, not synchronous');
      await new Promise(r => setTimeout(r, 200));
      assert.strictEqual(rerenders, 1, 'exactly one re-render after the debounce');
      (global as any).usesFrames = () => false;
      dispatch(slider, 'input');
      await new Promise(r => setTimeout(r, 200));
      assert.strictEqual(rerenders, 1, 'global engine: no shelf re-render');
    } finally {
      (global as any).usesFrames = savedUsesFrames;
      (global as any).applyFileClusters = savedApplyFileClusters;
    }
  });

  test('Repel range: slider maps its max position to Infinity (unlimited)', () => {
    const slider = doc.getElementById('slider-repel-range') as any;
    const val = doc.getElementById('val-repel-range')!;
    slider.value = '800';
    dispatch(slider, 'input');
    assert.strictEqual((global as any).settings.repelRange, 800);
    assert.strictEqual(val.textContent, '800');
    slider.value = '2000';
    dispatch(slider, 'input');
    assert.strictEqual((global as any).settings.repelRange, Infinity, 'max = unlimited');
    assert.strictEqual(val.textContent, '\u221E');
  });

  test('Repel range: save payload round-trips through JSON as unlimited', () => {
    (global as any).settings.repelRange = Infinity;
    (global as any).state.currentNodes = [];
    const p = buildSavePayload();
    assert.strictEqual(p.settings.repelRange, Infinity, 'payload carries the live value');
    const wire = JSON.parse(JSON.stringify(p)); // postMessage/disk serialization
    assert.strictEqual(wire.settings.repelRange, null, 'Infinity crosses JSON as null');
    (global as any).settings.repelRange = 300; // poison
    applySavedViewSettings(wire.settings);
    assert.strictEqual((global as any).settings.repelRange, Infinity, 'null restores as unlimited');
    applySavedViewSettings({ repelRange: 800 });
    assert.strictEqual((global as any).settings.repelRange, 800, 'finite value restores as-is');
    applySavedViewSettings({});
    assert.strictEqual((global as any).settings.repelRange, 800, 'old saves without the key change nothing');
  });

  test('reset restores every force to its canonical default (centerForce 0.025)', () => {
    Object.assign((global as any).settings, {
      centerForce: 0.9, fileClusterForce: 0.9, folderRepelForce: 9, fileRepelForce: 9,
      linkDistance: 99, velocityDecay: 0.9, collidePad: 9, slotPad: 9, repelRange: 300,
    });
    doc.getElementById('btn-reset-layout')?.click();
    const st = (global as any).settings;
    assert.strictEqual(st.repelRange, Infinity, 'reset returns Repel range to unlimited');
    assert.strictEqual(doc.getElementById('val-repel-range')!.textContent, '\u221E');
    assert.strictEqual(st.centerForce, 0.025);
    assert.strictEqual(st.fileClusterForce, 0.2);
    assert.strictEqual(st.folderRepelForce, 0.25);
    assert.strictEqual(st.fileRepelForce, 0.25);
    assert.strictEqual(st.linkDistance, 40);
    assert.strictEqual(st.velocityDecay, 0.3);
    assert.strictEqual(st.collidePad, 1.5);
    assert.strictEqual(st.slotPad, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite: Save Graph Layout button (btn-save-graph click handler)
// ---------------------------------------------------------------------------

suite('Save Graph Layout button', () => {
  const originalVscode = (global as any).vscode;
  const posted: any[] = [];

  setup(() => {
    posted.length = 0;
    (global as any).vscode = { postMessage: (msg: any) => posted.push(msg) };
    // controls.js reads these at click time from the global state object
    (global as any).state.currentNodes = [];
    (global as any).state.complexityLevel = 0.5;
    (global as any).state.clusterGroupBy = 'file';
    (global as any).state.layoutMode = 'dynamic';
    (global as any).state.gitMode = false;
    (global as any).state.languageMode = false;
    (global as any).state.folderMode = true;
    (global as any).state.classMode = false;
  });

  teardown(() => {
    (global as any).vscode = originalVscode;
  });

  test('click → postMessage with type save-graph, mode save-as, settings, and nodePositions', () => {
    (global as any).state.currentNodes = [
      { id: 'a::fn::1', x: 10, y: 20 },
      { id: 'b::fn::2', x: 30, y: 40 },
    ];
    (global as any).state.complexityLevel = 0.8;
    (global as any).state.clusterGroupBy = 'file';
    (global as any).state.layoutMode = 'static';
    (global as any).state.gitMode = true;
    (global as any).state.folderMode = true;
    (global as any).state.classMode = false;

    dom.window.document.getElementById('btn-save-graph')!.click();

    assert.strictEqual(posted.length, 1, 'postMessage should be called exactly once');
    const msg = posted[0];
    assert.strictEqual(msg.type, 'save-graph');
    assert.strictEqual(msg.mode, 'save-as', 'button always triggers save-as (prompt)');
    assert.deepStrictEqual(msg.payload.settings, {
      complexityLevel: 0.8,
      clusterGroupBy: 'file',
      layoutMode: 'static',
      gitMode: true,
      languageMode: false,
      folderMode: true,
      classMode: false,
      detailDepth: undefined, // not set in this stub state (v2 adds it)
      layoutEngine: undefined, // not set in this stub state (two-axis adds it)
      repelRange: Infinity,
    });
    assert.deepStrictEqual(msg.payload.nodePositions, {
      'a::fn::1': { x: 10, y: 20 },
      'b::fn::2': { x: 30, y: 40 },
    });
  });

  test('save-request message → postMessage with save-graph and forwarded mode', () => {
    (global as any).state.currentNodes = [{ id: 'x::1', x: 1, y: 2 }];

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'save-request', mode: 'save' },
    }));

    assert.strictEqual(posted.length, 1, 'postMessage should fire once');
    assert.strictEqual(posted[0].type, 'save-graph');
    assert.strictEqual(posted[0].mode, 'save');
    assert.deepStrictEqual(posted[0].payload.nodePositions, { 'x::1': { x: 1, y: 2 } });
  });

  test('save-request with mode save-as → forwards save-as', () => {
    (global as any).state.currentNodes = [];

    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'save-request', mode: 'save-as' },
    }));

    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].mode, 'save-as');
  });

  test('unrelated message → no save-graph postMessage', () => {
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'something-else' },
    }));

    assert.strictEqual(posted.length, 0);
  });

  test('falls back to fx/fy when x/y are nullish', () => {
    (global as any).state.currentNodes = [
      { id: 'pinned::1', x: null, y: null, fx: 5, fy: 6 },
      { id: 'pinned::2', fx: 100, fy: 200 },
    ];

    dom.window.document.getElementById('btn-save-graph')!.click();

    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(posted[0].payload.nodePositions, {
      'pinned::1': { x: 5, y: 6 },
      'pinned::2': { x: 100, y: 200 },
    });
  });

  test('zero as x/y is preserved (not replaced by fx/fy fallback)', () => {
    (global as any).state.currentNodes = [
      { id: 'origin::1', x: 0, y: 0, fx: 99, fy: 99 },
    ];

    dom.window.document.getElementById('btn-save-graph')!.click();

    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(posted[0].payload.nodePositions, {
      'origin::1': { x: 0, y: 0 },
    });
  });

  test('empty currentNodes → empty nodePositions object', () => {
    (global as any).state.currentNodes = [];

    dom.window.document.getElementById('btn-save-graph')!.click();

    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(posted[0].payload.nodePositions, {});
    // settings payload should still be populated
    assert.strictEqual(posted[0].payload.settings.clusterGroupBy, 'file');
  });
});

// ---------------------------------------------------------------------------
// Suite: Open Chat button (btn-open-chat click handler)
// ---------------------------------------------------------------------------

suite('Open Chat button', () => {
  const originalVscode = (global as any).vscode;
  const posted: any[] = [];

  setup(() => {
    posted.length = 0;
    (global as any).vscode = { postMessage: (msg: any) => posted.push(msg) };
  });

  teardown(() => {
    (global as any).vscode = originalVscode;
  });

  test('click → postMessage with type open-chat', () => {
    dom.window.document.getElementById('btn-open-chat')!.click();
    assert.strictEqual(posted.length, 1);
    assert.deepStrictEqual(posted[0], { type: 'open-chat' });
  });

  test('click does not carry any payload (focus-only signal)', () => {
    dom.window.document.getElementById('btn-open-chat')!.click();
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(Object.keys(posted[0]).length, 1, 'message has exactly one key');
  });
});

// ---------------------------------------------------------------------------
// Suite: Drill-down force sliders (Folder/File Repel)
// ---------------------------------------------------------------------------

suite('Drill-down force sliders', () => {
  const doc = dom.window.document;

  setup(() => { rerunLayoutCallCount = 0; });

  test('slider-folder-repel input → settings.folderRepelForce updated, val synced, rerunLayout', () => {
    const slider = doc.getElementById('slider-folder-repel') as any;
    slider.value = '0.5';
    dispatch(slider, 'input');
    assert.strictEqual((global as any).settings.folderRepelForce, 0.5);
    assert.strictEqual(doc.getElementById('val-folder-repel')!.textContent, '0.5');
    assert.strictEqual(rerunLayoutCallCount, 1);
  });

  test('slider-file-repel input → settings.fileRepelForce updated and rerunLayout', () => {
    const slider = doc.getElementById('slider-file-repel') as any;
    slider.value = '0.8';
    dispatch(slider, 'input');
    assert.strictEqual((global as any).settings.fileRepelForce, 0.8);
    assert.strictEqual(doc.getElementById('val-file-repel')!.textContent, '0.8');
    assert.strictEqual(rerunLayoutCallCount, 1);
  });
});

// ---------------------------------------------------------------------------
// Suite: applySavedViewSettings — graph-loaded display-state restore
// ---------------------------------------------------------------------------

suite('applySavedViewSettings()', () => {
  const st = () => (global as any).state;
  const doc = dom.window.document;

  setup(() => {
    // Deterministic baseline for every restore test.
    Object.assign(st(), {
      complexityLevel: 0.99, clusterGroupBy: 'file',
      gitMode: false, languageMode: false, folderMode: true, classMode: true,
    });
    ['btn-git-mode', 'btn-language-mode', 'btn-class-mode'].forEach(id =>
      doc.getElementById(id)!.classList.remove('active'));
    doc.getElementById('btn-folder-mode')!.classList.add('active');
  });

  test('every saved lens value loads as file (class/connect/legacy names)', () => {
    for (const legacy of ['class', 'connect', 'connectivity', 'auto', 'file']) {
      st().clusterGroupBy = 'poison';
      applySavedViewSettings({ clusterGroupBy: legacy });
      assert.strictEqual(st().clusterGroupBy, 'file', `saved '${legacy}' must load as file`);
    }
  });

  test('undefined clusterGroupBy leaves state untouched', () => {
    st().clusterGroupBy = 'file';
    applySavedViewSettings({});
    assert.strictEqual(st().clusterGroupBy, 'file');
  });

  test('folderMode:false restore updates state and clears the button active class', () => {
    applySavedViewSettings({ folderMode: false });
    assert.strictEqual(st().folderMode, false);
    assert.ok(!doc.getElementById('btn-folder-mode')!.classList.contains('active'));
  });

  test('gitMode/languageMode/classMode restore toggles state and button classes', () => {
    applySavedViewSettings({ gitMode: true, languageMode: true, classMode: false });
    assert.strictEqual(st().gitMode, true);
    assert.strictEqual(st().languageMode, true);
    assert.strictEqual(st().classMode, false);
    assert.ok(doc.getElementById('btn-git-mode')!.classList.contains('active'));
    assert.ok(doc.getElementById('btn-language-mode')!.classList.contains('active'));
    assert.ok(!doc.getElementById('btn-class-mode')!.classList.contains('active'));
  });

  test('complexityLevel restore syncs state, slider value, and val text', () => {
    applySavedViewSettings({ complexityLevel: 0.4 });
    assert.strictEqual(st().complexityLevel, 0.4);
    assert.strictEqual((doc.getElementById('slider-complexity') as any).value, '0.4');
    assert.strictEqual(doc.getElementById('val-complexity')!.textContent, '0.40');
  });

  test('empty settings object → no state mutation, no throw', () => {
    const before = { ...st() };
    applySavedViewSettings({});
    assert.strictEqual(st().complexityLevel, before.complexityLevel);
    assert.strictEqual(st().clusterGroupBy, before.clusterGroupBy);
    assert.strictEqual(st().gitMode, before.gitMode);
    assert.strictEqual(st().folderMode, before.folderMode);
  });
});

// ---------------------------------------------------------------------------
// Suite: applySavedDrilldownState — Global engine restore (F14)
// ---------------------------------------------------------------------------

suite('applySavedDrilldownState()', () => {
  const st = () => (global as any).state;
  let sliderCalls: number[];
  let parseCalls: number;

  setup(() => {
    sliderCalls = [];
    parseCalls = 0;
    (global as any).setDetailSlider = (v: number) => sliderCalls.push(v);
    (global as any).requestParseForExpanded = () => { parseCalls++; };
    st().detailDepth = 0.2;
    st().expandedFolders = new Set(['/old']);
  });

  teardown(() => {
    delete (global as any).setDetailSlider;
    delete (global as any).requestParseForExpanded;
  });

  test('applies detailDepth and expandedFolders from the payload', () => {
    const changed = applySavedDrilldownState({
      settings: { detailDepth: 0.6 },
      expandedFolders: ['/p', '/p/a'],
    });
    assert.strictEqual(changed, true);
    assert.strictEqual(st().detailDepth, 0.6);
    assert.deepStrictEqual([...st().expandedFolders].sort(), ['/p', '/p/a']);
    assert.deepStrictEqual(sliderCalls, [0.6], 'slider synced');
    assert.strictEqual(parseCalls, 1, 'expansion requests parses');
  });

  test('v1 payloads (no drill-down state) change nothing', () => {
    const changed = applySavedDrilldownState({ settings: {}, nodePositions: {} });
    assert.strictEqual(changed, false);
    assert.strictEqual(st().detailDepth, 0.2);
    assert.deepStrictEqual([...st().expandedFolders], ['/old']);
  });

  test('null payload is a no-op', () => {
    assert.strictEqual(applySavedDrilldownState(null), false);
  });
});

// ---------------------------------------------------------------------------
// Suite: file-level filters (R2a)
// ---------------------------------------------------------------------------

suite('file filters (R2a)', () => {
  const st = () => (global as any).state;
  const doc = dom.window.document;

  let savedBasename: any;
  setup(() => {
    st().hiddenFiles = new Set();
    st().onlyShowFile = null;
    st().hiddenFolders = new Set();
    st().onlyShowFolder = null;
    savedBasename = (global as any).pathBasename;
    (global as any).pathBasename = (fp: string) => fp.split('/').pop(); // folder.js global
  });

  teardown(() => { (global as any).pathBasename = savedBasename; });

  test('fileFilterAllows mirrors the folder rules', () => {
    assert.strictEqual(fileFilterAllows('/p/a.ts', null, new Set()), true);
    assert.strictEqual(fileFilterAllows('/p/a.ts', null, new Set(['/p/a.ts'])), false);
    assert.strictEqual(fileFilterAllows('/p/a.ts', '/p/a.ts', new Set()), true);
    assert.strictEqual(fileFilterAllows('/p/b.ts', '/p/a.ts', new Set()), false);
    // only-show wins even when also hidden (matches the folder semantics order)
    assert.strictEqual(fileFilterAllows('/p/a.ts', '/p/a.ts', new Set(['/p/a.ts'])), false);
  });

  test('save payload carries the file filters additively; restore round-trips', () => {
    st().currentNodes = [];
    st().hiddenFiles = new Set(['/p/b.ts', '/p/a.ts']);
    st().onlyShowFile = '/p/z.ts';
    const p = buildSavePayload();
    assert.deepStrictEqual(p.hiddenFiles, ['/p/a.ts', '/p/b.ts'], 'sorted, additive');
    assert.strictEqual(p.onlyShowFile, '/p/z.ts');
    st().hiddenFiles = new Set(); st().onlyShowFile = null;
    applySavedFileFilters(JSON.parse(JSON.stringify(p)));
    assert.deepStrictEqual([...st().hiddenFiles].sort(), ['/p/a.ts', '/p/b.ts']);
    assert.strictEqual(st().onlyShowFile, '/p/z.ts');
  });

  test('old saves without the fields change nothing', () => {
    st().hiddenFiles = new Set(['/keep.ts']);
    st().onlyShowFile = '/keep2.ts';
    assert.strictEqual(applySavedFileFilters({ settings: {}, nodePositions: {} }), false);
    assert.deepStrictEqual([...st().hiddenFiles], ['/keep.ts']);
    assert.strictEqual(st().onlyShowFile, '/keep2.ts');
  });

  test('filter chips render for files and clear them', () => {
    st().hiddenFiles = new Set(['/p/hidden.ts']);
    st().onlyShowFile = '/p/only.ts';
    updateFolderPanel();
    const body = doc.getElementById('folder-filters-body')!;
    const chips = body.querySelectorAll('.chip-file');
    assert.strictEqual(chips.length, 2, 'one chip per file filter');
    (body.querySelector('[data-action="unhide-file"]') as any).click();
    assert.strictEqual(st().hiddenFiles.size, 0, 'chip unhides the file');
    (body.querySelector('[data-action="clear-only-file"]') as any)?.click();
    assert.strictEqual(st().onlyShowFile, null);
  });

  test('Show All clears file filters too', () => {
    st().hiddenFiles = new Set(['/p/x.ts']);
    st().hiddenFolders = new Set(['/p']);
    updateFolderPanel();
    (doc.getElementById('btn-folder-show-all') as any).click();
    assert.strictEqual(st().hiddenFiles.size, 0);
    assert.strictEqual(st().hiddenFolders.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Suite: filter box shortcuts + match count
// ---------------------------------------------------------------------------

suite('search box UX', () => {
  const doc = dom.window.document;
  const searchEl = () => doc.getElementById('search') as any;
  const panel = () => doc.getElementById('settings-panel')!;
  const countEl = () => doc.getElementById('search-count')!;

  setup(() => {
    searchEl().value = '';
    panel().classList.remove('open');
    (global as any).state.funcPopups = new Map();
    updateSearchCount(null);
  });

  test('Ctrl+F opens the settings panel so the hidden search box is reachable', () => {
    dispatchKey(doc, 'keydown', 'f', { ctrlKey: true });
    assert.ok(panel().classList.contains('open'), 'panel must open — it is display:none while closed');
    assert.strictEqual(doc.activeElement, searchEl());
  });

  test('Cmd+F behaves like Ctrl+F', () => {
    dispatchKey(doc, 'keydown', 'f', { metaKey: true });
    assert.ok(panel().classList.contains('open'));
  });

  test('Escape clears a non-empty query before closing the panel', () => {
    panel().classList.add('open');
    searchEl().value = 'foo';
    dispatchKey(doc, 'keydown', 'Escape');
    assert.strictEqual(searchEl().value, '');
    assert.ok(panel().classList.contains('open'), 'first Escape only clears the query');
    dispatchKey(doc, 'keydown', 'Escape');
    assert.ok(!panel().classList.contains('open'), 'second Escape closes the panel');
  });

  test('Escape with an open function popup does not touch the query', () => {
    panel().classList.add('open');
    searchEl().value = 'foo';
    let closed = false;
    (global as any).closeFuncPopupInstance = () => { closed = true; };
    (global as any).state.funcPopups = new Map([['a', { element: { style: { zIndex: '200' } } }]]);
    dispatchKey(doc, 'keydown', 'Escape');
    assert.ok(closed, 'popup takes priority');
    assert.strictEqual(searchEl().value, 'foo');
  });

  test('clearSearch() returns false when the box is already empty', () => {
    assert.strictEqual(clearSearch(), false);
    searchEl().value = 'x';
    assert.strictEqual(clearSearch(), true);
  });

  test('match count is hidden while the query is empty', () => {
    updateSearchCount(new Set(['a', 'b']));
    assert.strictEqual(countEl().style.display, 'none');
    assert.strictEqual(countEl().textContent, '');
  });

  test('match count pluralizes and flags zero matches', () => {
    searchEl().value = 'foo';
    updateSearchCount(new Set(['a']));
    assert.strictEqual(countEl().textContent, '1 match');
    updateSearchCount(new Set(['a', 'b']));
    assert.strictEqual(countEl().textContent, '2 matches');
    assert.ok(!countEl().classList.contains('search-count--none'));
    updateSearchCount(new Set());
    assert.strictEqual(countEl().textContent, '0 matches');
    assert.ok(countEl().classList.contains('search-count--none'));
  });
});

// ---------------------------------------------------------------------------
// buildSavePayload — saved-layout v2 (frames engine)
// ---------------------------------------------------------------------------
suite('buildSavePayload (layout v2)', () => {
  let savedSerialize: unknown;

  setup(() => {
    savedSerialize = (global as any).serializeFrames;
    (global as any).state.currentNodes = [
      { id: 'fnA', x: 10, y: 20 },
      { id: 'fnB', x: 30, y: 40, fx: 31, fy: 41 },
    ];
    (global as any).state.detailDepth = 0.6;
    (global as any).state.layoutEngine = 'shelf';
    (global as any).state.expandedFolders = new Set(['/p', '/p/a']);
    (global as any).state.frames = { byPath: new Map([['/p/a', {}]]) };
    (global as any).serializeFrames = () => ({ '/p/a': { x: 1, y: 2, w: 300, h: 200, pinned: true } });
  });

  teardown(() => {
    (global as any).serializeFrames = savedSerialize;
    (global as any).state.frames = null;
    (global as any).state.expandedFolders = new Set();
  });

  test('carries v1 fields plus detailDepth, layoutEngine, expandedFolders and frames', () => {
    const p = buildSavePayload();
    assert.strictEqual(p.settings.detailDepth, 0.6);
    assert.strictEqual(p.settings.layoutEngine, 'shelf');
    assert.deepStrictEqual(p.expandedFolders, ['/p', '/p/a']);
    assert.deepStrictEqual(p.frames, { '/p/a': { x: 1, y: 2, w: 300, h: 200, pinned: true } });
    assert.deepStrictEqual(p.nodePositions.fnA, { x: 10, y: 20 });
    assert.deepStrictEqual(p.nodePositions.fnB, { x: 30, y: 40 }, 'positions stay absolute');
  });

  test('no frames / no expansion → v1-shaped payload (plus detailDepth)', () => {
    (global as any).state.frames = null;
    (global as any).state.expandedFolders = new Set();
    const p = buildSavePayload();
    assert.strictEqual(p.frames, undefined);
    assert.strictEqual(p.expandedFolders, undefined);
    assert.ok(p.nodePositions);
  });
});

// ---------------------------------------------------------------------------
// Layout toggles — engine (Shelf | Global) × motion (Dynamic | Static)
// ---------------------------------------------------------------------------
suite('Layout toggles (engine × motion)', () => {
  let savedSetLayoutMode: unknown;
  let savedSetLayoutEngine: unknown;
  let modeCalls: string[];
  let engineCalls: string[];

  setup(() => {
    savedSetLayoutMode = (global as any).setLayoutMode;
    savedSetLayoutEngine = (global as any).setLayoutEngine;
    modeCalls = [];
    engineCalls = [];
    (global as any).setLayoutMode = (m: string) => modeCalls.push(m);
    (global as any).setLayoutEngine = (e: string) => engineCalls.push(e);
  });

  teardown(() => {
    (global as any).setLayoutMode = savedSetLayoutMode;
    (global as any).setLayoutEngine = savedSetLayoutEngine;
  });

  test('engine buttons call setLayoutEngine', () => {
    dispatch(dom.window.document.getElementById('btn-engine-shelf'), 'click');
    dispatch(dom.window.document.getElementById('btn-engine-global'), 'click');
    assert.deepStrictEqual(engineCalls, ['shelf', 'global']);
    assert.deepStrictEqual(modeCalls, [], 'engine buttons never touch the motion axis');
  });

  test('motion buttons keep their classic wiring', () => {
    dispatch(dom.window.document.getElementById('btn-layout-dynamic'), 'click');
    dispatch(dom.window.document.getElementById('btn-layout-static'), 'click');
    assert.deepStrictEqual(modeCalls, ['dynamic', 'static']);
    assert.deepStrictEqual(engineCalls, [], 'motion buttons never touch the engine axis');
  });
});

// ---------------------------------------------------------------------------
// Suite: Filters section completeness (round 3, W2)
// ---------------------------------------------------------------------------

suite('Filters section (W2)', () => {
  const st = () => (global as any).state;
  const doc = dom.window.document;

  let savedBasename: any;
  setup(() => {
    st().hiddenFiles = new Set();
    st().onlyShowFile = null;
    st().hiddenFolders = new Set();
    st().onlyShowFolder = null;
    savedBasename = (global as any).pathBasename;
    (global as any).pathBasename = (fp: string) => fp.split('/').pop();
  });
  teardown(() => { (global as any).pathBasename = savedBasename; });

  test('folder filters save and restore (they never did before W2)', () => {
    st().currentNodes = [];
    st().hiddenFolders = new Set(['/p/b', '/p/a']);
    st().onlyShowFolder = '/p/z';
    const p = buildSavePayload();
    assert.deepStrictEqual(p.hiddenFolders, ['/p/a', '/p/b'], 'sorted, additive');
    assert.strictEqual(p.onlyShowFolder, '/p/z');
    st().hiddenFolders = new Set(); st().onlyShowFolder = null;
    applySavedFileFilters(JSON.parse(JSON.stringify(p)));
    assert.deepStrictEqual([...st().hiddenFolders].sort(), ['/p/a', '/p/b']);
    assert.strictEqual(st().onlyShowFolder, '/p/z');
    updateFolderPanel();
    const body = doc.getElementById('folder-filters-body')!;
    assert.strictEqual(body.querySelectorAll('[data-action="unhide"]').length, 2,
      'restored folder filters render as chips');
  });

  test('old saves without folder fields change nothing', () => {
    st().hiddenFolders = new Set(['/keep']);
    st().onlyShowFolder = '/keep2';
    applySavedFileFilters({ hiddenFiles: ['/p/x.ts'] });
    assert.deepStrictEqual([...st().hiddenFolders], ['/keep']);
    assert.strictEqual(st().onlyShowFolder, '/keep2');
  });

  test('un-hiding one kind leaves the other intact', () => {
    st().hiddenFolders = new Set(['/p/dir']);
    st().hiddenFiles = new Set(['/p/f.ts']);
    updateFolderPanel();
    const body = doc.getElementById('folder-filters-body')!;
    (body.querySelector('[data-action="unhide"]') as any).click();
    assert.strictEqual(st().hiddenFolders.size, 0);
    assert.deepStrictEqual([...st().hiddenFiles], ['/p/f.ts'], 'file filter untouched');
  });

  test('repo-controlled names are escaped in the chips', () => {
    const hostile = '/p/<img src=x onerror=boom>"\'.ts';
    st().hiddenFiles = new Set([hostile]);
    updateFolderPanel();
    const body = doc.getElementById('folder-filters-body')!;
    assert.strictEqual(body.querySelector('img'), null, 'no element injection');
    const label = body.querySelector('.chip-file .folder-filter-label') as any;
    assert.ok(label.textContent.includes('<img src=x onerror=boom>'), 'name shown verbatim');
    assert.strictEqual(label.getAttribute('title'), hostile, 'title survives quotes');
  });

  test('context-menu filter labels are sentence case in every engine', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fsMod = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    for (const f of ['folder.js', 'frameRender.js', 'rendering.js', 'drilldown.js']) {
      const src = fsMod.readFileSync(path.resolve(__dirname, '../../../src/webview/' + f), 'utf8');
      assert.ok(!src.includes("'Hide Folder'") && !src.includes("'Only Show Folder'")
        && !src.includes("'Show All Folders'"), `${f}: normalized labels`);
    }
  });
});
