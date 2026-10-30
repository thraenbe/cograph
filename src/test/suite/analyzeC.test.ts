import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cAnalyzer = require('../../../scripts/analyze_c.js');
const { collectCFiles, collectDefinitions, collectCalls } = cAnalyzer;

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');

// web-tree-sitter is async to initialise — load the WASM runtime + C grammar
// once before any suite parses. cAnalyzer.init() is idempotent.

/** Definitions + calls of the files written into `dir` by `files` ({ name: lines }). */
function analyse(dir: string, files: Record<string, string[]>) {
  const paths = Object.entries(files).map(([name, lines]) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  });
  const defs = collectDefinitions(paths);
  const { edges, libraryNodes } = collectCalls(paths, defs, dir);
  const list = Object.values(defs) as any[];
  const idOf = (name: string) => list.find((d: any) => d.name === name)?.id;
  const hasEdge = (from: string, to: string) => edges.some((e: any) => e.source === idOf(from) && e.target === idOf(to));
  return { list, edges, libraryNodes, idOf, hasEdge };
}

// ---------------------------------------------------------------------------
// collectCFiles — .c files plus the headers C owns
// ---------------------------------------------------------------------------

suite('collectCFiles', () => {
  let tmpDir: string;

  suiteSetup(async () => { await cAnalyzer.init(); });
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-c-files-')); });
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function write(rel: string) {
    const file = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// stub\n');
  }

  test('includes .c files and the .h files next to C sources only', () => {
    write('lib/sds.c'); write('lib/sds.h'); write('lib/README.md');
    const files: string[] = collectCFiles(tmpDir).map((f: string) => path.relative(tmpDir, f)).sort();
    assert.deepStrictEqual(files, [path.join('lib', 'sds.c'), path.join('lib', 'sds.h')]);
  });

  test('a .h next to a C++ source is not a C file; C++ sources never are', () => {
    write('app/main.cpp'); write('app/main.h'); write('app/util.c'); write('app/other.hpp');
    const files: string[] = collectCFiles(tmpDir).map((f: string) => path.relative(tmpDir, f));
    assert.deepStrictEqual(files, [path.join('app', 'util.c')]);
  });

  test('skips artefact directories and hidden directories', () => {
    write('src/a.c'); write('build/b.c'); write('node_modules/c.c'); write('.git/d.c');
    const files: string[] = collectCFiles(tmpDir).map((f: string) => path.relative(tmpDir, f));
    assert.deepStrictEqual(files, [path.join('src', 'a.c')]);
  });
});

// ---------------------------------------------------------------------------
// collectDefinitions — functions and prototypes
// ---------------------------------------------------------------------------

