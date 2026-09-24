// 70 — Canvas: pan, zoom, drag a node, drag a folder by its title, resize a
// frame, expand/collapse folder + file, the three context menus. Drags are
// checked for collateral movement (H4 / T3: nothing outside the folder may move).
import { scenario } from '../lib/scenario';
import { backgroundPoint, clickNode, ctxMenuClick, ctxMenuLabels, dragBy, fitToView, locateFrame, locateNode, restAndWatchChurn, rightClick, setSlider, wheelZoom, type Point } from '../lib/actions';
import { SkipStep, StepFinding, type StepRecord } from '../lib/step';
import { maxDisplacement } from '../metrics/compute';
import type { Snapshot } from '../metrics/types';

function collateral(rec: StepRecord, before: Snapshot | null, after: Snapshot | null, keep: (frame: string | null, id: string) => boolean): void {
  if (!before || !after) { return; }
  const d = maxDisplacement(before, after, n => keep(n.frame, n.id));
  rec.note = `${rec.note ?? ''} collateral: ${d.moved} node(s) moved, max ${d.max}px`.trim();
  if (d.moved > 0) { rec.findings.push({ rule: 'collateral-movement', severity: 'high', ref: 'H4/T3', message: `${d.moved} node(s) outside the dragged folder moved (max ${d.max}px)` }); }
}

scenario('canvas', { largeOk: true }, async ({ page, ux }, combo) => {
  /** F10: the hover overlay must be built once, not rebuilt every frame under a resting pointer. */
  const churnCheck = async (what: string, p: Point): Promise<void> => {
    const c = await restAndWatchChurn(page, p, 1000);
    if (c.rebuilds > 2) {
      throw new StepFinding({ rule: 'hover-churn', severity: 'medium', ref: 'F10/P4',
        message: `hover overlay rebuilt ${c.rebuilds}x in ${c.restMs} ms while resting on ${what} (${c.added} lines added, ${c.removed} removed)` });
    }
  };
  await ux.step('Fit', async () => { await fitToView(page); });
  await ux.step('Zoom in (wheel)', async () => { await wheelZoom(page, await backgroundPoint(page), -240, 3); });
  await ux.step('Pan (drag background)', async () => { await dragBy(page, await backgroundPoint(page), -120, 60); });
  await ux.step('Zoom out + fit', async () => { await wheelZoom(page, await backgroundPoint(page), 240, 3); await fitToView(page); });

  await ux.step('Zoom into the smallest folder for node work', async () => {
    const f = await locateFrame(page, 'smallest');
    await wheelZoom(page, { x: f.rect.x + f.rect.w / 2, y: f.rect.y + f.rect.h / 2 }, -240, 5);
  });

  await ux.step('Rest 1 s on a function node (hover churn)', async () => {
    const n = await locateNode(page, { kind: 'fn' });
    await churnCheck(`the function node ${n.label}`, n);
  }, { metrics: false, settle: false });

  let before = ux.lastSnapshot;
  let draggedFrame: string | null = null, draggedId = '';
  const dragNode = await ux.step('Drag one function node', async () => {
    const n = await locateNode(page, { kind: 'fn' });
    draggedId = n.id;
    draggedFrame = before?.nodes.find(x => x.id === n.id)?.frame ?? null;
    await dragBy(page, n, 24, 18);
  }, { userMoved: true });
  if (dragNode.status === 'ok') {
    collateral(dragNode, before, ux.lastSnapshot, (frame, id) => id !== draggedId && (combo.engine === 'shelf' ? frame !== draggedFrame : combo.motion === 'static'));
  }

  await ux.step('Fit before folder work', async () => { await fitToView(page); });
  before = ux.lastSnapshot;
  let movedPath = '';
  const dragFrame = await ux.step('Drag a folder by its title', async () => {
    const f = await locateFrame(page, 'smallest');
    movedPath = f.path;
    await dragBy(page, f.title, 70, 50);
  }, { userMoved: true });
  if (dragFrame.status === 'ok' && combo.engine === 'shelf') {
    collateral(dragFrame, before, ux.lastSnapshot, frame => !!frame && frame !== movedPath && !frame.startsWith(movedPath + '/') && !movedPath.startsWith(frame + '/'));
  }

  await ux.step('Resize a frame from its bottom-right corner', async () => {
    if (combo.engine !== 'shelf') { throw new SkipStep('frame resize exists only in the shelf engine'); }
    const f = await locateFrame(page, 'smallest');
    await dragBy(page, { x: f.rect.x + f.rect.w - 4, y: f.rect.y + f.rect.h - 4 }, 60, 40);
  }, { userMoved: true });

  await ux.step('Folder context menu', async () => {
    const f = await locateFrame(page, 'smallest');
    await rightClick(page, f.title);
    if ((await ctxMenuLabels(page)).length === 0) {
      // In Dynamic motion the title can move away between locating it and the click: retry once on a fresh position.
      const again = await locateFrame(page, 'smallest');
      await rightClick(page, again.title);
      if ((await ctxMenuLabels(page)).length === 0) { throw new StepFinding({ rule: 'context-menu-missing', severity: 'medium', message: `right-click on the title of ${again.path} opened no context menu (twice)` }); }
    }
  }, { metrics: false });
  await ux.step('Context menu → Collapse folder', async () => { await ctxMenuClick(page, /collapse folder/i); });
  await ux.step('Fit after collapse', async () => { await fitToView(page); });

  await ux.step('Rest 1 s on a collapsed folder glyph (hover churn)', async () => {
    const n = await locateNode(page, { kind: 'folder', pick: 'largest' });
    await churnCheck(`the collapsed folder glyph ${n.label}`, n);
  }, { metrics: false, settle: false });
  await ux.step('Click a collapsed folder to expand it', async () => { await clickNode(page, { kind: 'folder', pick: 'largest' }); });
  await ux.step('Folder glyph context menu → Only show this folder', async () => {
    const n = await locateNode(page, { kind: 'folder', pick: 'largest' });
    await rightClick(page, n);
    await ctxMenuClick(page, /only show/i);
  });
  await ux.step('Context menu → Show all', async () => {
    const f = await locateFrame(page, 'largest');
    await rightClick(page, f.title);
    await ctxMenuClick(page, /show all/i);
  });

  // Expanding a collapsed FILE is covered by 75-lazy-expand: with an eager host every file is parsed up front.
  await ux.step('File slot context menu', async () => {
    const slot = page.locator('#graph g.file-slot').first();
    if (await slot.count() === 0) { throw new SkipStep('no file slot rendered'); }
    const box = await slot.boundingBox();
    if (!box) { throw new SkipStep('file slot off screen'); }
    await rightClick(page, { x: box.x + 20, y: box.y + 6 });
    if ((await ctxMenuLabels(page)).length === 0) { throw new SkipStep('slot context menu did not open at that point'); }
    await page.keyboard.press('Escape');
    await page.mouse.click(box.x + box.width / 2, 2);
  }, { metrics: false });

  // F10 repro scene: partially collapsed tree, pointer resting on a glyph that has cross-folder links.
  await ux.step('Detail 0.3 + fit, rest 1 s on the largest collapsed folder (hover churn)', async () => {
    await setSlider(page, 'detailSlider', 0.3);
    await fitToView(page);
    await page.waitForTimeout(900);
    const n = await locateNode(page, { kind: 'folder', pick: 'largest' });
    await churnCheck(`the collapsed folder glyph ${n.label}`, n);
  }, { metrics: false, settle: false });
});
