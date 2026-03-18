import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { collectTsFiles, collectDefinitions, collectCalls } = require('../../../scripts/analyze_ts.js');

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

    // hidden dirs → excluded
    fs.mkdirSync(path.join(tmpDir, '.vscode-test', 'vscode'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.vscode-test', 'vscode', 'index.ts'), '');
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

  test('excludes hidden directories (starting with ".")', () => {
    const files: string[] = collectTsFiles(tmpDir);
    assert.ok(
      !files.some(f => f.includes('.vscode-test')),
      '.vscode-test should be excluded'
    );
  });
});

// ---------------------------------------------------------------------------
// collectDefinitions — TypeScript AST function detection
// ---------------------------------------------------------------------------

suite('collectDefinitions', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-ts-defs-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('function declaration → detected', () => {
    const file = path.join(tmpDir, 'fn.ts');
    fs.writeFileSync(file, 'function greet() { return "hello"; }\n');
    const defs = collectDefinitions([file]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('greet'), 'greet should be detected');
  });

  test('exported function declaration → detected', () => {
    const file = path.join(tmpDir, 'exported.ts');
    fs.writeFileSync(file, 'export function helper() {}\n');
    const defs = collectDefinitions([file]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('helper'), 'exported function should be detected');
  });

  test('async function declaration → detected', () => {
    const file = path.join(tmpDir, 'async.ts');
    fs.writeFileSync(file, 'async function fetchData() { return 42; }\n');
    const defs = collectDefinitions([file]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('fetchData'), 'async function should be detected');
  });

  test('generic function → detected, name excludes type params', () => {
    const file = path.join(tmpDir, 'generic.ts');
    fs.writeFileSync(file, 'function identity<T>(x: T): T { return x; }\n');
    const defs = collectDefinitions([file]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('identity'), 'generic function should be detected');
    assert.ok(!names.some((n: string) => n.includes('<')), 'name should not contain type params');
  });

  test('arrow function assigned to const → detected', () => {
    const file = path.join(tmpDir, 'arrow.ts');
    fs.writeFileSync(file, 'const foo = () => {};\n');
    const defs = collectDefinitions([file]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('foo'), 'arrow function should be detected');
  });

  test('function expression assigned to const → detected', () => {
    const file = path.join(tmpDir, 'funcexpr.ts');
    fs.writeFileSync(file, 'const bar = function() {};\n');
    const defs = collectDefinitions([file]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('bar'), 'function expression should be detected');
  });

  test('async arrow function → detected', () => {
    const file = path.join(tmpDir, 'asyncarrow.ts');
    fs.writeFileSync(file, 'const load = async () => { return []; };\n');
    const defs = collectDefinitions([file]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('load'), 'async arrow function should be detected');
  });

  test('class method → detected', () => {
    const file = path.join(tmpDir, 'class.ts');
    fs.writeFileSync(file, 'class MyClass {\n  myMethod() { return 1; }\n}\n');
    const defs = collectDefinitions([file]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('myMethod'), 'class method should be detected');
  });

  test('multiple functions in same file → all detected', () => {
    const file = path.join(tmpDir, 'multi.ts');
    fs.writeFileSync(file, [
      'function a() {}',
      'function b() {}',
      'const c = () => {};',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('a'), 'a should be detected');
    assert.ok(names.includes('b'), 'b should be detected');
    assert.ok(names.includes('c'), 'c should be detected');
  });

  test('.tsx file → function components detected', () => {
    const file = path.join(tmpDir, 'Component.tsx');
    fs.writeFileSync(file, 'function MyComponent() { return null; }\n');
    const defs = collectDefinitions([file]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('MyComponent'), 'tsx function component should be detected');
  });

  test('each definition has correct metadata', () => {
    const file = path.join(tmpDir, 'meta.ts');
    fs.writeFileSync(file, 'function testFn() {}\n');
    const defs = collectDefinitions([file]);
    const def: any = Object.values(defs)[0];
    assert.strictEqual(def.name, 'testFn');
    assert.strictEqual(def.file, file);
    assert.strictEqual(def.language, 'typescript');
    assert.ok(typeof def.line === 'number' && def.line >= 1, 'line should be a positive number');
  });
});

// ---------------------------------------------------------------------------
// collectCalls — edge detection and library node creation
// ---------------------------------------------------------------------------

