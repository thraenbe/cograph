// Tier B: Open in browser from the real panel in real VS Code (src/browserView).
//   npm run uxtest:vscode -- --repo click --scenario open-in-browser
// The button click goes through the real extension host: openInBrowser starts the loopback server and
// calls vscode.env.openExternal. On Linux that runs xdg-open; a stand-in first on PATH records the URL
// instead of opening the developer's own browser, and Playwright's Chromium opens it. The tab must show
// the panel's graph, the panel must count the tab, and a tab's expand must reach the host.
import { test, expect, chromium } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchVsCode } from './launch';
import { frameElementCenter, runCommand, waitForGraph } from './drive';
import { SkipStep } from '../lib/step';

const repo = (process.env.UXTEST_REPOS ?? 'click').split(',')[0].trim();

/** A fake xdg-open (and sensible-browser) that appends the URL to `log` and exits 0. */
function fakeOpener(): { bin: string; log: string } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-opener-'));
  const log = path.join(bin, 'opened.txt');
  for (const name of ['xdg-open', 'sensible-browser', 'x-www-browser', 'gio']) {
    const script = name === 'gio' ? `#!/bin/sh\n[ "$1" = open ] && shift\nprintf '%s\\n' "$1" >> '${log}'\n` : `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\n`;
    fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  }
  return { bin, log };
}

test(`vscode open-in-browser · ${repo}`, async () => {
  test.setTimeout(6 * 60 * 1000);
  const opener = fakeOpener();
  const savedPath = process.env.PATH;
  const savedBrowser = process.env.BROWSER;
  process.env.PATH = `${opener.bin}${path.delimiter}${savedPath ?? ''}`;
  process.env.BROWSER = path.join(opener.bin, 'xdg-open');
  const s = await launchVsCode(repo, 'open-in-browser');
  process.env.PATH = savedPath;
  if (savedBrowser === undefined) { delete process.env.BROWSER; } else { process.env.BROWSER = savedBrowser; }
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
      const c = await frameElementCenter(f, '#btn-open-browser');
      if (!c) { throw new SkipStep('no Open in browser button in this panel'); }
      await page.mouse.move(c.x, c.y, { steps: 10 });
      await page.mouse.click(c.x, c.y);
      await expect.poll(() => (fs.existsSync(opener.log) ? fs.readFileSync(opener.log, 'utf8').trim() : ''), { timeout: 20000 }).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+\/\?token=[0-9a-f]{64}$/);
      url = fs.readFileSync(opener.log, 'utf8').trim().split('\n')[0];
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
    fs.rmSync(opener.bin, { recursive: true, force: true });
    expect(run.steps.filter(x => x.status === 'failed').map(x => `${x.index}. ${x.name}: ${x.note}`)).toEqual([]);
  }
});
