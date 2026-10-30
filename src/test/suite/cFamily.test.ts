import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cFamily = require('../../../scripts/cFamily.js');
const { isCHeader, isCFamilyFile, splitCFamilyFiles, pruneRedundantDeclarations } = cFamily;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { collectSourceFiles, explicitFileList } = require('../../../scripts/sourceFiles.js');
const collectCFamilyFiles = (root: string) => collectSourceFiles(root, isCFamilyFile);
const cFamilyFileList = (argv: string[]) => explicitFileList(isCFamilyFile, argv);

// ---------------------------------------------------------------------------
// The header rule: a .h is C when its directory holds .c files and no C++ source
// ---------------------------------------------------------------------------

suite('cFamily — header rule', () => {
  let tmpDir: string;

  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-cfamily-')); });
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function dir(name: string, files: string[]): string {
    const d = path.join(tmpDir, name);
    fs.mkdirSync(d, { recursive: true });
    for (const f of files) { fs.writeFileSync(path.join(d, f), '// stub\n'); }
    return d;
  }

  test('.h next to .c files only → C', () => {
    const d = dir('c-only', ['sds.c', 'sds.h']);
    assert.strictEqual(isCHeader(path.join(d, 'sds.h')), true);
  });

  test('.h next to .cpp files only → C++', () => {
    const d = dir('cpp-only', ['widget.cpp', 'widget.h']);
    assert.strictEqual(isCHeader(path.join(d, 'widget.h')), false);
  });

  test('.h next to both .c and .cpp files → C++', () => {
    const d = dir('mixed', ['a.c', 'b.cc', 'api.h']);
    assert.strictEqual(isCHeader(path.join(d, 'api.h')), false);
  });

  test('.h in a header-only directory → C++ (today\'s behaviour)', () => {
    const d = dir('headers', ['api.h', 'util.h']);
    assert.strictEqual(isCHeader(path.join(d, 'api.h')), false);
  });

  test('.h in an unreadable directory → C++', () => {
    assert.strictEqual(isCHeader(path.join(tmpDir, 'missing', 'x.h')), false);
  });

  test('the rule looks at the header\'s own directory, not at the file list', () => {
    const d = dir('lib', ['lib.c', 'lib.h']);
    // A single-file subset run hands over only the header; it must still be C.
    const { c, cpp } = splitCFamilyFiles([path.join(d, 'lib.h')]);
    assert.deepStrictEqual(c, [path.join(d, 'lib.h')]);
    assert.deepStrictEqual(cpp, []);
  });

  test('splitCFamilyFiles: sources by extension, each .h to exactly one side', () => {
    const c = dir('c', ['main.c', 'main.h']);
    const cpp = dir('cpp', ['app.cpp', 'app.hpp', 'app.h', 'x.cxx', 'y.c++', 'z.cc', 'w.hh', 'v.hxx', 'u.h++']);
    const all = collectCFamilyFiles(tmpDir).sort();
    const split = splitCFamilyFiles(all);
    assert.deepStrictEqual(split.c.sort(), [path.join(c, 'main.c'), path.join(c, 'main.h')]);
    assert.strictEqual(split.cpp.length, 9);
    assert.ok(split.cpp.includes(path.join(cpp, 'app.h')));
    assert.strictEqual(split.c.length + split.cpp.length, all.length, 'nothing lost, nothing doubled');
  });

  test('the shared walk with isCFamilyFile skips artefact and hidden directories, ignores other files', () => {
    dir('src', ['a.c', 'b.cpp', 'README.md', 'c.py']);
    dir('node_modules', ['skip.c']);
    dir('build', ['skip.c']);
    dir('.git', ['skip.c']);
    const files = collectCFamilyFiles(tmpDir).map((f: string) => path.relative(tmpDir, f)).sort();
    assert.deepStrictEqual(files, [path.join('src', 'a.c'), path.join('src', 'b.cpp')]);
  });
});

// ---------------------------------------------------------------------------
// --files handling (sourceFiles.explicitFileList with isCFamilyFile)
// ---------------------------------------------------------------------------

suite('cFamily — --files list', () => {
  let tmpDir: string;
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-cfamily-list-')); });
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('no --files flag → null (full walk)', () => {
    assert.strictEqual(cFamilyFileList(['node', 'analyze_c.js', '/root']), null);
  });

  test('--files keeps only C-family entries, trims blanks', () => {
    const list = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(list, ['/p/a.c', '  /p/b.H ', '/p/c.py', '', '/p/d.CPP', '/p/e.ts'].join('\n'));
    assert.deepStrictEqual(cFamilyFileList(['node', 'x', '/root', '--files', list]), ['/p/a.c', '/p/b.H', '/p/d.CPP']);
  });

  test('unreadable list → [] (nothing analysed, no crash)', () => {
    assert.deepStrictEqual(cFamilyFileList(['node', 'x', '/root', '--files', path.join(tmpDir, 'nope.txt')]), []);
  });
});

// ---------------------------------------------------------------------------
// pruneRedundantDeclarations
// ---------------------------------------------------------------------------

suite('cFamily — pruneRedundantDeclarations', () => {
  const def = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, file: id, line: 1, ...extra });

  test('declaration pruned when a definition of the same name exists', () => {
    const defs: Record<string, any> = {
      h: def('h', 'f', { isDeclaration: true }),
      c: def('c', 'f'),
    };
    pruneRedundantDeclarations(defs);
    assert.deepStrictEqual(Object.keys(defs), ['c']);
  });

  test('two declarations and no definition → one node, marker stripped', () => {
    const defs: Record<string, any> = {
      h: def('h', 'f', { isDeclaration: true }),
      c: def('c', 'f', { isDeclaration: true }),
    };
    pruneRedundantDeclarations(defs);
    assert.strictEqual(Object.keys(defs).length, 1);
    assert.strictEqual(Object.values(defs)[0].isDeclaration, undefined);
  });

  test('className is part of the key: Foo::f and Bar::f are different functions', () => {
    const defs: Record<string, any> = {
      a: def('a', 'f', { className: 'Foo', isDeclaration: true }),
      b: def('b', 'f', { className: 'Bar' }),
    };
    pruneRedundantDeclarations(defs);
    assert.deepStrictEqual(Object.keys(defs).sort(), ['a', 'b']);
  });
});
