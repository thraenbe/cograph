// Tier B, the PR tour end to end (session tour-entry): real VS Code with the extension from source and the
// private tour package from COGRAPH_TOUR_PACKAGE, on a GitHub clone with a branch ahead of main. Runs "Tour
// your branch" from the palette, then "Tour this pull request…" on an open pull request, and loads each tour
// page in the lab's own Chromium. Electron's shell.openExternal is replaced in VS Code's main process by a
// recorder, so nothing opens on the desktop:
//   COGRAPH_TOUR_PACKAGE=<built private checkout> UXTEST_REPOS=<abs path of a GitHub clone on a branch ahead of main>
//   UXTEST_TOUR_PR=<open PR number> npm run uxtest:vscode -- --grep tour-e2e
import { test, expect, chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type { ElectronApplication, Frame, Page } from '@playwright/test';
import { launchVsCode } from './launch';
import { runCommand } from './drive';

const repo = process.env.UXTEST_REPOS ?? '';
const prNumber = process.env.UXTEST_TOUR_PR ?? '';

/** In VS Code's main process: shell.openExternal records instead of opening the desktop browser. */
async function recordExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as any;
    g.__tourUrls = [];
    shell.openExternal = async (url: string) => { g.__tourUrls.push(url); };
  });
}

async function nextUrl(app: ElectronApplication, seen: number, timeoutMs: number): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const lines = (await app.evaluate(() => (globalThis as any).__tourUrls as string[])).filter(u => u.includes('/tour/'));
    if (lines.length > seen) { return lines[lines.length - 1]; }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`no tour URL within ${timeoutMs} ms`);
}

/** The pull-request panel's webview (it carries the banner). */
async function prFrame(page: Page): Promise<Frame | null> {
  for (const f of page.frames()) {
    if (!f.url().startsWith('vscode-webview://')) { continue; }
    if (await f.evaluate(() => !!document.getElementById('pr-view-banner')).catch(() => false)) { return f; }
  }
  return null;
}

/** Load a tour page in a plain Chromium and report what a person would see. */
async function visit(url: string, shot: string) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(url);
    const facts = await page.evaluate(async () => {
      const w = window as any;
      const ready = await Promise.race([w.stageApi.ready().then(() => true), new Promise(r => setTimeout(() => r(false), 60_000))]);
      const cfg = w.COGRAPH_TOUR;
      const script = cfg ? await fetch(cfg.scriptUrl).then(r => r.json()).catch((e: Error) => ({ error: String(e) })) : null;
      return {
        ready, stageApi: w.stageApi?.version, nodes: w.stageApi?.nodes().length, tour: cfg && { tourId: cfg.tourId, theme: cfg.theme, stageRoot: !!cfg.stageRoot },
        tourJs: [...document.scripts].some(s => s.src.includes('/tour-assets/tour.js')),
        script: script && { version: script.version, chapters: (script.chapters || []).map((c: any) => `${c.id}:${(c.steps || []).length}`), summary: script.summary, security: script.security?.verdict },
      };
    });
    await page.screenshot({ path: shot });
    return { ...facts, errors };
  } finally {
    await browser.close();
  }
}

test('tour-e2e', async () => {
  test.skip(!repo || !process.env.COGRAPH_TOUR_PACKAGE, 'needs UXTEST_REPOS and COGRAPH_TOUR_PACKAGE');
  test.setTimeout(15 * 60 * 1000);
  const s = await launchVsCode(repo, 'tour-e2e');
  await recordExternal(s.app);
  const report: Record<string, unknown> = {};
  try {
    await s.ux.step('Tour your branch', async () => { await runCommand(s.page, 'CoGraph: Tour Your Branch'); });
    const branchUrl = await nextUrl(s.app, 0, 5 * 60 * 1000);
    report.branch = await visit(branchUrl, path.join(s.outDir, 'branch-tour.png'));
    report.branchPanel = !!(await prFrame(s.page));
    await s.page.screenshot({ path: path.join(s.outDir, 'branch-vscode.png') });
    if (prNumber) {
      await s.ux.step(`Tour pull request #${prNumber}`, async () => {
        await runCommand(s.page, 'CoGraph: Tour This Pull Request');
        // The pick fills once the open pull requests are listed (gh): wait for the row, then choose it.
        const row = s.page.locator('.quick-input-widget .quick-input-list .monaco-list-row', { hasText: `#${prNumber} ` }).first();
        await row.waitFor({ state: 'visible', timeout: 60_000 });
        await row.click();
      });
      const prUrl = await nextUrl(s.app, 1, 5 * 60 * 1000);
      report.pr = await visit(prUrl, path.join(s.outDir, 'pr-tour.png'));
      await s.page.screenshot({ path: path.join(s.outDir, 'pr-vscode.png') });
    }
  } finally {
    fs.writeFileSync(path.join(s.outDir, 'tour-e2e.json'), JSON.stringify(report, null, 2));
    console.log('TOUR-E2E', JSON.stringify(report));
    await s.close();
  }
  expect((report.branch as any).ready).toBe(true);
  expect((report.branch as any).tourJs).toBe(true);
  expect((report.branch as any).errors).toEqual([]);
});
