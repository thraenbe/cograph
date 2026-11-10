// 86 — Pinned cards (pinnedCards.js, Bela 2026-11-10): a click on a function keeps its hover
// card with close / open function / open file; several at once; the pinned focus (lines,
// callers and callees) stays when the pointer leaves. Pins two functions joined by a call
// across folders, moves away, checks both cards and both focus sets, the buttons, Escape.
// PINNED_SHOTS_DIR=<dir> also writes the screenshots there (dark + light).
import * as fs from 'fs';
import * as path from 'path';
import { expect, type Page } from '@playwright/test';
import { scenario, type ScenarioBody } from '../lib/scenario';
import { backgroundPoint, fitToView, glideTo, hoverPoint, wheelZoom } from '../lib/actions';
import { SkipStep } from '../lib/step';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Spot { id: string; x: number; y: number }

/** Runs in the page: two visible, hittable functions in different folders joined by a call, A first. */
function findPairInPage(): { a: Spot; b: Spot } | null {
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
  let best: { a: Spot; b: Spot; dist: number } | null = null;
  const st = (0, eval)('state') as any;
  for (const e of (st.graphData && st.graphData.edges) || []) {
    const s = String(typeof e.source === 'object' ? e.source.id : e.source);
    const t = String(typeof e.target === 'object' ? e.target.id : e.target);
    const ps = at.get(s), pt = at.get(t);
    if (!ps || !pt || s === t || ps.dir === pt.dir) { continue; }
    const dist = Math.hypot(ps.x - pt.x, ps.y - pt.y);
    if (dist < 120) { continue; }                       // far enough apart for two cards
    if (!best || dist < best.dist) { best = { a: { id: s, x: ps.x, y: ps.y }, b: { id: t, x: pt.x, y: pt.y }, dist }; }
  }
  return best ? { a: best.a, b: best.b } : null;
}

