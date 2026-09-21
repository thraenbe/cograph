// Lab self-test: the whole Tier A pipeline on the deterministic synthetic repo.
// Verifies what c8 cannot see (code that runs inside Chromium): snapshot
// collection, the settle detector, overlay, fps trace, host bridge.
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openLab } from '../lib/lab';
import { clickSel, dragBy, fitToView, locateNode, need, setSlider, switchEngine, wheelZoom, backgroundPoint } from '../lib/actions';
import { SkipStep } from '../lib/step';
import { attachLogFile, log } from '../lib/log';
import { EXT_ROOT } from '../harness/vscodeStub';

test('lab boots the real webview, records steps and produces sane geometry', async ({ browser }) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-lab-'));
  const lab = await openLab({ repo: 'synthetic-1k', scenario: 'selftest', browser, outDir, video: true });
  const { page, ux, host } = lab;
  let closed = false;
  try {
    const first = await ux.step('Load', async () => { /* observe */ });
    expect(first.status).toBe('ok');
    expect(first.still?.settled).toBe(true);
    expect(first.metrics).toMatchObject({ frameOverlapPairs: 0, slotOverlapPairs: 0, nodesOutsideFrame: 0, nodesOutsideSlot: 0 });
    expect(first.metrics?.nodes).toBeGreaterThan(100);
    expect(first.metrics?.frames).toBeGreaterThan(1);
    expect(first.metrics?.slots).toBeGreaterThan(1);
    expect(ux.lastSnapshot).toMatchObject({ engine: 'shelf', motion: 'static', viewport: { w: 1280, h: 800 } });
    expect(await page.locator('#__ux-overlay').count()).toBe(1);
    expect(await page.evaluate(() => document.body.classList.contains('vscode-dark'))).toBe(true);

    const fit = await ux.step('Fit', async () => { await fitToView(page); });
    expect(fit.metrics?.offscreenNodeRatio).toBe(0);

    await ux.step('Global + dynamic', async () => { await switchEngine(page, 'global'); await clickSel(page, 'motionDynamic'); }, { stillTimeoutMs: 4000 });
    expect(ux.lastSnapshot?.engine).toBe('global');
    expect(ux.lastSnapshot?.frames.length).toBeGreaterThanOrEqual(0);
    expect(ux.steps[2].metrics?.frames).toBe(0); // stale frames are not scored under the global engine

    await ux.step('Back to shelf/static, detail 0', async () => {
      await clickSel(page, 'engineShelf'); await clickSel(page, 'motionStatic'); await setSlider(page, 'detailSlider', 0);
    });
    await fitToView(page);            // the collapsed root glyph must be fully on screen to be locatable
    await page.waitForTimeout(900);
    const folder = await locateNode(page, { kind: 'folder', pick: 'largest' });
    expect(folder.id).toBeTruthy();

    const zoomBefore = ux.lastSnapshot?.zoom.k ?? 0;
    await ux.step('Zoom + pan', async () => {
      const bg = await backgroundPoint(page);
      await wheelZoom(page, bg, -200, 2);
      await dragBy(page, bg, -60, 40);
    });
    expect(ux.lastSnapshot?.zoom.k).toBeGreaterThan(zoomBefore);

    const skipped = await ux.step('Optional selector', async () => { await need(page, 'absentForTest'); });
    expect(skipped).toMatchObject({ status: 'skipped' });
    expect(skipped.note).toContain('selector absent');
    await expect(ux.step('Failing step', async () => { throw new Error('boom'); }, { settle: false, metrics: false })).rejects.toThrow('boom');
    expect(ux.steps[ux.steps.length - 1]).toMatchObject({ status: 'failed', note: 'boom', metrics: null });
    await expect(locateNode(page, { kind: 'fn', id: 'no-such-node' })).rejects.toBeInstanceOf(SkipStep);

    await lab.post({ type: 'config', defaultEngine: 'global' });
    await page.waitForFunction('state.layoutEngine === "global"');
    await clickSel(page, 'saveGraph');
    await expect.poll(() => host.saved.length).toBe(1);

    const run = await lab.close();
    closed = true;
    expect(run).toMatchObject({ repo: 'synthetic-1k', scenario: 'selftest', engine: 'shelf', motion: 'static', hostMode: 'eager', video: 'video.webm', blockedRequests: [] });
    // Product console errors are findings, not harness failures: they must be captured and attributed to a step.
    expect(run.steps.reduce((n, st) => n + st.consoleErrors.length, 0)).toBe(run.consoleErrors.length);
    for (const st of run.steps) { expect(st.findings.some(f => f.rule === 'console-error')).toBe(st.consoleErrors.length > 0 && st.metrics !== null); }
    expect(run.perfReport).toBeTruthy();
    expect(run.hostLog.some(l => l.message.type === 'save-graph')).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(outDir, 'run.json'), 'utf8'));
    expect(written.steps).toHaveLength(7);
    expect(fs.statSync(path.join(outDir, 'video.webm')).size).toBeGreaterThan(1000);
    for (const s of run.steps) { expect(fs.existsSync(path.join(outDir, s.screenshot as string)), s.name).toBe(true); }
    expect(fs.existsSync(path.join(outDir, run.steps[0].snapshot as string))).toBe(true);
    expect(fs.readFileSync(path.join(outDir, 'run.log'), 'utf8')).toContain('"event":"step"');
  } finally {
    if (!closed) { await lab.close().catch(() => undefined); }
  }
});

