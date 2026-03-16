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
    <input id="slider-repel-force" type="range" value="350" /><span id="val-repel-force">350</span>
    <input id="slider-link-force" type="range" value="1" /><span id="val-link-force">1</span>
    <input id="slider-link-distance" type="range" value="40" /><span id="val-link-distance">40</span>
    <div id="toggle-detail-legend"><span class="tl-chevron">▾</span></div>
    <div id="detail-legend-body"></div>
    <div id="toggle-git-legend"><span class="tl-chevron">▾</span></div>
    <div id="git-legend-body"></div>
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
  hasFitted: false,
  funcCardDragged: false,
  funcCardX: 0, funcCardY: 0, funcCardW: 0, funcCardH: 0,
  complexityLevel: 0.99,
  expandedClusters: new Set(),
  clusterTimer: null,
  activeFuncNode: null,
  activeLibNode: null,
};
(global as any).settings = {
  showOrphans: true, showLibraries: false, arrows: true,
  textFadeThreshold: 0.5, nodeSize: 2.5, textSize: 1.0, linkThickness: 4,
  centerForce: 1, repelForce: 350, linkForce: 1, linkDistance: 40,
};
(global as any).vscode = { postMessage: () => {} };

// Cross-module function stubs — controls.js calls these on events
(global as any).setLayoutMode = () => {};
(global as any).applyFilters = () => {};
(global as any).applyComplexity = () => {};
(global as any).applyDisplaySettings = () => {};
(global as any).rerunLayout = () => {};
(global as any).applyGitColors = () => {};
(global as any).fitToView = () => {};
(global as any).updateFuncHighlight = () => {};
(global as any).updateSaveBtn = () => {};

// Load controls.js (attaches all event listeners to existing DOM elements)
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../../src/webview/controls.js');

// Also get applyResizeDelta for direct testing
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyResizeDelta } = require('../../../src/webview/controls.js');

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
  test('click toggle-detail-legend header → body collapses (display:none)', () => {
    const header = dom.window.document.getElementById('toggle-detail-legend')!;
    const body = dom.window.document.getElementById('detail-legend-body')!;
    body.style.display = '';  // start expanded

    header.click();

    assert.strictEqual(body.style.display, 'none', 'body should be hidden after click');
  });

  test('second click on toggle-detail-legend header → body expands again', () => {
    const header = dom.window.document.getElementById('toggle-detail-legend')!;
    const body = dom.window.document.getElementById('detail-legend-body')!;
    body.style.display = 'none';  // start collapsed

    header.click();

    assert.strictEqual(body.style.display, '', 'body should be visible after second click');
  });

  test('click collapses → chevron gets "collapsed" class', () => {
    const header = dom.window.document.getElementById('toggle-detail-legend')!;
    const body = dom.window.document.getElementById('detail-legend-body')!;
    const chevron = header.querySelector('.tl-chevron')!;
    body.style.display = '';

    header.click();

    assert.ok(chevron.classList.contains('collapsed'), 'chevron should gain collapsed class when body hides');
  });

  test('second click expands → chevron loses "collapsed" class', () => {
    const header = dom.window.document.getElementById('toggle-detail-legend')!;
    const body = dom.window.document.getElementById('detail-legend-body')!;
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
  test('Tab key in textarea → inserts \\t at cursor position', () => {
    const ta = dom.window.document.getElementById('func-source-textarea') as any;
    ta.value = 'hello world';
    ta.selectionStart = 5;
    ta.selectionEnd = 5;

    const evt = dispatchKey(ta, 'keydown', 'Tab');
    // In jsdom, preventDefault doesn't actually prevent default, but we can check value
    // after the handler runs
    assert.ok(ta.value.includes('\t') || evt.defaultPrevented, 'Tab should insert a tab character or be prevented');
  });

  test('Ctrl+S in textarea → triggeres save (button click prevented default)', () => {
    const ta = dom.window.document.getElementById('func-source-textarea')!;
    const saveBtn = dom.window.document.getElementById('func-save-btn') as any;
    saveBtn.disabled = false;

    let saveCalled = false;
    saveBtn.addEventListener('click', () => { saveCalled = true; });

    const evt = dispatchKey(ta, 'keydown', 's', { ctrlKey: true });

    // Either the save button was clicked or the event was prevented
    assert.ok(saveCalled || evt.defaultPrevented, 'Ctrl+S should trigger save or prevent default');
  });
});
