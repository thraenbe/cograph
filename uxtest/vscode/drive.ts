// Workbench driving helpers for Tier B (command palette, quick input, webview frame).
import type { Frame, Page } from '@playwright/test';
import { SkipStep } from '../lib/step';
import { setCaption } from '../lib/overlay';

const QUICK = '.quick-input-widget';

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

/** Answer an InputBox / QuickPick if one opens within `waitMs`; returns whether it did. */
export async function answerQuickInput(page: Page, text: string, waitMs = 4000): Promise<boolean> {
  const input = page.locator(`${QUICK} input.input`).first();
  try { await input.waitFor({ state: 'visible', timeout: waitMs }); } catch { return false; }
  await input.fill(text);
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
