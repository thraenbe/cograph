// Tier B hunt for F11 / B7: on a COLD profile the host may post `structure`/`graph` before the webview
// listens → the panel stays blank. Every attempt is a fresh user-data-dir + fresh repo copy, recorded on video.
//   npm run uxtest:vscode -- --scenario cold-open --repo click        (UXTEST_COLD_ATTEMPTS, default 5)
import { test, expect } from '@playwright/test';
import { launchVsCode, within } from './launch';
import { runCommand, waitForGraph } from './drive';
import { StepFinding } from '../lib/step';

const repos = (process.env.UXTEST_REPOS ?? 'click').split(',').map(s => s.trim()).filter(Boolean);
const attempts = Number(process.env.UXTEST_COLD_ATTEMPTS ?? 5);

for (const repo of repos) {
  for (let i = 1; i <= attempts; i++) {
    test(`vscode cold open · ${repo} · attempt ${i}`, async () => {
      test.setTimeout(4 * 60 * 1000);
      const s = await launchVsCode(repo, `cold-open-${String(i).padStart(2, '0')}`);
      try {
        // No settling pause on purpose: a user hits the command as soon as the window is up.
        await s.ux.step('Visualize immediately after a cold start', async () => {
          await runCommand(s.page, 'CoGraph: Visualize Project');
          await waitForGraph(s.graphFrame, 60000, false);
        }, { settle: false, metrics: false });
        await s.ux.step('Graph must show nodes within 25 s', async () => {
          try { await waitForGraph(s.graphFrame, 25000, true); }
          catch {
            const f = await s.graphFrame();
            const st = f ? await within(f.evaluate('JSON.stringify({ nodes: state.currentNodes.length, hasGraphData: !!state.graphData, hasTree: !!state.structureTree, posted: (window.__uxPosted || []).length })') as Promise<string>, 2500, '{}') : 'no webview frame';
            throw new StepFinding({ rule: 'blank-graph-on-cold-open', severity: 'high', ref: 'F11/B7', message: `panel is open but shows no nodes 25 s after Visualize (webview state: ${st})` });
          }
        });
        await s.ux.step('Still there after 10 s (B7)', async () => {
          for (let t = 0; t < 10; t++) {
            await s.page.waitForTimeout(1000);
            if (!await s.graphFrame()) { throw new StepFinding({ rule: 'panel-vanished', severity: 'high', ref: 'B7', message: `CoGraph panel vanished ${t + 1} s after it appeared` }); }
          }
        }, { metrics: false, settle: false });
      } finally {
        const run = await s.close();
        expect(run.steps.filter(st => st.status === 'failed').map(st => `${st.index}. ${st.name}: ${st.note}`)).toEqual([]);
      }
    });
  }
}
