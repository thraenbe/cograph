import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { collectJsFiles, collectDefinitions, collectCalls } = require('../../../scripts/analyze_js.js');

// ---------------------------------------------------------------------------
// collectJsFiles
// ---------------------------------------------------------------------------

suite('collectJsFiles', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-js-files-'));

    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), '');
    fs.writeFileSync(path.join(tmpDir, 'src', 'comp.jsx'), '');
    fs.writeFileSync(path.join(tmpDir, 'src', 'mod.mjs'), '');
    fs.writeFileSync(path.join(tmpDir, 'src', 'cjs.cjs'), '');

    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'lib', 'index.js'), '');

    fs.mkdirSync(path.join(tmpDir, 'out'));
    fs.writeFileSync(path.join(tmpDir, 'out', 'bundle.js'), '');

    fs.mkdirSync(path.join(tmpDir, 'dist'));
    fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), '');

    // myoutput dir — name contains "out" but is NOT equal to "out"
    fs.mkdirSync(path.join(tmpDir, 'myoutput'));
    fs.writeFileSync(path.join(tmpDir, 'myoutput', 'extra.js'), '');
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('includes .js files', () => {
    const files: string[] = collectJsFiles(tmpDir);
    assert.ok(files.some(f => f.endsWith(path.join('src', 'app.js'))));
  });

  test('includes .jsx files', () => {
    const files: string[] = collectJsFiles(tmpDir);
    assert.ok(files.some(f => f.endsWith(path.join('src', 'comp.jsx'))));
  });

  test('includes .mjs files', () => {
    const files: string[] = collectJsFiles(tmpDir);
    assert.ok(files.some(f => f.endsWith(path.join('src', 'mod.mjs'))));
  });

  test('includes .cjs files', () => {
    const files: string[] = collectJsFiles(tmpDir);
    assert.ok(files.some(f => f.endsWith(path.join('src', 'cjs.cjs'))));
  });

  test('excludes node_modules/', () => {
    const files: string[] = collectJsFiles(tmpDir);
    assert.ok(!files.some(f => f.includes('node_modules')));
  });

  test('excludes out/', () => {
    const files: string[] = collectJsFiles(tmpDir);
    assert.ok(!files.some(f => f.split(path.sep).includes('out')));
  });

  test('excludes dist/', () => {
    const files: string[] = collectJsFiles(tmpDir);
    assert.ok(!files.some(f => f.includes(path.sep + 'dist' + path.sep)));
  });

  test('does NOT exclude directory whose name contains "out" but != "out"', () => {
    const files: string[] = collectJsFiles(tmpDir);
    assert.ok(files.some(f => f.endsWith(path.join('myoutput', 'extra.js'))));
  });
});

// ---------------------------------------------------------------------------
// collectDefinitions
// ---------------------------------------------------------------------------

suite('collectDefinitions (JS)', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-js-defs-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('function declaration → detected', () => {
    const file = path.join(tmpDir, 'fn.js');
    fs.writeFileSync(file, 'function greet() { return "hello"; }\n');
    const defs = collectDefinitions([file]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('greet'));
  });

  test('arrow function assigned to const → detected', () => {
    const file = path.join(tmpDir, 'arrow.js');
    fs.writeFileSync(file, 'const foo = () => {};\n');
    const defs = collectDefinitions([file]);
    assert.ok(Object.values(defs).some((d: any) => d.name === 'foo'));
  });

  test('function expression assigned to const → detected', () => {
    const file = path.join(tmpDir, 'funcexpr.js');
    fs.writeFileSync(file, 'const bar = function() {};\n');
    const defs = collectDefinitions([file]);
    assert.ok(Object.values(defs).some((d: any) => d.name === 'bar'));
  });

  test('class method → detected', () => {
    const file = path.join(tmpDir, 'class.js');
    fs.writeFileSync(file, 'class MyClass {\n  myMethod() { return 1; }\n}\n');
    const defs = collectDefinitions([file]);
    assert.ok(Object.values(defs).some((d: any) => d.name === 'myMethod'));
  });

  test('constructor → detected with name "constructor"', () => {
    const file = path.join(tmpDir, 'ctor.js');
    fs.writeFileSync(file, 'class Box { constructor() {} }\n');
    const defs = collectDefinitions([file]);
    assert.ok(Object.values(defs).some((d: any) => d.name === 'constructor'));
  });

  test('multiple functions in same file → all detected', () => {
    const file = path.join(tmpDir, 'multi.js');
    fs.writeFileSync(file, ['function a() {}', 'function b() {}', 'const c = () => {};'].join('\n'));
    const defs = collectDefinitions([file]);
    const names = Object.values(defs).map((d: any) => d.name);
    assert.ok(names.includes('a') && names.includes('b') && names.includes('c'));
  });

  test('each definition has correct metadata', () => {
    const file = path.join(tmpDir, 'meta.js');
    fs.writeFileSync(file, 'function testFn() {}\n');
    const defs = collectDefinitions([file]);
    const def: any = Object.values(defs)[0];
    assert.strictEqual(def.name, 'testFn');
    assert.strictEqual(def.file, file);
    assert.strictEqual(def.language, 'javascript');
    assert.ok(typeof def.line === 'number' && def.line >= 1);
  });
});

