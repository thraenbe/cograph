// Tier B smoke: the real extension in real VS Code. Slow, headed, serial.
//   npm run uxtest:vscode -- --repo click
// Covers what the lab cannot: activation, analyzers + host, command palette, Ctrl+S keybinding,
// QuickInput, the sidebar view, editor navigation, on-save incremental re-parse, and B7.
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchVsCode } from './launch';
import { answerQuickInput, frameElementCenter, runCommand, waitForGraph } from './drive';
import { SkipStep } from '../lib/step';
import { SEL } from '../selectors';

const repos = (process.env.UXTEST_REPOS ?? 'click,express,zod').split(',').map(s => s.trim()).filter(Boolean);
const ADDED_FN: Record<string, string> = {
  '.py': '\n\ndef uxtest_added_function():\n    return 42\n',
  '.js': '\n\nfunction uxtestAddedFunction() { return 42; }\n',
  '.ts': '\n\nexport function uxtestAddedFunction(): number { return 42; }\n',
};

function firstSourceFile(root: string): string | null {
  const stack = [root];
  while (stack.length) {
    const dir = stack.shift() as string;
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || /^(node_modules|tests?|docs?|examples?)$/.test(e.name)) { continue; }
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); } else if (ADDED_FN[path.extname(e.name)] && fs.statSync(p).size > 400) { return p; }
    }
  }
  return null;
}

for (const repo of repos) {
  test(`vscode smoke · ${repo}`, async () => {
    test.setTimeout(8 * 60 * 1000);
    const s = await launchVsCode(repo, 'smoke');
    const { page, ux, graphFrame } = s;
    try {
      await ux.step('VS Code started with the repo (copy) open', async () => { await page.waitForTimeout(2500); }, { metrics: false });

      let tFirst = 0;
      const visualize = await ux.step('Command palette → CoGraph: Visualize Project', async () => {
        await runCommand(page, 'CoGraph: Visualize Project');
        tFirst = (await waitForGraph(graphFrame, 60000, false)).ms;
      }, { settle: false, metrics: false });
      const functions = await ux.step('Graph shows nodes (T_functions)', async () => {
        const t = await waitForGraph(graphFrame, 180000, true);
        visualize.note = `T_first ${tFirst} ms`;
        functions.note = `first nodes after ${t.ms} ms more`;
      });

      await ux.step('Panel still alive after 15 s (B7)', async () => {
        for (let i = 0; i < 15; i++) {
          await page.waitForTimeout(1000);
          if (!await graphFrame()) { throw new Error(`CoGraph panel vanished ${i + 1} s after the graph appeared (B7)`); }
        }
      });

      await ux.step('Fit (double-click background) inside the real webview', async () => {
        const f = await graphFrame();
        const c = f ? await frameElementCenter(f, SEL.settingsBtn.css) : null;
        if (!c) { throw new SkipStep('settings button not found in the webview'); }
        await page.mouse.dblclick(c.x - 140, c.y + 120);
      });

      await ux.step('Engine → Global → Shelf, Motion → Dynamic → Static (real panel)', async () => {
        const f = await graphFrame();
        if (!f) { throw new Error('no webview'); }
        for (const name of ['engineGlobal', 'engineShelf', 'motionDynamic', 'motionStatic'] as const) {
          const c = await frameElementCenter(f, SEL[name].css);
          if (!c) { throw new SkipStep(`${name} not found`); }
          await page.mouse.move(c.x, c.y, { steps: 10 });
          await page.mouse.click(c.x, c.y);
          await page.waitForTimeout(1200);
        }
      }, { stillTimeoutMs: 15000 });

      await ux.step('Click a function node → source popup from the real host', async () => {
        const f = await graphFrame();
        if (!f) { throw new Error('no webview'); }
        const c = await frameElementCenter(f, '#graph circle.regular-node');
        if (!c) { throw new SkipStep('no function node on screen'); }
        await page.mouse.move(c.x, c.y, { steps: 10 });
        await page.mouse.click(c.x, c.y);
        await expect(f.locator('.func-card').first()).toBeVisible({ timeout: 8000 });
        await expect(f.locator('.func-card .func-source-textarea').first()).not.toHaveValue('', { timeout: 8000 });
        await page.keyboard.press('Escape');
      }, { metrics: false });

      await ux.step('Ctrl+S → Save Graph (InputBox: "uxtest-eval")', async () => {
        const f = await graphFrame();
        const c = f ? await frameElementCenter(f, SEL.layoutHint.css) : null;
        if (c) { await page.mouse.click(c.x, c.y); } // focus the webview so the keybinding's when-clause holds
        await page.keyboard.press('Control+s');
        const asked = await answerQuickInput(page, 'uxtest-eval');
        await page.waitForTimeout(1500);
        const saved = fs.existsSync(path.join(s.workspace, '.cograph')) ? fs.readdirSync(path.join(s.workspace, '.cograph'), { recursive: true }).map(String) : [];
        if (!asked && !saved.length) { throw new Error('Ctrl+S neither asked for a name nor wrote anything under .cograph/'); }
      }, { metrics: false });

      await ux.step('CoGraph sidebar (activity bar) opens', async () => {
        const icon = page.locator('.activitybar .action-item a[aria-label*="Cograph" i]').first();
        if (await icon.count() === 0) { throw new SkipStep('activity bar icon not found'); }
        await icon.click();
        await page.waitForTimeout(2500);
      }, { metrics: false });

      await ux.step('On-save incremental re-parse: add a function, save, graph gains a node', async () => {
        const file = firstSourceFile(s.workspace);
        const f = await graphFrame();
        if (!file || !f) { throw new SkipStep('no editable source file / no webview'); }
        const before = await f.evaluate('state.graphData ? state.graphData.nodes.length : 0') as number;
        await page.keyboard.press('Control+p');
        await answerQuickInput(page, path.relative(s.workspace, file), 8000);
        await page.waitForTimeout(1500);
        await page.keyboard.press('Control+End');
        await page.keyboard.type(ADDED_FN[path.extname(file)], { delay: 5 });
        await page.keyboard.press('Control+s');
        await expect.poll(async () => {
          const g = await graphFrame();
          return g ? await g.evaluate('state.graphData ? state.graphData.nodes.length : 0') as number : 0;
        }, { timeout: 30000, message: `graph did not grow after saving ${path.relative(s.workspace, file)}` }).toBeGreaterThan(before);
      }, { metrics: false });

      await ux.step('Command palette → CoGraph: Open or Reload Layout', async () => { await runCommand(page, 'CoGraph: Open or Reload Layout'); await answerQuickInput(page, '', 2500); });
    } finally {
      const run = await s.close();
      expect(run.steps.filter(st => st.status === 'failed').map(st => `${st.index}. ${st.name}: ${st.note}`)).toEqual([]);
    }
  });
}
