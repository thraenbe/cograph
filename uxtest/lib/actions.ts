// Real-input helpers. Everything goes through page.mouse / keyboard with a
// visible glide so the video shows what happened; selectors come from the map.
import type { Page } from '@playwright/test';
import { SEL, type SelName } from '../selectors';
import { SkipStep } from './step';

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
  const p = await centerOf(page, css);
  await glideTo(page, p);
  await page.mouse.click(p.x, p.y);
}

/** Range inputs cannot be typed into: set the value and fire the events the webview listens to. */
export async function setSlider(page: Page, name: SelName, value: number): Promise<void> {
  const css = await need(page, name);
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
/** Runs in the page. A background point: on the svg, not over any node, frame or panel. */
function findBackgroundInPage(): { x: number; y: number } | null {
  const svg = document.querySelector('#graph svg');
  if (!svg) { return null; }
  const W = window.innerWidth, H = window.innerHeight;
  for (let gy = 1; gy < 12; gy++) {
    for (let gx = 11; gx >= 1; gx--) {
      const x = Math.round((gx / 12) * W), y = Math.round((gy / 12) * H);
      if (document.elementFromPoint(x, y) === svg) { return { x, y }; }
    }
  }
  return null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function backgroundPoint(page: Page): Promise<Point> {
  const p = await page.evaluate(findBackgroundInPage);
  if (!p) { throw new SkipStep('no free background point on screen'); }
  return p;
}

/** The product's own fit gesture: double-click the canvas background. */
export async function fitToView(page: Page): Promise<void> {
  const p = await backgroundPoint(page);
  await glideTo(page, p);
  await page.mouse.dblclick(p.x, p.y);
}
