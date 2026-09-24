// 70 — Canvas: pan, zoom, drag a node, drag a folder by its title, resize a
// frame, expand/collapse folder + file, the three context menus. Drags are
// checked for collateral movement (H4 / T3: nothing outside the folder may move).
import { scenario } from '../lib/scenario';
import { backgroundPoint, clickNode, clickSel, need, ctxMenuClick, ctxMenuLabels, dragBy, dragFrame, fitToView, judgeFrameDrag, locateFrame, locateNode, restAndWatchChurn, rightClick, setSlider, wheelZoom, type Point } from '../lib/actions';
import { SkipStep, StepFinding, type StepRecord } from '../lib/step';
import { SEL } from '../selectors';
import * as path from 'path';
import { computeMetrics, maxDisplacement } from '../metrics/compute';
import type { Snapshot } from '../metrics/types';

function collateral(rec: StepRecord, before: Snapshot | null, after: Snapshot | null, keep: (frame: string | null, id: string) => boolean): void {
  if (!before || !after) { return; }
  const d = maxDisplacement(before, after, n => keep(n.frame, n.id));
  rec.note = `${rec.note ?? ''} collateral: ${d.moved} node(s) moved, max ${d.max}px`.trim();
  if (d.moved > 0) { rec.findings.push({ rule: 'collateral-movement', severity: 'high', ref: 'H4/T3', message: `${d.moved} node(s) outside the dragged folder moved (max ${d.max}px)` }); }
}

