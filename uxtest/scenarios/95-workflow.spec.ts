// 95 — Workflow view: a graph carrying workflow metadata switches the primary
// view; the Detail slider walks the ten reveal levels.
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { fitToView, setSlider } from '../lib/actions';
import { workflowGraph } from '../lib/fixtures';

scenario('workflow', { perMotion: false, perEngine: false }, async ({ page, ux, post, repo }) => {
  await ux.step('Host sends a workflow graph', async () => {
    await post({ type: 'graph', data: workflowGraph(repo), gitAvailable: false, fileGitStatus: {}, isReanalysis: false });
    await page.waitForFunction('state.viewMode === "workflow"', undefined, { timeout: 10000 });
  });
  const counts: number[] = [];
  for (let level = 0; level <= 9; level++) {
    const rec = await ux.step(`Workflow level ${level}`, async () => {
      await setSlider(page, 'detailSlider', level / 9);
      await page.waitForFunction(`state.workflowLevel === ${level}`, undefined, { timeout: 5000 });
      if (level === 0 || level === 9) { await fitToView(page); }
    });
    counts.push(rec.metrics?.nodes ?? 0);
  }
  expect(counts[9], `levels must reveal more nodes: ${counts.join(',')}`).toBeGreaterThanOrEqual(counts[0]);
  await ux.step('Host sends the normal graph again → back to the folder view', async () => {
    await post({ type: 'graph', data: repo.graph, gitAvailable: false, fileGitStatus: {}, isReanalysis: false });
    await page.waitForFunction('state.viewMode !== "workflow"', undefined, { timeout: 10000 });
  });
});
