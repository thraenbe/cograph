// ux16 search bar, Tier A (headless lab, real webview, real repos): the function filter is always on the
// canvas, filters the graph live, shows its count inline, clears back to the full graph, and stays clear of
// the control strip, the gear, the timeline transport and the PR banner at wide and narrow widths.
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openLab } from '../lib/lab';

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };

async function rectOf(page: Page, css: string): Promise<Box> {
  return page.locator(css).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
}

const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** The webview's own filter result: ids it shows, and the labels of the function nodes among them. */
async function visibleSet(page: Page): Promise<{ size: number; fnLabels: string[] }> {
  return page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = globalThis as any;
    const ids: Set<string> = w.eval('getVisibleNodeIds()');
    const nodes: any[] = w.eval('state.currentNodes') ?? [];
    const fnLabels = nodes.filter((n) => ids.has(n.id) && !n.isCluster && !n.isLibrary && !n.isSynthetic)
      .map((n) => String(n.label ?? ''));
    return { size: ids.size, fnLabels };
  });
}

/** Labels of the function dots the user can see right now. */
async function shownFunctionLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('#graph circle.regular-node')]
    .filter((el) => getComputedStyle(el).display !== 'none')
    .map((el) => String((el as unknown as { __data__?: { label?: string } }).__data__?.label ?? '')));
}

for (const repoName of ['click', 'flask', 'express']) {
  test(`search bar on ${repoName}: always visible, filters live, counts inline, clears`, async ({ browser }) => {
    test.setTimeout(240000);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-searchbar-'));
    const lab = await openLab({ repo: repoName, scenario: 'search-bar', browser, outDir, video: false });
    const { page, repo } = lab;
    try {
      // Visible without opening anything, and not part of the settings panel.
      await expect(page.locator('#search')).toBeVisible();
      expect(await page.locator('#search').evaluate((el) => el.closest('#settings-panel') === null)).toBe(true);
      expect(await page.locator('#settings-panel').evaluate((el) => el.classList.contains('open'))).toBe(false);

      await lab.ux.step('Load', async () => { /* settle */ }, { metrics: false });
      const before = await visibleSet(page);
      expect(before.fnLabels.length).toBeGreaterThan(0);
      const probeNode = repo.graph.nodes.find((n) => !n.isLibrary && n.file && String(n.name ?? '').length > 4);
      const query = String(probeNode?.name ?? 'main').slice(0, 4).toLowerCase();

      await page.keyboard.press('Control+f');
      await expect(page.locator('#search')).toBeFocused();
      await page.keyboard.type(query, { delay: 30 });
      await expect(page.locator('#search-count')).toHaveText(/^\d+ match(es)?$/);
      const count = Number((await page.locator('#search-count').innerText()).split(' ')[0]);
      const after = await visibleSet(page);
      expect(count, 'the inline count is the size of the filtered set').toBe(after.size);
      expect(after.fnLabels.length).toBeGreaterThan(0);
      expect(after.fnLabels.length).toBeLessThan(before.fnLabels.length);
      expect(after.fnLabels.every((l) => l.toLowerCase().includes(query)), `every kept function matches "${query}"`).toBe(true);
      const shown = await shownFunctionLabels(page);
      expect(shown.every((l) => l.toLowerCase().includes(query)), 'no drawn dot fails the query').toBe(true);
      await expect(page.locator('#btn-clear-search')).toBeVisible();

      // Zero matches: "No matches", the bar border goes to the error colour.
      await page.keyboard.press('Control+a');
      await page.keyboard.type('zzqqxx', { delay: 20 });
      await expect(page.locator('#search-count')).toHaveText('No matches');
      await expect(page.locator('#search-bar')).toHaveClass(/search-container--none/);

      // The cross clears and restores the full graph.
      await page.locator('#btn-clear-search').click();
      await expect(page.locator('#search')).toHaveValue('');
      await expect(page.locator('#search-count')).toBeHidden();
      await expect.poll(async () => (await visibleSet(page)).size).toBe(before.size);

      // Escape empties a query first.
      await page.locator('#search').fill('');
      await page.keyboard.press('Control+f');
      await page.keyboard.type(query, { delay: 20 });
      await page.keyboard.press('Escape');
      await expect(page.locator('#search')).toHaveValue('');
      await expect.poll(async () => (await visibleSet(page)).size).toBe(before.size);

      // Clear of the strip and the gear, wide and at 600 px; the lab's hit test sees the bar as an occluder.
      for (const width of [1280, 600]) {
        await page.setViewportSize({ width, height: 800 });
        const bar = await rectOf(page, '#search-bar');
        expect(bar.width, `bar expanded at ${width}`).toBeGreaterThan(200);
        expect(overlaps(bar, await rectOf(page, '#top-left-controls')), `bar vs strip at ${width}`).toBe(false);
        expect(overlaps(bar, await rectOf(page, '#settings-btn')), `bar vs gear at ${width}`).toBe(false);
        const hitInBar = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('#search-bar'),
          { x: bar.left + bar.width / 2, y: bar.top + bar.height / 2 });
        expect(hitInBar, 'a pointer over the bar hits the bar, so locateNode never picks a node under it').toBe(true);
      }

      // Narrow: the empty bar folds to its magnifier and opens on Ctrl+F.
      await page.setViewportSize({ width: 440, height: 800 });
      await page.locator('#search').blur();
      expect((await rectOf(page, '#search-bar')).width).toBeLessThanOrEqual(32);
      await page.keyboard.press('Control+f');
      await expect(page.locator('#search')).toBeFocused();
      expect((await rectOf(page, '#search-bar')).width).toBeGreaterThan(150);
      expect(overlaps(await rectOf(page, '#search-bar'), await rectOf(page, '#settings-btn'))).toBe(false);
      await page.keyboard.press('Escape');

      // A PR banner across its row pushes the bar below it; without the banner it returns to 10 px.
      await page.setViewportSize({ width: 900, height: 800 });
      await page.evaluate(() => {
        const b = document.createElement('div');
        b.id = 'pr-view-banner';
        b.style.cssText = 'position:fixed;top:10px;left:212px;right:56px;height:46px;';
        document.body.appendChild(b);
      });
      await expect.poll(async () => (await rectOf(page, '#search-bar')).top).toBeGreaterThanOrEqual(62);
      expect(overlaps(await rectOf(page, '#search-bar'), await rectOf(page, '#pr-view-banner'))).toBe(false);
      await page.evaluate(() => document.getElementById('pr-view-banner')?.remove());
      await expect.poll(async () => (await rectOf(page, '#search-bar')).top).toBe(10);
    } finally {
      await lab.close();
    }
  });
}

test('search bar in the timeline window drops below the transport when they share the row', async ({ browser }) => {
  test.setTimeout(240000);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-searchbar-tl-'));
  const lab = await openLab({ repo: 'click', scenario: 'search-bar-timeline', browser, outDir, video: false, timeline: true });
  const { page } = lab;
  try {
    for (const width of [1600, 900]) {
      await page.setViewportSize({ width, height: 800 });
      const transport = await rectOf(page, '#tl-transport');
      await expect.poll(async () => overlaps(await rectOf(page, '#search-bar'), transport), `width ${width}`).toBe(false);
    }
    expect((await rectOf(page, '#search-bar')).top, 'at 900 px the transport covers the row').toBeGreaterThan(10);
  } finally {
    await lab.close();
  }
});
