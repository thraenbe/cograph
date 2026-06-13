import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const javaAnalyzer = require('../../../scripts/analyze_java.js');
const { collectJavaFiles, collectDefinitions, collectCalls } = javaAnalyzer;

// ---------------------------------------------------------------------------
// collectJavaFiles — extension inclusion + skip rules
// ---------------------------------------------------------------------------

suite('collectJavaFiles', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-java-files-'));

    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'Foo.java'), 'class Foo {}\n');

    // node_modules / out / dist / target / build → excluded
    for (const skip of ['node_modules', 'out', 'dist', 'target', 'build']) {
      fs.mkdirSync(path.join(tmpDir, skip), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, skip, 'Skip.java'), 'class Skip {}\n');
    }

    // hidden dir → excluded
    fs.mkdirSync(path.join(tmpDir, '.idea'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.idea', 'Hidden.java'), 'class Hidden {}\n');

    // non-.java file → excluded
    fs.writeFileSync(path.join(tmpDir, 'src', 'README.md'), 'docs');
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('includes .java files', () => {
    const files: string[] = collectJavaFiles(tmpDir);
    assert.ok(files.some(f => f.endsWith(path.join('src', 'Foo.java'))));
  });

  test('excludes node_modules/, out/, dist/, target/, build/', () => {
    const files: string[] = collectJavaFiles(tmpDir);
    for (const skip of ['node_modules', 'out', 'dist', 'target', 'build']) {
      assert.ok(
        !files.some(f => f.includes(path.sep + skip + path.sep)),
        `${skip}/ should be excluded`,
      );
    }
  });

  test('excludes hidden directories', () => {
    const files: string[] = collectJavaFiles(tmpDir);
    assert.ok(!files.some(f => f.includes('.idea')));
  });

  test('excludes non-.java files', () => {
    const files: string[] = collectJavaFiles(tmpDir);
    assert.ok(!files.some(f => f.endsWith('.md')));
  });
});

// ---------------------------------------------------------------------------
// collectDefinitions — class/interface/method/constructor detection + metadata
// ---------------------------------------------------------------------------

suite('collectDefinitions (Java)', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-java-defs-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('class method → detected with className', () => {
    const file = path.join(tmpDir, 'Greeter.java');
    fs.writeFileSync(file, 'class Greeter {\n  public void greet() {}\n}\n');
    const defs = collectDefinitions([file]);
    const greet: any = Object.values(defs).find((d: any) => d.name === 'greet');
    assert.ok(greet, 'greet method should be detected');
    assert.strictEqual(greet.className, 'Greeter');
    assert.strictEqual(greet.language, 'java');
  });

  test('constructor → detected with name "constructor"', () => {
    const file = path.join(tmpDir, 'Foo.java');
    fs.writeFileSync(file, 'class Foo {\n  public Foo() {}\n}\n');
    const defs = collectDefinitions([file]);
    const ctor: any = Object.values(defs).find((d: any) => d.name === 'constructor');
    assert.ok(ctor, 'constructor should be detected');
    assert.strictEqual(ctor.className, 'Foo');
  });

  test('class extends → classExtends captured', () => {
    const file = path.join(tmpDir, 'Child.java');
    fs.writeFileSync(file, 'class Child extends Parent {\n  void m() {}\n}\n');
    const defs = collectDefinitions([file]);
    const m: any = Object.values(defs).find((d: any) => d.name === 'm');
    assert.ok(m, 'method should be detected');
    assert.strictEqual(m.classExtends, 'Parent');
  });

  test('class implements → classImplements captured', () => {
    const file = path.join(tmpDir, 'Worker.java');
    fs.writeFileSync(file, 'class Worker implements Runnable, Comparable<Worker> {\n  public void run() {}\n}\n');
    const defs = collectDefinitions([file]);
    const run: any = Object.values(defs).find((d: any) => d.name === 'run');
    assert.ok(run, 'run method should be detected');
    assert.deepStrictEqual(run.classImplements, ['Runnable', 'Comparable']);
  });

  test('interface method → detected with className', () => {
    const file = path.join(tmpDir, 'MyIface.java');
    fs.writeFileSync(file, 'interface MyIface {\n  void doIt();\n}\n');
    const defs = collectDefinitions([file]);
    const doIt: any = Object.values(defs).find((d: any) => d.name === 'doIt');
    assert.ok(doIt, 'interface method should be detected');
    assert.strictEqual(doIt.className, 'MyIface');
  });

  test('definition metadata: id includes file::name::line', () => {
    const file = path.join(tmpDir, 'Meta.java');
    fs.writeFileSync(file, 'class Meta {\n  void only() {}\n}\n');
    const defs = collectDefinitions([file]);
    const only: any = Object.values(defs).find((d: any) => d.name === 'only');
    assert.ok(only);
    assert.strictEqual(only.id, `${file}::only::2`);
    assert.strictEqual(only.file, file);
    assert.strictEqual(only.line, 2);
  });

  test('parse-error file → does not crash, returns other files normally', () => {
    const good = path.join(tmpDir, 'Good.java');
    const bad  = path.join(tmpDir, 'Bad.java');
    fs.writeFileSync(good, 'class Good { void g() {} }\n');
    fs.writeFileSync(bad,  'class { this is not valid java\n');
    const defs = collectDefinitions([good, bad]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('g'), 'good file should still produce definitions');
  });
});

// ---------------------------------------------------------------------------
// collectCalls — internal edges + library nodes + dedupe
// ---------------------------------------------------------------------------

