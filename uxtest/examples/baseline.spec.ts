// Example: using openLab() for a measurement instead of a feature walkthrough —
// time-to-still, frame times and the webview's own perfReport() on both engines.
//   npm run uxtest -- --project examples --repo synthetic-3k
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { openLab } from '../lib/lab';
import { matrix } from '../lib/matrix';
import { setSlider } from '../lib/actions';

for (const c of matrix({ perMotion: false })) {
  test(`baseline · ${c.repo} · ${c.engine}`, async ({ browser }) => {
    const lab = await openLab({ ...c, motion: 'dynamic', scenario: 'baseline', browser, video: false, keepSnapshots: false });
    try {
      const expand = await lab.ux.step('Expand to full depth and settle', async () => {
        await setSlider(lab.page, 'detailSlider', 1);
      }, { stillTimeoutMs: 60000 });
      const summary = {
        repo: c.repo, engine: c.engine, nodes: expand.metrics?.nodes,
        timeToStillMs: expand.still?.ms, settled: expand.still?.settled, fps: expand.fps,
        perfReport: await lab.page.evaluate('typeof perfReport === "function" ? perfReport() : null'),
      };
      fs.writeFileSync(path.join(lab.outDir, 'baseline.json'), JSON.stringify(summary, null, 2));
    } finally {
      await lab.close();
    }
  });
}
