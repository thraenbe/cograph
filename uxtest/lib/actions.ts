// Real-input helpers. Everything goes through page.mouse / keyboard with a
// visible glide so the video shows what happened; selectors come from the map.
import type { Page } from '@playwright/test';
import { SEL, type SelName } from '../selectors';
import { SkipStep, StepFinding } from './step';
import { collectSnapshot } from '../metrics/collect';
import type { Snapshot } from '../metrics/types';

export interface Point { x: number; y: number }
export type NodePick = { kind: 'folder' | 'file' | 'fn'; pick?: 'largest' | 'first'; id?: string };

/** Resolve a mapped selector; optional + absent → SkipStep, required + absent → error. */
export async function need(page: Page, name: SelName): Promise<string> {
  const sel: { css: string; optional?: boolean } = SEL[name];
  if (await page.locator(sel.css).count() > 0) { return sel.css; }
  if (sel.optional) { throw new SkipStep(`selector absent: ${name} (${sel.css})`); }
  throw new Error(`required selector missing: ${name} (${sel.css})`);
}

export async function glideTo(page: Page, p: Point): Promise<void> {
  await page.mouse.move(p.x, p.y, { steps: 14 });
}

async function centerOf(page: Page, css: string): Promise<Point> {
  const box = await page.locator(css).first().boundingBox();
  if (!box) { throw new Error(`element not visible: ${css}`); }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function clickSel(page: Page, name: SelName): Promise<void> {
  const css = await need(page, name);
  await reveal(page, css);
  const p = await centerOf(page, css);
  await glideTo(page, p);
  await page.mouse.click(p.x, p.y);
}

/** Range inputs cannot be typed into: set the value and fire the events the webview listens to. */
export async function setSlider(page: Page, name: SelName, value: number): Promise<void> {
  const css = await need(page, name);
  await reveal(page, css);
  // ux UI: force rows that do not apply to the current engine × motion are hidden, not removed.
  if (!await page.locator(css).first().isVisible()) { throw new SkipStep(`control hidden in this engine/motion: ${name}`); }
  const box = await page.locator(css).first().boundingBox();
  if (box) { await glideTo(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }); }
  await page.locator(css).first().evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Runs in the page. Screen-space centre of a rendered graph node, or null. */
function locateNodeInPage(q: NodePick): { x: number; y: number; id: string; label: string } | null {
  const css = q.kind === 'fn' ? '#graph circle.regular-node' : '#graph path.cloud-node';
  let best: { el: Element; d: any; score: number } | null = null;
  document.querySelectorAll(css).forEach((el) => {
    const d = (el as any).__data__;
    if (!d || (el as HTMLElement).style.display === 'none') { return; }
    if (q.kind === 'folder' && !d.isFolderCluster) { return; }
    if (q.kind === 'file' && !d.isFileCluster) { return; }
    if (q.id !== undefined && String(d.id) !== q.id) { return; }
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.left < 0 || b.top < 0 || b.right > window.innerWidth || b.bottom > window.innerHeight) { return; }
    const score = q.pick === 'largest' ? (d._size ?? d.count ?? 0) : 0;
    if (!best || score > best.score) { best = { el, d, score }; }
  });
  if (!best) { return null; }
  const hit = best as { el: Element; d: any };
  const r = hit.el.getBoundingClientRect();
  // Glyphs are not convex (folder silhouette with a tab): pick a point that really hits the element.
  for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.65], [0.35, 0.6], [0.65, 0.6], [0.5, 0.35], [0.3, 0.3]]) {
    const x = r.left + r.width * fx, y = r.top + r.height * fy;
    if (document.elementFromPoint(x, y) === hit.el) { return { x, y, id: String(hit.d.id), label: String(hit.d.name ?? hit.d.label ?? hit.d.id) }; }
  }
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: String(hit.d.id), label: String(hit.d.name ?? hit.d.label ?? hit.d.id) };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function locateNode(page: Page, q: NodePick): Promise<{ x: number; y: number; id: string; label: string }> {
  const hit = await page.evaluate(locateNodeInPage, q);
  if (!hit) { throw new SkipStep(`no visible ${q.kind} node on screen`); }
  return hit;
}

