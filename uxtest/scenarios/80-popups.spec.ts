// 80 — Function popup (open, edit, Ctrl+S / Save, resize, drag, close), navigate
// fallback, library popup, Ctrl+S layout save.
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { clickNode, dragBy, fitToView, locateFrame, openSettings, toggleSwitch, wheelZoom } from '../lib/actions';
import { SkipStep } from '../lib/step';
import { SEL } from '../selectors';

scenario('popups', { perMotion: false }, async ({ page, ux, host, post }) => {
  await ux.step('Zoom into a folder', async () => {
    await fitToView(page);
    await page.waitForTimeout(700);
    const f = await locateFrame(page, 'smallest');
    await wheelZoom(page, { x: f.rect.x + f.rect.w / 2, y: f.rect.y + f.rect.h / 2 }, -240, 5);
  });

  await ux.step('Click a function → source popup', async () => {
    await clickNode(page, { kind: 'fn' });
    await expect(page.locator('.func-card').first()).toBeVisible();
    await expect.poll(() => host.posted('get-func-source').length).toBeGreaterThan(0);
  }, { metrics: false });

  await ux.step('Drag the popup by its header', async () => {
    const box = await page.locator('.func-card .func-header').first().boundingBox();
    if (!box) { throw new SkipStep('popup header not visible'); }
    await dragBy(page, { x: box.x + 60, y: box.y + box.height / 2 }, 140, 60);
  }, { metrics: false });

  await ux.step('Resize the popup', async () => {
    const handle = page.locator('.func-card .func-resize-handle').last();
    const box = await handle.boundingBox();
    if (!box) { throw new SkipStep('no resize handle'); }
    await dragBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 80, 60);
  }, { metrics: false });

  await ux.step('Edit the source and save with Ctrl+S', async () => {
    const ta = page.locator('.func-card .func-source-textarea').first();
    await expect(ta).not.toHaveValue('', { timeout: 5000 });
    if (await ta.evaluate(el => (el as HTMLTextAreaElement).readOnly)) { throw new SkipStep('source not editable (synthetic repo has no files on disk)'); }
    await ta.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n# edited by uxtest', { delay: 15 });
    await page.keyboard.press('Control+s');
    await expect.poll(() => host.posted('save-func-source').length).toBe(1);
  }, { metrics: false });

  await ux.step('Close the popup (button, or Escape when saving already closed it)', async () => {
    const close = page.locator('.func-card .func-header button[title="Close"]').first();
    if (await close.count() > 0) { await close.click(); }
    await expect(page.locator('.func-card')).toHaveCount(0);
  }, { metrics: false });

  await ux.step('Open a popup again and dismiss it with Escape', async () => {
    await clickNode(page, { kind: 'fn' });
    await expect(page.locator('.func-card').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.func-card')).toHaveCount(0);
  }, { metrics: false });

  await ux.step('Popup toggle off → click navigates to the editor', async () => {
    await toggleSwitch(page, 'toggleFuncPopup');
    await page.mouse.click(640, 790); // close the gear panel
    const before = host.posted('navigate').length;
    await clickNode(page, { kind: 'fn' });
    await expect.poll(() => host.posted('navigate').length).toBeGreaterThan(before);
    await toggleSwitch(page, 'toggleFuncPopup');
  }, { metrics: false });

  await ux.step('Show libraries and open a library popup', async () => {
    await openSettings(page);
    if (await page.locator(SEL.toggleLibraries.css).isDisabled()) {
      const hint = await page.locator(SEL.librariesHint.css).innerText().catch(() => '');
      await page.mouse.click(640, 790);
      throw new SkipStep(`Show Libraries is disabled under this engine; hint shown: "${hint.trim()}"`);
    }
    await toggleSwitch(page, 'toggleLibraries');
    await page.mouse.click(640, 790);
    await page.waitForTimeout(1200);
    await fitToView(page);
    await page.waitForTimeout(800);
    const lib = page.locator('#graph g.lib-nodes > *').first();
    if (await lib.count() === 0) { throw new SkipStep('no library nodes rendered (the Shelf engine does not draw libraries; repos without imports have none)'); }
    const box = await lib.boundingBox();
    if (!box) { throw new SkipStep('library node off screen'); }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(SEL.libPopup.css)).toBeVisible({ timeout: 3000 });
    await page.locator(SEL.libPopupClose.css).click();
  }, { stillTimeoutMs: 8000 });

  // Ctrl+S itself is a VS Code keybinding (covered by Tier B); the host turns it into `save-request`.
  await ux.step('Host relays Ctrl+S as save-request → webview posts save-graph', async () => {
    const before = host.saved.length;
    await post({ type: 'save-request', mode: 'save' });
    await expect.poll(() => host.saved.length).toBeGreaterThan(before);
  }, { metrics: false });
});
