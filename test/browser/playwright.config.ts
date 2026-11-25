import { defineConfig } from '@playwright/test';

// Browser-view specs (src/browserView). Needs `npm run compile && npm run bundle` first:
// the specs load the production server and page from out/ and the stage from src/webview + dist/webview.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: './test-results',
  workers: 1,
  retries: 0,
  timeout: 3 * 60 * 1000,
  reporter: [['list']],
  use: { browserName: 'chromium', headless: process.env.BROWSER_HEADED !== '1', actionTimeout: 10000 },
});
