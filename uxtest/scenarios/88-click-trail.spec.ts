// 88 — Click trail on pinned cards (Bela 2026-11-12): "every time I click a new node make sure
// that the connections from the older clicked nodes fade a bit". Pins three functions (two of
// them joined by a call across folders), moves the pointer away and reads the rendered opacity
// of each pin's own lines: newest full, each older one a step fainter, node rings full. Then
// unpins the middle one (the trail closes up), hovers an unpinned function (full, trail kept)
// and clears with Escape. TRAIL_SHOTS_DIR=<dir> writes screenshots, TRAIL_SHOTS_PHASE names
// them (before / after).
import * as fs from 'fs';
import * as path from 'path';
import { expect, type Page } from '@playwright/test';
import { scenario, type ScenarioBody } from '../lib/scenario';
import { backgroundPoint, fitToView, glideTo, hoverPoint, wheelZoom } from '../lib/actions';
import { SkipStep } from '../lib/step';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Spot { id: string; x: number; y: number }

/**
 * Runs in the page: A and B in different folders joined by a call, C a third function with
 * calls of its own, not joined to A or B; D an unpinned function with calls, not joined to any.
 */
function findTrioInPage(): { a: Spot; b: Spot; c: Spot; d: Spot | null } | null {
  const hit = (el: Element): { x: number; y: number } | null => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (r.width < 3 || x < 240 || y < 20 || x > window.innerWidth - 300 || y > window.innerHeight - 40) { return null; }
    return document.elementFromPoint(x, y) === el ? { x, y } : null;
  };
  const at = new Map<string, { x: number; y: number; dir: string }>();
  document.querySelectorAll('#graph circle.regular-node').forEach((el) => {
    const d = (el as any).__data__;
    if (!d || !d.file || !(d.line > 0)) { return; }
    const p = hit(el);
    if (p) { at.set(String(d.id), { ...p, dir: String(d.file).replace(/\\/g, '/').replace(/\/[^/]*$/, '') }); }
  });
  const st = (0, eval)('state') as any;
  const idOf = (e: any) => String(typeof e === 'object' ? e.id : e);
  const edges = ((st.graphData && st.graphData.edges) || []).map((e: any) => [idOf(e.source), idOf(e.target)] as [string, string]);
  const nbrs = new Map<string, Set<string>>();
  for (const [s, t] of edges) {
    if (s === t) { continue; }
    if (!nbrs.has(s)) { nbrs.set(s, new Set()); }
    if (!nbrs.has(t)) { nbrs.set(t, new Set()); }
    nbrs.get(s)!.add(t); nbrs.get(t)!.add(s);
  }
  const far = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y) >= 120;
  const spot = (id: string): Spot => ({ id, x: at.get(id)!.x, y: at.get(id)!.y });
  let best: { a: string; b: string; dist: number } | null = null;
  for (const [s, t] of edges) {
    const ps = at.get(s), pt = at.get(t);
    if (!ps || !pt || s === t || ps.dir === pt.dir || !far(ps, pt)) { continue; }
    const dist = Math.hypot(ps.x - pt.x, ps.y - pt.y);
    if (!best || dist < best.dist) { best = { a: s, b: t, dist }; }
  }
  if (!best) { return null; }
  const { a, b } = best;
  const free = (id: string, taken: string[]) => !taken.includes(id) && taken.every(x => !(nbrs.get(id) || new Set()).has(x)
    && far(at.get(id)!, at.get(x)!)) && [...(nbrs.get(id) || [])].some(n => at.has(n));
  const ids = [...at.keys()];
  const c = ids.find(id => free(id, [a, b]));
  if (!c) { return null; }
  const d = ids.find(id => free(id, [a, b, c])) || null;
  return { a: spot(a), b: spot(b), c: spot(c), d: d ? spot(d) : null };
}

/**
 * Runs in the page: per id, the highest rendered opacity of the lines it alone owns among
 * `ids` (a line to another of them is shared), and whether its ring is drawn at full strength.
 */
