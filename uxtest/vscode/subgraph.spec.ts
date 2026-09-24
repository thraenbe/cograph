// Tier B round 3 (session-178): the two host-side entry points into a subgraph scope.
//   1. palette command "CoGraph: Only visualize folder…" → QuickPick over the folders → unsaved scoped view titled
//      "<basename> · scoped"; only that folder's frames in the webview; Filters section lists the excluded folders.
//   2. sidebar "⊂ Create new Subgraph" → #subgraph-picker (tree of folders with checkboxes) → Create posts
//      subgraph-create {name, include}; the host writes .cograph/<name>.json, opens it, and the saved-graph list
//      shows a `.graph-card.subgraph` card.
// Every step skips (never fails) on a branch without the command / the picker.
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type { Frame } from '@playwright/test';
import { launchVsCode, within } from './launch';
import { answerQuickInput, frameBackground, frameSetSlider, runCommand, waitForGraph } from './drive';
import { SkipStep, StepFinding } from '../lib/step';
import { SEL } from '../selectors';

const repos = (process.env.UXTEST_REPOS ?? 'click,zod').split(',').map(s => s.trim()).filter(Boolean);
const SRC = /\.(py|ts|js|java|c|cc|cpp|h|hpp)$/;
const SKIP_DIR = /^(node_modules|\.git|dist|out|build|docs?|examples?)$/;

/** Top-level folders of the workspace copy that hold source, biggest first. */
function topFolders(root: string): Array<{ name: string; files: number }> {
  const count = (dir: string, depth: number): number => {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP_DIR.test(e.name)) { continue; }
      if (e.isDirectory()) { if (depth < 6) { n += count(path.join(dir, e.name), depth + 1); } } else if (SRC.test(e.name)) { n++; }
    }
    return n;
  };
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIR.test(e.name))
    .map(e => ({ name: e.name, files: count(path.join(root, e.name), 1) }))
    .filter(f => f.files > 0).sort((a, b) => b.files - a.files);
}

async function renderedTops(f: Frame, root: string): Promise<string[]> {
  return within(f.evaluate((root) => [...new Set([...document.querySelectorAll('#graph g.frame, #graph g.folder-bubble')]
    .map(g => { const d = (g as unknown as { __data__?: { path?: string; folderPath?: string } }).__data__ ?? {}; return String(d.path ?? d.folderPath ?? ''); })
    .filter(p => p.startsWith(root + '/')).map(p => p.slice(root.length + 1).split('/')[0]))], root), 8000, [] as string[]);
}

/** Reveal the CoGraph view (activity bar) and find the webview frame that holds `css`. */
async function sidebarFrame(page: import('@playwright/test').Page, css: string): Promise<Frame | null> {
  const icon = page.locator('.activitybar .action-item a[aria-label*="Cograph" i]').first();
  if (await icon.count() > 0) { await icon.click(); }
  for (let attempt = 0; attempt < 16; attempt++) {
    await page.waitForTimeout(500);
    for (const f of page.frames()) {
      if (!f.url().startsWith('vscode-webview://')) { continue; }
      if (await within(f.locator(css).first().count(), 1500, 0) > 0) { return f; }
    }
  }
  return null;
}