suite('collectDefinitions (C)', () => {
  let tmpDir: string;

  suiteSetup(async () => { await cAnalyzer.init(); });
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-c-defs-')); });
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('free function → node with language "c", id file::name::line, no className', () => {
    const { list } = analyse(tmpDir, { 'add.c': ['', 'int add(int a, int b) { return a + b; }'] });
    assert.strictEqual(list.length, 1);
    const add = list[0];
    assert.strictEqual(add.name, 'add');
    assert.strictEqual(add.language, 'c');
    assert.strictEqual(add.line, 2);
    assert.strictEqual(add.id, `${path.join(tmpDir, 'add.c')}::add::2`);
    assert.strictEqual(add.className, undefined);
  });

  test('static, inline and pointer-returning functions are detected', () => {
    const { idOf } = analyse(tmpDir, { 'f.c': [
      'static int hidden(void) { return 1; }',
      'static inline unsigned char *peek(unsigned char *p) { return p; }',
      'const char **names(void) { return 0; }',
    ] });
    assert.ok(idOf('hidden'), 'static');
    assert.ok(idOf('peek'), 'static inline, pointer return');
    assert.ok(idOf('names'), 'double pointer return');
  });

  test('a function returning a function pointer is named by the inner declarator', () => {
    const { idOf, list } = analyse(tmpDir, { 'f.c': ['int (*pick(int n))(int) { return 0; }'] });
    assert.ok(idOf('pick'));
    assert.strictEqual(list.length, 1);
  });

  test('a variable named `new` does not break the parse (the C++ grammar did)', () => {
    const { idOf } = analyse(tmpDir, { 'f.c': [
      'int before(void) { return 0; }',
      'int run(void) { int new = 1; int class = 2; return new + class; }',
      'int after(void) { return 0; }',
    ] });
    assert.ok(idOf('before') && idOf('run') && idOf('after'), 'all three functions survive');
  });

  test('prototype + definition → one node, the definition', () => {
    const { list } = analyse(tmpDir, {
      'util.h': ['int compute(int x);'],
      'util.c': ['#include "util.h"', 'int compute(int x) { return x; }'],
    });
    const computes = list.filter((d: any) => d.name === 'compute');
    assert.strictEqual(computes.length, 1);
    assert.ok(computes[0].file.endsWith('util.c'));
    assert.strictEqual(computes[0].isDeclaration, undefined, 'internal marker never leaks');
  });

  test('forward declaration of a static function + definition → one node', () => {
    const { list } = analyse(tmpDir, { 'f.c': [
      'static void helper(void);',
      'void run(void) { helper(); }',
      'static void helper(void) {}',
    ] });
    const helpers = list.filter((d: any) => d.name === 'helper');
    assert.strictEqual(helpers.length, 1);
    assert.strictEqual(helpers[0].line, 3);
  });

  test('prototype with no definition anywhere → kept, once, so calls can resolve', () => {
    const { list } = analyse(tmpDir, {
      'api.h': ['char *external_dup(const char *s);'],
      'use.c': ['char *external_dup(const char *s);', 'void run(void) { external_dup("x"); }'],
    });
    const dups = list.filter((d: any) => d.name === 'external_dup');
    assert.strictEqual(dups.length, 1, 'two declarations collapse to one node');
    assert.strictEqual(dups[0].isDeclaration, undefined);
  });

  test('function-pointer variables and struct members are not functions', () => {
    const { list } = analyse(tmpDir, { 'f.c': [
      'int (*global_cb)(int);',
      'struct ops { int (*open)(int); void (*close)(void); };',
      'typedef int (*handler_t)(int);',
      'int real(int x) { int (*local)(int) = 0; return x; }',
    ] });
    assert.deepStrictEqual(list.map((d: any) => d.name), ['real']);
  });

  test('definitions inside #ifdef branches and extern "C" blocks are found', () => {
    const { idOf } = analyse(tmpDir, { 'f.c': [
      '#ifdef _WIN32', 'int win_only(void) { return 1; }', '#else', 'int posix_only(void) { return 2; }', '#endif',
      '#ifdef __cplusplus', 'extern "C" {', '#endif',
      'int wrapped(void);',
      '#ifdef __cplusplus', '}', '#endif',
    ] });
    assert.ok(idOf('win_only') && idOf('posix_only'), 'both preprocessor branches');
    assert.ok(idOf('wrapped'), 'prototype inside the extern "C" guard');
  });

  test('macros are not functions', () => {
    const { list } = analyse(tmpDir, { 'f.c': ['#define SQ(x) ((x)*(x))', '#define LIMIT 10', 'int f(void) { return SQ(LIMIT); }'] });
    assert.deepStrictEqual(list.map((d: any) => d.name), ['f']);
  });

  test('parse-error file does not crash; other files still indexed', () => {
    const { idOf } = analyse(tmpDir, { 'good.c': ['void g(void) {}'], 'bad.c': ['~~~ this is not C ~~~'] });
    assert.ok(idOf('g'));
  });
});

// ---------------------------------------------------------------------------
// collectCalls — direct calls, callbacks, libc, and what is not tracked
// ---------------------------------------------------------------------------

