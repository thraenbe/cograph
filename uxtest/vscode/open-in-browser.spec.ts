// Tier B: Open in browser from the real panel in real VS Code (src/browserView).
//   npm run uxtest:vscode -- --repo click --scenario open-in-browser
// The button click goes through the real extension host: openInBrowser starts the loopback server and
// calls vscode.env.openExternal. Electron's shell.openExternal is replaced in VS Code's main process by a
// recorder, so nothing opens on the desktop, and Playwright's Chromium opens the URL. The tab must show
// the panel's graph, the panel must count the tab, and a tab's expand must reach the host.
import { test, expect, chromium } from '@playwright/test';
import * as path from 'path';
import type { ElectronApplication } from '@playwright/test';
import { launchVsCode } from './launch';
import { runCommand, waitForGraph } from './drive';
import { SkipStep } from '../lib/step';

const repo = (process.env.UXTEST_REPOS ?? 'click').split(',')[0].trim();

/** In VS Code's main process: shell.openExternal records instead of opening the desktop browser. */
async function recordExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as any;
    g.__openedUrls = [];
    shell.openExternal = async (url: string) => { g.__openedUrls.push(url); };
  });
}

const openedUrl = (app: ElectronApplication): Promise<string> =>
  app.evaluate(() => ((globalThis as any).__openedUrls as string[])[0] ?? '');

test(`vscode open-in-browser · ${repo}`, async () => {
  test.setTimeout(6 * 60 * 1000);
  const s = await launchVsCode(repo, 'open-in-browser');
  await recordExternal(s.app);
  const { page, ux, graphFrame } = s;
  const browser = await chromium.launch();
  let url = '';
  try {
    await ux.step('Visualize: the panel shows the graph', async () => {
      await page.waitForTimeout(2500);
      await runCommand(page, 'CoGraph: Visualize Project');
      await waitForGraph(graphFrame, 180000, true);
    }, { settle: false, metrics: false });

    await ux.step('Click "Open in browser" in the panel → openExternal with the tokened loopback URL, toast', async () => {
      const f = await graphFrame();
      if (!f) { throw new Error('no webview'); }
      const button = f.locator('#btn-open-browser');
      if (await button.count() === 0) { throw new SkipStep('no Open in browser button in this panel'); }
      // A locator click: the panel still grows as the legend arrives, and a click at measured coordinates misses.
      await button.click();
      await expect.poll(() => openedUrl(s.app), { timeout: 20000 }).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/\?token=[0-9a-f]{64}$/);
      url = await openedUrl(s.app);
      await expect(page.locator('.notifications-toasts').getByText('Graph opened in your browser')).toBeVisible({ timeout: 10000 });
      expect(await page.locator('.notifications-toasts').innerText()).not.toMatch(/[0-9a-f]{64}/);
    }, { settle: false, metrics: false });

    await ux.step('The tab renders the panel graph; the panel says "Browser: 1 tab"', async () => {
      const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors: string[] = [];
      tab.on('pageerror', e => errors.push(e.message));
      await tab.goto(url);
      await tab.waitForFunction(() => document.querySelectorAll('#graph path.cloud-node, #graph circle.regular-node').length > 0, undefined, { timeout: 60000 });
      const f = await graphFrame();
      await expect.poll(async () => (f ? await f.locator('#browser-status').innerText().catch(() => '') : ''), { timeout: 10000 }).toBe('Browser: 1 tab');
      // Expand in the tab: Detail 1 opens the folders; the host parses them and the tab gets the functions.
      await tab.evaluate(() => {
        const sl = document.getElementById('slider-complexity') as HTMLInputElement;
        sl.value = '1';
        sl.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await tab.waitForFunction(() => document.querySelectorAll('#graph circle.regular-node').length > 20, undefined, { timeout: 60000 });
      await tab.screenshot({ path: path.join(s.outDir, 'browser-tab.png') });
      expect(errors).toEqual([]);
      await tab.close();
    }, { settle: false, metrics: false });

    await ux.step('Tab closed → the panel says "Browser: not connected"', async () => {
      const f = await graphFrame();
      await expect.poll(async () => (f ? await f.locator('#browser-status').innerText().catch(() => '') : ''), { timeout: 10000 }).toBe('Browser: not connected');
    }, { settle: false, metrics: false });
  } finally {
    await browser.close();
    const run = await s.close();
    expect(run.steps.filter(x => x.status === 'failed').map(x => `${x.index}. ${x.name}: ${x.note}`)).toEqual([]);
  }
});