export async function clickNode(page: Page, q: NodePick): Promise<{ id: string; label: string }> {
  const hit = await locateNode(page, q);
  await glideTo(page, hit);
  await page.mouse.click(hit.x, hit.y);
  return hit;
}

export async function dragBy(page: Page, from: Point, dx: number, dy: number): Promise<void> {
  await glideTo(page, from);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 20 });
  await page.mouse.up();
}

export async function wheelZoom(page: Page, at: Point, deltaY: number, ticks = 4): Promise<void> {
  await glideTo(page, at);
  for (let i = 0; i < ticks; i++) { await page.mouse.wheel(0, deltaY); await page.waitForTimeout(60); }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Runs in the page. A point where a double-click means "fit": the bare svg if any is
 *  visible, else a folder box (rendering.js fits on every svg target except nodes). */
function findBackgroundInPage(): { x: number; y: number } | null {
  const svg = document.querySelector('#graph svg');
  if (!svg) { return null; }
  const W = window.innerWidth, H = window.innerHeight;
  let fallback: { x: number; y: number } | null = null;
  for (let gy = 1; gy < 20; gy++) {
    for (let gx = 29; gx >= 1; gx--) {
      const x = Math.round((gx / 30) * W), y = Math.round((gy / 20) * H);
      const el = document.elementFromPoint(x, y);
      if (el === svg) { return { x, y }; }
      if (!fallback && el && svg.contains(el) && el.tagName !== 'circle' && !el.classList.contains('cloud-node')
        && !el.closest('.file-slot') && (el.classList.contains('folder-bubble-shape') || el.tagName === 'rect')) { fallback = { x, y }; }
    }
  }
  return fallback;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function backgroundPoint(page: Page): Promise<Point> {
  // Right after a re-render the canvas can be momentarily covered; give it a moment.
  for (let attempt = 0; attempt < 20; attempt++) {
    const p = await page.evaluate(findBackgroundInPage);
    if (p) { return p; }
    await page.waitForTimeout(100);
  }
  throw new SkipStep('no free background point on screen');
}

/** The product's own fit gesture: double-click the canvas background. */
export async function fitToView(page: Page): Promise<void> {
  const p = await backgroundPoint(page);
  await glideTo(page, p);
  await page.mouse.dblclick(p.x, p.y);
}

export async function rightClick(page: Page, p: Point): Promise<void> {
  await glideTo(page, p);
  await page.mouse.click(p.x, p.y, { button: 'right' });
}

/** Labels of the open context menu (empty when it is closed). */
export async function ctxMenuLabels(page: Page): Promise<string[]> {
  if (!await page.locator(SEL.ctxMenu.css).isVisible()) { return []; }
  return (await page.locator(SEL.ctxMenuItems.css).allTextContents()).map(s => s.trim());
}

export async function ctxMenuClick(page: Page, label: string | RegExp): Promise<void> {
  const item = page.locator(SEL.ctxMenuItems.css).filter({ hasText: label }).first();
  if (await item.count() === 0) { throw new SkipStep(`context menu has no item ${String(label)}`); }
  let box = await item.boundingBox();
  if (!box) { await item.scrollIntoViewIfNeeded().catch(() => undefined); box = await item.boundingBox(); }
  if (!box) { await page.keyboard.press('Escape'); throw new SkipStep(`context menu item ${String(label)} exists but is not visible (menu placed off screen?)`); }
  const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await glideTo(page, p);
  await page.mouse.click(p.x, p.y);
}

/** Toggle a pill switch: the checkbox itself is visually hidden, its label is the target. */
export async function toggleSwitch(page: Page, name: SelName): Promise<boolean> {
  const css = await need(page, name);
  await reveal(page, css);
  const label = page.locator(`label.switch:has(${css})`).first();
  const box = await (await label.count() > 0 ? label : page.locator(css).first()).boundingBox();
  if (!box) { throw new SkipStep(`switch not visible: ${name}`); }
  const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await glideTo(page, p);
  await page.mouse.click(p.x, p.y);
  return page.locator(css).first().isChecked();
}

export async function typeInto(page: Page, name: SelName, text: string): Promise<void> {
  await clickSel(page, name);
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text, { delay: 40 });
}

export async function hoverPoint(page: Page, p: Point, holdMs = 400): Promise<void> {
  await glideTo(page, p);
  await page.waitForTimeout(holdMs);
}

export async function isVisible(page: Page, name: SelName): Promise<boolean> {
  const sel: { css: string } = SEL[name];
  const loc = page.locator(sel.css).first();
  return (await loc.count()) > 0 && loc.isVisible();
}

/** Open the gear panel if it is closed (any click outside closes it again). */
export async function openSettings(page: Page): Promise<void> {
  if (await page.locator(`${SEL.settingsPanel.css}.open`).count() > 0) { return; }
  const p = await centerOf(page, SEL.settingsBtn.css);
  await glideTo(page, p);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
}

/** Make a control reachable: open the gear panel for controls inside it, and the "show more forces"
 *  expander (ux: #forces-advanced, class `open`) for the advanced force sliders. */
async function reveal(page: Page, css: string): Promise<void> {
  const where = await page.locator(css).first().evaluate((el, panelCss) => ({
    inSettings: !!el.closest(panelCss),
    inClosedAdvanced: !!el.closest('#forces-advanced') && !el.closest('#forces-advanced')?.classList.contains('open'),
  }), SEL.settingsPanel.css);
  if (where.inSettings) { await openSettings(page); }
  if (where.inClosedAdvanced && await page.locator(SEL.showMoreForces.css).count() > 0) {
    const p = await centerOf(page, SEL.showMoreForces.css);
    await glideTo(page, p);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(200);
  }
}

export interface FrameHit { path: string; title: Point; rect: { x: number; y: number; w: number; h: number } }

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Runs in the page. A folder box whose title strip is fully on screen: a shelf frame
 *  (g.frame, not the root) or a drill-down box of the global engine (g.folder-bubble). */
function locateFrameInPage(q: { pick: 'smallest' | 'largest'; pathSuffix?: string }): { hit: FrameHit | null; why: Record<string, number> } {
  const pick = q.pick;
  let best: FrameHit | null = null, bestArea = 0;
  const why: Record<string, number> = { groups: 0, root: 0, noGrip: 0, tooSmall: 0, offscreen: 0, covered: 0 };
  document.querySelectorAll('#graph g.frame, #graph g.folder-bubble').forEach((grp) => {
    why.groups++;
    const d = (grp as any).__data__;
    const path = d ? String(d.path ?? d.folderPath ?? '') : '';
    if (!path || (d && d.kind === 'root')) { why.root++; return; }
    if (q.pathSuffix && !path.replace(/\\/g, '/').endsWith(q.pathSuffix)) { why.otherPath = (why.otherPath ?? 0) + 1; return; }
    const shape = grp.querySelector(':scope > .folder-bubble-shape');
    // The drag target is the transparent title strip; the visual .frame-tab is pointer-events:none and must not be matched.
    const grip = grp.querySelector(':scope > rect.folder-bubble-titlebar, :scope > .folder-bubble-titlebar');
    if (!shape || !grip) { why.noGrip++; return; }
    const r = shape.getBoundingClientRect(), t = grip.getBoundingClientRect();
    if (r.width < 40 || t.width < 10 || t.height < 3) { why.tooSmall++; return; }
    // Only the part of the title strip right of the left toolbar and above the caption is grabbable.
    const vl = Math.max(t.left, 215), vr = Math.min(t.right, window.innerWidth - 10);
    if (vr - vl < 30 || t.top < 0 || t.bottom > window.innerHeight - 40) { why.offscreen++; return; }
    // Probe along the strip; a hit counts only if THIS frame's own strip is the topmost element there
    // (a child frame's strip stacked on top would start a drag of the child).
    let title: { x: number; y: number } | null = null;
    for (const fx of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const cand = { x: vl + (vr - vl) * fx, y: t.top + t.height / 2 };
      if (document.elementFromPoint(cand.x, cand.y) === grip) { title = cand; break; }
    }
    if (!title) { why.covered++; return; }
    const area = r.width * r.height;
    if (!best || (pick === 'largest' ? area > bestArea : area < bestArea)) {
      best = { path, title, rect: { x: r.left, y: r.top, w: r.width, h: r.height } }; bestArea = area;
    }
  });
  return { hit: best, why };
}

/** Runs in the page. Which frame currently owns the pointer position (its title strip is the topmost element). */
function frameUnderPointInPage(p: { x: number; y: number }): string | null {
  const el = document.elementFromPoint(p.x, p.y);
  if (!el || !el.classList.contains('folder-bubble-titlebar')) { return null; }
  const grp = el.closest('g.frame, g.folder-bubble');
  const d = grp ? (grp as any).__data__ : null;
  return d ? String(d.path ?? d.folderPath ?? '') : null;
}

/** Runs in the page. Screen rect of a frame by path, or null (detached / off screen). */
function frameRectInPage(path: string): { x: number; y: number; w: number; h: number } | null {
  for (const grp of document.querySelectorAll('#graph g.frame, #graph g.folder-bubble')) {
    const d = (grp as any).__data__;
    if (!d || String(d.path ?? d.folderPath ?? '') !== path) { continue; }
    const shape = grp.querySelector(':scope > .folder-bubble-shape');
    if (!shape) { return null; }
    const b = shape.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }
  return null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function locateFrame(page: Page, pick: 'smallest' | 'largest' = 'smallest', pathSuffix?: string): Promise<FrameHit> {
  let why: Record<string, number> = {};
  // On mid-size repos every folder box is a few px wide at fit-to-view (and the perf branch parks their
  // content below k 0.3): zoom into the middle of the canvas until a title can be grabbed, like a user would.
  for (let zoomRound = 0; zoomRound <= 3; zoomRound++) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const res = await page.evaluate(locateFrameInPage, { pick, pathSuffix });
      if (res.hit) { return res.hit; }
      why = res.why;
      await page.waitForTimeout(100);
    }
    if (!(why.tooSmall > 0) || zoomRound === 3) { break; }
    await wheelZoom(page, { x: Math.round(215 + (page.viewportSize()?.width ?? 1280) / 2 - 107), y: Math.round((page.viewportSize()?.height ?? 800) / 2) }, -240, 3);
    await page.waitForTimeout(500);
  }
  throw new SkipStep(`no folder frame${pathSuffix ? ` ending in "${pathSuffix}"` : ''} with a grabbable title on screen ${JSON.stringify(why)}`);
}

