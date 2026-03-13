import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { collectDefinitions: collectTsDefs } = require('../../../scripts/analyze_ts.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { collectDefinitions: collectJsDefs } = require('../../../scripts/analyze_js.js');

// Stub minimal globals so class.js can be require()'d in Node.js
const globalAny = global as any;
if (!globalAny.state) { globalAny.state = {}; }
if (!globalAny.settings) { globalAny.settings = { nodeSize: 2.5, textSize: 1 }; }
if (!globalAny.d3) { globalAny.d3 = {}; }
if (!globalAny.getVisibleNodeIds) { globalAny.getVisibleNodeIds = () => new Set(); }
if (!globalAny.nodeRadius) { globalAny.nodeRadius = () => 6; }
if (!globalAny.boundingCircle) { globalAny.boundingCircle = (pts: any[]) => ({ cx: 0, cy: 0, r: 0 }); }
if (!globalAny.getLanguageColor) { globalAny.getLanguageColor = () => '#888888'; }
if (!globalAny.ticked) { globalAny.ticked = () => {}; }

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { groupByClass, buildClassLabelParts } = require('../../../src/webview/class.js');

// ── Suite 1: TS class metadata ─────────────────────────────────────────────────

suite('analyzeTs OOP — class metadata', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-oop-ts-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('method in class → className set correctly', () => {
    const file = path.join(tmpDir, 'a.ts');
    fs.writeFileSync(file, `class Dog { bark() {} }\n`);
    const defs = collectTsDefs([file]);
    const def: any = Object.values(defs).find((d: any) => d.name === 'bark');
    assert.ok(def, 'bark method should be detected');
    assert.strictEqual(def.className, 'Dog');
  });

  test('class with extends → classExtends populated', () => {
    const file = path.join(tmpDir, 'b.ts');
    fs.writeFileSync(file, `class Animal { move() {} }\nclass Dog extends Animal { bark() {} }\n`);
    const defs = collectTsDefs([file]);
    const def: any = Object.values(defs).find((d: any) => d.name === 'bark');
    assert.ok(def, 'bark should be detected');
    assert.strictEqual(def.classExtends, 'Animal');
  });

  test('class with implements → classImplements array populated', () => {
    const file = path.join(tmpDir, 'c.ts');
    fs.writeFileSync(file, `interface Speakable { speak(): void; }\nclass Cat implements Speakable { speak() {} }\n`);
    const defs = collectTsDefs([file]);
    const def: any = Object.values(defs).find((d: any) => d.name === 'speak');
    assert.ok(def, 'speak should be detected');
    assert.ok(Array.isArray(def.classImplements), 'classImplements should be an array');
    assert.ok(def.classImplements.includes('Speakable'), 'should include Speakable');
  });

  test('class with extends and implements → both fields present', () => {
    const file = path.join(tmpDir, 'd.ts');
    fs.writeFileSync(file, `
interface Runnable { run(): void; }
interface Flyable { fly(): void; }
class Animal { move() {} }
class Bird extends Animal implements Runnable, Flyable { run() {} fly() {} }
`);
    const defs = collectTsDefs([file]);
    const runDef: any = Object.values(defs).find((d: any) => d.name === 'run');
    assert.ok(runDef, 'run should be detected');
    assert.strictEqual(runDef.classExtends, 'Animal');
    assert.ok(runDef.classImplements.length >= 2, 'should have at least two implements');
  });

  test('free function → className is undefined', () => {
    const file = path.join(tmpDir, 'e.ts');
    fs.writeFileSync(file, `function standalone() {}\n`);
    const defs = collectTsDefs([file]);
    const def: any = Object.values(defs).find((d: any) => d.name === 'standalone');
    assert.ok(def, 'standalone should be detected');
    assert.strictEqual(def.className, undefined);
  });

  test('constructor method → detected with className', () => {
    const file = path.join(tmpDir, 'f.ts');
    fs.writeFileSync(file, `class Box { constructor() {} }\n`);
    const defs = collectTsDefs([file]);
    const def: any = Object.values(defs).find((d: any) => d.name === 'constructor');
    assert.ok(def, 'constructor should be detected');
    assert.strictEqual(def.className, 'Box');
  });
});

// ── Suite 2: JS class metadata ─────────────────────────────────────────────────

suite('analyzeJs OOP — class metadata', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-oop-js-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('method in class → className set correctly', () => {
    const file = path.join(tmpDir, 'a.js');
    fs.writeFileSync(file, `class Dog { bark() {} }\n`);
    const defs = collectJsDefs([file]);
    const def: any = Object.values(defs).find((d: any) => d.name === 'bark');
    assert.ok(def, 'bark method should be detected');
    assert.strictEqual(def.className, 'Dog');
  });

  test('class with extends → classExtends populated', () => {
    const file = path.join(tmpDir, 'b.js');
    fs.writeFileSync(file, `class Animal { move() {} }\nclass Dog extends Animal { bark() {} }\n`);
    const defs = collectJsDefs([file]);
    const def: any = Object.values(defs).find((d: any) => d.name === 'bark');
    assert.ok(def, 'bark should be detected');
    assert.strictEqual(def.classExtends, 'Animal');
  });

  test('free function → className is undefined', () => {
    const file = path.join(tmpDir, 'c.js');
    fs.writeFileSync(file, `function standalone() {}\n`);
    const defs = collectJsDefs([file]);
    const def: any = Object.values(defs).find((d: any) => d.name === 'standalone');
    assert.ok(def, 'standalone should be detected');
    assert.strictEqual(def.className, undefined);
  });

  test('constructor method → detected with className', () => {
    const file = path.join(tmpDir, 'd.js');
    fs.writeFileSync(file, `class Box { constructor() {} }\n`);
    const defs = collectJsDefs([file]);
    const def: any = Object.values(defs).find((d: any) => d.name === 'constructor');
    assert.ok(def, 'constructor should be detected');
    assert.strictEqual(def.className, 'Box');
  });
});