suite('collectCalls (C)', () => {
  let tmpDir: string;

  suiteSetup(async () => { await cAnalyzer.init(); });
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-c-calls-')); });
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('direct call → edge; repeated calls → one edge', () => {
    const { edges, hasEdge, idOf } = analyse(tmpDir, { 'f.c': ['int helper(void) { return 1; }', 'void run(void) { helper(); helper(); }'] });
    assert.ok(hasEdge('run', 'helper'));
    assert.strictEqual(edges.filter((e: any) => e.source === idOf('run')).length, 1);
  });

  test('call across two files → edge; a recursive call → no self edge', () => {
    const { hasEdge } = analyse(tmpDir, {
      'a.c': ['int fact(int n) { return n < 2 ? 1 : n * fact(n - 1); }'],
      'b.c': ['int fact(int n);', 'int run(void) { return fact(5); }'],
    });
    assert.ok(hasEdge('run', 'fact'));
    assert.ok(!hasEdge('fact', 'fact'));
  });

  test('call into a pointer-returning function is linked (the C++ bug, on the C side)', () => {
    const { hasEdge } = analyse(tmpDir, { 'f.c': ['char *make(void) { return 0; }', 'void run(void) { char *p = make(); }'] });
    assert.ok(hasEdge('run', 'make'));
  });

  test('nested call in an argument is visited', () => {
    const { hasEdge } = analyse(tmpDir, { 'f.c': ['int a(void) { return 1; }', 'int b(int x) { return x; }', 'int run(void) { return b(a()); }'] });
    assert.ok(hasEdge('run', 'a') && hasEdge('run', 'b'));
  });

  test('libc call → library node named by header stem, language "c", one node per function', () => {
    const { libraryNodes, edges, idOf } = analyse(tmpDir, { 'f.c': [
      '#include <stdio.h>', '#include <string.h>',
      'void a(const char *s) { printf("%s", s); }',
      'void b(const char *s) { printf("%s", s); memcpy((void*)s, s, strlen(s)); }',
    ] });
    const printf = libraryNodes.find((n: any) => n.name === 'printf');
    assert.ok(printf, 'printf library node');
    assert.strictEqual(printf.libraryName, 'stdio');
    assert.strictEqual(printf.language, 'c');
    assert.strictEqual(printf.isLibrary, true);
    assert.strictEqual(printf.file, null);
    assert.strictEqual(libraryNodes.filter((n: any) => n.name === 'printf').length, 1, 'deduped across callers');
    assert.deepStrictEqual(libraryNodes.map((n: any) => `${n.libraryName}.${n.name}`).sort(), ['stdio.printf', 'string.memcpy', 'string.strlen']);
    assert.ok(edges.some((e: any) => e.source === idOf('a') && e.target === printf.id && e.isLibraryEdge === true));
  });

  test('perror and strerror belong to the headers that declare them (stdio.h, string.h), not errno.h', () => {
    // errno.h declares only `errno` and the E* macros, so no library node is named "errno".
    const { libraryNodes } = analyse(tmpDir, { 'f.c': [
      '#include <stdio.h>', '#include <string.h>', '#include <errno.h>',
      'void fail(void) { perror("open"); fprintf(stderr, "%s", strerror(errno)); }',
    ] });
    const names = libraryNodes.map((n: any) => `${n.libraryName}.${n.name}`).sort();
    assert.deepStrictEqual(names, ['stdio.fprintf', 'stdio.perror', 'string.strerror']);
  });

  test('a workspace function shadowing a libc name is linked internally, not as a library', () => {
    const { hasEdge, libraryNodes } = analyse(tmpDir, { 'f.c': ['void *memcpy(void *d, const void *s, unsigned n) { return d; }', 'void run(void) { memcpy(0, 0, 0); }'] });
    assert.ok(hasEdge('run', 'memcpy'));
    assert.strictEqual(libraryNodes.length, 0);
  });

  test('call to an unknown name (third-party or macro) → no edge, no node', () => {
    const { edges, libraryNodes } = analyse(tmpDir, { 'f.c': ['#define LOG(x) log_impl(x)', 'void run(void) { SDL_Init(0); LOG(1); }'] });
    assert.strictEqual(edges.length, 0);
    assert.strictEqual(libraryNodes.length, 0);
  });

  test('callback passed as an argument → edge from the caller to the callback', () => {
    const { hasEdge } = analyse(tmpDir, { 'f.c': [
      'int handler(int x) { return x; }',
      'void each(int (*cb)(int)) { cb(1); }',
      'void run(void) { each(handler); }',
    ] });
    assert.ok(hasEdge('run', 'handler'), 'run hands handler on');
    assert.ok(hasEdge('run', 'each'));
    assert.ok(!hasEdge('each', 'handler'), 'the call through the pointer is not resolved');
  });

  test('callback stored in a local, a struct initializer or assigned → edge', () => {
    const { hasEdge } = analyse(tmpDir, { 'f.c': [
      'int my_open(int x) { return x; }',
      'void my_close(void) {}',
      'int my_read(void) { return 0; }',
      'int fallback(void) { return 0; }',
      'struct ops { int (*open)(int); void (*close)(void); int (*read)(void); };',
      'int (*pick(void))(void) { return fallback; }',
      'void run(void) {',
      '  int (*f)(int) = my_open;',
      '  struct ops o = { .open = my_open, .close = my_close };',
      '  o.read = my_read;',
      '  o.open(1); (*f)(2); o.read();',
      '}',
    ] });
    assert.ok(hasEdge('run', 'my_open'), 'initializer and designated initializer');
    assert.ok(hasEdge('run', 'my_close'), 'designated initializer');
    assert.ok(hasEdge('run', 'my_read'), 'assignment');
    assert.ok(hasEdge('pick', 'fallback'), 'returned function');
  });

  test('a function table at file scope has no caller → no edge, no crash', () => {
    const { edges } = analyse(tmpDir, { 'f.c': [
      'int my_open(int x) { return x; }',
      'struct ops { int (*open)(int); };',
      'static const struct ops table = { .open = my_open };',
    ] });
    assert.strictEqual(edges.length, 0);
  });

  test('a bare identifier that is not a call or a hand-over (comparison, sizeof) → no edge', () => {
    const { hasEdge } = analyse(tmpDir, { 'f.c': [
      'int target(void) { return 0; }',
      'int run(void) { return target != 0 && sizeof(target) > 0; }',
    ] });
    assert.ok(!hasEdge('run', 'target'));
  });

  test('calls inside a header\'s inline function are attributed to it', () => {
    const { hasEdge } = analyse(tmpDir, {
      'sds.h': ['#include <string.h>', 'static inline unsigned len(const char *s) { return strlen(s); }', 'unsigned twice(const char *s);'],
      'sds.c': ['#include "sds.h"', 'unsigned twice(const char *s) { return 2 * len(s); }'],
    });
    assert.ok(hasEdge('twice', 'len'));
  });

  test('call to a prototype with no definition → edge to the surviving declaration node', () => {
    const { hasEdge, idOf, list } = analyse(tmpDir, {
      'ext.h': ['int ext_init(void);'],
      'use.c': ['#include "ext.h"', 'void run(void) { ext_init(); }'],
    });
    assert.ok(idOf('ext_init'));
    assert.ok(list.find((d: any) => d.name === 'ext_init').file.endsWith('ext.h'));
    assert.ok(hasEdge('run', 'ext_init'));
  });
});