export interface HoverChurn { restMs: number; rebuilds: number; added: number; removed: number; attrWrites: number }

/** Runs in the page. Counts how often the hover overlay (`line.cross-hover`) is torn down and rebuilt
 *  while the pointer does not move. One build on entry is expected; more is churn (F10). */
function watchHoverChurnInPage(restMs: number): Promise<HoverChurn> {
  return new Promise((resolve) => {
    const root = document.querySelector('#graph svg');
    const out: HoverChurn = { restMs, rebuilds: 0, added: 0, removed: 0, attrWrites: 0 };
    if (!root) { return resolve(out); }
    const isHover = (n: Node): boolean => n instanceof Element && (n.classList.contains('cross-hover') || !!n.querySelector?.('.cross-hover'));
    const mo = new MutationObserver((records) => {
      let addedNow = 0;
      for (const r of records) {
        if (r.type === 'attributes') { if (r.target instanceof Element && r.target.classList.contains('cross-hover')) { out.attrWrites++; } continue; }
        r.addedNodes.forEach((n) => { if (isHover(n)) { addedNow++; } });
        r.removedNodes.forEach((n) => { if (isHover(n)) { out.removed++; } });
      }
      if (addedNow) { out.rebuilds++; out.added += addedNow; }
    });
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['x1', 'y1', 'x2', 'y2', 'd'] });
    setTimeout(() => { mo.disconnect(); resolve(out); }, restMs);
  });
}