function trailStateInPage(ids: string[]): { lines: Array<number | null>; ringFull: boolean[] } {
  const idOf = (e: any) => String(typeof e === 'object' ? e.id : e);
  const all = [...document.querySelectorAll('#graph line')] as any[];
  const lines = ids.map((id) => {
    let best: number | null = null;
    for (const el of all) {
      const d = el.__data__;
      if (!d || d.source === undefined || !el.classList.contains('cg-hl') && !el.classList.contains('cross-hover')) { continue; }
      const s = idOf(d.source), t = idOf(d.target);
      if (s !== id && t !== id) { continue; }
      if (ids.some(x => x !== id && (x === s || x === t))) { continue; }
      const o = Number(getComputedStyle(el).opacity);
      best = best === null ? o : Math.max(best, o);
    }
    return best;
  });
  const ringFull = ids.map((id) => {
    const c = ([...document.querySelectorAll('#graph circle.cg-pinned')] as any[]).find(x => x.__data__ && String(x.__data__.id) === id);
    if (!c) { return false; }
    const cs = getComputedStyle(c);
    return Number(cs.opacity) === 1 && Number(cs.strokeOpacity) === 1 && Number(cs.fillOpacity) === 1;
  });
  return { lines, ringFull };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function posOf(page: Page, id: string): Promise<{ x: number; y: number }> {
  const p = await page.evaluate((nid) => {
    for (const el of document.querySelectorAll('#graph circle.regular-node')) {
      const d = (el as unknown as { __data__?: { id: unknown } }).__data__;
      if (!d || String(d.id) !== nid) { continue; }
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return document.elementFromPoint(x, y) === el ? { x, y } : null;
    }
    return null;
  }, id);
  if (!p) { throw new SkipStep(`node ${id} not hittable on screen`); }
  return p;
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.TRAIL_SHOTS_DIR;
  if (!dir) { return; }
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${process.env.TRAIL_SHOTS_PHASE || 'after'}-${name}.png`) });
}

/** The same view with the cards hidden for one frame, so the lines under them show. */
async function linesShot(page: Page, name: string): Promise<void> {
  if (!process.env.TRAIL_SHOTS_DIR) { return; }
  const tag = await page.addStyleTag({ content: '.pinned-card, svg.pc-leaders { visibility: hidden !important; }' });
  await page.waitForTimeout(100);
  await shot(page, name);
  await tag.evaluate((el) => (el as unknown as HTMLElement).remove());
}

async function clickNode(page: Page, id: string): Promise<void> {
  const p = await posOf(page, id);
  await glideTo(page, p);
  await page.mouse.click(p.x, p.y);
}

const near = (got: number | null, want: number) => got !== null && Math.abs(got - want) < 0.02;

const body = (theme: 'dark' | 'light'): ScenarioBody => async ({ page, ux }, combo) => {
  let trio: { a: Spot; b: Spot; c: Spot; d: Spot | null } | null = null;
  const tag = `${combo.repo}-${combo.engine}-${theme}`;

  await ux.step('Fit, then find three functions with calls of their own (A and B across folders)', async () => {
    await fitToView(page);
    await page.waitForTimeout(600);
    trio = await page.evaluate(findTrioInPage);
    for (let i = 0; !trio && i < 3; i++) {
      await wheelZoom(page, { x: 760, y: 400 }, -120, 2);
      await page.waitForTimeout(500);
      trio = await page.evaluate(findTrioInPage);
    }
    if (!trio) { throw new SkipStep('no three hittable functions with separate calls'); }
  }, { metrics: false });

  await ux.step('Pin A, B, C: newest full, each older one a step fainter, rings full', async () => {
    if (!trio) { throw new SkipStep('no trio'); }
    for (const s of [trio.a, trio.b, trio.c]) { await clickNode(page, s.id); }
    await expect(page.locator('.pinned-card')).toHaveCount(3);
    await hoverPoint(page, await backgroundPoint(page), 900);
    await shot(page, `three-pins-${tag}`);
    await linesShot(page, `three-pins-lines-${tag}`);
    const s = await page.evaluate(trailStateInPage, [trio.a.id, trio.b.id, trio.c.id]);
    expect(s.ringFull, 'rings stay full').toEqual([true, true, true]);
    expect(near(s.lines[2], 1), `C (newest) full: ${s.lines[2]}`).toBe(true);
    expect(near(s.lines[1], 0.7), `B one step: ${s.lines[1]}`).toBe(true);
    expect(near(s.lines[0], 0.5), `A two steps: ${s.lines[0]}`).toBe(true);
  }, { metrics: false });

  await ux.step('Unpin B: the trail closes up (A one step, C full)', async () => {
    if (!trio) { throw new SkipStep('no trio'); }
    await clickNode(page, trio.b.id);
    await expect(page.locator('.pinned-card')).toHaveCount(2);
    await hoverPoint(page, await backgroundPoint(page), 600);
    const s = await page.evaluate(trailStateInPage, [trio.a.id, trio.c.id]);
    expect(near(s.lines[0], 0.7), `A one step: ${s.lines[0]}`).toBe(true);
    expect(near(s.lines[1], 1), `C full: ${s.lines[1]}`).toBe(true);
    await shot(page, `closed-up-${tag}`);
  }, { metrics: false });

  await ux.step('Hover an unpinned function: its lines full, the trail unchanged', async () => {
    if (!trio || !trio.d) { throw new SkipStep('no fourth function'); }
    await hoverPoint(page, await posOf(page, trio.d.id), 600);
    const s = await page.evaluate(trailStateInPage, [trio.a.id, trio.c.id, trio.d.id]);
    expect(near(s.lines[2], 1), `hovered full: ${s.lines[2]}`).toBe(true);
    expect(near(s.lines[0], 0.7), `A still one step: ${s.lines[0]}`).toBe(true);
    expect(near(s.lines[1], 1), `C still full: ${s.lines[1]}`).toBe(true);
    await shot(page, `hover-unpinned-${tag}`);
  }, { metrics: false });

  await ux.step('Escape clears the pins and the trail', async () => {
    await page.mouse.move(5, 790);
    await page.keyboard.press('Escape');
    await expect(page.locator('.pinned-card')).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelectorAll('#graph line[style*="--cg-tr-o"]').length), 'no trail strength left').toBe(0);
  }, { metrics: false });
};

scenario('click-trail', { perMotion: false, only: { motion: 'static' }, theme: 'dark' }, body('dark'));
scenario('click-trail-light', { perMotion: false, perEngine: false, only: { motion: 'static', engine: 'shelf' }, theme: 'light' }, body('light'));
