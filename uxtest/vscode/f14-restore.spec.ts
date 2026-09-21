// Tier B check for F14: does a layout saved under the GLOBAL engine come back in real VS Code?
// Visualize → Detail 0.6 → drag a folder → Ctrl+S (name) → close the panel → click the saved graph's card in the
// CoGraph sidebar (that is the load path; "Open or Reload Layout" only re-opens a FRESH layout) → compare.
//   npm run uxtest:vscode -- --scenario f14-restore --repo express [--ext-root <checkout>]
import { test, expect } from '@playwright/test';
import { launchVsCode, within } from './launch';
import { answerQuickInput, frameBackground, frameHittable, frameSetSlider, runCommand, waitForGraph } from './drive';
import { collectSnapshot } from '../metrics/collect';
import { maxDisplacement } from '../metrics/compute';
import type { Snapshot } from '../metrics/types';
import { SkipStep } from '../lib/step';
import { SEL } from '../selectors';

const repos = (process.env.UXTEST_REPOS ?? 'express').split(',').map(s => s.trim()).filter(Boolean);
const engine = process.env.UXTEST_ENGINES?.split(',')[0] === 'shelf' ? 'shelf' : 'global';
const NAME = 'f14-eval';

for (const repo of repos) {
  test(`vscode F14 restore · ${repo} · ${engine}`, async () => {
    test.setTimeout(6 * 60 * 1000);
    const s = await launchVsCode(repo, `f14-restore-${engine}`, { 'cograph.layout.defaultEngine': engine, 'cograph.layout.defaultMode': 'static' });
    const { page, ux, graphFrame } = s;
    const snap = async (): Promise<Snapshot | null> => { const f = await graphFrame(); return f ? within(collectSnapshot(f, { maxLabels: 50 }), 8000, null) : null; };
    try {
      await ux.step(`Visualize (${engine} + static from settings)`, async () => {
        await runCommand(page, 'CoGraph: Visualize Project');
        await waitForGraph(graphFrame, 120000, true);
      });
      await ux.step('Detail → 0.6, fit', async () => {
        const f = await graphFrame(); if (!f) { throw new Error('no webview'); }
        await frameSetSlider(f, SEL.detailSlider.css, 0.6);
        await page.waitForTimeout(5000); // lazy host parses the opened folders
        const bg = await frameBackground(f);
        if (bg) { await page.mouse.dblclick(bg.x, bg.y); }
      }, { stillTimeoutMs: 20000 });
      await ux.step('Drag one folder by its title', async () => {
        const f = await graphFrame(); if (!f) { throw new Error('no webview'); }
        const c = await frameHittable(f, '#graph g.folder-bubble .folder-bubble-titlebar, #graph g.frame .folder-bubble-titlebar', 300);
        if (!c) { throw new SkipStep('no grabbable folder title'); }
        await page.mouse.move(c.x, c.y, { steps: 8 }); await page.mouse.down();
        await page.mouse.move(c.x + 60, c.y + 45, { steps: 16 }); await page.mouse.up();
      }, { userMoved: true });
      const arranged = await snap();
      await ux.step(`Ctrl+S → save as "${NAME}"`, async () => {
        const f = await graphFrame();
        const hint = f ? await frameHittable(f, SEL.layoutHint.css) : null;
        if (hint) { await page.mouse.click(hint.x, hint.y); }
        await page.keyboard.press('Control+s');
        if (!await answerQuickInput(page, NAME, 6000)) { throw new Error('Save Graph did not ask for a name'); }
        await page.waitForTimeout(2000);
      }, { metrics: false });
      await ux.step('Close the CoGraph panel', async () => {
        await runCommand(page, 'View: Close All Editors');
        await page.waitForTimeout(1500);
        if (await graphFrame()) { throw new Error('panel still open'); }
      }, { metrics: false, settle: false });
      ux.birth = 'user-moved'; // the saved picture contains the dragged folder; a fresh panel would otherwise count as grid-born
      const restore = await ux.step(`Sidebar → Saved Graphs → click "${NAME}"`, async () => {
        const icon = page.locator('.activitybar .action-item a[aria-label*="Cograph" i]').first();
        if (await icon.count() === 0) { throw new Error('CoGraph activity-bar icon not found'); }
        await icon.click();
        let clicked = false;
        for (let attempt = 0; attempt < 20 && !clicked; attempt++) {
          await page.waitForTimeout(500);
          for (const f of page.frames()) {
            if (!f.url().startsWith('vscode-webview://')) { continue; }
            const card = f.locator(`.graph-card[data-name="${NAME}"]`).first();
            if (await within(card.count(), 1500, 0) > 0) { await card.click({ position: { x: 20, y: 12 } }); clicked = true; break; }
          }
        }
        if (!clicked) { throw new Error(`saved graph card "${NAME}" not found in the sidebar`); }
        await waitForGraph(graphFrame, 120000, true);
        await page.waitForTimeout(5000); // lazy host re-parses the saved expansion
      }, { stillTimeoutMs: 20000 });
      const restored = await snap();
      expect(arranged, 'snapshot before saving').toBeTruthy();
      expect(restored, 'snapshot after restoring').toBeTruthy();
      const d = maxDisplacement(arranged as Snapshot, restored as Snapshot);
      const common = (restored as Snapshot).nodes.filter(n => (arranged as Snapshot).nodes.some(a => a.id === n.id)).length;
      const title = (await page.locator('.tabs-container .tab.active').first().innerText().catch(() => '')).trim();
      restore.note = `panel title "${title}"; saved ${arranged?.nodes.length} visible nodes (engine ${arranged?.engine}/${arranged?.motion}), restored ${restored?.nodes.length} (engine ${restored?.engine}/${restored?.motion}); ${common} in common, ${d.moved} of them at a different position (max ${d.max} px)`;
      if (d.max > 2 || arranged?.nodes.length !== restored?.nodes.length) {
        restore.findings.push({ rule: 'restore-differs', severity: 'high', ref: 'F14/R5', message: restore.note });
      }
    } finally {
      const run = await s.close();
      expect(run.steps.filter(st => st.status === 'failed').map(st => `${st.index}. ${st.name}: ${st.note}`)).toEqual([]);
    }
  });
}
