// 40 — Folder panel: folder mode, the folder/file forces, "more forces", folder filters.
import { scenario } from '../lib/scenario';
import { clickSel, ctxMenuClick, locateFrame, need, rightClick, setSlider } from '../lib/actions';
import { SkipStep } from '../lib/step';
import { SEL } from '../selectors';

scenario('folder-panel', { perMotion: false, only: { motion: 'dynamic' } }, async ({ page, ux }) => {
  await ux.step('Baseline (dynamic)', async () => { /* observe */ });
  await ux.step('Folder mode off', async () => { await clickSel(page, 'folderMode'); });
  await ux.step('Folder mode on', async () => { await clickSel(page, 'folderMode'); });

  for (const [name, values] of [['forceFileCluster', [0, 1, 0.2]], ['forceFolderRepel', [0, 5, 0.25]], ['forceFileRepel', [0, 5, 0.25]]] as const) {
    for (const v of values) { await ux.step(`${name} = ${v}`, async () => { await setSlider(page, name, v); }, { stillTimeoutMs: 8000 }); }
  }

  await ux.step('"view more forces" opens the gear panel (checkpoint UI)', async () => { await clickSel(page, 'moreForcesOld'); }, { metrics: false });
  await ux.step('"show more forces" inline expander (ux UI)', async () => { await clickSel(page, 'showMoreForces'); }, { metrics: false });
  for (const name of ['forceLinkDistance', 'forceVelocityDecay', 'forceCollidePad', 'forceSlotPad'] as const) {
    await ux.step(`${name} to its maximum`, async () => {
      const css = await need(page, name); // optional: skips on the checkpoint UI
      const max = await page.locator(css).first().getAttribute('max');
      await setSlider(page, name, Number(max ?? 1));
    }, { stillTimeoutMs: 8000 });
  }

  // Folder filters are created from a folder's context menu and listed (and cleared) in the panel.
  await ux.step('Hide a folder via its context menu', async () => {
    const frame = await locateFrame(page, 'smallest');
    await rightClick(page, frame.title);
    await ctxMenuClick(page, /hide folder/i);
  });
  await ux.step('Filter row appears in the Filters list', async () => {
    if (await page.locator(`${SEL.folderFiltersBody.css} .folder-filter-row`).count() === 0) { throw new SkipStep('no filter row after hiding a folder'); }
  }, { metrics: false });
  await ux.step('Clear the filter from the panel', async () => {
    const clear = page.locator(`${SEL.folderFiltersBody.css} .folder-filter-clear`).first();
    if (await clear.count() === 0) { throw new SkipStep('no clear button'); }
    await clear.click();
  });
  await ux.step('Collapse the Filters list', async () => { await clickSel(page, 'folderFiltersToggle'); }, { metrics: false });
});
