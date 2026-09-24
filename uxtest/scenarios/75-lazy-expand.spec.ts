// 75 — Lazy host (the real open flow for bigger repos): the panel starts as a
// folder skeleton, a folder click asks the host to parse it (`expand-folder`),
// the spinner shows, the `graph-patch` fills in functions; then the background
// pass delivers the full graph without losing the drill-down.
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { clickNode, fitToView, setSlider } from '../lib/actions';
import { SkipStep } from '../lib/step';

scenario('lazy-expand', { perMotion: false, hostMode: 'lazy', largeOk: true, expandFirst: false }, async ({ page, ux, host, post }) => {
  await ux.step('Skeleton only (no functions parsed yet)', async () => {
    await setSlider(page, 'detailSlider', 0);
    await fitToView(page);
  });
  const before = host.posted('expand-folder').length;
  await ux.step('Open folders until the host is asked to parse one (expand-folder)', async () => {
    // A folder without direct source files opens without a parse request, so dive until one has files.
    for (let dive = 0; dive < 5 && host.posted('expand-folder').length === before; dive++) {
      await clickNode(page, { kind: 'folder', pick: 'largest' });
      await page.waitForTimeout(600);
      await fitToView(page);
      await page.waitForTimeout(700);
    }
    expect(host.posted('expand-folder').length).toBeGreaterThan(before);
  });
  await ux.step('Fit after the patch', async () => { await fitToView(page); });
  await ux.step('Click a still-collapsed file → parse-file / expand', async () => {
    const hasFile = await page.evaluate(() => [...document.querySelectorAll('#graph path.cloud-node')]
      .some(el => (el as unknown as { __data__?: { isFileCluster?: boolean } }).__data__?.isFileCluster));
    if (!hasFile) { throw new SkipStep('no collapsed file on screen after the folder patch'); }
    await clickNode(page, { kind: 'file', pick: 'largest' });
  });
  await ux.step('Open one more folder level', async () => { await clickNode(page, { kind: 'folder', pick: 'largest' }); });
  const expanded = await page.evaluate('state.expandedFolders.size') as number;
  await ux.step('Background analysis finishes (full graph arrives)', async () => {
    for (const r of host.backgroundDone()) { await post(r.message); }
  }, { stillTimeoutMs: 10000 });
  expect(await page.evaluate('state.expandedFolders.size') as number, 'drill-down must survive the full graph').toBeGreaterThanOrEqual(expanded);
  await ux.step('Fit the final state', async () => { await fitToView(page); });
});
