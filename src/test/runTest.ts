import * as path from 'path';
import { runTests, downloadAndUnzipVSCode } from '@vscode/test-electron';

// Keep in sync with the cache key in .github/workflows/ci.yml
const VSCODE_VERSION = '1.116.0';
const MAX_RETRIES = 3;

async function downloadWithRetry(): Promise<string> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await downloadAndUnzipVSCode(VSCODE_VERSION);
    } catch (err) {
      if (attempt === MAX_RETRIES) { throw err; }
      console.log(`Download attempt ${attempt} failed, retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw new Error('unreachable');
}

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  try {
    const vscodeExecutablePath = await downloadWithRetry();
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
    });
  } catch (err) {
    console.error('Test run failed:', err);
    process.exit(1);
  }
}

main();