scenario('canvas', { largeOk: true }, async (lab, combo) => {
  const { page, ux } = lab;
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
  let dragNote = '';
  let drag: Awaited<ReturnType<typeof dragFrame>> | null = null;
  const dragFrameStep = await ux.step('Drag a folder by its title', async () => {
    const f = await locateFrame(page, 'smallest');
    movedPath = f.path;
    drag = await dragFrame(page, f, 70, 50, 12, path.join(lab.outDir, 'steps', `${String(ux.steps.length).padStart(2, '0')}-drag-a-folder-MID-DRAG.png`));
    dragNote = judgeFrameDrag(drag);
  }, { userMoved: true });
  dragFrameStep.note = [dragNote, dragFrameStep.note].filter(Boolean).join(' | ');
  if (dragFrameStep.status === 'ok' && combo.engine === 'shelf' && drag && before) {
    const d = drag as Awaited<ReturnType<typeof dragFrame>>;
    const outside = (frame: string | null): boolean => !!frame && frame !== movedPath && !frame.startsWith(movedPath + '/') && !movedPath.startsWith(frame + '/');
    // H4, DRAG PHASE: while the button is down nothing but the dragged subtree may move.
    if (d.midDrag) {
      const mid = maxDisplacement(before, d.midDrag, n => outside(n.frame));
      dragFrameStep.note += ` | during drag: ${mid.moved} outside node(s) moved (max ${mid.max} px)`;
      if (mid.moved > 0) { dragFrameStep.findings.push({ rule: 'collateral-movement', severity: 'high', ref: 'H4/T3', message: `${mid.moved} node(s) outside the dragged folder moved WHILE the button was down (max ${mid.max} px)` }); }
    }
    // DROP: a sibling re-pack is by design (glide) - reported as info; frames overlapping afterwards is not.
    if (d.midDrag && d.afterDrop) {
      const rep = maxDisplacement(d.midDrag, d.afterDrop, n => outside(n.frame));
      const framesBefore = new Map(d.midDrag.frames.map(f => [f.path, f.rect]));
      const movedFrames = d.afterDrop.frames.filter(f => { const b = framesBefore.get(f.path); return b && outside(f.path) && Math.hypot(f.rect.x - b.x, f.rect.y - b.y) > 0.5; }).length;
      const overlaps = computeMetrics(d.afterDrop).frameOverlapPairs;
      dragFrameStep.note += ` | on drop: ${rep.moved} node(s) in ${movedFrames} frame(s) re-packed (max ${rep.max} px), frame overlaps after ${overlaps}`;
      if (rep.moved > 0 || movedFrames > 0) { dragFrameStep.findings.push({ rule: 'drop-repack', severity: 'low', ref: 'ux-round2 R1', message: `drop re-packed ${movedFrames} sibling frame(s) / ${rep.moved} node(s), max displacement ${rep.max} px, frame overlaps after: ${overlaps}` }); }
      // R1c: the drop position is sacred and siblings shift only minimally, so residual overlaps after a drop are intended (low).
      if (overlaps > 0) { dragFrameStep.findings.push({ rule: 'user-frame-overlap', severity: 'low', ref: 'R1c', message: `${overlaps} sibling frame pair(s) still overlap after the drop (intended by the no-cascade rule)` }); }
    }
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

  // ── ux-round2: file-level filters (R2a) and slot dragging (R2b) — every step skips on branches without them ──
  const slotLabel = async (): Promise<{ x: number; y: number; file: string } | null> => page.evaluate(() => {
    for (const g of document.querySelectorAll('#graph g.file-slot')) {
      const d = (g as unknown as { __data__?: { file?: string } }).__data__;
      const el = g.querySelector('.file-slot-label');
      if (!d?.file || !el) { continue; }
      const b = el.getBoundingClientRect();
      if (b.left > 230 && b.right < window.innerWidth - 20 && b.top > 10 && b.bottom < window.innerHeight - 60 && document.elementFromPoint(b.left + 8, b.top + b.height / 2)?.closest('g.file-slot') === g) {
        return { x: b.left + 8, y: b.top + b.height / 2, file: d.file };
      }
    }
    return null;
  });
  /** perf's LOD parks function circles below zoom 0.3: a DOM count is only meaningful above that. Zoom into
   *  the given point until k >= 0.5 (no re-render happens: zoom is a transform). */
  const ensureLod = async (at: { x: number; y: number }): Promise<number> => {
    for (let i = 0; i < 6; i++) {
      const k = await page.evaluate('d3.zoomTransform(document.querySelector("#graph svg")).k') as number;
      if (k >= 0.5) { return k; }
      await wheelZoom(page, at, -240, 2);
      await page.waitForTimeout(250);
    }
    return await page.evaluate('d3.zoomTransform(document.querySelector("#graph svg")).k') as number;
  };
  const fnCountInState = (file: string): Promise<number> =>
    page.evaluate(`state.currentNodes.filter(n => n.file === ${JSON.stringify(file)} && !n.isCluster && !n.isLibrary && !n.isSynthetic).length`) as Promise<number>;
  // Earlier steps may leave a folder filter active (file filters AND with folder filters) - clear through the panel.
  await ux.step('Clear folder filters via the Filters panel', async () => {
    const active = (): Promise<boolean> => page.evaluate('!!(state.onlyShowFolder || (state.hiddenFolders && state.hiddenFolders.size) || state.onlyShowFile || (state.hiddenFiles && state.hiddenFiles.size))') as Promise<boolean>;
    if (!await active()) { return; }
    if (await page.locator(`${SEL.folderFiltersBody.css}`).isHidden()) { await clickSel(page, 'folderFiltersToggle'); }
    for (let i = 0; i < 12 && await active(); i++) {
      const clear = page.locator(`${SEL.folderFiltersBody.css} .folder-filter-clear, ${SEL.folderFiltersBody.css} .chip-file`).first();
      if (await clear.count() === 0) { break; }
      await clear.click();
      await page.waitForTimeout(250);
    }
    if (await active()) { throw new StepFinding({ rule: 'filter-panel-cannot-clear', severity: 'medium', message: 'a folder/file filter stayed active although the Filters panel offered no clear button for it' }); }
  }, { metrics: false });
  let hiddenFile = '';
  await ux.step('File context menu → Hide file (R2a)', async () => {
    if (combo.engine !== 'shelf') { throw new SkipStep('file slots exist only in the shelf engine'); }
    await setSlider(page, 'detailSlider', 1);
    await fitToView(page);
    await page.waitForTimeout(600);
    const f = await locateFrame(page, 'smallest');
    await wheelZoom(page, { x: f.rect.x + f.rect.w / 2, y: f.rect.y + f.rect.h / 2 }, -240, 4);
    await page.waitForTimeout(500);
    const l = await slotLabel();
    if (!l) { throw new SkipStep('no file slot label on screen'); }
    await rightClick(page, l);
    if (!(await ctxMenuLabels(page)).some(x => /hide file/i.test(x))) { await page.keyboard.press('Escape'); throw new SkipStep('no "Hide file" item (ux-round2 R2a not on this branch)'); }
    // Compare like with like: the visible set right before and right after the menu action.
    const visibleNow = (): Promise<number> => page.evaluate('typeof getVisibleNodeIds === "function" ? getVisibleNodeIds().size : state.currentNodes.length') as Promise<number>;
    const before = await visibleNow();
    hiddenFile = l.file;
    // Assert on the RENDERED DOM right after the click, with nothing in between: function circles of that file
    // that are attached and displayed. (State alone can lie: a memoised visibility set may ignore the filter.)
    const drawnOf = (file: string): Promise<number> => page.evaluate((f) => [...document.querySelectorAll('#graph circle.regular-node')]
      .filter(el => (el as unknown as { __data__?: { file?: string } }).__data__?.file === f && getComputedStyle(el).display !== 'none' && el.isConnected).length, file);
    // A single-function file is drawn as a file circle, not as a function circle: the DOM count needs >= 2 functions.
    if (await fnCountInState(hiddenFile) < 2) { hiddenFile = ''; await page.keyboard.press('Escape'); throw new SkipStep(`${l.file.split('/').pop()} has < 2 function nodes - DOM count not meaningful`); }
    await ensureLod(l);
    const drawnBefore = await drawnOf(hiddenFile);
    await ctxMenuClick(page, /hide file/i);
    await page.waitForTimeout(500);
    const kAfter = await ensureLod(l);
    const drawnAfter = await drawnOf(hiddenFile);
    const after = await visibleNow();
    ux.steps[ux.steps.length - 1].note = `${hiddenFile.split('/').pop()}: drawn ${drawnBefore} → ${drawnAfter} (k ${kAfter.toFixed(2)}); visible set ${before} → ${after}`;
    if (drawnAfter > 0 || (before && after >= before)) {
      throw new StepFinding({ rule: 'file-filter-noop', severity: 'high', ref: 'R2a', message: `Hide file on ${hiddenFile}: ${drawnBefore} → ${drawnAfter} of its nodes still drawn in the DOM; visible set ${before} → ${after}` });
    }
  });
  await ux.step('Hidden file appears as a chip; click unhides (R2a)', async () => {
    if (!hiddenFile) { throw new SkipStep('nothing hidden'); }
    await need(page, 'fileFilterChip');
    if (await page.locator(SEL.folderFiltersBody.css).isHidden()) { await clickSel(page, 'folderFiltersToggle'); }
    const chip = page.locator(SEL.fileFilterChip.css).first();
    if (await chip.count() === 0) { throw new StepFinding({ rule: 'file-filter-chip-missing', severity: 'medium', ref: 'R2a', message: `no .chip-file for the hidden file ${hiddenFile}` }); }
    const hiddenBefore = await page.evaluate('state.hiddenFiles ? state.hiddenFiles.size : -1') as number;
    // The chip is a row; its ✕ button (.folder-filter-clear) does the unhiding, like the folder chips.
    const clear = chip.locator('.folder-filter-clear');
    await (await clear.count() > 0 ? clear.first() : chip).click();
    await page.waitForTimeout(400);
    const hiddenAfter = await page.evaluate('state.hiddenFiles ? state.hiddenFiles.size : -1') as number;
    ux.steps[ux.steps.length - 1].note = `chip click: hiddenFiles ${hiddenBefore} → ${hiddenAfter}`;
    if (hiddenAfter >= hiddenBefore) { throw new StepFinding({ rule: 'file-chip-noop', severity: 'high', ref: 'R2a', message: `clicking the hidden-file chip did not unhide ${hiddenFile.split('/').pop()} (hiddenFiles ${hiddenBefore} → ${hiddenAfter})` }); }
  });
  await ux.step('File context menu → Show only this file → Show all (R2a)', async () => {
    // Independent of the chip step: a leftover hidden file would AND with "show only" and empty the graph.
    if (await page.evaluate('!!(state.hiddenFiles && state.hiddenFiles.size)')) {
      const l0 = await slotLabel();
      if (l0) { await rightClick(page, l0); if ((await ctxMenuLabels(page)).some(x => /^show all$/i.test(x))) { await ctxMenuClick(page, /^show all$/i); } else { await page.keyboard.press('Escape'); } await page.waitForTimeout(300); }
    }
    const l = await slotLabel();
    if (!l) { throw new SkipStep('no file slot label on screen'); }
    // DOM counts: drawn (attached + displayed) function circles of the file / of any other file.
    const drawn = (): Promise<{ mine: number; others: number; attached: number; frames: number; k: number; only: string | null; hidden: number }> => page.evaluate(`(() => { const f = ${JSON.stringify(l.file)};
      let mine = 0, others = 0, attached = 0;
      for (const el of document.querySelectorAll('#graph circle.regular-node')) { attached++; if (!el.isConnected || getComputedStyle(el).display === 'none') continue; if (el.__data__ && el.__data__.file === f) mine++; else others++; }
      return { mine, others, attached, frames: document.querySelectorAll('#graph g.frame').length, k: +d3.zoomTransform(document.querySelector('#graph svg')).k.toFixed(2), only: state.onlyShowFile || null, hidden: state.hiddenFiles ? state.hiddenFiles.size : -1 };
    })()`) as Promise<{ mine: number; others: number; attached: number; frames: number; k: number; only: string | null; hidden: number }>;
    const visibleNow = (): Promise<number> => page.evaluate('typeof getVisibleNodeIds === "function" ? getVisibleNodeIds().size : state.currentNodes.length') as Promise<number>;
    if (await fnCountInState(l.file) < 2) { throw new SkipStep(`${l.file.split('/').pop()} has < 2 function nodes - DOM count not meaningful`); }
    await ensureLod(l);
    const start = await drawn(), all0 = await visibleNow();
    await rightClick(page, l);
    if (!(await ctxMenuLabels(page)).some(x => /show only this file/i.test(x))) { await page.keyboard.press('Escape'); throw new SkipStep('no "Show only this file" item'); }
    await ctxMenuClick(page, /show only this file/i);
    await page.waitForTimeout(500);
    await ensureLod(l);
    const only = await drawn(), onlyVisible = await visibleNow();
    const l2 = await slotLabel();
    if (l2) { await rightClick(page, l2); await ctxMenuClick(page, /^show all$/i); }
    await page.waitForTimeout(500);
    if (l2) { await ensureLod(l2); }
    const back = await drawn(), all = await visibleNow();
    const fmt = (d: typeof start): string => `${d.mine}/${d.others} (attached ${d.attached}, frames ${d.frames}, k ${d.k}, only ${d.only ? d.only.split('/').pop() : '-'}, hidden ${d.hidden})`;
    const rec = ux.steps[ux.steps.length - 1];
    rec.note = `${l.file.split('/').pop()}: drawn mine/others ${fmt(start)} → show only ${fmt(only)} → show all ${fmt(back)}; visible set ${all0} → ${onlyVisible} → ${all}`;
    if (only.others > 0 || only.mine === 0) { throw new StepFinding({ rule: 'file-filter-noop', severity: 'high', ref: 'R2a/F17', message: `Show only this file: ${rec.note}` }); }
    if (back.others < start.others || back.mine < start.mine) { throw new StepFinding({ rule: 'file-filter-noop', severity: 'high', ref: 'R2a/F17', message: `Show all did not restore: drawn ${back.mine}/${back.others} vs ${start.mine}/${start.others} before` }); }
  });
  await ux.step('Drag a file slot by its label band (R2b)', async () => {
    if (combo.engine !== 'shelf') { throw new SkipStep('file slots exist only in the shelf engine'); }
    await need(page, 'fileSlotHandle');
    // Prefer a slot inside a MULTI-slot frame: a lone slot fills its frame and the clamp correctly cannot move it.
    const h = await page.evaluate(() => {
      let fallback: { x: number; y: number; file: string; sx: number; sy: number; siblings: number } | null = null;
      for (const el of document.querySelectorAll('#graph g.file-slot rect.file-slot-handle')) {
        const b = el.getBoundingClientRect();
        if (!(b.width > 30 && b.left > 230 && b.right < window.innerWidth - 20 && b.top > 10 && b.bottom < window.innerHeight - 60
          && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === el)) { continue; }
        const g = el.closest('g.file-slot') as unknown as { __data__?: { file?: string } };
        const shape = el.parentElement?.querySelector('.file-slot-shape')?.getBoundingClientRect();
        const siblings = el.closest('g.f-slots')?.querySelectorAll('g.file-slot').length ?? 1;
        const hit = { x: b.left + b.width / 2, y: b.top + b.height / 2, file: g?.__data__?.file ?? '', sx: shape?.left ?? 0, sy: shape?.top ?? 0, siblings };
        if (siblings >= 2) { return hit; }
        if (!fallback) { fallback = hit; }
      }
      return fallback;
    });
    if (!h) { throw new SkipStep('no hittable slot handle on screen'); }
    if (h.siblings < 2) { throw new SkipStep(`only lone-slot frames on screen (${h.file.split('/').pop()}); a lone slot fills its frame`); }
    const memberBefore = ux.lastSnapshot?.nodes.filter(n => n.file === h.file).map(n => ({ id: n.id, x: n.x, y: n.y })) ?? [];
    await dragBy(page, h, 45, 30);
    await page.waitForTimeout(400);
    const moved = await page.evaluate((file) => {
      for (const g of document.querySelectorAll('#graph g.file-slot')) {
        const d = (g as unknown as { __data__?: { file?: string } }).__data__;
        if (d?.file === file) { const b = g.querySelector('.file-slot-shape')?.getBoundingClientRect(); return b ? { x: b.left, y: b.top } : null; }
      }
      return null;
    }, h.file);
    if (!moved || Math.hypot(moved.x - h.sx, moved.y - h.sy) < 10) { throw new StepFinding({ rule: 'slot-drag-noop', severity: 'high', ref: 'R2b', message: `slot ${h.file} did not follow the drag (${moved ? Math.hypot(moved.x - h.sx, moved.y - h.sy).toFixed(1) : 'gone'} px)` }); }
    (page as unknown as { __slotMembers?: unknown }).__slotMembers = memberBefore;
  }, { userMoved: true });
  await ux.step('Slot members rode along with the slot (R2b)', async () => {
    const before = (page as unknown as { __slotMembers?: Array<{ id: string; x: number; y: number }> }).__slotMembers;
    if (!before || !before.length) { throw new SkipStep('no slot dragged'); }
    const after = new Map((ux.lastSnapshot?.nodes ?? []).map(n => [n.id, n]));
    const stayed = before.filter(b => { const a = after.get(b.id); return a && Math.hypot(a.x - b.x, a.y - b.y) < 5; }).length;
    // F19: every member translates with its slot, in BOTH motions (this scenario runs static and dynamic).
    if (stayed > 0) { throw new StepFinding({ rule: 'slot-members-left-behind', severity: 'high', ref: 'R2b/F19', message: `${stayed} of ${before.length} members of the dragged slot did not move with it (${combo.motion})` }); }
  }, { settle: false, metrics: false });
});