for (const repo of repos) {
  test(`vscode subgraph · ${repo}`, async () => {
    test.setTimeout(10 * 60 * 1000);
    const s = await launchVsCode(repo, 'subgraph');
    const { page, ux, graphFrame, workspace } = s;
    const tops = topFolders(workspace);
    const pick = tops[0]?.name ?? null;
    const activeTitle = async (): Promise<string> => (await page.locator('.tabs-container .tab.active').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    try {
      await ux.step('VS Code started with the repo (copy) open', async () => { await page.waitForTimeout(2500); }, { metrics: false });

      const cmd = await ux.step(`Palette → "CoGraph: Only visualize folder…" → pick ${pick ?? '(no folder)'}`, async () => {
        if (!pick) { throw new SkipStep('the repo has no top-level source folder'); }
        await runCommand(page, 'CoGraph: Only visualize folder');
        const answered = await answerQuickInput(page, pick, 8000, pick);
        if (!answered) { throw new StepFinding({ rule: 'scope-picker-missing', severity: 'high', ref: 'round3 cmd', message: 'the command opened no QuickPick within 8 s' }); }
        await waitForGraph(graphFrame, 120000, true);
      }, { settle: false, metrics: false });
      if (cmd.status !== 'ok') { return; }

      const title = await ux.step('Panel title reads "<folder> · scoped" (unsaved, not dirty)', async () => {
        await page.waitForTimeout(800);
        const t = await activeTitle();
        ux.steps[ux.steps.length - 1].note = `tab title "${t}"`;
        if (!t.includes(`${pick} · scoped`)) { throw new StepFinding({ rule: 'scope-title', severity: 'medium', ref: 'round3 cmd', message: `expected "${pick} · scoped", tab reads "${t}"` }); }
        if (t.startsWith('●')) { throw new StepFinding({ rule: 'scope-dirty-on-open', severity: 'low', ref: 'round3 cmd', message: 'a freshly scoped view is marked dirty' }); }
      }, { metrics: false, settle: false });
      void title;

      await ux.step('Only the picked folder\'s frames are rendered (Detail 1)', async () => {
        const f = await graphFrame();
        if (!f) { throw new Error('no webview'); }
        await frameSetSlider(f, SEL.detailSlider.css, 1); // the panel opens collapsed (one root glyph): frames exist only at full detail
        await page.waitForTimeout(2500);
        const bg = await frameBackground(f);
        if (bg) { await page.mouse.move(bg.x, bg.y, { steps: 8 }); await page.mouse.dblclick(bg.x, bg.y); await page.waitForTimeout(800); }
        const rendered = await renderedTops(f, workspace);
        const stray = rendered.filter(t => t !== pick);
        ux.steps[ux.steps.length - 1].note = `rendered top-level folders: ${rendered.join(', ') || '(none)'}`;
        if (stray.length) { throw new StepFinding({ rule: 'scope-leak', severity: 'high', ref: 'round3 cmd', message: `frames outside the scope: ${stray.join(', ')}` }); }
        if (!rendered.includes(pick as string)) { throw new StepFinding({ rule: 'scope-empty', severity: 'high', ref: 'round3 cmd', message: `no frame of ${pick} rendered` }); }
      });

      await ux.step('Filters section lists the excluded folders with a Visualize action', async () => {
        const f = await graphFrame();
        if (!f) { throw new Error('no webview'); }
        const others = tops.slice(1).map(t => t.name);
        if (!others.length) { throw new SkipStep('single top-level source folder: nothing excluded'); }
        const rows = f.locator(SEL.subgraphRow.css);
        const n = await within(rows.count(), 5000, 0);
        if (n === 0) { throw new StepFinding({ rule: 'scope-rows-missing', severity: 'high', ref: 'round3 W4', message: `no ${SEL.subgraphRow.css} rows for ${others.length} excluded folder(s)` }); }
        const texts = await within(rows.allInnerTexts(), 5000, [] as string[]);
        const vis = await within(f.locator(SEL.subgraphVisualize.css).count(), 3000, 0);
        ux.steps[ux.steps.length - 1].note = `${n} row(s), ${vis} Visualize action(s): ${texts.map(t => t.replace(/\s+/g, ' ').trim()).slice(0, 5).join(' | ')}`;
        const missing = others.filter(o => !texts.some(t => t.includes(o)));
        if (missing.length) { throw new StepFinding({ rule: 'scope-rows-incomplete', severity: 'medium', ref: 'round3 W4', message: `excluded folders without a row: ${missing.join(', ')}` }); }
      }, { metrics: false, settle: false });

      await ux.step('Visualize on an excluded folder → its frames come in, panel marked dirty', async () => {
        const f = await graphFrame();
        if (!f) { throw new Error('no webview'); }
        const others = tops.slice(1).map(t => t.name);
        if (!others.length) { throw new SkipStep('nothing excluded'); }
        const btn = f.locator(SEL.subgraphVisualize.css).first();
        if (await within(btn.count(), 3000, 0) === 0) { throw new SkipStep(`no ${SEL.subgraphVisualize.css}`); }
        const rowText = (await within(btn.locator('xpath=ancestor::*[contains(@class,"subgraph-row")]').first().innerText(), 2000, '')).replace(/\s+/g, ' ').trim();
        await btn.click();
        await page.waitForTimeout(4000); // patch lands (cached) or a lazy parse for uncached files
        const bg = await frameBackground(f);
        if (bg) { await page.mouse.move(bg.x, bg.y, { steps: 8 }); await page.mouse.dblclick(bg.x, bg.y); await page.waitForTimeout(800); }
        const rendered = await renderedTops(f, workspace);
        const entered = others.find(o => rowText.includes(o)) ?? null;
        const t = await activeTitle();
        ux.steps[ux.steps.length - 1].note = `clicked Visualize on "${rowText}" (folder ${entered ?? '?'}); rendered now: ${rendered.join(', ')}; title "${t}"`;
        if (entered && !rendered.includes(entered)) { throw new StepFinding({ rule: 'scope-include-not-rendered', severity: 'high', ref: 'round3 W4', message: `after Visualize ${entered} its frame is not rendered` }); }
        if (!t.startsWith('●')) { throw new StepFinding({ rule: 'scope-include-not-dirty', severity: 'low', ref: 'round3 host', message: `include did not mark the panel dirty (title "${t}")` }); }
      });

      await ux.step('Exit subgraph → title back to "CoGraph", other folders rendered', async () => {
        const f = await graphFrame();
        if (!f) { throw new Error('no webview'); }
        const exit = f.locator(SEL.subgraphExit.css).first();
        if (await within(exit.count(), 3000, 0) === 0) { throw new SkipStep(`no ${SEL.subgraphExit.css}`); }
        await exit.click();
        await page.waitForTimeout(2500);
        const t = await activeTitle();
        const rendered = await renderedTops(f, workspace);
        ux.steps[ux.steps.length - 1].note = `title "${t}", rendered: ${rendered.join(', ')}`;
        if (t.includes('scoped')) { throw new StepFinding({ rule: 'scope-exit-title', severity: 'medium', ref: 'round3 cmd', message: `title still "${t}" after Exit` }); }
        const missing = tops.map(x => x.name).filter(x => !rendered.includes(x));
        if (missing.length) { throw new StepFinding({ rule: 'scope-exit-incomplete', severity: 'high', ref: 'round3 W4', message: `after Exit still missing: ${missing.join(', ')}` }); }
      });

      // ---- sidebar picker --------------------------------------------------------------------------------
      let side: Frame | null = null;
      const NAME = 'uxtest-sub';
      const picker = await ux.step('Sidebar → "⊂ Create new Subgraph" opens the picker', async () => {
        side = await sidebarFrame(page, SEL.sidebarNewSubgraph.css);
        if (!side) { throw new SkipStep(`no sidebar frame with ${SEL.sidebarNewSubgraph.css}`); }
        await side.locator(SEL.sidebarNewSubgraph.css).first().click();
        const p = side.locator(SEL.subgraphPicker.css).first();
        await p.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { throw new StepFinding({ rule: 'subgraph-picker-missing', severity: 'high', ref: 'round3 sidebar', message: `${SEL.subgraphPicker.css} did not appear` }); });
        const picking = await within(side.locator('#body-graphs.picking').count(), 2000, 0);
        const hiddenList = await within(side.locator('#graph-list').first().isHidden(), 2000, false);
        ux.steps[ux.steps.length - 1].note = `#body-graphs.picking ${picking > 0}, #graph-list hidden ${hiddenList}`;
        if (!hiddenList) { throw new StepFinding({ rule: 'picker-list-visible', severity: 'low', ref: 'round3 sidebar', message: 'the saved-graph list stays visible behind the picker' }); }
      }, { metrics: false, settle: false });
      if (picker.status !== 'ok' || !side) { return; }
      const sb = side as Frame;

      await ux.step(`Pick ${pick} (checkbox), name it, Create → subgraph card + scoped panel`, async () => {
        const row = sb.locator(`${SEL.subgraphPickerRow.css}[data-rel="${pick}"]`).first();
        if (await within(row.count(), 3000, 0) === 0) { throw new StepFinding({ rule: 'picker-row-missing', severity: 'high', ref: 'round3 sidebar', message: `no .sp-row[data-rel="${pick}"]` }); }
        await row.locator(SEL.subgraphPickerCheck.css).first().click();
        const childLocked = await within(sb.locator(`${SEL.subgraphPickerRow.css}.locked`).count(), 2000, 0);
        await sb.locator(SEL.subgraphPickerName.css).first().fill(NAME);
        await sb.locator(SEL.subgraphPickerCreate.css).first().click();
        await waitForGraph(graphFrame, 120000, true);
        await page.waitForTimeout(1500);
        const card = sb.locator(`${SEL.subgraphCard.css}[data-name="${NAME}"], ${SEL.subgraphCard.css}`).filter({ hasText: NAME }).first();
        const hasCard = await within(card.count(), 5000, 0) > 0;
        const desc = hasCard ? await within(card.locator('.card-desc').first().innerText(), 2000, '') : '';
        const t = await activeTitle();
        const file = path.join(workspace, '.cograph', `${NAME}.json`);
        ux.steps[ux.steps.length - 1].note = `locked descendants after the check: ${childLocked}; card ${hasCard} ("${desc.trim()}"); title "${t}"; file ${fs.existsSync(file)}`;
        if (!fs.existsSync(file)) { throw new StepFinding({ rule: 'subgraph-not-saved', severity: 'high', ref: 'round3 sidebar', message: `Create did not write ${file}` }); }
        if (!hasCard) { throw new StepFinding({ rule: 'subgraph-card-missing', severity: 'medium', ref: 'round3 sidebar', message: `no ${SEL.subgraphCard.css} for ${NAME}` }); }
        if (!/Subgraph/.test(desc)) { throw new StepFinding({ rule: 'subgraph-card-desc', severity: 'low', ref: 'round3 sidebar', message: `card description "${desc.trim()}" does not read "Subgraph · N folders"` }); }
        if (!t.includes(NAME)) { throw new StepFinding({ rule: 'subgraph-title', severity: 'medium', ref: 'round3 sidebar', message: `panel title "${t}" is not the subgraph name` }); }
        const f = await graphFrame();
        const rendered = f ? await renderedTops(f, workspace) : [];
        const stray = rendered.filter(x => x !== pick);
        if (stray.length) { throw new StepFinding({ rule: 'scope-leak', severity: 'high', ref: 'round3 sidebar', message: `opened subgraph renders frames outside it: ${stray.join(', ')}` }); }
      });

      await ux.step('Picker keyboard: Escape cancels, list comes back', async () => {
        await sb.locator(SEL.sidebarNewSubgraph.css).first().click();
        await sb.locator(SEL.subgraphPicker.css).first().waitFor({ state: 'visible', timeout: 5000 });
        await sb.locator('#sp-tree').first().focus();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        const gone = await within(sb.locator(SEL.subgraphPicker.css).first().isHidden(), 2000, false);
        const listBack = await within(sb.locator('#graph-list').first().isVisible(), 2000, false);
        ux.steps[ux.steps.length - 1].note = `picker hidden ${gone}, list visible ${listBack}`;
        if (!gone || !listBack) { throw new StepFinding({ rule: 'picker-escape', severity: 'low', ref: 'round3 sidebar', message: 'Escape did not close the picker / restore the list' }); }
      }, { metrics: false, settle: false });
    } finally {
      await s.close();
    }
  });
}
