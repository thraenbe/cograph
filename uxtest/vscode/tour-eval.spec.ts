// Tier B, the PR tour's evaluation run with AI on (the plan's pre-registered gate): real VS Code, the
// private package from COGRAPH_TOUR_PACKAGE, Graph Intelligence on (Claude Code), tour.ai.mode 'on'.
// Each target is toured the way a person starts it - a pull request from the Version Control pane's
// Tour button (filter All, so merged ones are listed), a branch from "CoGraph: Tour Your Branch" - and
// the cached script JSON is copied out. A running total of script.ai.costUsd is kept in
// <out>/spent.json; a tour that could push it past UXTEST_EVAL_CAP_USD is not started.
//   COGRAPH_TOUR_PACKAGE=<pkg> UXTEST_REPOS=<workspace> UXTEST_EVAL_OUT=<dir> UXTEST_EVAL_TARGETS=pr:96,pr:97|branch
//   UXTEST_EVAL_NAMES=pr-96,pr-97|branch-click [UXTEST_EVAL_BUDGET_USD=0.12] [UXTEST_EVAL_CAP_USD=1]
//   npm run uxtest:vscode -- --grep tour-eval
import { test, chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type { ElectronApplication, Frame, Page } from '@playwright/test';
import { launchVsCode } from './launch';
import { runCommand } from './drive';

const repo = process.env.UXTEST_REPOS ?? '';
const out = process.env.UXTEST_EVAL_OUT ?? '';
const targets = (process.env.UXTEST_EVAL_TARGETS ?? '').split(',').filter(Boolean);
const names = (process.env.UXTEST_EVAL_NAMES ?? '').split(',').filter(Boolean);
const budget = Number(process.env.UXTEST_EVAL_BUDGET_USD ?? 0.12);
const cap = Number(process.env.UXTEST_EVAL_CAP_USD ?? 1);
const TOUR_TIMEOUT_MS = 10 * 60 * 1000;

interface Spent { totalUsd: number; tours: Record<string, number | null> }
const spentFile = () => path.join(out, 'spent.json');
const readSpent = (): Spent => (fs.existsSync(spentFile()) ? JSON.parse(fs.readFileSync(spentFile(), 'utf8')) : { totalUsd: 0, tours: {} });

async function recordExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as any;
    g.__tourUrls = [];
    shell.openExternal = async (url: string) => { g.__tourUrls.push(url); };
  });
}
/** The tour page as a reviewer sees it, at chapter 3 (key 3 jumps there), into <out>/<file>. */
async function shootChapter3(url: string, file: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url);
    await page.evaluate(() => (window as any).stageApi.ready());
    await page.waitForTimeout(2500);
    await page.keyboard.press('3');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: file });
  } finally {
    await browser.close();
  }
}
const lastUrl = async (app: ElectronApplication) => (await app.evaluate(() => (globalThis as any).__tourUrls as string[])).filter(u => u.includes('/tour/')).pop();
const urlCount = async (app: ElectronApplication) => ((await app.evaluate(() => (globalThis as any).__tourUrls as string[])).filter(u => u.includes('/tour/')).length);

/** Every cached tour script under the window's global storage. */
function scripts(userDataDir: string): string[] {
  const outFiles: string[] = [];
  const walk = (d: string, depth: number) => {
    let list: fs.Dirent[] = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 8) { walk(p, depth + 1); }
      else if (e.isFile() && e.name.endsWith('.json') && p.includes(`${path.sep}.cograph${path.sep}tour${path.sep}`)) { outFiles.push(p); }
    }
  };
  walk(path.join(userDataDir, 'User', 'globalStorage'), 0);
  return outFiles;
}

async function toasts(page: Page): Promise<string[]> {
  return page.locator('.notifications-toasts .notification-list-item-message').allInnerTexts().catch(() => []);
}

async function sidebarFrame(page: Page): Promise<Frame | null> {
  for (const f of page.frames()) {
    if (!f.url().startsWith('vscode-webview://')) { continue; }
    if (await f.evaluate(() => !!document.getElementById('hdr-vcs')).catch(() => false)) { return f; }
  }
  return null;
}

async function startPr(page: Page, num: string): Promise<void> {
  let side = await sidebarFrame(page);
  if (!side) {
    await page.locator('.activitybar [aria-label*="CoGraph" i], .activitybar [aria-label*="Cograph" i]').first().click();
    for (let i = 0; i < 60 && !side; i++) { await page.waitForTimeout(500); side = await sidebarFrame(page); }
  }
  if (!side) { throw new Error('no Version Control pane'); }
  const row = side.locator(`.vcs-pr[data-number="${num}"]`);
  if (!(await row.count())) {
    await side.locator('.vcs-tools button', { hasText: 'All' }).click();
    await row.waitFor({ state: 'visible', timeout: 60_000 });
  }
  await row.locator('button.vcs-tour').click();
}

