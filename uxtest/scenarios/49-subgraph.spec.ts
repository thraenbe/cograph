// 49 — round 3 W4 (session-111 + session-178): the host opens the panel inside a subgraph scope. Only the
// included folders' frames are rendered; the Filters section lists the excluded top-level folders with a
// Visualize action that posts `subgraph-include {path}`; "Exit subgraph" posts `subgraph-exit`. The FakeHost
// answers like the real host (scope re-sent, graph-patch for the entering folder). Gated on scope.js.
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { clickSel, ctxMenuClick, ctxMenuLabels, fitToView, locateFrame, rightClick, setSlider } from '../lib/actions';
import { SkipStep, StepFinding } from '../lib/step';
import { scopeFixture } from '../lib/fixtures';
import { SEL } from '../selectors';

scenario('subgraph', { perMotion: false, scope: scopeFixture }, async ({ page, ux, host, repo }) => {
  const sc = scopeFixture(repo);
  const gate = async (): Promise<void> => { if (!await page.evaluate('typeof frameFolderVisible === "function"')) { throw new SkipStep('round-3 scope.js not on this branch'); } };
  const renderedTops = (): Promise<string[]> => page.evaluate((root) => [...new Set([...document.querySelectorAll('#graph g.frame, #graph g.folder-bubble')]
    .map(g => String((g as unknown as { __data__?: { path?: string; folderPath?: string } }).__data__?.path ?? (g as unknown as { __data__?: { folderPath?: string } }).__data__?.folderPath ?? ''))
    .filter(p => p && p !== root && p.startsWith(root + '/')).map(p => p.slice(root.length + 1).split('/')[0]))], sc.root);

  await ux.step('Detail 0: the root glyph counts only in-scope files (e22c370)', async () => {
    await gate();
    await setSlider(page, 'detailSlider', 0);
    await page.waitForTimeout(1200);
    const counts = await page.evaluate(() => [...document.querySelectorAll('#graph text')].map(t => (t.textContent || '').trim()).map(t => /^(\d[\d,.]*)\s+files?$/.exec(t)).filter((m): m is RegExpExecArray => !!m).map(m => Number(m[1].replace(/[,.]/g, ''))));
    const folders = (repo.structure.folders ?? {}) as Record<string, { path?: string; fileCount?: number; totalFiles?: number }>;
    const inc = folders[`${sc.root}/${sc.include[0]}`] ?? Object.values(folders).find(f => f.path === `${sc.root}/${sc.include[0]}`);
    const structureCount = inc?.totalFiles ?? inc?.fileCount ?? null;
    const graphCount = new Set(repo.graph.nodes.map(n => n.file).filter((f): f is string => !!f && f.startsWith(`${sc.root}/${sc.include[0]}/`))).size;
    const total = repo.structure.totalFiles;
    ux.steps[ux.steps.length - 1].note = `glyph count(s): ${counts.join(', ') || '(none)'}; in-scope files: structure ${structureCount ?? '?'}, graph ${graphCount}; whole project ${total}`;
    if (!counts.length) { throw new SkipStep('no "N files" glyph label at Detail 0'); }
    const root = Math.max(...counts);
    if (root === total && total !== structureCount && total !== graphCount) { throw new StepFinding({ rule: 'scoped-glyph-counts-whole-project', severity: 'medium', ref: 'round3 e22c370', message: `root glyph says ${root} files (whole project) while scoped to ${sc.include[0]} (${structureCount ?? graphCount} files)` }); }
    if (root !== structureCount && root !== graphCount) { throw new StepFinding({ rule: 'scoped-glyph-count-mismatch', severity: 'low', ref: 'round3 e22c370', message: `root glyph says ${root} files; in-scope structure ${structureCount ?? '?'} / graph ${graphCount}` }); }
  }, { settle: false });

  await ux.step(`Opened inside scope "${sc.include[0]}" → only that folder's frames exist`, async () => {
    await gate();
    await setSlider(page, 'detailSlider', 1);
    await fitToView(page);
    const tops = await renderedTops();
    const stray = tops.filter(t => !sc.include.includes(t));
    ux.steps[ux.steps.length - 1].note = `rendered top-level folders: ${tops.join(', ') || '(none)'}; excluded per fixture: ${sc.excludedTop.join(', ') || '(none)'}`;
    if (stray.length) { throw new StepFinding({ rule: 'scope-leak', severity: 'high', ref: 'round3 W4', message: `frames rendered outside the scope: ${stray.join(', ')}` }); }
    if (!tops.length) { throw new StepFinding({ rule: 'scope-empty', severity: 'high', ref: 'round3 W4', message: `no frame of the included folder ${sc.include[0]} rendered` }); }
  });

  await ux.step('Filters section lists the excluded folders with counts + Visualize', async () => {
    await gate();
    if (!sc.excludedTop.length) { throw new SkipStep('the repo has a single top-level folder: nothing to exclude'); }
    if (await page.locator(SEL.folderFiltersBody.css).isHidden()) { await clickSel(page, 'folderFiltersToggle'); }
    const rows = page.locator(SEL.subgraphRow.css);
    if (await rows.count() === 0) { throw new StepFinding({ rule: 'scope-rows-missing', severity: 'high', ref: 'round3 W4', message: `no excluded-folder rows (${SEL.subgraphRow.css}) in the Filters section for ${sc.excludedTop.length} excluded folder(s)` }); }
    const texts = await rows.allInnerTexts();
    const missing = sc.excludedTop.filter(t => !texts.some(x => x.includes(t)));
    ux.steps[ux.steps.length - 1].note = `${await rows.count()} row(s): ${texts.map(t => t.replace(/\s+/g, ' ').trim()).slice(0, 6).join(' | ')}`;
    if (missing.length) { throw new StepFinding({ rule: 'scope-rows-incomplete', severity: 'medium', ref: 'round3 W4', message: `excluded folders without a row: ${missing.join(', ')}` }); }
    if (!texts.some(t => /\d/.test(t))) { throw new StepFinding({ rule: 'scope-rows-no-count', severity: 'low', ref: 'round3 W4', message: 'excluded-folder rows carry no file count' }); }
  }, { metrics: false });

  await ux.step('Visualize on an excluded folder → subgraph-include posted, its frames appear', async () => {
    await gate();
    if (!sc.excludedTop.length) { throw new SkipStep('nothing to include'); }
    const btn = page.locator(SEL.subgraphVisualize.css).first();
    if (await btn.count() === 0) { throw new SkipStep(`no Visualize action (${SEL.subgraphVisualize.css})`); }
    const before = host.posted('subgraph-include').length;
    await btn.click();
    await expect.poll(() => host.posted('subgraph-include').length, { timeout: 5000 }).toBeGreaterThan(before);
    const path = String(host.posted('subgraph-include').slice(-1)[0].path ?? '');
    await page.waitForTimeout(1500);
    await fitToView(page);
    const tops = await renderedTops();
    ux.steps[ux.steps.length - 1].note = `posted subgraph-include {path: ${path}}; rendered now: ${tops.join(', ')}`;
    if (!tops.includes(path.split('/')[0])) { throw new StepFinding({ rule: 'scope-include-not-rendered', severity: 'high', ref: 'round3 W4', message: `after subgraph-include ${path} (host re-sent subgraph + graph-patch) its frame is not rendered` }); }
  });

  await ux.step('Exit subgraph → subgraph-exit posted, whole project renders', async () => {
    await gate();
    const btn = page.locator(SEL.subgraphExit.css).first();
    if (await btn.count() === 0) { throw new SkipStep(`no Exit action (${SEL.subgraphExit.css})`); }
    await btn.click();
    await expect.poll(() => host.posted('subgraph-exit').length, { timeout: 5000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1500);
    await fitToView(page);
    const tops = await renderedTops();
    const missing = [...sc.include, ...sc.excludedTop].filter(t => !tops.includes(t));
    ux.steps[ux.steps.length - 1].note = `rendered after exit: ${tops.join(', ')}`;
    if (missing.length) { throw new StepFinding({ rule: 'scope-exit-incomplete', severity: 'high', ref: 'round3 W4', message: `after subgraph-exit these top-level folders are still missing: ${missing.join(', ')}` }); }
  });

  await ux.step('Show all does NOT touch the scope (product Q3)', async () => {
    await gate();
    // Show all is rendered only while something is filtered: hide a folder first (the scope is exited by now
    // only if Exit existed; either way Show all must not post subgraph-exit).
    const f = await locateFrame(page, 'smallest');
    await rightClick(page, f.title);
    if (!(await ctxMenuLabels(page)).some(x => /hide folder/i.test(x))) { await page.keyboard.press('Escape'); throw new SkipStep('no "Hide folder" item'); }
    await ctxMenuClick(page, /hide folder/i);
    await page.waitForTimeout(800);
    const showAll = page.locator(SEL.folderShowAll.css);
    if (await showAll.count() === 0) { throw new SkipStep('no Show all button'); }
    const before = host.posted('subgraph-exit').length;
    if (await page.locator(SEL.folderFiltersBody.css).isHidden()) { await clickSel(page, 'folderFiltersToggle'); }
    await showAll.click();
    await page.waitForTimeout(500);
    if (host.posted('subgraph-exit').length > before) { throw new StepFinding({ rule: 'show-all-exits-scope', severity: 'medium', ref: 'round3 Q3', message: 'Show all posted subgraph-exit' }); }
  }, { metrics: false, settle: false });
});