// ── Suite 3: buildClassLabelParts ──────────────────────────────────────────────

suite('buildClassLabelParts', () => {
  test('class only → single normal part', () => {
    const parts = buildClassLabelParts('MyClass', undefined, []);
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(parts[0].text, 'MyClass');
    assert.strictEqual(parts[0].style, 'normal');
  });

  test('with parent → dim part added', () => {
    const parts = buildClassLabelParts('Dog', 'Animal', []);
    assert.strictEqual(parts.length, 2);
    assert.strictEqual(parts[1].text, ':Animal');
    assert.strictEqual(parts[1].style, 'dim');
  });

  test('with interface → italic-dim part added', () => {
    const parts = buildClassLabelParts('Cat', undefined, ['Speakable']);
    assert.strictEqual(parts.length, 2);
    assert.strictEqual(parts[1].text, ':Speakable');
    assert.strictEqual(parts[1].style, 'italic-dim');
  });

  test('with both extends and implements → three parts in correct order', () => {
    const parts = buildClassLabelParts('Bird', 'Animal', ['Flyable']);
    assert.strictEqual(parts.length, 3);
    assert.strictEqual(parts[0].style, 'normal');
    assert.strictEqual(parts[1].style, 'dim');
    assert.strictEqual(parts[2].style, 'italic-dim');
  });

  test('multiple implements → one part per interface', () => {
    const parts = buildClassLabelParts('X', undefined, ['A', 'B', 'C']);
    assert.strictEqual(parts.length, 4);
    assert.ok(parts.every((p: any, i: number) => i === 0 || p.style === 'italic-dim'));
  });
});

// ── Suite 4: groupByClass ──────────────────────────────────────────────────────

suite('groupByClass', () => {
  function makeNode(overrides: Record<string, any>) {
    return {
      id: Math.random().toString(),
      name: 'fn',
      file: '/proj/foo.ts',
      language: 'typescript',
      isLibrary: false,
      isCluster: false,
      isSynthetic: false,
      isOrphanCluster: false,
      ...overrides,
    };
  }

  test('groups method nodes by className correctly', () => {
    const nodes = [
      makeNode({ name: 'bark', className: 'Dog' }),
      makeNode({ name: 'fetch', className: 'Dog' }),
      makeNode({ name: 'meow', className: 'Cat' }),
    ];
    const map = groupByClass(nodes);
    assert.strictEqual(map.size, 2, 'should have two class groups');
    const dogGroup = [...map.values()].find((g: any) => g.className === 'Dog');
    assert.ok(dogGroup, 'Dog group should exist');
    assert.strictEqual(dogGroup.nodes.length, 2);
  });

  test('excludes nodes without className', () => {
    const nodes = [
      makeNode({ name: 'standalone' }),   // no className
      makeNode({ name: 'method', className: 'Foo' }),
    ];
    const map = groupByClass(nodes);
    assert.strictEqual(map.size, 1, 'only one class group');
  });

  test('excludes library nodes', () => {
    const nodes = [
      makeNode({ name: 'libFn', className: 'LibClass', isLibrary: true }),
      makeNode({ name: 'myFn', className: 'MyClass' }),
    ];
    const map = groupByClass(nodes);
    assert.strictEqual(map.size, 1);
    assert.ok([...map.values()][0].className === 'MyClass');
  });

  test('excludes cluster nodes', () => {
    const nodes = [
      makeNode({ name: 'clusterFn', className: 'SomeClass', isCluster: true }),
      makeNode({ name: 'realFn', className: 'RealClass' }),
    ];
    const map = groupByClass(nodes);
    assert.strictEqual(map.size, 1);
  });

  test('excludes synthetic nodes', () => {
    const nodes = [
      makeNode({ name: 'synth', className: 'SynClass', isSynthetic: true }),
      makeNode({ name: 'real', className: 'RealClass' }),
    ];
    const map = groupByClass(nodes);
    assert.strictEqual(map.size, 1);
  });

  test('excludes orphan cluster nodes', () => {
    const nodes = [
      makeNode({ name: 'orphan', className: 'OrpClass', isOrphanCluster: true }),
      makeNode({ name: 'real', className: 'RealClass' }),
    ];
    const map = groupByClass(nodes);
    assert.strictEqual(map.size, 1);
  });
});
