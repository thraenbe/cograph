import * as assert from 'assert';

// ---------------------------------------------------------------------------
// DOM setup via jsdom — must happen BEFORE requiring timeline.js
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require('jsdom');

function makeDOM() {
  const html = `<!DOCTYPE html><html><body>
    <button id="btn-timeline-play" disabled></button>
    <button id="btn-timeline-reset" disabled></button>
    <input id="slider-timeline-speed" type="range" min="0.5" max="50" step="0.5" value="5" />
    <span id="val-timeline-speed">5</span>
    <input id="slider-timeline-pos" type="range" min="0" max="0" step="1" value="0" disabled />
    <span id="val-timeline-pos">0 / 0</span>
  </body></html>`;
  return new JSDOM(html);
}

const dom = makeDOM();

// Timeline.js captures `state.timeline` by reference at module load, so we keep our own
// pointer — other test files overwrite `global.state` later, but timeline.js still mutates
// THIS object via its captured `tl` reference.
const tlState = {
  graphData: null as any,
  currentNodes: [],
  timeline: {
    order: [] as string[],
    libOrder: new Map<string, number>(),
    isPlaying: false,
    currentIdx: 0,
    rafHandle: null as number | null,
    lastFrameMs: 0,
    nodesPerSec: 5,
    filterPredicate: null as ((n: any) => boolean) | null,
  },
};

// Snapshot pre-existing globals so we can restore them between tests and after the suite.
// Prevents leaking `tlState` / our DOM into sibling test files (e.g. webviewControls) that
// also rely on `global.state` / `global.document`. Captured LAZILY on first install, so
// that sibling test files (whose file-level code may run before or after ours) have a
// chance to set their globals first.
let prevDocument: any = (global as any).document;
let prevWindow: any = (global as any).window;
let prevState: any = (global as any).state;
let prevApplyFilters: any = (global as any).applyFilters;
let prevRAF: any = (global as any).requestAnimationFrame;
let prevCAF: any = (global as any).cancelAnimationFrame;
let prevCaptured = false;
function capturePrev() {
  if (prevCaptured) { return; }
  prevCaptured = true;
  prevDocument = (global as any).document;
  prevWindow = (global as any).window;
  prevState = (global as any).state;
  prevApplyFilters = (global as any).applyFilters;
  prevRAF = (global as any).requestAnimationFrame;
  prevCAF = (global as any).cancelAnimationFrame;
}

// RAF driver that lets tests step frames manually.
const rafQueue: Array<(t: number) => void> = [];
let rafNow = 0;
const timelineRAF = (cb: (t: number) => void) => {
  rafQueue.push(cb);
  return rafQueue.length;
};
const timelineCAF = (_id: number) => { rafQueue.length = 0; };

function runFrame(dtMs: number) {
  rafNow += dtMs;
  const pending = rafQueue.splice(0);
  for (const cb of pending) { cb(rafNow); }
}

let applyFiltersCalls = 0;
const timelineApplyFilters = () => { applyFiltersCalls++; };

// Install our globals so timeline.js can capture `state.timeline` at require-time. We
// intentionally do NOT restore the previous globals here: file-level setup from sibling
// test files may run AFTER ours (glob order is filesystem-dependent) and will overwrite
// `global.state` anyway. We capture-and-restore LAZILY on first installTimelineGlobals()
// call, by which time all test files have loaded.
(global as any).document = dom.window.document;
(global as any).window = dom.window;
(global as any).state = tlState;
(global as any).applyFilters = timelineApplyFilters;
(global as any).requestAnimationFrame = timelineRAF;
(global as any).cancelAnimationFrame = timelineCAF;
(dom.window as any).requestAnimationFrame = timelineRAF;
(dom.window as any).cancelAnimationFrame = timelineCAF;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const timeline = require('../../../src/webview/timeline.js');

function installTimelineGlobals() {
  capturePrev();
  (global as any).document = dom.window.document;
  (global as any).window = dom.window;
  (global as any).state = tlState;
  (global as any).applyFilters = timelineApplyFilters;
  (global as any).requestAnimationFrame = timelineRAF;
  (global as any).cancelAnimationFrame = timelineCAF;
}

