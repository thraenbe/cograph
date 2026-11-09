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
  timeout: Number(process.env.UXTEST_TEST_TIMEOUT_MS ?? 10 * 60 * 1000), // raise for very large repos (analysis runs inside the test)
  reporter: [['list']],
  // A missing element must fail the step in seconds, not hang until the test timeout.
  use: { actionTimeout: 10000 },
  projects: [
    { name: 'lab', testMatch: /scenarios\/.*\.spec\.ts$/, use: { browserName: 'chromium', headless: process.env.UXTEST_HEADED !== '1' } },
    { name: 'examples', testMatch: /examples\/.*\.spec\.ts$/, use: { browserName: 'chromium', headless: process.env.UXTEST_HEADED !== '1' } },
    { name: 'unit', testMatch: /unit\/.*\.test\.ts$/ },
    { name: 'sweep', testMatch: /sweep\/.*\.spec\.ts$/, use: { browserName: 'chromium', headless: true } },
    { name: 'report', testMatch: /report\/report\.spec\.ts$/ },
    // Perf benchmarks: ONE worker (no neighbour competing for the CPU), uncapped frame rate so headroom above the
    // display refresh is visible. Headless like every project: a run must never open a window by surprise.
    // `--headed` (UXTEST_HEADED=1) for GPU-raster numbers on a machine where a window is allowed.
    { name: 'bench', testMatch: /bench\/.*\.spec\.ts$/, workers: 1, fullyParallel: false,
      use: { browserName: 'chromium', headless: process.env.UXTEST_HEADED !== '1',
        launchOptions: { args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] } } },
    { name: 'vscode', testMatch: /vscode\/.*\.spec\.ts$/, workers: 1, fullyParallel: false },
  ],
});
