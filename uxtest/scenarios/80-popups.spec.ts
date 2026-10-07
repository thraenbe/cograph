// 80 — Function popup (open, edit, Ctrl+S / Save, resize, drag, close), navigate
// fallback, library popup, Ctrl+S layout save.
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { clickNode, dragBy, fitToView, locateFrame, openSettings, toggleSwitch, wheelZoom } from '../lib/actions';
import { SkipStep } from '../lib/step';
import { SEL } from '../selectors';

/** file + line of the popup opened last (its get-func-source request). */
function lastPopupTarget(host: { posted(t: string): Record<string, unknown>[] }): { file: string; line: number } {
  const m = host.posted('get-func-source').at(-1);
  return { file: String(m?.file ?? ''), line: Number(m?.line ?? 1) };
}

scenario('popups', { perMotion: false }, async ({ page, ux, host, post }) => {
  let shownBeforeSave: string | null = null;
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
    if (await page.locator('.func-card').count() === 0) { throw new SkipStep('no popup open (the node click was skipped)'); }
    const box = await page.locator('.func-card .func-header').first().boundingBox();
    if (!box) { throw new SkipStep('popup header not visible'); }
    await dragBy(page, { x: box.x + 60, y: box.y + box.height / 2 }, 140, 60);
  }, { metrics: false });

  await ux.step('Resize the popup', async () => {
    if (await page.locator('.func-card').count() === 0) { throw new SkipStep('no popup open'); }
    const handle = page.locator('.func-card .func-resize-handle').last();
    const box = await handle.boundingBox();
    if (!box) { throw new SkipStep('no resize handle'); }
    await dragBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 80, 60);
  }, { metrics: false });

  await ux.step('Edit the source and save with Ctrl+S', async () => {
    if (await page.locator('.func-card').count() === 0) { throw new SkipStep('no popup open'); }
    const ta = page.locator('.func-card .func-source-textarea').first();
    await expect(ta).not.toHaveValue('', { timeout: 5000 });
    if (await ta.evaluate(el => (el as HTMLTextAreaElement).readOnly)) { throw new SkipStep('source not editable (synthetic repo has no files on disk)'); }
    const t = lastPopupTarget(host);
    shownBeforeSave = host.sources.read(t.file, t.line);
    await ta.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n# edited by uxtest', { delay: 15 });
    await page.keyboard.press('Control+s');
    await expect.poll(() => host.posted('save-func-source').length).toBe(1);
  }, { metrics: false });

  // PR #69: the save carries what the popup showed, the host answers func-source-saved, ok closes the popup.
  await ux.step('Save carries the shown original and is confirmed (popup closes)', async () => {
    const save = host.posted('save-func-source').at(-1);
    if (!save) { throw new SkipStep('no save was posted (the edit step was skipped)'); }
    if (save.reqId === undefined) { throw new SkipStep('no func-source-saved round trip on this branch (before PR #69)'); }
    expect(save.original, 'save-func-source.original = the text the popup showed').toBe(shownBeforeSave);
    await expect(page.locator('.func-card')).toHaveCount(0, { timeout: 3000 });
  }, { metrics: false });

  await ux.step('A save over a changed file is refused, keeps the edit; Reload from file, then save', async () => {
    if (host.posted('save-func-source').at(-1)?.reqId === undefined) { throw new SkipStep('no func-source-saved round trip on this branch (before PR #69)'); }
    await clickNode(page, { kind: 'fn' });
    const ta = page.locator('.func-card .func-source-textarea').first();
    await expect(ta).not.toHaveValue('', { timeout: 5000 });
    const t = lastPopupTarget(host);
    await ta.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n# refused by uxtest', { delay: 15 });
    const edited = await ta.inputValue();
    // "On disk" a line appears ABOVE the function: works for one-line functions too, and Reload must find it one line down.
    host.sources.externalEdit(t.file, l => { l.splice(t.line - 1, 0, ''); return l; });
    await page.keyboard.press('Control+s');
    await expect(page.locator(SEL.funcSaveError.css)).toBeVisible({ timeout: 3000 });
    await expect(page.locator(SEL.funcSaveReason.css)).toContainText('Not saved');
    expect(await ta.inputValue(), 'the refused edit is still in the popup').toBe(edited);
    expect(await ta.evaluate(el => (el as HTMLTextAreaElement).readOnly), 'editable again after the refusal').toBe(false);
    const reload = page.locator(SEL.funcSaveReload.css);
    await reload.click();
    await expect(reload).toHaveClass(/armed/);
    await reload.click();
    await expect(ta).toHaveValue(host.sources.read(t.file, t.line + 1));
    await expect(page.locator(SEL.funcSaveError.css)).toHaveCount(0);
    await ta.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n# after reload by uxtest', { delay: 15 }); // Save is only enabled for a changed text
    await page.keyboard.press('Control+s');
    await expect(page.locator('.func-card')).toHaveCount(0, { timeout: 3000 });
    expect(host.sources.text(t.file), 'the retry after Reload saved') // a trailing comment may lie past the scanned function end.toContain('# after reload by uxtest');
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
