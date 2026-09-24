// 47 — round 3 W1/W2 (session-111): hiding a folder/file removes its FRAME / SLOT from the DOM and re-packs the
// shelf (not just display:none on nodes); every hide is a chip in the Filters section and reversible one by one;
// "Show all" clears everything and brings the frames back. Gated on the round-3 predicate module (scope.js)
// being present: on older branches every step skips.
import { scenario } from '../lib/scenario';
import { clickSel, ctxMenuClick, ctxMenuLabels, fitToView, locateFrame, rightClick, setSlider, wheelZoom } from '../lib/actions';
import { SkipStep, StepFinding } from '../lib/step';
import { SEL } from '../selectors';

interface FrameGeom { path: string; x: number; y: number; w: number; h: number }

scenario('hide-entirely', { perMotion: false, largeOk: false }, async ({ page, ux }, combo) => {
  const round3 = (): Promise<boolean> => page.evaluate('typeof frameFolderVisible === "function"') as Promise<boolean>;
  const gate = async (): Promise<void> => { if (!await round3()) { throw new SkipStep('round-3 scope.js not on this branch'); } };
  const frames = (): Promise<FrameGeom[]> => page.evaluate(`[...document.querySelectorAll('#graph g.frame, #graph g.folder-bubble')].map(g => { const d = g.__data__ || {}; const b = (g.querySelector(':scope > .folder-bubble-shape') || g).getBoundingClientRect(); return { path: String(d.path || d.folderPath || ''), x: b.left, y: b.top, w: b.width, h: b.height }; })`) as Promise<FrameGeom[]>;
  const slotsOf = (file: string): Promise<number> => page.evaluate((f) => [...document.querySelectorAll('#graph g.file-slot')].filter(g => (g as unknown as { __data__?: { file?: string } }).__data__?.file === f && g.isConnected).length, file);
  const filters = (): Promise<{ hf: number; hfiles: number; only: string | null; onlyFile: string | null }> => page.evaluate('({ hf: state.hiddenFolders.size, hfiles: state.hiddenFiles ? state.hiddenFiles.size : 0, only: state.onlyShowFolder || null, onlyFile: state.onlyShowFile || null })') as Promise<{ hf: number; hfiles: number; only: string | null; onlyFile: string | null }>;

  let hidden = '', parentBefore: FrameGeom | null = null, siblingsBefore: FrameGeom[] = [];
  await ux.step('Full detail, fitted', async () => { await gate(); await setSlider(page, 'detailSlider', 1); await fitToView(page); });

  await ux.step('Hide a folder → its frame is gone from the DOM and the shelf re-packed', async () => {
    await gate();
    const f = await locateFrame(page, 'smallest');
    hidden = f.path;
    const before = await frames();
    const parentPath = hidden.replace(/[\\/][^\\/]*$/, '');
    parentBefore = before.find(g => g.path === parentPath) ?? null;
    siblingsBefore = before.filter(g => g.path !== hidden && g.path.replace(/[\\/][^\\/]*$/, '') === parentPath);
    await rightClick(page, f.title);
    if (!(await ctxMenuLabels(page)).some(x => /hide folder/i.test(x))) { await page.keyboard.press('Escape'); throw new SkipStep('no "Hide folder" item'); }
    await ctxMenuClick(page, /hide folder/i);
    await page.waitForTimeout(1200); // glide
    const after = await frames();
    if (after.some(g => g.path === hidden)) { throw new StepFinding({ rule: 'hidden-frame-still-in-dom', severity: 'high', ref: 'round3 W1', message: `frame of hidden folder ${hidden.split('/').pop()} is still in the DOM (${after.filter(g => g.path === hidden).length} element(s))` }); }
    const parentAfter = after.find(g => g.path === parentPath) ?? null;
    const siblingsAfter = after.filter(g => siblingsBefore.some(s => s.path === g.path));
    const parentShrank = parentBefore && parentAfter && (parentAfter.w < parentBefore.w - 1 || parentAfter.h < parentBefore.h - 1);
    const siblingMoved = siblingsAfter.some(g => { const b = siblingsBefore.find(s => s.path === g.path); return b && (Math.abs(g.x - b.x) > 1 || Math.abs(g.y - b.y) > 1); });
    ux.steps[ux.steps.length - 1].note = `hid ${hidden.split('/').pop()}: frames ${before.length} → ${after.length}, parent ${parentBefore ? `${Math.round(parentBefore.w)}×${Math.round(parentBefore.h)}` : '-'} → ${parentAfter ? `${Math.round(parentAfter.w)}×${Math.round(parentAfter.h)}` : '-'}, ${siblingsBefore.length} sibling(s), moved ${siblingMoved}`;
    if (siblingsBefore.length && !parentShrank && !siblingMoved) { throw new StepFinding({ rule: 'no-repack-after-hide', severity: 'high', ref: 'round3 W1', message: `hiding ${hidden.split('/').pop()} left the gap: parent did not shrink and no sibling moved` }); }
  });

  await ux.step('The hidden folder is a chip; its ✕ brings the frame back', async () => {
    await gate();
    if (!hidden) { throw new SkipStep('nothing hidden'); }
    if (await page.locator(SEL.folderFiltersBody.css).isHidden()) { await clickSel(page, 'folderFiltersToggle'); }
    const clear = page.locator(`${SEL.folderFiltersBody.css} .folder-filter-row .folder-filter-clear`).first();
    if (await clear.count() === 0) { throw new StepFinding({ rule: 'filter-chip-missing', severity: 'high', ref: 'round3 W2', message: `no chip for the hidden folder ${hidden.split('/').pop()}` }); }
    await clear.click();
    await page.waitForTimeout(1200);
    const back = (await frames()).some(g => g.path === hidden);
    if (!back) { throw new StepFinding({ rule: 'unhide-did-not-restore-frame', severity: 'high', ref: 'round3 W2', message: `after the chip's ✕ the frame of ${hidden.split('/').pop()} is not back in the DOM` }); }
  });

  await ux.step('Hide a file → its slot is gone; Show all brings everything back', async () => {
    await gate();
    if (combo.engine !== 'shelf') { throw new SkipStep('slots exist only in the shelf engine'); }
    const f = await locateFrame(page, 'largest');
    await wheelZoom(page, { x: f.rect.x + f.rect.w / 2, y: f.rect.y + f.rect.h / 2 }, -240, 3);
    await page.waitForTimeout(400);
    const l = await page.evaluate(() => {
      for (const g of document.querySelectorAll('#graph g.file-slot')) {
        const d = (g as unknown as { __data__?: { file?: string } }).__data__; const el = g.querySelector('.file-slot-label'); if (!d?.file || !el) { continue; }
        const b = el.getBoundingClientRect();
        if (b.left > 230 && b.right < window.innerWidth - 20 && b.top > 10 && b.bottom < window.innerHeight - 60 && document.elementFromPoint(b.left + 8, b.top + b.height / 2)?.closest('g.file-slot') === g) { return { x: b.left + 8, y: b.top + b.height / 2, file: d.file }; }
      }
      return null;
    });
    if (!l) { throw new SkipStep('no file slot label on screen'); }
    await rightClick(page, l);
    if (!(await ctxMenuLabels(page)).some(x => /hide file/i.test(x))) { await page.keyboard.press('Escape'); throw new SkipStep('no "Hide file" item'); }
    await ctxMenuClick(page, /hide file/i);
    await page.waitForTimeout(1200);
    const left = await slotsOf(l.file);
    if (left > 0) { throw new StepFinding({ rule: 'hidden-slot-still-in-dom', severity: 'high', ref: 'round3 W1', message: `slot of hidden file ${l.file.split('/').pop()} is still in the DOM` }); }
    const fBefore = await filters();
    const showAll = page.locator(SEL.folderShowAll.css);
    if (await showAll.count() === 0) { throw new StepFinding({ rule: 'show-all-missing', severity: 'medium', ref: 'round3 W2', message: '#btn-folder-show-all not found in the Filters section' }); }
    if (await page.locator(SEL.folderFiltersBody.css).isHidden()) { await clickSel(page, 'folderFiltersToggle'); }
    await showAll.click();
    await page.waitForTimeout(1200);
    const fAfter = await filters();
    const slotBack = await slotsOf(l.file);
    ux.steps[ux.steps.length - 1].note = `hid ${l.file.split('/').pop()} (slots ${left}); filters before ${JSON.stringify(fBefore)} → after Show all ${JSON.stringify(fAfter)}; slot back ${slotBack > 0}`;
    if (fAfter.hf || fAfter.hfiles || fAfter.only || fAfter.onlyFile) { throw new StepFinding({ rule: 'show-all-incomplete', severity: 'high', ref: 'round3 W2', message: `Show all left filters active: ${JSON.stringify(fAfter)}` }); }
    if (slotBack === 0) { throw new StepFinding({ rule: 'show-all-no-rerender', severity: 'high', ref: 'round3 W2', message: `Show all cleared the sets but the slot of ${l.file.split('/').pop()} did not come back` }); }
  });
});