test('tour-eval', async () => {
  test.skip(!repo || !out || !targets.length || !process.env.COGRAPH_TOUR_PACKAGE, 'needs UXTEST_REPOS, UXTEST_EVAL_OUT, UXTEST_EVAL_TARGETS, COGRAPH_TOUR_PACKAGE');
  test.setTimeout(targets.length * TOUR_TIMEOUT_MS + 5 * 60 * 1000);
  fs.mkdirSync(out, { recursive: true });
  const s = await launchVsCode(repo, 'tour-eval', {
    'cograph.graphIntelligence.enabled': true, 'cograph.graphIntelligence.provider': 'claude-code',
    'cograph.tour.ai.mode': process.env.UXTEST_EVAL_AI === 'off' ? 'off' : 'on', 'cograph.tour.ai.maxBudgetUsd': budget, 'cograph.tour.ai.model': 'inherit',
  });
  await recordExternal(s.app);
  const results: Record<string, unknown>[] = [];
  try {
    await s.page.waitForTimeout(3000);
    for (const [i, target] of targets.entries()) {
      const name = names[i] ?? target.replace(':', '-');
      const spent = readSpent();
      if (spent.totalUsd + budget > cap) { results.push({ name, skipped: `spent $${spent.totalUsd.toFixed(4)}; the next tour could pass $${cap}` }); continue; }
      const before = new Set(scripts(s.userDataDir));
      const opened = await urlCount(s.app);
      const t0 = Date.now();
      await s.ux.step(`Tour ${name}`, async () => {
        if (target === 'branch') { await runCommand(s.page, 'CoGraph: Tour Your Branch'); } else { await startPr(s.page, target.split(':')[1]); }
      });
      let file: string | undefined;
      let openedAt = 0;
      while (Date.now() - t0 < TOUR_TIMEOUT_MS) {
        file = scripts(s.userDataDir).find(f => !before.has(f));
        const isOpen = (await urlCount(s.app)) > opened;
        if (file && isOpen) { break; }
        // Opened without a cached script: the host caches only when an AI reply was valid (or AI is off).
        if (isOpen && !openedAt) { openedAt = Date.now(); }
        if (openedAt && Date.now() - openedAt > 20_000) { break; }
        await s.page.waitForTimeout(1000);
      }
      const seconds = Math.round((Date.now() - t0) / 1000);
      await s.page.screenshot({ path: path.join(s.outDir, `${name}.png`) });
      if (!file) { results.push({ name, failed: openedAt ? 'opened, but no cached script (no valid AI reply)' : 'no cached script', seconds, toasts: await toasts(s.page) }); continue; }
      fs.copyFileSync(file, path.join(out, `${name}.json`));
      const script = JSON.parse(fs.readFileSync(file, 'utf8'));
      const cost = script.ai?.costUsd ?? null;
      spent.tours[name] = cost;
      spent.totalUsd = Math.round((spent.totalUsd + (typeof cost === 'number' ? cost : budget)) * 10000) / 10000;
      fs.writeFileSync(spentFile(), JSON.stringify(spent, null, 2));
      results.push({ name, seconds, cost, opened: (await urlCount(s.app)) > opened, toasts: await toasts(s.page) });
      const url = await lastUrl(s.app);
      if (process.env.UXTEST_EVAL_SHOT && url && !fs.existsSync(path.join(out, process.env.UXTEST_EVAL_SHOT))) {
        await shootChapter3(url, path.join(out, process.env.UXTEST_EVAL_SHOT)).catch((e) => results.push({ name, screenshotFailed: String(e) }));
      }
    }
  } finally {
    fs.writeFileSync(path.join(out, `run-${path.basename(repo)}-${Date.now()}.json`), JSON.stringify({ repo, targets, results }, null, 2));
    console.log('TOUR-EVAL', JSON.stringify(results));
    await s.close();
    for (const f of fs.readdirSync(s.outDir).filter(f => f === 'vscode-output.log')) {
      fs.copyFileSync(path.join(s.outDir, f), path.join(out, `vscode-output-${path.basename(repo)}${process.env.UXTEST_EVAL_SUFFIX ?? ''}.log`));
    }
  }
});