/** Runs in the page: what the pins hold right now. */
function pinStateInPage(ids: string[]): Record<string, unknown> {
  const g = document.querySelector('#graph g.cg-hovering, #graph g.cg-focus, #graph svg > g');
  const circles = [...document.querySelectorAll('#graph circle.regular-node')] as any[];
  const of = (id: string) => circles.filter(c => c.__data__ && String(c.__data__.id) === id);
  const cards = [...document.querySelectorAll('.pinned-card')] as HTMLElement[];
  return {
    cards: cards.filter(c => c.style.display !== 'none').length,
    cardNames: cards.map(c => (c.querySelector('.hc-name')?.textContent || '').trim()),
    pinned: ids.map(id => of(id).some(c => c.classList.contains('cg-pinned'))),
    neighbours: ids.map(id => of(id).some(c => c.classList.contains('cg-nb'))),
    focus: !!(g && g.classList.contains('cg-focus')),
    litLines: document.querySelectorAll('#graph line.cg-hl').length + document.querySelectorAll('#graph line.cross-hover').length,
    hoverCard: !!document.querySelector('.hover-card.visible:not(.pinned-card)'),
    overlap: (() => {
      const r = cards.map(c => c.getBoundingClientRect());
      return r.length === 2 && r[0].left < r[1].right && r[1].left < r[0].right && r[0].top < r[1].bottom && r[1].top < r[0].bottom;
    })(),
    coversOwnNode: ids.some((id) => {
      const c = of(id)[0]; if (!c) { return false; }
      const n = c.getBoundingClientRect(); const x = n.left + n.width / 2, y = n.top + n.height / 2;
      return cards.some(k => { const b = k.getBoundingClientRect(); return x > b.left && x < b.right && y > b.top && y < b.bottom; });
    }),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** On-screen centre of a function's circle. */
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

async function shot(page: Page, name: string, around?: { x: number; y: number }): Promise<void> {
  const dir = process.env.PINNED_SHOTS_DIR;
  if (!dir) { return; }
  fs.mkdirSync(dir, { recursive: true });
  const clip = around ? { x: Math.max(0, around.x - 60), y: Math.max(0, around.y - 40), width: 120, height: 80 } : undefined;
  await page.screenshot({ path: path.join(dir, name + '.png'), clip });
}

const body = (theme: 'dark' | 'light'): ScenarioBody => async ({ page, ux, host }, combo) => {
  let pair: { a: Spot; b: Spot } | null = null;
  const tag = `${combo.repo}-${combo.engine}-${theme}`;

  await ux.step('Fit, then find two functions in different folders joined by a call', async () => {
    await fitToView(page);
    await page.waitForTimeout(600);
    pair = await page.evaluate(findPairInPage);
    for (let i = 0; !pair && i < 3; i++) {
      await wheelZoom(page, { x: 760, y: 400 }, -120, 2);
      await page.waitForTimeout(500);
      pair = await page.evaluate(findPairInPage);
    }
    if (!pair) { throw new SkipStep('no cross-folder call with both ends hittable on screen'); }
    if (await page.locator('.pinned-card').count() > 0) { throw new Error('a card is pinned before any click'); }
  }, { metrics: false });

  // Before (unchanged for unpinned functions, = main): the hover card and lines go when the pointer moves on.
  await ux.step('Before: hover A, then follow its call to B', async () => {
    if (!pair) { throw new SkipStep('no pair'); }
    await hoverPoint(page, pair.a, 900);
    await expect(page.locator('.hover-card.visible:not(.pinned-card)')).toBeVisible({ timeout: 2000 });
    await shot(page, `before-hover-${tag}`);
    await glideTo(page, { x: (pair.a.x + pair.b.x) / 2, y: (pair.a.y + pair.b.y) / 2 + 3 });
    await page.waitForTimeout(500);
    await shot(page, `before-away-${tag}`);
    await hoverPoint(page, await backgroundPoint(page), 300);
  }, { metrics: false });

  await ux.step('Click A, then B: two pinned cards', async () => {
    if (!pair) { throw new SkipStep('no pair'); }
    await glideTo(page, pair.a); await page.mouse.click(pair.a.x, pair.a.y);
    await expect(page.locator('.pinned-card')).toHaveCount(1);
    await glideTo(page, pair.b); await page.mouse.click(pair.b.x, pair.b.y);
    await expect(page.locator('.pinned-card')).toHaveCount(2);
    expect(await page.locator('.func-card').count(), 'a click no longer opens the source popup directly').toBe(0);
  }, { metrics: false });

  await ux.step('Pointer away: both cards and both focus sets stay', async () => {
    if (!pair) { throw new SkipStep('no pair'); }
    await hoverPoint(page, await backgroundPoint(page), 900);
    const s = await page.evaluate(pinStateInPage, [pair.a.id, pair.b.id]);
    expect(s.cards, 'cards on screen').toBe(2);
    expect(s.pinned, 'ring on both nodes').toEqual([true, true]);
    expect(s.neighbours, 'both stay in the focus').toEqual([true, true]);
    expect(s.focus, 'the rest stays dimmed').toBe(true);
    expect(s.litLines as number, 'lines of the pinned functions stay lit').toBeGreaterThan(0);
    expect(s.overlap, 'cards do not overlap').toBe(false);
    expect(s.coversOwnNode, 'no card covers its own node').toBe(false);
    await expect(page.locator('.pinned-card .hc-sig').first()).not.toHaveText('', { timeout: 3000 });
    await page.waitForTimeout(300);
    await shot(page, `pinned-${tag}`);
    await shot(page, `ring-${tag}`, await posOf(page, pair.a.id).catch(() => pair!.a));
  }, { metrics: false });

  await ux.step('Zoom: the cards follow their nodes', async () => {
    if (!pair) { throw new SkipStep('no pair'); }
    const before = await page.locator('.pinned-card').first().boundingBox();
    // one step in, centred between the two (zoomed out far, function nodes are parked and the cards wait)
    await wheelZoom(page, { x: (pair.a.x + pair.b.x) / 2, y: (pair.a.y + pair.b.y) / 2 }, -100, 1);
    await page.waitForTimeout(500);
    const after = await page.locator('.pinned-card').first().boundingBox();
    expect(before && after && (before.x !== after.x || before.y !== after.y), 'card moved with the zoom').toBe(true);
    const s = await page.evaluate(pinStateInPage, [pair.a.id, pair.b.id]);
    expect(s.pinned).toEqual([true, true]);
  }, { metrics: false });

  await ux.step('Open file posts navigate at the function line; Open function opens the popup', async () => {
    if (!pair) { throw new SkipStep('no pair'); }
    const before = host.posted('navigate').length;
    const card = page.locator('.pinned-card:visible').first();
    await card.locator('.pc-open-file').click();
    await expect.poll(() => host.posted('navigate').length).toBe(before + 1);
    const nav = host.posted('navigate').at(-1)!;
    expect(Number(nav.line), 'line of the function').toBeGreaterThan(0);
    await card.locator('.pc-open-fn').click();
    await expect(page.locator('.func-card').first()).toBeVisible();
    await page.keyboard.press('Escape');                 // first Escape: the popup
    await expect(page.locator('.func-card')).toHaveCount(0);
    await expect(page.locator('.pinned-card')).toHaveCount(2);
  }, { metrics: false });

  await ux.step('Tab reaches the card buttons', async () => {
    if (!pair) { throw new SkipStep('no pair'); }
    await page.locator('.pinned-card:visible .pc-close').first().focus();
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || '');
    expect(label.startsWith('Open function '), `focus after close: "${label}"`).toBe(true);
  }, { metrics: false, settle: false });

  await ux.step('Close unpins one; a click on the node unpins the other', async () => {
    if (!pair) { throw new SkipStep('no pair'); }
    await page.locator('.pinned-card:visible .pc-close').first().click();
    await expect(page.locator('.pinned-card')).toHaveCount(1);
    const s = await page.evaluate(pinStateInPage, [pair.a.id, pair.b.id]);
    expect((s.pinned as boolean[]).filter(Boolean).length).toBe(1);
    const left = (s.pinned as boolean[])[0] ? pair.a.id : pair.b.id;
    const p = await posOf(page, left);
    await glideTo(page, p); await page.mouse.click(p.x, p.y);
    await expect(page.locator('.pinned-card')).toHaveCount(0);
  }, { metrics: false });

  await ux.step('Pin both again, Escape unpins all', async () => {
    if (!pair) { throw new SkipStep('no pair'); }
    for (const id of [pair.a.id, pair.b.id]) { const p = await posOf(page, id); await glideTo(page, p); await page.mouse.click(p.x, p.y); }
    await expect(page.locator('.pinned-card')).toHaveCount(2);
    await page.mouse.move(5, 790);
    await page.keyboard.press('Escape');
    await expect(page.locator('.pinned-card')).toHaveCount(0);
    expect(await page.locator('#graph circle.cg-pinned').count()).toBe(0);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => !!document.querySelector('#graph g.cg-focus')), 'the dim ends with the last pin').toBe(false);
    await shot(page, `unpinned-${tag}`);
  }, { metrics: false });
};

scenario('pinned-cards', { perMotion: false, only: { motion: 'static' }, theme: 'dark' }, body('dark'));
scenario('pinned-cards-light', { perMotion: false, perEngine: false, only: { motion: 'static', engine: 'shelf' }, theme: 'light' }, body('light'));
