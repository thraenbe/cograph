import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cppAnalyzer = require('../../../scripts/analyze_cpp.js');
const { collectCppFiles, collectDefinitions, collectCalls } = cppAnalyzer;

// web-tree-sitter is async to initialise — load the WASM runtime + C++ grammar
// once before any suite parses. cppAnalyzer.init() is idempotent.

// ---------------------------------------------------------------------------
// collectCppFiles — extension inclusion + skip rules
// ---------------------------------------------------------------------------

suite('collectCppFiles', () => {
  let tmpDir: string;

  suiteSetup(async () => { await cppAnalyzer.init(); });

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-cpp-files-'));

    fs.mkdirSync(path.join(tmpDir, 'src'));
    for (const ext of ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.h']) {
      fs.writeFileSync(path.join(tmpDir, 'src', `Foo${ext}`), '// stub\n');
    }

    // skip dirs
    for (const skip of ['node_modules', 'out', 'dist', 'target', 'build', 'CMakeFiles', 'cmake-build-debug']) {
      fs.mkdirSync(path.join(tmpDir, skip), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, skip, 'Skip.cpp'), '// stub\n');
    }

    // hidden dir
    fs.mkdirSync(path.join(tmpDir, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.vscode', 'Hidden.cpp'), '// stub\n');

    // non-C++ files
    fs.writeFileSync(path.join(tmpDir, 'src', 'README.md'), 'docs');
    fs.writeFileSync(path.join(tmpDir, 'src', 'plain.c'), 'int main() { return 0; }');
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('includes all C++ extensions (.cpp .cc .cxx .c++ .hpp .hh .hxx .h++ .h)', () => {
    const files: string[] = collectCppFiles(tmpDir);
    for (const ext of ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.h']) {
      assert.ok(
        files.some(f => f.endsWith(`Foo${ext}`)),
        `Foo${ext} should be included`,
      );
    }
  });

  test('excludes node_modules/, out/, dist/, target/, build/, CMakeFiles/, cmake-build-*/', () => {
    const files: string[] = collectCppFiles(tmpDir);
    for (const skip of ['node_modules', 'out', 'dist', 'target', 'build', 'CMakeFiles', 'cmake-build-debug']) {
      assert.ok(
        !files.some(f => f.includes(path.sep + skip + path.sep)),
        `${skip}/ should be excluded`,
      );
    }
  });

  test('excludes hidden directories', () => {
    const files: string[] = collectCppFiles(tmpDir);
    assert.ok(!files.some(f => f.includes('.vscode')));
  });

  test('excludes non-C++ files (.md, .c)', () => {
    const files: string[] = collectCppFiles(tmpDir);
    assert.ok(!files.some(f => f.endsWith('.md')));
    assert.ok(!files.some(f => f.endsWith('.c')));
  });
});

// ---------------------------------------------------------------------------
// collectDefinitions — function / class / inheritance / metadata
// ---------------------------------------------------------------------------

suite('collectDefinitions (C++)', () => {
  let tmpDir: string;

  suiteSetup(async () => { await cppAnalyzer.init(); });

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-cpp-defs-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('free function → detected without className', () => {
    const file = path.join(tmpDir, 'free.cpp');
    fs.writeFileSync(file, 'int add(int a, int b) { return a + b; }\n');
    const defs = collectDefinitions([file]);
    const add: any = Object.values(defs).find((d: any) => d.name === 'add');
    assert.ok(add, 'add free function should be detected');
    assert.strictEqual(add.className, undefined);
    assert.strictEqual(add.language, 'cpp');
  });

  test('class method via class_specifier → detected with className', () => {
    const file = path.join(tmpDir, 'Greeter.cpp');
    fs.writeFileSync(file, 'class Greeter { public: void greet() {} };\n');
    const defs = collectDefinitions([file]);
    const greet: any = Object.values(defs).find((d: any) => d.name === 'greet');
    assert.ok(greet, 'greet method should be detected');
    assert.strictEqual(greet.className, 'Greeter');
  });

  test('struct method → detected with className', () => {
    const file = path.join(tmpDir, 'Point.cpp');
    fs.writeFileSync(file, 'struct Point { void move() {} };\n');
    const defs = collectDefinitions([file]);
    const move: any = Object.values(defs).find((d: any) => d.name === 'move');
    assert.ok(move, 'struct method should be detected');
    assert.strictEqual(move.className, 'Point');
  });

  test('out-of-line definition (Foo::bar) → single node at the definition', () => {
    const file = path.join(tmpDir, 'Foo.cpp');
    fs.writeFileSync(file, 'class Foo { public: void bar(); };\nvoid Foo::bar() {}\n');
    const defs = collectDefinitions([file]);
    // The in-class declaration is redundant once the out-of-line definition
    // exists — only the definition (line 2) should survive.
    const bars = Object.values(defs).filter((d: any) => d.name === 'bar') as any[];
    assert.strictEqual(bars.length, 1, 'declaration deduplicated against definition');
    assert.strictEqual(bars[0].className, 'Foo');
    assert.strictEqual(bars[0].line, 2, 'surviving node is the out-of-line definition');
  });

  test('constructor → name "constructor", in-class form', () => {
    const file = path.join(tmpDir, 'Ctor.cpp');
    fs.writeFileSync(file, 'class Foo { public: Foo() {} };\n');
    const defs = collectDefinitions([file]);
    const ctor: any = Object.values(defs).find((d: any) => d.name === 'constructor');
    assert.ok(ctor, 'in-class constructor should be named "constructor"');
    assert.strictEqual(ctor.className, 'Foo');
  });

  test('constructor → name "constructor", out-of-line form', () => {
    const file = path.join(tmpDir, 'Ctor2.cpp');
    fs.writeFileSync(file, 'class Foo { public: Foo(); };\nFoo::Foo() {}\n');
    const defs = collectDefinitions([file]);
    const ctors = Object.values(defs).filter((d: any) => d.name === 'constructor') as any[];
    assert.ok(ctors.length >= 1, 'out-of-line constructor should be named "constructor"');
    assert.ok(ctors.every(c => c.className === 'Foo'));
  });

  test('destructor → name "destructor"', () => {
    const file = path.join(tmpDir, 'Dtor.cpp');
    fs.writeFileSync(file, 'class Foo { public: ~Foo() {} };\nFoo::~Foo() {}\n');
    const defs = collectDefinitions([file]);
    const dtors = Object.values(defs).filter((d: any) => d.name === 'destructor') as any[];
    assert.ok(dtors.length >= 1, 'destructor should be named "destructor"');
    assert.ok(dtors.every(d => d.className === 'Foo'));
  });

  test('class extends → classExtends captured', () => {
    const file = path.join(tmpDir, 'Child.cpp');
    fs.writeFileSync(file, 'class Parent {}; class Child : public Parent { public: void m() {} };\n');
    const defs = collectDefinitions([file]);
    const m: any = Object.values(defs).find((d: any) => d.name === 'm');
    assert.ok(m);
    assert.strictEqual(m.classExtends, 'Parent');
  });

  test('multi-inheritance: first base → classExtends, rest → classImplements', () => {
    const file = path.join(tmpDir, 'Multi.cpp');
    fs.writeFileSync(file, 'class A {}; class B {}; class C : public A, public B { public: void m() {} };\n');
    const defs = collectDefinitions([file]);
    const m: any = Object.values(defs).find((d: any) => d.name === 'm');
    assert.ok(m);
    assert.strictEqual(m.classExtends, 'A');
    assert.deepStrictEqual(m.classImplements, ['B']);
  });

  test('definition metadata: id includes file::name::line', () => {
    const file = path.join(tmpDir, 'Meta.cpp');
    fs.writeFileSync(file, 'class Meta {\n public:\n  void only() {}\n};\n');
    const defs = collectDefinitions([file]);
    const only: any = Object.values(defs).find((d: any) => d.name === 'only');
    assert.ok(only);
    assert.strictEqual(only.id, `${file}::only::3`);
    assert.strictEqual(only.file, file);
    assert.strictEqual(only.line, 3);
  });

  test('parse-error file does not crash; other files still indexed', () => {
    const good = path.join(tmpDir, 'Good.cpp');
    const bad  = path.join(tmpDir, 'Bad.cpp');
    fs.writeFileSync(good, 'void g() {}\n');
    fs.writeFileSync(bad,  '~~~ this is not valid C++ ~~~\n');
    const defs = collectDefinitions([good, bad]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('g'));
  });
});

// ---------------------------------------------------------------------------
// collectDefinitions — declaration vs. definition dedup (visual-noise removal)
// ---------------------------------------------------------------------------

suite('collectDefinitions — declaration/definition dedup', () => {
  let tmpDir: string;

  suiteSetup(async () => { await cppAnalyzer.init(); });

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-cpp-dedup-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('header declaration + .cpp definition → single node (the definition)', () => {
    const header = path.join(tmpDir, 'Widget.h');
    const source = path.join(tmpDir, 'Widget.cpp');
    fs.writeFileSync(header, 'class Widget { public: void draw(); };\n');
    fs.writeFileSync(source, '#include "Widget.h"\nvoid Widget::draw() {}\n');
    const defs = collectDefinitions([header, source]);
    const draws = Object.values(defs).filter((d: any) => d.name === 'draw') as any[];
    assert.strictEqual(draws.length, 1, 'only one draw node — declaration pruned');
    assert.ok(draws[0].file.endsWith('Widget.cpp'), 'surviving node is the definition');
    assert.strictEqual(draws[0].className, 'Widget');
  });

  test('free-function declaration + definition → single node', () => {
    const header = path.join(tmpDir, 'util.h');
    const source = path.join(tmpDir, 'util.cpp');
    fs.writeFileSync(header, 'int compute(int x);\n');
    fs.writeFileSync(source, '#include "util.h"\nint compute(int x) { return x; }\n');
    const defs = collectDefinitions([header, source]);
    const computes = Object.values(defs).filter((d: any) => d.name === 'compute') as any[];
    assert.strictEqual(computes.length, 1);
    assert.ok(computes[0].file.endsWith('util.cpp'));
  });

  test('declaration with no definition anywhere → kept so calls can resolve', () => {
    const header = path.join(tmpDir, 'Iface.h');
    fs.writeFileSync(header, 'class Iface { public: void run(); };\n');
    const defs = collectDefinitions([header]);
    const runs = Object.values(defs).filter((d: any) => d.name === 'run') as any[];
    assert.strictEqual(runs.length, 1, 'lone declaration is retained');
    assert.strictEqual(runs[0].className, 'Iface');
  });

  test('internal "isDeclaration" marker never leaks into output', () => {
    const header = path.join(tmpDir, 'Iface.h');
    fs.writeFileSync(header, 'class Iface { public: void run(); void stop(); };\n');
    const defs = collectDefinitions([header]);
    for (const d of Object.values(defs) as any[]) {
      assert.strictEqual(d.isDeclaration, undefined, `${d.name} must not carry isDeclaration`);
    }
  });
});

// ---------------------------------------------------------------------------
// collectCalls — internal edges + library nodes + dedupe
// ---------------------------------------------------------------------------

suite('collectCalls (C++)', () => {
  let tmpDir: string;

  suiteSetup(async () => { await cppAnalyzer.init(); });

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-cpp-calls-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('internal bare call → edge created', () => {
    const file = path.join(tmpDir, 'Internal.cpp');
    fs.writeFileSync(file, [
      'int helper() { return 1; }',
      'void run() { helper(); }',
    ].join('\n') + '\n');
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const list = Object.values(defs) as any[];
    const helperId = list.find((d: any) => d.name === 'helper')?.id;
    const runId    = list.find((d: any) => d.name === 'run')?.id;
    assert.ok(helperId && runId);
    assert.ok(edges.some((e: any) => e.source === runId && e.target === helperId));
  });

  test('this->method() → internal edge created', () => {
    const file = path.join(tmpDir, 'ThisCall.cpp');
    fs.writeFileSync(file, [
      'class Foo {',
      ' public:',
      '  void helper() {}',
      '  void run() { this->helper(); }',
      '};',
    ].join('\n') + '\n');
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const list = Object.values(defs) as any[];
    const helperId = list.find((d: any) => d.name === 'helper')?.id;
    const runId    = list.find((d: any) => d.name === 'run')?.id;
    assert.ok(helperId && runId);
    assert.ok(edges.some((e: any) => e.source === runId && e.target === helperId));
  });

  test('std::sort → library node with libraryName "std"', () => {
    const file = path.join(tmpDir, 'WithStd.cpp');
    fs.writeFileSync(file, [
      '#include <algorithm>',
      '#include <vector>',
      'void run() { std::vector<int> v; std::sort(v.begin(), v.end()); }',
    ].join('\n') + '\n');
    const defs = collectDefinitions([file]);
    const { libraryNodes, edges } = collectCalls([file], defs);
    const lib = libraryNodes.find((n: any) => n.libraryName === 'std' && n.name === 'sort');
    assert.ok(lib, 'std::sort library node should exist');
    assert.strictEqual(lib.language, 'cpp');
    assert.strictEqual(lib.isLibrary, true);
    assert.strictEqual(lib.file, null);
    assert.ok(edges.some((e: any) => e.isLibraryEdge === true));
  });

  test('std::ranges::sort → library node with libraryName "std::ranges"', () => {
    const file = path.join(tmpDir, 'Ranges.cpp');
    fs.writeFileSync(file, [
      '#include <algorithm>',
      '#include <vector>',
      'void run() { std::vector<int> v; std::ranges::sort(v); }',
    ].join('\n') + '\n');
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    const lib = libraryNodes.find((n: any) => n.libraryName === 'std::ranges' && n.name === 'sort');
    assert.ok(lib, 'std::ranges::sort library node should exist');
  });

  test('boost::lexical_cast<int>("3") → library node with libraryName "boost"', () => {
    const file = path.join(tmpDir, 'Boost.cpp');
    fs.writeFileSync(file, [
      '#include <boost/lexical_cast.hpp>',
      'int parse() { return boost::lexical_cast<int>("3"); }',
    ].join('\n') + '\n');
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    const lib = libraryNodes.find((n: any) => n.libraryName === 'boost' && n.name === 'lexical_cast');
    assert.ok(lib, 'boost::lexical_cast library node should exist');
  });

  test('repeated calls → edges deduplicated', () => {
    const file = path.join(tmpDir, 'Dup.cpp');
    fs.writeFileSync(file, [
      'void helper() {}',
      'void caller() { helper(); helper(); helper(); }',
    ].join('\n') + '\n');
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const list = Object.values(defs) as any[];
    const helperId = list.find((d: any) => d.name === 'helper')?.id;
    const callerId = list.find((d: any) => d.name === 'caller')?.id;
    const matching = edges.filter((e: any) => e.source === callerId && e.target === helperId);
    assert.strictEqual(matching.length, 1);
  });

  test('library node dedupe across multiple calls', () => {
    const file = path.join(tmpDir, 'LibDup.cpp');
    fs.writeFileSync(file, [
      '#include <algorithm>',
      '#include <vector>',
      'void a() { std::vector<int> v; std::sort(v.begin(), v.end()); }',
      'void b() { std::vector<int> v; std::sort(v.begin(), v.end()); }',
    ].join('\n') + '\n');
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    const matching = libraryNodes.filter((n: any) => n.libraryName === 'std' && n.name === 'sort');
    assert.strictEqual(matching.length, 1);
  });

  test('call to unknown name → no internal edge created', () => {
    const file = path.join(tmpDir, 'Unknown.cpp');
    fs.writeFileSync(file, 'void run() { somethingUndefined(); }\n');
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const list = Object.values(defs) as any[];
    const runId = list.find((d: any) => d.name === 'run')?.id;
    const internal = edges.filter((e: any) => e.source === runId && !e.isLibraryEdge);
    assert.strictEqual(internal.length, 0);
  });

  test('internal call across two files → edge created', () => {
    const fileA = path.join(tmpDir, 'A.cpp');
    const fileB = path.join(tmpDir, 'B.cpp');
    fs.writeFileSync(fileA, 'void helper() {}\n');
    fs.writeFileSync(fileB, 'void run() { helper(); }\n');
    const defs = collectDefinitions([fileA, fileB]);
    const { edges } = collectCalls([fileA, fileB], defs);
    const list = Object.values(defs) as any[];
    const helperId = list.find((d: any) => d.name === 'helper')?.id;
    const runId    = list.find((d: any) => d.name === 'run')?.id;
    assert.ok(helperId && runId);
    assert.ok(edges.some((e: any) => e.source === runId && e.target === helperId));
  });

  test('call to a header-declared method → one edge to the definition only', () => {
    // Without declaration dedup this produced two edges (one to the header
    // declaration, one to the .cpp definition) for a single logical call.
    const header = path.join(tmpDir, 'Svc.h');
    const source = path.join(tmpDir, 'Svc.cpp');
    fs.writeFileSync(header, 'class Svc { public: void start(); };\n');
    fs.writeFileSync(source, [
      '#include "Svc.h"',
      'void Svc::start() {}',
      'void boot() { Svc s; s.start(); }',
    ].join('\n') + '\n');
    const defs = collectDefinitions([header, source]);
    const { edges } = collectCalls([header, source], defs);
    const list = Object.values(defs) as any[];
    const starts = list.filter((d: any) => d.name === 'start');
    assert.strictEqual(starts.length, 1, 'one start node — header declaration pruned');
    const bootId = list.find((d: any) => d.name === 'boot')?.id;
    const edgesToStart = edges.filter((e: any) => e.source === bootId && e.target === starts[0].id);
    assert.strictEqual(edgesToStart.length, 1, 'exactly one edge to the definition');
  });
});
