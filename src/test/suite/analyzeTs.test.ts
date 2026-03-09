import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { collectTsFiles } = require('../../../scripts/analyze_ts.js');

// ---------------------------------------------------------------------------
// collectTsFiles — P1-B regression: uses entry.name (exact match) not substring
// ---------------------------------------------------------------------------

suite('collectTsFiles', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-test-'));

    // src/foo.ts → included
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'foo.ts'), '');

    // src/bar.tsx → included
    fs.writeFileSync(path.join(tmpDir, 'src', 'bar.tsx'), '');

    // src/types.d.ts → excluded (.d.ts)
    fs.writeFileSync(path.join(tmpDir, 'src', 'types.d.ts'), '');

    // node_modules/lib/index.ts → excluded
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'lib', 'index.ts'), '');

    // out/compiled.ts → excluded
    fs.mkdirSync(path.join(tmpDir, 'out'));
    fs.writeFileSync(path.join(tmpDir, 'out', 'compiled.ts'), '');

    // dist/bundle.ts → excluded
    fs.mkdirSync(path.join(tmpDir, 'dist'));
    fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.ts'), '');

    // myoutput/extra.ts → INCLUDED (name contains "out" but != "out")
    fs.mkdirSync(path.join(tmpDir, 'myoutput'));
    fs.writeFileSync(path.join(tmpDir, 'myoutput', 'extra.ts'), '');
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('includes .ts files', () => {
    const files: string[] = collectTsFiles(tmpDir);
    assert.ok(
      files.some(f => f.endsWith(path.join('src', 'foo.ts'))),
      'src/foo.ts should be included'
    );
  });

  test('includes .tsx files', () => {
    const files: string[] = collectTsFiles(tmpDir);
    assert.ok(
      files.some(f => f.endsWith(path.join('src', 'bar.tsx'))),
      'src/bar.tsx should be included'
    );
  });

  test('excludes .d.ts files', () => {
    const files: string[] = collectTsFiles(tmpDir);
    assert.ok(
      !files.some(f => f.endsWith('types.d.ts')),
      'types.d.ts should be excluded'
    );
  });

  test('excludes node_modules/ directory', () => {
    const files: string[] = collectTsFiles(tmpDir);
    assert.ok(
      !files.some(f => f.includes('node_modules')),
      'node_modules should be excluded'
    );
  });

  test('excludes out/ directory', () => {
    const files: string[] = collectTsFiles(tmpDir);
    const outFiles = files.filter(f => {
      const parts = f.split(path.sep);
      return parts.includes('out');
    });
    assert.strictEqual(outFiles.length, 0, 'out/ directory should be excluded');
  });

  test('excludes dist/ directory', () => {
    const files: string[] = collectTsFiles(tmpDir);
    assert.ok(
      !files.some(f => f.includes(path.sep + 'dist' + path.sep)),
      'dist/ directory should be excluded'
    );
  });

  test('does NOT exclude directory whose name contains "out" but != "out" (regression for old substring check)', () => {
    const files: string[] = collectTsFiles(tmpDir);
    assert.ok(
      files.some(f => f.endsWith(path.join('myoutput', 'extra.ts'))),
      'myoutput/extra.ts should be included — "myoutput" != "out"'
    );
  });
});
