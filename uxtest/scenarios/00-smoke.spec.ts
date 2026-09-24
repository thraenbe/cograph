// 00-smoke — the thin slice and the harness self-test: boot the real webview,
// open the largest folder, walk the engine × motion matrix, record everything.
import { test, expect } from '@playwright/test';
import { openLab } from '../lib/lab';
import { matrix } from '../lib/matrix';
import { clickNode, clickSel, fitToView, setSlider, switchEngine } from '../lib/actions';

for (const c of matrix({ perEngine: false, perMotion: false })) {
  test(`smoke · ${c.repo}`, async ({ browser }) => {
    const lab = await openLab({ ...c, scenario: 'smoke', browser });
    const { page, ux } = lab;
    try {
      await ux.step('Overview after load (C1)', async () => { /* observe only */ });

      await ux.step('Fit to view (double-click background)', async () => { await fitToView(page); });
      await ux.step('Detail slider to 0 (collapse to top-level folders)', async () => { await setSlider(page, 'detailSlider', 0); });
      await ux.step('Fit the collapsed overview', async () => { await fitToView(page); });
      await ux.step('Expand the largest folder (C2)', async () => {
        await clickNode(page, { kind: 'folder', pick: 'largest' });
      });

      await ux.step('Detail slider to full depth (C3)', async () => { await setSlider(page, 'detailSlider', 1); });
      await ux.step('Fit the full-depth layout', async () => { await fitToView(page); });

      await ux.step('Motion: Dynamic', async () => { await clickSel(page, 'motionDynamic'); });
      await ux.step('Engine: Global', async () => { await switchEngine(page, 'global'); });
      await ux.step('Motion: Static', async () => { await clickSel(page, 'motionStatic'); });
      await ux.step('Engine: Shelf', async () => { await clickSel(page, 'engineShelf'); });

      const last = ux.steps[ux.steps.length - 1];
      expect(last.metrics?.nodes ?? 0).toBeGreaterThan(0);
    } finally {
      const run = await lab.close();
      expect(run.steps.filter(s => s.status === 'failed')).toEqual([]);
    }
  });
}
