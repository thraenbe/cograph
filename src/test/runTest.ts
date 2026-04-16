import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// Keep in sync with the cache key in .github/workflows/ci.yml
const VSCODE_VERSION = '1.116.0';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      version: VSCODE_VERSION,
    });
  } catch (err) {
    console.error('Test run failed:', err);
    process.exit(1);
  }
}

main();
