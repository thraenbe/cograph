import { defineConfig } from '@playwright/test';

// Video / screenshots / metrics are produced by uxtest/lib (one folder per
// repo × scenario × engine × motion under uxtest/artifacts/<runId>/), not by
// Playwright's own reporter, so `use.video` stays off here.
export default defineConfig({
  testDir: '.',
  outputDir: './test-results',
  fullyParallel: true,
  workers: process.env.UXTEST_WORKERS ? Number(process.env.UXTEST_WORKERS) : 2,
  retries: 0,
  timeout: 10 * 60 * 1000,
  reporter: [['list']],
  projects: [
    { name: 'lab', testMatch: /scenarios\/.*\.spec\.ts$/, use: { browserName: 'chromium', headless: process.env.UXTEST_HEADED !== '1' } },
    { name: 'examples', testMatch: /examples\/.*\.spec\.ts$/, use: { browserName: 'chromium', headless: process.env.UXTEST_HEADED !== '1' } },
    { name: 'unit', testMatch: /unit\/.*\.test\.ts$/ },
    { name: 'sweep', testMatch: /sweep\/.*\.spec\.ts$/, use: { browserName: 'chromium', headless: true } },
    { name: 'vscode', testMatch: /vscode\/.*\.spec\.ts$/, workers: 1, fullyParallel: false },
  ],
});
