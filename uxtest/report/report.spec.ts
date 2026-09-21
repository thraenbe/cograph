// `npm run uxtest:report [-- --run-id <id>]` — builds the static report(s) for a run.
// Runs under the Playwright runner only because it transpiles TypeScript; no browser is used.
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { REPO_ROOT } from '../harness/vscodeStub';
import { writeSweepReport } from './sweepReport';
import { log } from '../lib/log';

export function newestRun(artifacts: string): string | null {
  if (!fs.existsSync(artifacts)) { return null; }
  const dirs = fs.readdirSync(artifacts).filter(d => fs.statSync(path.join(artifacts, d)).isDirectory());
  return dirs.sort((a, b) => fs.statSync(path.join(artifacts, a)).mtimeMs - fs.statSync(path.join(artifacts, b)).mtimeMs).pop() ?? null;
}

test('build report', async () => {
  const artifacts = path.join(REPO_ROOT, 'uxtest', 'artifacts');
  const runId = process.env.UXTEST_REPORT_RUN ?? newestRun(artifacts);
  expect(runId, 'no run found under uxtest/artifacts').toBeTruthy();
  const runDir = path.join(artifacts, runId as string);
  expect(fs.existsSync(runDir), `run ${runId} does not exist`).toBe(true);
  const written = [...writeSweepReport(runDir)];
  log.info('report-written', { runId, files: written.map(f => path.relative(REPO_ROOT, f)) });
});