test('lab self-launches a browser and boots in lazy host mode', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-lab-'));
  const lab = await openLab({ repo: 'synthetic-1k', hostMode: 'lazy', engine: 'global', motion: 'dynamic', outDir, video: false, keepSnapshots: false, theme: 'light' });
  try {
    expect(await lab.page.evaluate('state.layoutEngine + "/" + state.layoutMode')).toBe('global/dynamic');
    expect(await lab.page.evaluate(() => document.body.classList.contains('vscode-light'))).toBe(true);
    const rec = await lab.ux.step('Skeleton', async () => { /* observe */ }, { stillTimeoutMs: 3000 });
    expect(rec.snapshot).toBeNull();
    for (const r of lab.host.backgroundDone()) { await lab.post(r.message); }
  } finally {
    const run = await lab.close();
    expect(run.video).toBeNull();
    expect(run.hostMode).toBe('lazy');
  }
});

test('worker transport: a bundled checkout really runs its sims in workers inside the lab (and sync when switched off)', async ({ browser }) => {
  // Only checkouts that ship dist/webview/simWorker.js have a worker transport (perf branch onwards).
  test.skip(!fs.existsSync(path.join(EXT_ROOT, 'dist', 'webview', 'simWorker.js')), `${EXT_ROOT} has no bundled simWorker.js`);
  for (const mode of ['on', 'off'] as const) {
    const lab = await openLab({ repo: 'synthetic-1k', engine: 'shelf', motion: 'dynamic', workers: mode, browser, video: false, keepSnapshots: false,
      outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-lab-')) });
    try {
      const before = await lab.ux.step('Settle', async () => { /* observe */ }, { stillTimeoutMs: 30000 });
      await lab.ux.step('Repel 250 → 600', async () => { await setSlider(lab.page, 'forceRepel', 600); }, { expectMotionMs: 10000, stillTimeoutMs: 30000 });
      expect(before.metrics?.nodes).toBeGreaterThan(100);
      expect(lab.ux.steps[1].still?.firstMoveMs, `${mode}: the force change must move nodes`).not.toBeNull();
      const t = await lab.simTransport();
      if (mode === 'on') {
        expect(t.workerUri, 'COGRAPH_CONFIG.workerUri').toContain('simWorker.js');
        expect(t).toMatchObject({ requested: 'on', kind: 'worker', fallbacks: [] });
        expect(t.poolSize).toBeGreaterThan(0);
        expect(await lab.page.evaluate('typeof d3 !== "undefined"')).toBe(true);
      } else {
        expect(t).toMatchObject({ requested: 'off', kind: 'sync', poolSize: 0 });
      }
    } finally {
      const run = await lab.close();
      expect(run.blockedRequests).toEqual([]);
      expect(run.simTransport.requested).toBe(mode);
    }
  }
});

test('logger mirrors into a file and survives a bad sink', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-log-')), 'run.log');
  attachLogFile(file);
  log.info('hello', { a: 1 }); log.warn('w'); log.error('e'); log.debug('d');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(lines.map(l => l.event)).toEqual(['hello', 'w', 'e', 'd']);
  expect(lines[0]).toMatchObject({ level: 'info', a: 1 });
  attachLogFile('/definitely/not/a/dir/run.log');
  expect(() => log.info('still-works')).not.toThrow();
});
