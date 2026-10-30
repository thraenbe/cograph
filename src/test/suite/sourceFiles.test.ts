import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { collectSourceFiles, explicitFileList } = require('../../../scripts/sourceFiles.js');

const isTxt = (f: string) => f.endsWith('.txt');

suite('sourceFiles — collectSourceFiles', () => {
  let tmp: string;

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-sourcefiles-'));
    for (const dir of ['src/deep', 'node_modules/pkg', '.git', 'build']) {
      fs.mkdirSync(path.join(tmp, dir), { recursive: true });
      fs.writeFileSync(path.join(tmp, dir, 'f.txt'), '');
    }
    fs.writeFileSync(path.join(tmp, 'src', 'a.txt'), '');
    fs.writeFileSync(path.join(tmp, 'src', 'b.md'), '');
  });
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test('returns the matching files under root, skipping project-excluded directories', () => {
    const rel = collectSourceFiles(tmp, isTxt).map((f: string) => path.relative(tmp, f)).sort();
    assert.deepStrictEqual(rel, [path.join('src', 'a.txt'), path.join('src', 'deep', 'f.txt')]);
  });

  test('the predicate receives the full path, so it can read the file (a .vue routing check does)', () => {
    const seen: string[] = [];
    collectSourceFiles(tmp, (f: string) => { seen.push(f); return false; });
    assert.ok(seen.includes(path.join(tmp, 'src', 'a.txt')), seen.join(', '));
    assert.ok(seen.every((f) => path.isAbsolute(f)));
  });

  test('a missing root yields no files', () => {
    assert.deepStrictEqual(collectSourceFiles(path.join(tmp, 'absent'), isTxt), []);
  });
});

suite('sourceFiles — explicitFileList', () => {
  let tmp: string;

  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-filelist-')); });
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  test('null when --files is absent or has no path', () => {
    assert.strictEqual(explicitFileList(isTxt, ['node', 'analyze.js', '/ws']), null);
    assert.strictEqual(explicitFileList(isTxt, ['node', 'analyze.js', '/ws', '--files']), null);
  });

  test('an unreadable list yields no files', () => {
    assert.deepStrictEqual(explicitFileList(isTxt, ['node', 'analyze.js', '/ws', '--files', path.join(tmp, 'absent')]), []);
  });

  test('trims lines, drops blanks and keeps only matching files', () => {
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, '/ws/a.txt\n  /ws/b.txt  \n\n/ws/c.md\r\n/ws/d.txt\r\n');
    assert.deepStrictEqual(
      explicitFileList(isTxt, ['node', 'analyze.js', '/ws', '--files', list]),
      ['/ws/a.txt', '/ws/b.txt', '/ws/d.txt'],
    );
  });
});
