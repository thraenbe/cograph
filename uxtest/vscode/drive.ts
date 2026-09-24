// Workbench driving helpers for Tier B (command palette, quick input, webview frame).
import type { Frame, Page } from '@playwright/test';
import { SkipStep } from '../lib/step';
import { setCaption } from '../lib/overlay';

const QUICK = '.quick-input-widget';

/** Try several titles of one command (it was renamed between branches); the first one in the palette wins. */
export async function runCommandAny(page: Page, titles: string[]): Promise<string> {
  let last: unknown = null;
  for (const t of titles) {
    try { await runCommand(page, t); return t; }
    catch (err) { if (!(err instanceof SkipStep)) { throw err; } last = err; }
  }
  throw last;
}

/** F1 → type the command title → Enter. */
export async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('F1');
  const input = page.locator(`${QUICK} input.input`).first();
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.fill(`>${title}`);
  const row = page.locator(`${QUICK} .quick-input-list .monaco-list-row`).first();
  await row.waitFor({ state: 'visible', timeout: 10000 });
  const label = (await row.innerText()).replace(/\s+/g, ' ');
  if (!label.toLowerCase().includes(title.toLowerCase().slice(0, 12))) {
    await page.keyboard.press('Escape');
    throw new SkipStep(`command not in the palette: "${title}" (top hit: "${label.slice(0, 60)}")`);
  }
  await page.keyboard.press('Enter');
}

/** Answer an InputBox / QuickPick if one opens within `waitMs`; returns whether it did.
 *  `expectRow`: wait until a result row containing this text is listed before pressing Enter (Quick Open is async). */
export async function answerQuickInput(page: Page, text: string, waitMs = 4000, expectRow?: string): Promise<boolean> {
  const input = page.locator(`${QUICK} input.input`).first();
  try { await input.waitFor({ state: 'visible', timeout: waitMs }); } catch { return false; }
  await page.waitForTimeout(250); // a command that re-opens the widget (Go to File) swaps its mode first
  await input.fill(text);
  if (expectRow) {
    await page.locator(`${QUICK} .quick-input-list .monaco-list-row`).filter({ hasText: expectRow }).first().waitFor({ state: 'visible', timeout: 15000 });
  }
  await page.keyboard.press('Enter');
  return true;
}

export async function waitForGraph(getFrame: () => Promise<Frame | null>, timeoutMs: number, needNodes: boolean): Promise<{ frame: Frame; ms: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const f = await getFrame();
    if (f) {
      const n = await f.evaluate('typeof state !== "undefined" && state.currentNodes ? state.currentNodes.length : 0').catch(() => 0) as number;
      if (!needNodes || n > 0) { return { frame: f, ms: Date.now() - t0 }; }
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`CoGraph webview ${needNodes ? 'showed no nodes' : 'did not appear'} within ${timeoutMs} ms`);
}

/** Frame-local element centre → window coordinates (nested webview iframes have offsets). */
export async function frameElementCenter(frame: Frame, css: string): Promise<{ x: number; y: number } | null> {
  const loc = frame.locator(css).first();
  if (await loc.count() === 0) { return null; }
  const box = await loc.boundingBox(); // Playwright already reports main-window coordinates
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

export async function caption(page: Page, text: string): Promise<void> { await setCaption(page, text); }

/** Set a range input inside the webview frame and fire the events the webview listens to. */
export async function frameSetSlider(frame: Frame, css: string, value: number): Promise<void> {
  await frame.locator(css).first().evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

/** Window coordinates of an element of `css` that is really hittable inside the frame (not under a panel, on screen). */
export async function frameHittable(frame: Frame, css: string, minLeft = 0): Promise<{ x: number; y: number } | null> {
  const index = await frame.evaluate(([sel, left]) => {
    const els = [...document.querySelectorAll(sel as string)];
    for (let i = 0; i < els.length; i++) {
      const b = els[i].getBoundingClientRect();
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      if (b.width < 2 || x < (left as number) || x > window.innerWidth - 10 || y < 10 || y > window.innerHeight - 60) { continue; }
      if (document.elementFromPoint(x, y) === els[i]) { return i; }
    }
    return -1;
  }, [css, minLeft]);
  if (index < 0) { return null; }
  const box = await frame.locator(css).nth(index).boundingBox();
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

/** A bare-canvas point of the webview in window coordinates (for the double-click fit). */
export async function frameBackground(frame: Frame): Promise<{ x: number; y: number } | null> {
  const local = await frame.evaluate(() => {
    const svg = document.querySelector('#graph svg');
    if (!svg) { return null; }
    for (let gy = 1; gy < 16; gy++) {
      for (let gx = 23; gx >= 6; gx--) {
        const x = Math.round((gx / 24) * window.innerWidth), y = Math.round((gy / 16) * window.innerHeight);
        if (document.elementFromPoint(x, y) === svg) { return { x, y }; }
      }
    }
    return null;
  });
  if (!local) { return null; }
  const origin = await frame.locator('body').boundingBox(); // frame origin in window coordinates
  return origin ? { x: origin.x + local.x, y: origin.y + local.y } : null;
}