/** Rest the pointer on `p` and report hover-overlay churn. The observer is armed AFTER the pointer
 *  arrived and the first overlay was built, so every rebuild it sees happened under a resting pointer. */
export async function restAndWatchChurn(page: Page, p: Point, restMs = 1000): Promise<HoverChurn> {
  await glideTo(page, p);
  await page.waitForTimeout(350);
  return page.evaluate(watchHoverChurnInPage, restMs);
}

export const GLOBAL_GUARD_NODES = 4000; // ux ee36bf5: state.currentNodes.length above which Engine:Global needs a confirming click

/** Switch the engine like a user: above the guard threshold the first Global click only shows a hint. */
export async function switchEngine(page: Page, engine: 'shelf' | 'global'): Promise<{ guarded: boolean }> {
  await clickSel(page, engine === 'global' ? 'engineGlobal' : 'engineShelf');
  if (engine !== 'global') { return { guarded: false }; }
  await page.waitForTimeout(250);
  const guarded = await page.locator(SEL.globalGuardHint.css).first().isVisible().catch(() => false);
  if (guarded) { await clickSel(page, 'engineGlobal'); } // confirm within the 6 s window
  return { guarded };
}

/** Measurement-grade fit: call the product's own fitToView() instead of the double-click gesture. On a layout that
 *  is still moving the gesture can land on a drifting node (opening a source popup instead of fitting) — fine to
 *  discover in a UX walkthrough, fatal for a sweep whose metrics are taken "at fit". Also closes stray popups. */