function restorePrevGlobals() {
  if (!prevCaptured) { return; }
  (global as any).document = prevDocument;
  (global as any).window = prevWindow;
  (global as any).state = prevState;
  (global as any).applyFilters = prevApplyFilters;
  (global as any).requestAnimationFrame = prevRAF;
  (global as any).cancelAnimationFrame = prevCAF;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetState(graph: any) {
  // Re-install our globals so timeline.js (which reads global.state/document lazily inside
  // its exported functions) sees the correct DOM and state during this test.
  installTimelineGlobals();
  tlState.graphData = graph;
  tlState.timeline.order = [];
  tlState.timeline.libOrder = new Map();
  tlState.timeline.isPlaying = false;
  tlState.timeline.currentIdx = 0;
  tlState.timeline.rafHandle = null;
  tlState.timeline.lastFrameMs = 0;
  tlState.timeline.nodesPerSec = 5;
  tlState.timeline.filterPredicate = null;
  applyFiltersCalls = 0;
  rafQueue.length = 0;
  rafNow = 0;
}

// ---------------------------------------------------------------------------
// receiveTimelineData — ordering
// ---------------------------------------------------------------------------

suite('timeline.receiveTimelineData()', () => {
  teardown(restorePrevGlobals);

  test('sorts project nodes by timestamp ascending', () => {
    resetState({
      nodes: [
        { id: 'a', file: '/ws/a.py', line: 1, isLibrary: false },
        { id: 'b', file: '/ws/b.py', line: 1, isLibrary: false },
        { id: 'c', file: '/ws/c.py', line: 1, isLibrary: false },
      ],
      edges: [],
    });
    timeline.receiveTimelineData([
      { id: 'a', ts: 300 },
      { id: 'b', ts: 100 },
      { id: 'c', ts: 200 },
    ]);
    assert.deepStrictEqual(tlState.timeline.order, ['b', 'c', 'a']);
  });

  test('nodes with no ts are appended at the end (stable by id)', () => {
    resetState({
      nodes: [
        { id: 'new2', file: '/ws/new2.py', line: 1 },
        { id: 'new1', file: '/ws/new1.py', line: 1 },
        { id: 'old', file: '/ws/old.py', line: 1 },
      ],
      edges: [],
    });
    timeline.receiveTimelineData([{ id: 'old', ts: 100 }]);
    const order = tlState.timeline.order;
    assert.strictEqual(order[0], 'old');
    assert.deepStrictEqual(order.slice(1).sort(), ['new1', 'new2']);
  });

  test('library nodes are excluded from project order', () => {
    resetState({
      nodes: [
        { id: 'lib1', isLibrary: true, file: null },
        { id: 'proj1', file: '/ws/a.py', line: 1 },
      ],
      edges: [],
    });
    timeline.receiveTimelineData([{ id: 'proj1', ts: 100 }]);
    assert.deepStrictEqual(tlState.timeline.order, ['proj1']);
  });

  test('MAIN sentinel node is excluded from order', () => {
    resetState({
      nodes: [
        { id: '::MAIN::0', file: null },
        { id: 'proj1', file: '/ws/a.py', line: 1 },
      ],
      edges: [],
    });
    timeline.receiveTimelineData([{ id: 'proj1', ts: 100 }]);
    assert.deepStrictEqual(tlState.timeline.order, ['proj1']);
  });

  test('enables Play/Reset buttons and sets scrubber max', () => {
    resetState({
      nodes: [{ id: 'a', file: '/ws/a.py', line: 1 }],
      edges: [],
    });
    timeline.receiveTimelineData([{ id: 'a', ts: 100 }]);
    const playBtn = dom.window.document.getElementById('btn-timeline-play');
    const resetBtn = dom.window.document.getElementById('btn-timeline-reset');
    const slider = dom.window.document.getElementById('slider-timeline-pos');
    assert.strictEqual(playBtn.disabled, false);
    assert.strictEqual(resetBtn.disabled, false);
    assert.strictEqual(slider.disabled, false);
    assert.strictEqual(slider.max, '1');
  });

  test('installs filterPredicate on state', () => {
    resetState({
      nodes: [{ id: 'a', file: '/ws/a.py', line: 1 }],
      edges: [],
    });
    timeline.receiveTimelineData([{ id: 'a', ts: 100 }]);
    assert.strictEqual(typeof tlState.timeline.filterPredicate, 'function');
  });

  test('default currentIdx is at the end (full state visible, idle)', () => {
    resetState({
      nodes: [
        { id: 'a', file: '/ws/a.py', line: 1 },
        { id: 'b', file: '/ws/b.py', line: 1 },
      ],
      edges: [],
    });
    timeline.receiveTimelineData([
      { id: 'a', ts: 100 },
      { id: 'b', ts: 200 },
    ]);
    assert.strictEqual(tlState.timeline.currentIdx, 2);
  });
});

// ---------------------------------------------------------------------------
// filterPredicate — project / library / special nodes
// ---------------------------------------------------------------------------

suite('timeline.filterPredicate', () => {
  teardown(restorePrevGlobals);

  test('project node hidden when idx >= currentIdx', () => {
    resetState({
      nodes: [
        { id: 'a', file: '/ws/a.py', line: 1 },
        { id: 'b', file: '/ws/b.py', line: 1 },
      ],
      edges: [],
    });
    timeline.receiveTimelineData([
      { id: 'a', ts: 100 },
      { id: 'b', ts: 200 },
    ]);
    const pred = tlState.timeline.filterPredicate!;
    tlState.timeline.currentIdx = 1;
    assert.strictEqual(pred({ id: 'a', file: '/ws/a.py', line: 1 }), true, 'a visible at idx 1');
    assert.strictEqual(pred({ id: 'b', file: '/ws/b.py', line: 1 }), false, 'b hidden at idx 1');
  });

  test('cluster nodes are always visible', () => {
    resetState({ nodes: [{ id: 'a', file: '/ws/a.py', line: 1 }], edges: [] });
    timeline.receiveTimelineData([{ id: 'a', ts: 100 }]);
    const pred = tlState.timeline.filterPredicate!;
    tlState.timeline.currentIdx = 0;
    assert.strictEqual(pred({ id: 'cluster-1', isCluster: true }), true);
  });

  test('synthetic nodes are always visible', () => {
    resetState({ nodes: [{ id: 'a', file: '/ws/a.py', line: 1 }], edges: [] });
    timeline.receiveTimelineData([{ id: 'a', ts: 100 }]);
    const pred = tlState.timeline.filterPredicate!;
    tlState.timeline.currentIdx = 0;
    assert.strictEqual(pred({ id: 'synth-1', isSynthetic: true }), true);
  });

  test('MAIN sentinel is always visible', () => {
    resetState({ nodes: [{ id: 'a', file: '/ws/a.py', line: 1 }], edges: [] });
    timeline.receiveTimelineData([{ id: 'a', ts: 100 }]);
    const pred = tlState.timeline.filterPredicate!;
    tlState.timeline.currentIdx = 0;
    assert.strictEqual(pred({ id: '::MAIN::0' }), true);
  });

  test('library node visible only when first referencer has appeared', () => {
    resetState({
      nodes: [
        { id: 'a', file: '/ws/a.py', line: 1 },
        { id: 'b', file: '/ws/b.py', line: 1 },
        { id: 'lib:numpy.array', isLibrary: true, file: null },
      ],
      edges: [
        { source: 'b', target: 'lib:numpy.array' },
      ],
    });
    timeline.receiveTimelineData([
      { id: 'a', ts: 100 },
      { id: 'b', ts: 200 },
    ]);
    // order: a, b. lib is referenced by b (idx 1), so libOrder = 2 (appears AFTER b).
    const pred = tlState.timeline.filterPredicate!;
    const libNode = { id: 'lib:numpy.array', isLibrary: true };
    tlState.timeline.currentIdx = 1;
    assert.strictEqual(pred(libNode), false, 'lib hidden when only a is visible');
    tlState.timeline.currentIdx = 2;
    assert.strictEqual(pred(libNode), true, 'lib visible once b has appeared');
  });

  test('library with no referencer is hidden throughout timeline', () => {
    resetState({
      nodes: [
        { id: 'a', file: '/ws/a.py', line: 1 },
        { id: 'orphanLib', isLibrary: true, file: null },
      ],
      edges: [],
    });
    timeline.receiveTimelineData([{ id: 'a', ts: 100 }]);
    const pred = tlState.timeline.filterPredicate!;
    tlState.timeline.currentIdx = 1;
    assert.strictEqual(pred({ id: 'orphanLib', isLibrary: true }), false);
  });
});

// ---------------------------------------------------------------------------
// play / pause / reset
// ---------------------------------------------------------------------------

suite('timeline.play / pause / reset', () => {
  teardown(restorePrevGlobals);

  test('play() sets isPlaying and schedules RAF', () => {
    resetState({
      nodes: [
        { id: 'a', file: '/ws/a.py', line: 1 },
        { id: 'b', file: '/ws/b.py', line: 1 },
      ],
      edges: [],
    });
    timeline.receiveTimelineData([
      { id: 'a', ts: 100 },
      { id: 'b', ts: 200 },
    ]);
    tlState.timeline.currentIdx = 0;
    timeline.play();
    assert.strictEqual(tlState.timeline.isPlaying, true);
    assert.strictEqual(rafQueue.length, 1, 'RAF should be scheduled');
  });

  test('tick advances currentIdx based on nodesPerSec × dt', () => {
    resetState({
      nodes: [
        { id: 'a', file: '/ws/a.py', line: 1 },
        { id: 'b', file: '/ws/b.py', line: 1 },
        { id: 'c', file: '/ws/c.py', line: 1 },
        { id: 'd', file: '/ws/d.py', line: 1 },
      ],
      edges: [],
    });
    timeline.receiveTimelineData([
      { id: 'a', ts: 100 },
      { id: 'b', ts: 200 },
      { id: 'c', ts: 300 },
      { id: 'd', ts: 400 },
    ]);
    tlState.timeline.currentIdx = 0;
    tlState.timeline.nodesPerSec = 10;
    timeline.play();
    // First frame establishes baseline (dt=0); subsequent frames advance.
    runFrame(0);
    runFrame(200); // 200ms × 10/sec = 2 nodes
    assert.ok(tlState.timeline.currentIdx >= 2 - 1e-9);
    assert.ok(tlState.timeline.currentIdx <= 2 + 1e-9);
  });

  test('tick pauses and clamps when reaching end', () => {
    resetState({
      nodes: [
        { id: 'a', file: '/ws/a.py', line: 1 },
        { id: 'b', file: '/ws/b.py', line: 1 },
      ],
      edges: [],
    });
    timeline.receiveTimelineData([
      { id: 'a', ts: 100 },
      { id: 'b', ts: 200 },
    ]);
    tlState.timeline.currentIdx = 0;
    tlState.timeline.nodesPerSec = 100;
    timeline.play();
    runFrame(0);
    runFrame(1000);
    assert.strictEqual(tlState.timeline.isPlaying, false);
    assert.strictEqual(tlState.timeline.currentIdx, 2);
  });

  test('pause() stops RAF loop', () => {
    resetState({
      nodes: [{ id: 'a', file: '/ws/a.py', line: 1 }],
      edges: [],
    });
    timeline.receiveTimelineData([{ id: 'a', ts: 100 }]);
    tlState.timeline.currentIdx = 0;
    timeline.play();
    timeline.pause();
    assert.strictEqual(tlState.timeline.isPlaying, false);
  });

  test('reset() returns to idx 0 and pauses', () => {
    resetState({
      nodes: [
        { id: 'a', file: '/ws/a.py', line: 1 },
        { id: 'b', file: '/ws/b.py', line: 1 },
      ],
      edges: [],
    });
    timeline.receiveTimelineData([
      { id: 'a', ts: 100 },
      { id: 'b', ts: 200 },
    ]);
    tlState.timeline.currentIdx = 1;
    tlState.timeline.isPlaying = true;
    timeline.reset();
    assert.strictEqual(tlState.timeline.currentIdx, 0);
    assert.strictEqual(tlState.timeline.isPlaying, false);
  });

  test('play() from end → restarts from 0', () => {
    resetState({
      nodes: [
        { id: 'a', file: '/ws/a.py', line: 1 },
        { id: 'b', file: '/ws/b.py', line: 1 },
      ],
      edges: [],
    });
    timeline.receiveTimelineData([
      { id: 'a', ts: 100 },
      { id: 'b', ts: 200 },
    ]);
    tlState.timeline.currentIdx = 2;
    timeline.play();
    assert.strictEqual(tlState.timeline.currentIdx, 0);
  });
});

// ---------------------------------------------------------------------------
// disarmControls — called on reanalysis
// ---------------------------------------------------------------------------

suite('timeline.disarmControls()', () => {
  teardown(restorePrevGlobals);

  test('clears order, libOrder, and disables buttons', () => {
    resetState({
      nodes: [{ id: 'a', file: '/ws/a.py', line: 1 }],
      edges: [],
    });
    timeline.receiveTimelineData([{ id: 'a', ts: 100 }]);
    timeline.disarmControls();
    assert.deepStrictEqual(tlState.timeline.order, []);
    assert.strictEqual(tlState.timeline.filterPredicate, null);
    const playBtn = dom.window.document.getElementById('btn-timeline-play');
    assert.strictEqual(playBtn.disabled, true);
  });
});