// ---------------------------------------------------------------------------
// parse cache — each file is parsed once per analysis run
// ---------------------------------------------------------------------------

suite('parse cache (C)', () => {
  let tmpDir: string;

  suiteSetup(async () => { await cAnalyzer.init(); });
  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-c-cache-')); });
  teardown(() => { cAnalyzer.clearTreeCache(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

  test('collectDefinitions + collectCalls parse each file once, not twice', () => {
    const a = path.join(tmpDir, 'a.c');
    const b = path.join(tmpDir, 'b.c');
    fs.writeFileSync(a, 'int helper(void) { return 1; }\n');
    fs.writeFileSync(b, 'int helper(void);\nvoid run(void) { helper(); }\n');
    cAnalyzer.clearTreeCache();
    cAnalyzer._stats.parses = 0;
    const defs = collectDefinitions([a, b]);
    collectCalls([a, b], defs, tmpDir);
    assert.strictEqual(cAnalyzer._stats.parses, 2);
  });
});

// ---------------------------------------------------------------------------
// end to end: both analyzer processes on one mixed C / C++ workspace
// ---------------------------------------------------------------------------

suite('analyze_c.js and analyze_cpp.js as processes', () => {
  let tmpDir: string;

  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-c-e2e-')); });
  teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function runAnalyzer(script: string, args: string[]) {
    const out = cp.execFileSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8', timeout: 60_000 });
    return JSON.parse(out) as { nodes: any[]; edges: any[]; files: string[] };
  }

  function writeWorkspace() {
    const write = (rel: string, text: string) => {
      const file = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    };
    return {
      cSrc:  write('clib/str.c', '#include "str.h"\nunsigned str_len(const char *s) { unsigned n = 0; while (*s++) n++; return n; }\n'),
      cHdr:  write('clib/str.h', 'unsigned str_len(const char *s);\n'),
      cppSrc: write('app/main.cpp', '#include "main.h"\nvoid App::run() { int new_count = 0; }\n'),
      cppHdr: write('app/main.h', 'class App { public: void run(); };\n'),
    };
  }

  test('full walk: each file lands in exactly one analyzer, headers by the directory rule', () => {
    const ws = writeWorkspace();
    const c = runAnalyzer('analyze_c.js', [tmpDir]);
    const cpp = runAnalyzer('analyze_cpp.js', [tmpDir]);
    assert.deepStrictEqual(c.files.sort(), [ws.cSrc, ws.cHdr].sort());
    assert.deepStrictEqual(cpp.files.sort(), [ws.cppSrc, ws.cppHdr].sort());
    assert.deepStrictEqual(c.nodes.map(n => [n.name, n.language]), [['str_len', 'c']]);
    assert.deepStrictEqual(cpp.nodes.map(n => [n.name, n.className, n.language]), [['run', 'App', 'cpp']]);
  });

  test('--files subset with a lone C header: still C, and the C++ analyzer leaves it alone', () => {
    const ws = writeWorkspace();
    const list = path.join(tmpDir, 'list.txt');
    fs.writeFileSync(list, [ws.cHdr, ws.cppHdr, path.join(tmpDir, 'other.py')].join('\n'));
    const c = runAnalyzer('analyze_c.js', [tmpDir, '--files', list]);
    const cpp = runAnalyzer('analyze_cpp.js', [tmpDir, '--files', list]);
    assert.deepStrictEqual(c.files, [ws.cHdr]);
    assert.deepStrictEqual(cpp.files, [ws.cppHdr]);
    assert.deepStrictEqual(c.nodes.map(n => n.name), ['str_len'], 'the lone prototype is kept as a node');
  });

  test('a run with no C files prints an empty graph and exits 0', () => {
    fs.writeFileSync(path.join(tmpDir, 'only.py'), 'def f(): pass\n');
    const c = runAnalyzer('analyze_c.js', [tmpDir]);
    assert.deepStrictEqual(c, { nodes: [], edges: [], files: [] });
  });
});