export async function fitDirect(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  const ok = await page.evaluate('typeof fitToView === "function" ? (fitToView(), true) : false');
  if (!ok) { await fitToView(page); return; }
  await page.waitForTimeout(750); // fitToView() animates for 500 ms
}

export interface FrameDragResult {
  path: string; grabbed: string | null;   // grabbed = the frame whose strip was under the pointer at mousedown
  pointerDx: number; pointerDy: number;   // total pointer travel
  frameDx: number; frameDy: number;       // total frame travel
  maxJumpPx: number; maxStepPx: number;   // largest per-step frame move vs the largest per-step pointer move
  samples: number;
  /** geometry with the button still down (last pointer position) and right after the drop */
  midDrag: Snapshot | null; afterDrop: Snapshot | null;
  /** how far the DRAGGED frame moved between release (button still down) and the settled drop */
  releaseToDropPx: number | null;
  midDragScreenshot?: string;             // set by the caller when it saved one
}

/** Drag a folder by its title strip in small steps and watch the frame follow. Asserts the grab hit the intended
 *  frame; reports the largest per-step jump of the frame so a scenario can flag `drag-jump` (frame moves more than
 *  twice the pointer step: it is being pulled by something other than the pointer). */
export async function dragFrame(page: Page, hit: FrameHit, dx: number, dy: number, steps = 12, midDragScreenshot?: string): Promise<FrameDragResult> {
  await glideTo(page, hit.title);
  const grabbed = await page.evaluate(frameUnderPointInPage, hit.title);
  const out: FrameDragResult = { path: hit.path, grabbed, pointerDx: dx, pointerDy: dy, frameDx: 0, frameDy: 0, maxJumpPx: 0, maxStepPx: 0, samples: 0, midDrag: null, afterDrop: null, releaseToDropPx: null };
  if (grabbed !== hit.path) { return out; } // the caller decides (wrong-frame-grab finding); do not drag a stranger
  const start = await page.evaluate(frameRectInPage, hit.path);
  await page.mouse.down();
  let prev = start;
  for (let i = 1; i <= steps; i++) {
    const px = hit.title.x + (dx * i) / steps, py = hit.title.y + (dy * i) / steps;
    await page.mouse.move(px, py);
    await page.waitForTimeout(40);
    const cur = await page.evaluate(frameRectInPage, hit.path);
    if (cur && prev) {
      const jump = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const step = Math.hypot(dx / steps, dy / steps);
      if (jump > out.maxJumpPx) { out.maxJumpPx = +jump.toFixed(1); }
      out.maxStepPx = +step.toFixed(1);
      out.samples++;
    }
    prev = cur;
  }
  // Button still down: this is the drag phase the H4 rule judges.
  out.midDrag = await collectSnapshot(page, { maxLabels: 10 });
  if (midDragScreenshot) { await page.screenshot({ path: midDragScreenshot }); out.midDragScreenshot = midDragScreenshot; }
  await page.mouse.up();
  await page.waitForTimeout(900); // drop re-pack + glide
  out.afterDrop = await collectSnapshot(page, { maxLabels: 10 });
  const atRelease = out.midDrag?.frames.find(f => f.path === hit.path)?.rect, atDrop = out.afterDrop?.frames.find(f => f.path === hit.path)?.rect;
  if (atRelease && atDrop) { out.releaseToDropPx = +Math.hypot(atDrop.x - atRelease.x, atDrop.y - atRelease.y).toFixed(1); }
  const end = await page.evaluate(frameRectInPage, hit.path);
  if (start && end) { out.frameDx = +(end.x - start.x).toFixed(1); out.frameDy = +(end.y - start.y).toFixed(1); }
  return out;
}

