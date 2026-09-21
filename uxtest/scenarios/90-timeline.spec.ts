// 90 — Timeline panel: transport appears only in the timeline HTML; play, scrub, speed, reset.
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { clickSel, fitToView, setSlider } from '../lib/actions';
import { timelineEntries } from '../lib/fixtures';
import { SEL } from '../selectors';

scenario('timeline', { perMotion: false, perEngine: false, timeline: true }, async ({ page, ux, post, repo }) => {
  const entries = timelineEntries(repo);
  await ux.step('Timeline panel loaded; transport disabled until history arrives', async () => {
    await fitToView(page);
    await expect(page.locator(SEL.tlPlay.css)).toBeDisabled();
  });
  await ux.step(`Host sends timeline-data (${entries.length} functions)`, async () => {
    await post({ type: 'timeline-data', nodes: entries });
    await expect(page.locator(SEL.tlPlay.css)).toBeEnabled();
  });
  await ux.step('Reset to the empty graph', async () => { await clickSel(page, 'tlReset'); });
  await ux.step('Speed to maximum', async () => { await setSlider(page, 'tlSpeed', 50); }, { metrics: false });
  await ux.step('Play for 3 s', async () => { await clickSel(page, 'tlPlay'); await page.waitForTimeout(3000); }, { settle: false });
  await ux.step('Pause', async () => { await clickSel(page, 'tlPlay'); });
  await ux.step('Scrub to the middle', async () => { await setSlider(page, 'tlPos', Math.floor(entries.length / 2)); });
  await ux.step('Scrub to the end', async () => { await setSlider(page, 'tlPos', entries.length); });
});
