// 20 — Detail slider: sweep the drill-down depth 0 → 1 → 0 (C1/C2/C3 checkpoints).
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { fitToView, setSlider } from '../lib/actions';
import { SEL } from '../selectors';

scenario('detail', { perMotion: false, largeOk: true }, async ({ page, ux }) => {
  const counts: number[] = [];
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const rec = await ux.step(`Detail ${v.toFixed(2)}`, async () => { await setSlider(page, 'detailSlider', v); await fitToView(page); });
    counts.push(rec.metrics?.nodes ?? 0);
  }
  await ux.step('Detail back to 0', async () => { await setSlider(page, 'detailSlider', 0); await fitToView(page); });
  expect(await page.locator(SEL.detailValue.css).innerText()).not.toBe('');
  expect(counts[counts.length - 1], `more detail must not show fewer nodes: ${counts.join(',')}`).toBeGreaterThanOrEqual(counts[0]);
});
