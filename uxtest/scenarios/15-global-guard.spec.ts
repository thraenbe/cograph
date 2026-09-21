// 15 — Global guard (ux ee36bf5): above 4 000 visible nodes the first "Engine: Global" click must only show
// #global-guard-hint; a second click within 6 s switches. Below the threshold there is no hint and one click
// switches. Optional selector → every step skips on branches without the guard.
//   npm run uxtest -- --scenario global-guard --repo synthetic-10k,click
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { clickSel, GLOBAL_GUARD_NODES, need, setSlider } from '../lib/actions';
import { StepFinding } from '../lib/step';
import { SEL } from '../selectors';

scenario('global-guard', { perMotion: false, only: { engine: 'shelf', motion: 'static' }, largeOk: true }, async ({ page, ux }) => {
  const hint = page.locator(SEL.globalGuardHint.css).first();
  const engineNow = (): Promise<string> => page.evaluate('state.layoutEngine') as Promise<string>;
  await ux.step('Full detail', async () => { await need(page, 'globalGuardHint'); await setSlider(page, 'detailSlider', 1); }, { stillTimeoutMs: 60000 });
  const nodes = await page.evaluate('state.currentNodes.length') as number;
  const big = nodes > GLOBAL_GUARD_NODES;

  await ux.step(`First click on Global with ${nodes} nodes → ${big ? 'hint, still Shelf' : 'switches, no hint'}`, async () => {
    await need(page, 'globalGuardHint');
    await clickSel(page, 'engineGlobal');
    await page.waitForTimeout(400);
    const shown = await hint.isVisible(), eng = await engineNow();
    if (big && (!shown || eng !== 'shelf')) { throw new StepFinding({ rule: 'global-guard-missing', severity: 'high', ref: 'Global guard', message: `${nodes} nodes: first Global click gave hint=${shown}, engine=${eng} (expected the hint and engine shelf)` }); }
    if (!big && (shown || eng !== 'global')) { throw new StepFinding({ rule: 'global-guard-overeager', severity: 'medium', ref: 'Global guard', message: `${nodes} nodes (≤ ${GLOBAL_GUARD_NODES}): hint=${shown}, engine=${eng} (expected a direct switch)` }); }
  }, { settle: false, metrics: false });

  await ux.step(big ? 'Second click within 6 s → Global' : 'Already Global', async () => {
    await need(page, 'globalGuardHint');
    if (big) { await clickSel(page, 'engineGlobal'); await page.waitForTimeout(600); }
    expect(await engineNow(), 'engine after confirming').toBe('global');
  }, { settle: false, metrics: false });

  await ux.step('Back to Shelf (never guarded)', async () => {
    await need(page, 'globalGuardHint');
    await clickSel(page, 'engineShelf');
    await page.waitForFunction('state.layoutEngine === "shelf"', undefined, { timeout: 30000 });
    expect(await hint.isVisible()).toBe(false);
  }, { stillTimeoutMs: 30000 });

  await ux.step('Guard re-arms: one click, then wait out the 6 s window → still Shelf', async () => {
    await need(page, 'globalGuardHint');
    if (!big) { return; }
    await clickSel(page, 'engineGlobal');
    await page.waitForTimeout(6800);
    if (await engineNow() !== 'shelf') { throw new StepFinding({ rule: 'global-guard-missing', severity: 'high', message: 'a single Global click switched the engine after the hint window' }); }
  }, { settle: false, metrics: false });
});
