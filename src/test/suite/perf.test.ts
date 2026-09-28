import * as assert from 'assert';

// perf.js is a pure webview global module (no DOM/d3 at load); it reads the
// shared `state` global for the enable flag and `vscode.postMessage` for
// reports — both stubbed here (pattern: webviewControls.test.ts).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const perf = require('../../../src/webview/perf.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = global as any;

suite('webview perf instrumentation', () => {
  let savedState: unknown;
  let savedVscode: unknown;
  let posted: any[];

  setup(() => {
    savedState = g.state;
    savedVscode = g.vscode;
    posted = [];
    g.state = { perfEnabled: true, currentNodes: [{}, {}], layoutEngine: 'global' };
    g.vscode = { postMessage: (m: any) => posted.push(m) };
    perf.perfReset();
  });

  teardown(() => {
    perf.perfReset();
    g.state = savedState;
    g.vscode = savedVscode;
  });

  test('disabled: everything is a no-op and nothing is posted', () => {
    g.state.perfEnabled = false;
    perf.perfMark('render:start');
    perf.perfMeasure('renderElements', 'render:start');
    perf.perfTick(5);
    perf.perfCount('getVisibleNodeIds');
    perf.perfSettled();
    perf.postPerfReport();
    assert.strictEqual(posted.length, 0);
    const report = perf.perfReport();
    assert.deepStrictEqual(report.stats, {});
    assert.strictEqual(report.tick.samples, 0);
  });

  test('mark + measure accumulate count/avg/max', () => {
    perf.perfMark('render:start');
    perf.perfMeasure('renderElements', 'render:start');
    perf.perfMark('render:start');
    perf.perfMeasure('renderElements', 'render:start');
    const report = perf.perfReport();
    assert.strictEqual(report.stats.renderElements.count, 2);
    assert.ok(report.stats.renderElements.avgMs >= 0);
    assert.ok(report.stats.renderElements.maxMs >= report.stats.renderElements.avgMs);
  });

  test('measure without a prior mark is ignored', () => {
    perf.perfMeasure('renderElements', 'never-marked');
    assert.deepStrictEqual(perf.perfReport().stats, {});
  });

  test('tick ring buffer caps at PERF_TICK_RING and reports percentiles', () => {
    for (let i = 0; i < perf.PERF_TICK_RING + 30; i++) { perf.perfTick(i); }
    const report = perf.perfReport();
    assert.strictEqual(report.tick.samples, perf.PERF_TICK_RING);
    assert.ok(report.tick.p50Ms > 0);
    assert.ok(report.tick.p95Ms >= report.tick.p50Ms);
    assert.ok(report.tick.maxMs >= report.tick.p95Ms);
  });

  test('counts are reported', () => {
    perf.perfCount('getVisibleNodeIds');
    perf.perfCount('getVisibleNodeIds');
    assert.strictEqual(perf.perfReport().counts.getVisibleNodeIds, 2);
  });

  test('report carries node count and engine from state', () => {
    const report = perf.perfReport();
    assert.strictEqual(report.nodes, 2);
    assert.strictEqual(report.engine, 'global');
  });

  test('postPerfReport posts a perf-report message when enabled', () => {
    perf.perfTick(1);
    perf.postPerfReport();
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].type, 'perf-report');
    assert.strictEqual(posted[0].report.tick.samples, 1);
  });

  test('perfSettled records sim:settle since sim:start', () => {
    perf.perfMark('sim:start');
    perf.perfSettled();
    const report = perf.perfReport();
    assert.strictEqual(report.stats['sim:settle'].count, 1);
    perf.perfReset(); // clears the auto-report timer perfSettled scheduled
  });

  test('frame ring buffer caps and reports percentiles next to ticks', () => {
    for (let i = 0; i < perf.PERF_TICK_RING + 5; i++) { perf.perfFrame(i); }
    const report = perf.perfReport();
    assert.strictEqual(report.frame.samples, perf.PERF_TICK_RING);
    assert.ok(report.frame.p95Ms >= report.frame.p50Ms);
    assert.strictEqual(report.tick.samples, 0);
    perf.perfReset();
    assert.strictEqual(perf.perfReport().frame.samples, 0);
  });

  test('perfBegin/perfEnd and perfSpan accumulate named stats', () => {
    const t0 = perf.perfBegin();
    assert.ok(t0 > 0);
    perf.perfEnd('hover:over', t0);
    const value = perf.perfSpan('hover:over', () => 42);
    assert.strictEqual(value, 42);
    assert.strictEqual(perf.perfReport().stats['hover:over'].count, 2);
  });

  test('perfSpan records even when the callback throws', () => {
    assert.throws(() => perf.perfSpan('boom', () => { throw new Error('x'); }));
    assert.strictEqual(perf.perfReport().stats.boom.count, 1);
  });

  test('disabled: perfBegin returns 0 and perfEnd/perfFrame/perfSpan record nothing', () => {
    g.state.perfEnabled = false;
    const t0 = perf.perfBegin();
    assert.strictEqual(t0, 0);
    perf.perfEnd('x', t0);
    perf.perfFrame(3);
    assert.strictEqual(perf.perfSpan('y', () => 'ok'), 'ok');
    const report = perf.perfReport();
    assert.deepStrictEqual(report.stats, {});
    assert.strictEqual(report.frame.samples, 0);
  });
});