/** Turn a drag result into findings: a grab of the wrong frame (high), a frame that jumps ahead of the pointer
 *  (drag-jump, medium: max per-step frame move > 2x the pointer step), or a frame that did not follow at all. */
export function judgeFrameDrag(r: FrameDragResult): string {
  if (r.grabbed !== r.path) {
    throw new StepFinding({ rule: 'wrong-frame-grab', severity: 'high', ref: 'ux-round2 R1', message: `mousedown on the title of ${r.path} would grab ${r.grabbed ?? 'nothing'} (stacked title strips)` });
  }
  if (r.samples && r.maxStepPx > 0 && r.maxJumpPx > 2 * r.maxStepPx) {
    throw new StepFinding({ rule: 'drag-jump', severity: 'medium', ref: 'ux-round2 R1', message: `frame jumped ${r.maxJumpPx} px in one step while the pointer moved ${r.maxStepPx} px (${Math.round(r.maxJumpPx / r.maxStepPx)}x)` });
  }
  if (r.samples && Math.hypot(r.frameDx, r.frameDy) < 0.3 * Math.hypot(r.pointerDx, r.pointerDy)) {
    throw new StepFinding({ rule: 'frame-did-not-follow', severity: 'medium', message: `pointer moved ${r.pointerDx},${r.pointerDy} px but the frame only ${r.frameDx},${r.frameDy}` });
  }
  return `drag ok: grabbed ${r.path.split('/').pop()}, frame moved ${r.frameDx},${r.frameDy} px for ${r.pointerDx},${r.pointerDy} px pointer, max step ${r.maxJumpPx} px (pointer ${r.maxStepPx} px), release→drop ${r.releaseToDropPx ?? '–'} px`;
}

/**
 * Wait until the simulation is at REST, not merely visually still: alpha <= 0.001 (d3's alphaMin, the point
 * where Global stops ticking), or no tick for one second (node positions exactly unchanged; Shelf frame sims
 * stop at their own threshold). Global/Dynamic needs ~340 ticks at 15-26 ticks/s, i.e. 13-16 s on corpus
 * repos; a movement heuristic samples inside that. Returns how it ended.
 */
export async function waitSimRest(page: Page, timeoutMs = 60000): Promise<{ rested: boolean; alpha: number | null; ms: number; by: string }> {
  const t0 = Date.now();
  const read = (): Promise<{ alpha: number | null; sig: string }> => page.evaluate(`(() => {
    let a = null; try { a = state.simulation && state.simulation.alpha ? state.simulation.alpha() : null; } catch (e) { a = null; }
    let h = 0; for (const n of (state.currentNodes || [])) { h = (h * 31 + Math.round((n.x || 0) * 100) * 7 + Math.round((n.y || 0) * 100)) | 0; }
    return { alpha: a, sig: String(h) };
  })()`) as Promise<{ alpha: number | null; sig: string }>;
  let last = await read(), sameSince = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (last.alpha !== null && last.alpha <= 0.001) { return { rested: true, alpha: last.alpha, ms: Date.now() - t0, by: 'alpha' }; }
    await page.waitForTimeout(250);
    const cur = await read();
    if (cur.sig !== last.sig) { sameSince = Date.now(); }
    else if (Date.now() - sameSince >= 1000) { return { rested: true, alpha: cur.alpha, ms: Date.now() - t0, by: 'no-ticks' }; }
    last = cur;
  }
  return { rested: false, alpha: last.alpha, ms: Date.now() - t0, by: 'timeout' };
}