// ---------------------------------------------------------------------------
// collectCalls
// ---------------------------------------------------------------------------

suite('collectCalls (JS)', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-js-calls-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('internal function call → edge created', () => {
    const file = path.join(tmpDir, 'internal.js');
    fs.writeFileSync(file, ['function greet() { return "hello"; }', 'function main() { greet(); }'].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const defList = Object.values(defs) as any[];
    const greetId = defList.find((d: any) => d.name === 'greet')?.id;
    const mainId  = defList.find((d: any) => d.name === 'main')?.id;
    assert.ok(greetId && mainId);
    assert.ok(edges.some((e: any) => e.source === mainId && e.target === greetId));
  });

  test('constructor body calls → edges created (regression)', () => {
    // Note: this.method() uses ThisExpression (not Identifier) so is a known
    // limitation. Test with a plain call to a top-level function instead.
    const file = path.join(tmpDir, 'ctor.js');
    fs.writeFileSync(file, [
      'function init() {}',
      'class Dog {',
      '  constructor() { init(); }',
      '}',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const defList = Object.values(defs) as any[];
    const ctorId  = defList.find((d: any) => d.name === 'constructor')?.id;
    const initId  = defList.find((d: any) => d.name === 'init')?.id;
    assert.ok(ctorId && initId, 'both constructor and init should be defined');
    assert.ok(
      edges.some((e: any) => e.source === ctorId && e.target === initId),
      'edge from constructor → init should exist'
    );
  });

  test('no duplicate edges for repeated calls → deduplicated', () => {
    const file = path.join(tmpDir, 'dup.js');
    fs.writeFileSync(file, ['function helper() {}', 'function caller() { helper(); helper(); helper(); }'].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    const defList = Object.values(defs) as any[];
    const helperId = defList.find((d: any) => d.name === 'helper')?.id;
    const callerId = defList.find((d: any) => d.name === 'caller')?.id;
    const matching = edges.filter((e: any) => e.source === callerId && e.target === helperId);
    assert.strictEqual(matching.length, 1, 'only one edge despite three calls');
  });

  test('call to unknown function → no edge created', () => {
    const file = path.join(tmpDir, 'unknown.js');
    fs.writeFileSync(file, 'function main() { unknownFn(); }\n');
    const defs = collectDefinitions([file]);
    const { edges } = collectCalls([file], defs);
    assert.strictEqual(edges.length, 0);
  });

  test('ESM namespace import library call → library node created', () => {
    const file = path.join(tmpDir, 'esm-ns.js');
    fs.writeFileSync(file, [
      "import * as fs from 'fs';",
      "function readConfig() { fs.readFileSync('cfg.json'); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { edges, libraryNodes } = collectCalls([file], defs);
    assert.ok(libraryNodes.some((n: any) => n.libraryName === 'fs' && n.name === 'readFileSync'));
    assert.ok(edges.some((e: any) => e.isLibraryEdge === true));
  });

  test('ESM named import library call → library node created', () => {
    const file = path.join(tmpDir, 'esm-named.js');
    fs.writeFileSync(file, [
      "import { useState } from 'react';",
      'function App() { useState(0); }',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    assert.ok(libraryNodes.some((n: any) => n.libraryName === 'react' && n.name === 'useState'));
  });

  test('CJS require() namespace call → library node created', () => {
    const file = path.join(tmpDir, 'cjs-ns.js');
    fs.writeFileSync(file, [
      "const fs = require('fs');",
      "function readConfig() { fs.readFileSync('cfg.json'); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    assert.ok(libraryNodes.some((n: any) => n.libraryName === 'fs' && n.name === 'readFileSync'));
  });

  test('CJS destructured require() call → library node created', () => {
    const file = path.join(tmpDir, 'cjs-dest.js');
    fs.writeFileSync(file, [
      "const { join } = require('path');",
      "function build() { join('a', 'b'); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    assert.ok(libraryNodes.some((n: any) => n.libraryName === 'path' && n.name === 'join'));
  });

  test('relative import → not treated as a library', () => {
    const file = path.join(tmpDir, 'relative.js');
    fs.writeFileSync(file, [
      "import { helper } from './utils';",
      'function main() { helper(); }',
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    assert.ok(!libraryNodes.some((n: any) => n.libraryName === './utils'));
  });

  test('library node has correct metadata', () => {
    const file = path.join(tmpDir, 'libmeta.js');
    fs.writeFileSync(file, [
      "const path = require('path');",
      "function build() { path.join('a', 'b'); }",
    ].join('\n'));
    const defs = collectDefinitions([file]);
    const { libraryNodes } = collectCalls([file], defs);
    const libNode = libraryNodes.find((n: any) => n.name === 'join');
    assert.ok(libNode);
    assert.strictEqual(libNode.libraryName, 'path');
    assert.strictEqual(libNode.isLibrary, true);
    assert.strictEqual(libNode.language, 'javascript');
    assert.strictEqual(libNode.file, null);
  });
});
