// 10 — Engine × Motion: every toggle, the layout hint, the live `config`
// message, and switching engines while the other one is still settling.
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { clickSel, fitToView } from '../lib/actions';
import { SEL } from '../selectors';

scenario('engine-motion', { perEngine: false, perMotion: false }, async ({ page, ux, post }) => {
  const hint = () => page.locator(SEL.layoutHint.css).innerText();
  await ux.step('Shelf + Static after load', async () => { await fitToView(page); });
  const hints: Record<string, string> = { 'shelf/static': await hint() };

  await ux.step('Motion → Dynamic (Shelf)', async () => { await clickSel(page, 'motionDynamic'); });
  hints['shelf/dynamic'] = await hint();
  await ux.step('Engine → Global while Dynamic', async () => { await clickSel(page, 'engineGlobal'); }, { stillTimeoutMs: 6000 });
  hints['global/dynamic'] = await hint();
  await ux.step('Engine → Shelf while Global is still settling', async () => { await clickSel(page, 'engineShelf'); });
  await ux.step('Motion → Static', async () => { await clickSel(page, 'motionStatic'); });
  await ux.step('Engine → Global (Static)', async () => { await clickSel(page, 'engineGlobal'); });
  hints['global/static'] = await hint();
  await ux.step('Fit Global + Static', async () => { await fitToView(page); });

  await ux.step('Host pushes config: shelf + dynamic', async () => {
    await post({ type: 'config', defaultEngine: 'shelf', defaultMode: 'dynamic' });
    await page.waitForFunction('state.layoutEngine === "shelf" && state.layoutMode === "dynamic"');
  });
  await ux.step('Host pushes config: static', async () => { await post({ type: 'config', defaultMode: 'static' }); });

  expect(new Set(Object.values(hints)).size, `layout hint must differ per combination: ${JSON.stringify(hints)}`).toBe(4);
  expect(await page.evaluate('state.layoutEngine + "/" + state.layoutMode')).toBe('shelf/static');
});
