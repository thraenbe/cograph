import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanStructure } from '../../structureScanner';

suite('structureScanner', () => {
  let tmp: string;

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-structure-'));
  });
  teardown(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function write(rel: string, content = '') {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  }

  test('builds a single-root tree with correct depths, parents, and recursive counts', () => {
    const aTs = write('src/a.ts', 'export const x = 1;');
    const bPy = write('src/sub/b.py', 'def f(): pass');
    const cJava = write('lib/C.java', 'class C {}');

    const tree = scanStructure(tmp);

    // Common root = the workspace dir (ancestor of src, src/sub, lib)
    assert.strictEqual(tree.root, tmp);
    assert.strictEqual(tree.totalFiles, 3);

    const root = tree.folders[tmp];
    const src = tree.folders[path.join(tmp, 'src')];
    const sub = tree.folders[path.join(tmp, 'src', 'sub')];
    const lib = tree.folders[path.join(tmp, 'lib')];
    assert.ok(root && src && sub && lib, 'all folders present');

    assert.strictEqual(root.depth, 0);
    assert.strictEqual(src.depth, 1);
    assert.strictEqual(sub.depth, 2);
    assert.strictEqual(lib.depth, 1);

    assert.strictEqual(root.parent, null);
    assert.strictEqual(src.parent, tmp);
    assert.strictEqual(sub.parent, path.join(tmp, 'src'));
    assert.strictEqual(lib.parent, tmp);

    assert.deepStrictEqual([...root.childFolders].sort(), [path.join(tmp, 'lib'), path.join(tmp, 'src')].sort());
    assert.deepStrictEqual(src.childFolders, [path.join(tmp, 'src', 'sub')]);

    // Direct files
    assert.deepStrictEqual(src.files, [aTs]);
    assert.deepStrictEqual(sub.files, [bPy]);
    assert.deepStrictEqual(lib.files, [cJava]);
    assert.deepStrictEqual(root.files, []);

    // Recursive counts
    assert.strictEqual(root.fileCount, 3);
    assert.strictEqual(src.fileCount, 2); // a.ts + sub/b.py
    assert.strictEqual(sub.fileCount, 1);
    assert.strictEqual(lib.fileCount, 1);
  });

  test('classifies languages and excludes .d.ts / non-source files', () => {
    write('a.ts');
    write('b.tsx');
    write('c.js');
    write('d.mjs');
    write('e.py');
    write('F.java');
    write('g.cpp');
    write('h.hpp');
    write('types.d.ts');   // excluded (declaration file)
    write('README.md');    // not source
    write('data.json');    // not source

    const tree = scanStructure(tmp);
    const langByName: Record<string, string> = {};
    for (const f of tree.files) { langByName[path.basename(f.path)] = f.language; }

    assert.strictEqual(langByName['a.ts'], 'typescript');
    assert.strictEqual(langByName['b.tsx'], 'typescript');
    assert.strictEqual(langByName['c.js'], 'javascript');
    assert.strictEqual(langByName['d.mjs'], 'javascript');
    assert.strictEqual(langByName['e.py'], 'python');
    assert.strictEqual(langByName['F.java'], 'java');
    assert.strictEqual(langByName['g.cpp'], 'cpp');
    assert.strictEqual(langByName['h.hpp'], 'cpp');
    assert.ok(!('types.d.ts' in langByName), '.d.ts excluded');
    assert.ok(!('README.md' in langByName), 'non-source excluded');
    assert.ok(!('data.json' in langByName), 'json excluded');
    assert.strictEqual(tree.totalFiles, 8);
  });

  test('skips node_modules, build dirs, and dot-directories', () => {
    write('src/keep.ts');
    write('node_modules/pkg/skip.ts');
    write('dist/skip.js');
    write('build/skip.cpp');
    write('target/skip.java');
    write('CMakeFiles/skip.cpp');
    write('cmake-build-debug/skip.cpp');
    write('.hidden/skip.py');

    const tree = scanStructure(tmp);
    assert.strictEqual(tree.totalFiles, 1, 'only src/keep.ts survives');
    assert.strictEqual(path.basename(tree.files[0].path), 'keep.ts');
  });

  test('single source file → root is that file’s directory', () => {
    write('pkg/only.py');
    const tree = scanStructure(tmp);
    assert.strictEqual(tree.root, path.join(tmp, 'pkg'));
    assert.strictEqual(tree.folders[tree.root].depth, 0);
    assert.strictEqual(tree.folders[tree.root].files.length, 1);
  });

  test('no supported files → empty tree (no throw)', () => {
    write('README.md');
    write('notes.txt');
    const tree = scanStructure(tmp);
    assert.strictEqual(tree.root, '');
    assert.strictEqual(tree.totalFiles, 0);
    assert.deepStrictEqual(tree.folders, {});
  });
});