suite('collectCalls (Java)', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-java-calls-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('internal method call → edge created', () => {
    const file = path.join(tmpDir, 'Internal.java');
    fs.writeFileSync(file, [
      'class Internal {',
      '  int helper() { return 1; }',
      '  void run() { helper(); }',
      '}',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const list = Object.values(defs) as any[];
    const helperId = list.find((d: any) => d.name === 'helper')?.id;
    const runId    = list.find((d: any) => d.name === 'run')?.id;
    assert.ok(helperId && runId);
    assert.ok(edges.some((e: any) => e.source === runId && e.target === helperId));
  });

  test('this.method() → internal edge created', () => {
    const file = path.join(tmpDir, 'ThisCall.java');
    fs.writeFileSync(file, [
      'class ThisCall {',
      '  void helper() {}',
      '  void run() { this.helper(); }',
      '}',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const list = Object.values(defs) as any[];
    const helperId = list.find((d: any) => d.name === 'helper')?.id;
    const runId    = list.find((d: any) => d.name === 'run')?.id;
    assert.ok(edges.some((e: any) => e.source === runId && e.target === helperId));
  });

  test('JDK library call → library node created with java.* libraryName', () => {
    const file = path.join(tmpDir, 'WithJdk.java');
    fs.writeFileSync(file, [
      'import java.util.List;',
      'class WithJdk {',
      '  void run() { List.of(1, 2); }',
      '}',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes, edges } = collectCalls([file], defs);
    const lib = libraryNodes.find((n: any) => n.libraryName === 'java.util' && n.name === 'of');
    assert.ok(lib, 'java.util library node for List.of should exist');
    assert.strictEqual(lib.language, 'java');
    assert.strictEqual(lib.isLibrary, true);
    assert.strictEqual(lib.file, null);
    assert.ok(edges.some((e: any) => e.isLibraryEdge === true));
  });

  test('third-party library call → library node created', () => {
    const file = path.join(tmpDir, 'WithLib.java');
    fs.writeFileSync(file, [
      'import org.apache.commons.lang3.StringUtils;',
      'class WithLib {',
      '  boolean check() { return StringUtils.isEmpty("x"); }',
      '}',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    const lib = libraryNodes.find((n: any) =>
      n.libraryName === 'org.apache.commons.lang3' && n.name === 'isEmpty');
    assert.ok(lib, 'StringUtils.isEmpty library node should exist');
  });

  test('repeated calls → deduplicated', () => {
    const file = path.join(tmpDir, 'Dup.java');
    fs.writeFileSync(file, [
      'class Dup {',
      '  void helper() {}',
      '  void caller() { helper(); helper(); helper(); }',
      '}',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const list = Object.values(defs) as any[];
    const helperId = list.find((d: any) => d.name === 'helper')?.id;
    const callerId = list.find((d: any) => d.name === 'caller')?.id;
    const matching = edges.filter((e: any) => e.source === callerId && e.target === helperId);
    assert.strictEqual(matching.length, 1);
  });

  test('library node dedupe across multiple calls', () => {
    const file = path.join(tmpDir, 'LibDup.java');
    fs.writeFileSync(file, [
      'import org.apache.commons.lang3.StringUtils;',
      'class LibDup {',
      '  void a() { StringUtils.isEmpty("x"); }',
      '  void b() { StringUtils.isEmpty("y"); }',
      '}',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    const matching = libraryNodes.filter((n: any) =>
      n.libraryName === 'org.apache.commons.lang3' && n.name === 'isEmpty');
    assert.strictEqual(matching.length, 1, 'only one library node despite two calls');
  });

  test('call to unknown method → no internal edge created', () => {
    const file = path.join(tmpDir, 'Unknown.java');
    fs.writeFileSync(file, [
      'class Unknown {',
      '  void run() { somethingUndefined(); }',
      '}',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const list = Object.values(defs) as any[];
    const runId = list.find((d: any) => d.name === 'run')?.id;
    const internal = edges.filter((e: any) => e.source === runId && !e.isLibraryEdge);
    assert.strictEqual(internal.length, 0);
  });

  test('internal call across two files → edge created', () => {
    const fileA = path.join(tmpDir, 'A.java');
    const fileB = path.join(tmpDir, 'B.java');
    fs.writeFileSync(fileA, 'class A {\n  void helper() {}\n}\n');
    fs.writeFileSync(fileB, 'class B {\n  void run() { helper(); }\n}\n');
    const defs = collectDefinitions([fileA, fileB]);
    const { edges } = collectCalls([fileA, fileB], defs);
    const list = Object.values(defs) as any[];
    const helperId = list.find((d: any) => d.name === 'helper')?.id;
    const runId    = list.find((d: any) => d.name === 'run')?.id;
    assert.ok(helperId && runId);
    assert.ok(edges.some((e: any) => e.source === runId && e.target === helperId));
  });
});

// ---------------------------------------------------------------------------
// parse cache — each file is parsed once per analysis run (single-parse)
// ---------------------------------------------------------------------------

suite('parse cache (single-parse, Java)', () => {
  let tmpDir: string;

  setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-java-cache-')); });
  teardown(() => {
    javaAnalyzer.clearCstCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('collectDefinitions + collectCalls parse each file once, not twice', () => {
    const fileA = path.join(tmpDir, 'A.java');
    const fileB = path.join(tmpDir, 'B.java');
    fs.writeFileSync(fileA, 'class A {\n  void helper() {}\n}\n');
    fs.writeFileSync(fileB, 'class B {\n  void run() { helper(); }\n}\n');
    const files = [fileA, fileB];

    javaAnalyzer.clearCstCache();
    javaAnalyzer._stats.parses = 0;
    const defs = collectDefinitions(files);
    collectCalls(files, defs);
    assert.strictEqual(javaAnalyzer._stats.parses, files.length,
      'two files → two parses across both passes (cache reused), not four');
  });
});