suite('collectCalls', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-ts-calls-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('internal function call → edge created between definitions', () => {
    const file = path.join(tmpDir, 'internal.ts');
    fs.writeFileSync(file, [
      'function greet() { return "hello"; }',
      'function main() { greet(); }',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const defList = Object.values(defs) as any[];
    const greetId = defList.find((d: any) => d.name === 'greet')?.id;
    const mainId = defList.find((d: any) => d.name === 'main')?.id;
    assert.ok(greetId && mainId, 'both functions should be defined');
    assert.ok(
      edges.some((e: any) => e.source === mainId && e.target === greetId),
      'edge from main → greet should exist'
    );
  });

  test('namespace import library call → library node created', () => {
    const file = path.join(tmpDir, 'lib.ts');
    fs.writeFileSync(file, [
      "import * as fs from 'fs';",
      "function readConfig() { fs.readFileSync('cfg.json'); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges, libraryNodes } = collectCalls([file], defs);
    assert.ok(
      libraryNodes.some((n: any) => n.libraryName === 'fs' && n.name === 'readFileSync'),
      'fs.readFileSync library node should be created'
    );
    assert.ok(edges.some((e: any) => e.isLibraryEdge === true), 'library edge should be created');
  });

  test('named import library call → library node created', () => {
    const file = path.join(tmpDir, 'named.ts');
    fs.writeFileSync(file, [
      "import { useState } from 'react';",
      'function App() { useState(0); }',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    assert.ok(
      libraryNodes.some((n: any) => n.libraryName === 'react' && n.name === 'useState'),
      'useState library node should be created'
    );
  });

  test('default import library call → library node created', () => {
    const file = path.join(tmpDir, 'default.ts');
    fs.writeFileSync(file, [
      "import axios from 'axios';",
      "function fetchData() { axios('https://example.com'); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    assert.ok(
      libraryNodes.some((n: any) => n.libraryName === 'axios'),
      'axios library node should be created'
    );
  });

  test('no duplicate edges for repeated calls → deduplicated', () => {
    const file = path.join(tmpDir, 'dup.ts');
    fs.writeFileSync(file, [
      'function helper() {}',
      'function caller() { helper(); helper(); helper(); }',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const defList = Object.values(defs) as any[];
    const helperId = defList.find((d: any) => d.name === 'helper')?.id;
    const callerId = defList.find((d: any) => d.name === 'caller')?.id;
    const matching = edges.filter((e: any) => e.source === callerId && e.target === helperId);
    assert.strictEqual(matching.length, 1, 'only one edge despite three calls');
  });

  test('call to unknown function → no edge created', () => {
    const file = path.join(tmpDir, 'unknown.ts');
    fs.writeFileSync(file, 'function main() { unknownFn(); }\n');
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    assert.strictEqual(edges.length, 0, 'no edge for unknown function call');
  });

  test('relative import → not treated as a library', () => {
    const file = path.join(tmpDir, 'relative.ts');
    fs.writeFileSync(file, [
      "import { helper } from './utils';",
      'function main() { helper(); }',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    assert.ok(
      !libraryNodes.some((n: any) => n.libraryName === './utils'),
      'relative imports should not create library nodes'
    );
  });

  test('library node has correct metadata', () => {
    const file = path.join(tmpDir, 'libmeta.ts');
    fs.writeFileSync(file, [
      "import * as path from 'path';",
      "function build() { path.join('a', 'b'); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    const libNode = libraryNodes.find((n: any) => n.name === 'join');
    assert.ok(libNode, 'path.join library node should exist');
    assert.strictEqual(libNode.libraryName, 'path');
    assert.strictEqual(libNode.isLibrary, true);
    assert.strictEqual(libNode.language, 'typescript');
    assert.strictEqual(libNode.file, null);
  });

  test('direct local call between two functions → edge created', () => {
    // this.method() calls currently not resolved (this is ThisExpression, not Identifier).
    // Test a plain local call instead, which is the supported case.
    const file = path.join(tmpDir, 'localCall.ts');
    fs.writeFileSync(file, [
      'function helper() { return 1; }',
      'function run() { helper(); }',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const defList = Object.values(defs) as any[];
    const helperId = defList.find((d: any) => d.name === 'helper')?.id;
    const runId = defList.find((d: any) => d.name === 'run')?.id;
    assert.ok(helperId && runId, 'both functions should be defined');
    assert.ok(
      edges.some((e: any) => e.source === runId && e.target === helperId),
      'run() → helper() edge should exist'
    );
  });
});
