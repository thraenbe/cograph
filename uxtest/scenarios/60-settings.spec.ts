// 60 — Gear panel: search (+ Ctrl+F, clear, count), filters, display sliders,
// global forces, function-popup toggle, reset layout.
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { clickSel, openSettings, setSlider, toggleSwitch, typeInto } from '../lib/actions';
import { SEL } from '../selectors';

scenario('settings', { perMotion: false }, async ({ page, ux, repo, host }) => {
  const probe = (repo.graph.nodes.find(n => !n.isLibrary && n.file && String(n.name ?? '').length > 3)?.name as string | undefined) ?? 'test';
  await ux.step('Open the gear panel', async () => { await openSettings(page); }, { metrics: false });
  await ux.step(`Search "${probe.slice(0, 4)}"`, async () => { await typeInto(page, 'search', probe.slice(0, 4)); });
  expect(await page.locator(SEL.searchCount.css).innerText()).not.toBe('');
  await ux.step('Clear search', async () => { await clickSel(page, 'clearSearch'); });
  await ux.step('Ctrl+F focuses search', async () => {
    await page.keyboard.press('Control+f');
    await expect(page.locator(SEL.search.css)).toBeFocused();
  }, { metrics: false });

  for (const name of ['toggleOrphans', 'toggleLibraries', 'toggleEmptyFiles', 'toggleArrows'] as const) {
    await ux.step(`${name} flip`, async () => { await toggleSwitch(page, name); }, { stillTimeoutMs: 8000 });
    await ux.step(`${name} restore`, async () => { await toggleSwitch(page, name); }, { stillTimeoutMs: 8000 });
  }
  for (const [name, v, back] of [['sliderTextFade', 0, 0.5], ['sliderNodeSize', 5, 2.5], ['sliderTextSize', 3, 1.5], ['sliderLinkThickness', 8, 4]] as const) {
    await ux.step(`${name} = ${v}`, async () => { await setSlider(page, name, v); });
    await ux.step(`${name} = ${back}`, async () => { await setSlider(page, name, back); });
  }
  await ux.step('Motion → Dynamic for the force sliders', async () => { await clickSel(page, 'motionDynamic'); });
  for (const [name, v, back] of [['forceCenter', 0.5, 0.05], ['forceRepel', 900, 250], ['forceLink', 8, 1]] as const) {
    await ux.step(`${name} = ${v}`, async () => { await setSlider(page, name, v); }, { stillTimeoutMs: 8000 });
    await ux.step(`${name} = ${back}`, async () => { await setSlider(page, name, back); }, { stillTimeoutMs: 8000 });
  }
  await ux.step('Function popup toggle off', async () => { await toggleSwitch(page, 'toggleFuncPopup'); }, { metrics: false });
  await ux.step('Function popup toggle on', async () => { await toggleSwitch(page, 'toggleFuncPopup'); }, { metrics: false });
  await ux.step('Reset layout', async () => { await clickSel(page, 'resetLayout'); }, { stillTimeoutMs: 10000 });
  await ux.step('Motion → Static', async () => { await clickSel(page, 'motionStatic'); });
  expect(host.posted('dirty-state').length).toBeGreaterThan(0);
});
