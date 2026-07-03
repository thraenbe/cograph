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
    <input id="search" type="text" />
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
    <button id="btn-group-file" class="active"></button>
    <button id="btn-group-class"></button>
    <button id="btn-group-connect"></button>
    <button id="btn-folder-mode"></button>
    <button id="btn-class-mode"></button>
    <input id="slider-folder-repel" type="range" value="0.25" /><span id="val-folder-repel">0.25</span>
    <input id="slider-file-repel" type="range" value="0.25" /><span id="val-file-repel">0.25</span>
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
  folderRepelForce: 0.25, fileRepelForce: 0.25,
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

// Also get applyResizeDelta / applySavedViewSettings for direct testing
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyResizeDelta, applySavedViewSettings } = require('../../../src/webview/controls.js');

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

suite('Link Distance removal regression', () => {
  test('settings object has no linkDistance property', () => {
    assert.strictEqual(
      (global as any).settings.linkDistance,
      undefined,
      'linkDistance was removed — rendering must use a hardcoded value, not settings.linkDistance',
    );
  });

  test('slider-link-distance element does not exist in DOM', () => {
    const slider = dom.window.document.getElementById('slider-link-distance');
    assert.strictEqual(slider, null, 'slider-link-distance should not be present in the webview HTML');
  });

  test('wireSlider input event does not create settings.linkDistance', () => {
    // Trigger every wired slider — none should write linkDistance onto settings
    const sliderIds = [
      'slider-text-size', 'slider-center-force', 'slider-repel-force', 'slider-link-force',
    ];
    for (const id of sliderIds) {
      const slider = dom.window.document.getElementById(id) as any;
      if (slider) dispatch(slider, 'input');
    }
    assert.strictEqual(
      (global as any).settings.linkDistance,
      undefined,
      'no slider should write settings.linkDistance',
    );
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
    (global as any).state.clusterGroupBy = 'connect';
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
    (global as any).state.clusterGroupBy = 'class';
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
      clusterGroupBy: 'class',
      layoutMode: 'static',
      gitMode: true,
      languageMode: false,
      folderMode: true,
      classMode: false,
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
    assert.strictEqual(posted[0].payload.settings.clusterGroupBy, 'connect');
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
// Suite: Group-by lens buttons (File / Class / Connect)
// ---------------------------------------------------------------------------

suite('Group-by lens buttons', () => {
  const st = () => (global as any).state;
  const doc = dom.window.document;
  let savedApplyComplexity: any;
  let savedEnterFileClusterMode: any;
  let applyComplexityCalls: number;
  let enterFileClusterModeCalls: number;

  setup(() => {
    savedApplyComplexity = (global as any).applyComplexity;
    savedEnterFileClusterMode = (global as any).enterFileClusterMode;
    applyComplexityCalls = 0;
    enterFileClusterModeCalls = 0;
    (global as any).applyComplexity = () => { applyComplexityCalls++; };
    (global as any).enterFileClusterMode = () => { enterFileClusterModeCalls++; };
    Object.assign(st(), {
      viewMode: 'cluster', clusterGroupBy: 'file',
      expandedClusters: new Set(['some-cluster']),
    });
  });

  teardown(() => {
    (global as any).applyComplexity = savedApplyComplexity;
    (global as any).enterFileClusterMode = savedEnterFileClusterMode;
  });

  test('File click → delegates to enterFileClusterMode and clears expandedClusters', () => {
    doc.getElementById('btn-group-file')!.click();
    assert.strictEqual(enterFileClusterModeCalls, 1, 'file lens enters the drill-down');
    assert.strictEqual(st().expandedClusters.size, 0, 'expanded clusters reset');
    assert.strictEqual(applyComplexityCalls, 0, 'handler defers rendering to enterFileClusterMode');
  });

  test('Class click → viewMode=cluster, clusterGroupBy=class, applyComplexity called', () => {
    st().viewMode = 'workflow'; // prove the lens click leaves workflow mode
    doc.getElementById('btn-group-class')!.click();
    assert.strictEqual(st().viewMode, 'cluster');
    assert.strictEqual(st().clusterGroupBy, 'class');
    assert.strictEqual(applyComplexityCalls, 1);
    assert.strictEqual(enterFileClusterModeCalls, 0);
  });

  test('Connect click → clusterGroupBy=connect and applyComplexity called', () => {
    doc.getElementById('btn-group-connect')!.click();
    assert.strictEqual(st().viewMode, 'cluster');
    assert.strictEqual(st().clusterGroupBy, 'connect');
    assert.strictEqual(applyComplexityCalls, 1);
  });

  test('lens buttons toggle the active class exclusively', () => {
    doc.getElementById('btn-group-class')!.click();
    assert.ok(doc.getElementById('btn-group-class')!.classList.contains('active'));
    assert.ok(!doc.getElementById('btn-group-file')!.classList.contains('active'));
    assert.ok(!doc.getElementById('btn-group-connect')!.classList.contains('active'));
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

  test('legacy clusterGroupBy remap: connectivity → connect', () => {
    applySavedViewSettings({ clusterGroupBy: 'connectivity' });
    assert.strictEqual(st().clusterGroupBy, 'connect');
  });

  test('legacy clusterGroupBy remap: auto → connect', () => {
    applySavedViewSettings({ clusterGroupBy: 'auto' });
    assert.strictEqual(st().clusterGroupBy, 'connect');
  });

  test('modern clusterGroupBy passes through; undefined leaves state untouched', () => {
    applySavedViewSettings({ clusterGroupBy: 'class' });
    assert.strictEqual(st().clusterGroupBy, 'class');
    applySavedViewSettings({});
    assert.strictEqual(st().clusterGroupBy, 'class', 'undefined key must not reset the lens');
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
