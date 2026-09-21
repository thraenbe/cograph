// `npm run uxtest:report [-- --run-id <id>]` — builds the static report(s) for a run.
// Runs under the Playwright runner only because it transpiles TypeScript; no browser is used.
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { REPO_ROOT } from '../harness/vscodeStub';
import { writeSweepReport } from './sweepReport';
import { newestRun, writeRunReport } from './build';
import { log } from '../lib/log';

test('build report', async () => {
  const artifacts = path.join(REPO_ROOT, 'uxtest', 'artifacts');
  const runId = process.env.UXTEST_REPORT_RUN ?? newestRun(artifacts);
  expect(runId, 'no run found under uxtest/artifacts').toBeTruthy();
  const runDir = path.join(artifacts, runId as string);
  expect(fs.existsSync(runDir), `run ${runId} does not exist`).toBe(true);
  const sweepFiles = writeSweepReport(runDir);
  const baseline = process.env.UXTEST_REPORT_BASELINE ? path.join(artifacts, process.env.UXTEST_REPORT_BASELINE) : undefined;
  if (baseline) { expect(fs.existsSync(baseline), `baseline run ${baseline} does not exist`).toBe(true); }
  const links = sweepFiles.map(f => path.basename(f)).filter(f => /contact-sheet|recommendations/.test(f));
  const written = [...sweepFiles, ...writeRunReport(runDir, baseline, links)];
  expect(written.length, `run ${runId} holds neither recordings nor sweep samples`).toBeGreaterThan(0);
  log.info('report-written', { runId, files: written.map(f => path.relative(REPO_ROOT, f)) });
});
