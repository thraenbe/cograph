import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Constructor edges (tour review B2): `new X(…)` → X's declared constructor and
// `super(…)` / a C++ base initializer → the base class's constructor, in the
// TS, JS and C++ analyzers. A class that declares no constructor runs its nearest base's (implicit
// constructor). Java's constructor edges come from its type resolver (javaResolve.js, main 1.4.4), which
// picks the overload by argument types and links no implicit or anonymous-class constructor: the Java
// suite below pins that on the same shape (analyzeJavaResolve.test.ts covers the resolver itself).

/* eslint-disable @typescript-eslint/no-require-imports */
const tsAnalyzer = require('../../../scripts/analyze_ts.js');
const jsAnalyzer = require('../../../scripts/analyze_js.js');
const javaAnalyzer = require('../../../scripts/analyze_java.js');
const cppAnalyzer = require('../../../scripts/analyze_cpp.js');
/* eslint-enable @typescript-eslint/no-require-imports */

interface Analyzer {
  collectDefinitions(files: string[]): Record<string, any>;
  collectCalls(files: string[], defs: Record<string, any>, root?: string): { edges: { source: string; target: string }[] };
}

/** Edges as "caller@line -> callee@line" (className.name), sorted. */
function edgesOf(analyzer: Analyzer, dir: string, file: string, source: string): string[] {
  const filepath = path.join(dir, file);
  fs.writeFileSync(filepath, source);
  const defs = analyzer.collectDefinitions([filepath]);
  const { edges } = analyzer.collectCalls([filepath], defs, dir);
  const label = (id: string) => {
    const d = defs[id];
    return d ? `${d.className ? d.className + '.' : ''}${d.name}@${d.line}` : id;
  };
  return edges.map(e => `${label(e.source)} -> ${label(e.target)}`).sort();
}

function withTmp(prefix: string, body: (dir: () => string) => void): void {
  let dir = '';
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); });
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  body(() => dir);
}

suite('constructor edges — TypeScript', () => {
  withTmp('cograph-ctor-ts-', (dir) => {
    test('new X() → X.constructor', () => {
      const edges = edgesOf(tsAnalyzer, dir(), 'a.ts', [
        'class Box { constructor(n: number) {} }',
        'function make() { return new Box(1); }',
      ].join('\n'));
      assert.deepStrictEqual(edges, ['make@2 -> Box.constructor@1']);
    });

    test('super(…) → base constructor', () => {
      const edges = edgesOf(tsAnalyzer, dir(), 'b.ts', [
        'class Base { constructor(l: string) {} }',
        'class Child extends Base { constructor() { super("x"); } }',
      ].join('\n'));
      assert.deepStrictEqual(edges, ['Child.constructor@2 -> Base.constructor@1']);
    });

    test('class without a constructor → nearest base constructor', () => {
      const edges = edgesOf(tsAnalyzer, dir(), 'c.ts', [
        'class Base { constructor() {} }',
        'class Mid extends Base { run() {} }',
        'class Leaf extends Mid { stop() {} }',
        'function make() { return new Leaf(); }',
      ].join('\n'));
      assert.deepStrictEqual(edges, ['make@4 -> Base.constructor@1']);
    });

    test('no declared constructor anywhere, member access, unknown class → no edge', () => {
      const edges = edgesOf(tsAnalyzer, dir(), 'd.ts', [
        'class Empty { run() {} }',
        'class Box { constructor() {} }',
        'const ns = { Box };',
        'function make() { new Empty(); new ns.Box(); new Map(); }',
      ].join('\n'));
      assert.deepStrictEqual(edges, []);
    });

    test('new on a parameter or local of the same name as a class → no edge (zod `Class`)', () => {
      const edges = edgesOf(tsAnalyzer, dir(), 'f.ts', [
        'abstract class Class { constructor() {} }',
        'function viaParam(Class: any) { return new Class(); }',
        'function viaLocal() { const { Class } = load(); return () => new Class(); }',
        'function load(): any { return {}; }',
        'function real() { return new (Class as any)(); }',
      ].join('\n'));
      assert.deepStrictEqual(edges, ['viaLocal@3 -> load@4']);
    });

    test('new inside a nested arrow belongs to the enclosing function', () => {
      const edges = edgesOf(tsAnalyzer, dir(), 'e.ts', [
        'class Box { constructor() {} }',
        'function factory() { return () => new Box(); }',
      ].join('\n'));
      assert.deepStrictEqual(edges, ['factory@2 -> Box.constructor@1']);
    });
  });
});

suite('constructor edges — JavaScript', () => {
  withTmp('cograph-ctor-js-', (dir) => {
    // The shape of PR 3's web/discounts.js in the tour test repository.
    const discounts = [
      'class Discount {',
      '  constructor(label) { this.label = label; }',
      '  apply(total) { return total; }',
      '}',
      'class PercentOff extends Discount {',
      '  constructor(percent) { super(`-${percent}%`); this.percent = percent; }',
      '  apply(total) { return total * (1 - this.percent / 100); }',
      '}',
      'const COUPONS = { WELCOME10: () => new PercentOff(10) };',
      'function discountFor(code) { const make = COUPONS[code]; return make ? make() : null; }',
      'function direct() { return new PercentOff(5); }',
    ].join('\n');

    test('super(…) and new X() in a strategy hierarchy', () => {
      assert.deepStrictEqual(edgesOf(jsAnalyzer, dir(), 'discounts.js', discounts), [
        'PercentOff.constructor@6 -> Discount.constructor@2',
        'direct@11 -> PercentOff.constructor@6',
      ]);
    });

    test('known limit: new inside a module-level object literal arrow has no caller node', () => {
      const edges = edgesOf(jsAnalyzer, dir(), 'discounts.js', discounts);
      assert.ok(!edges.some(e => e.startsWith('discountFor')), edges.join('\n'));
    });

    test('same code, same graph', () => {
      const first = edgesOf(jsAnalyzer, dir(), 'discounts.js', discounts);
      assert.deepStrictEqual(edgesOf(jsAnalyzer, dir(), 'discounts.js', discounts), first);
    });
  });
});

suite('constructor edges — Java (type resolver)', () => {
  withTmp('cograph-ctor-java-', (dir) => {
    test('new and super(…) link the declared constructor; implicit and anonymous ones get no edge', () => {
      const edges = edgesOf(javaAnalyzer, dir(), 'Shop.java', [
        'package shop;',
        'class Discount { Discount(String l) {} double apply(double t) { return t; } }',
        'class PercentOff extends Discount {',
        '  PercentOff(int p) { super("x"); }',
        '}',
        'class Plain extends Discount { double apply(double t) { return t; } }',
        'class Shop {',
        '  Discount a() { return new PercentOff(10); }',
        '  Discount b() { return new shop.Plain(); }',
        '  Discount c() { return new Discount("y") { }; }',
        '  Object d() { return new java.util.ArrayList<String>(); }',
        '}',
      ].join('\n'));
      assert.deepStrictEqual(edges, [
        'PercentOff.constructor@4 -> Discount.constructor@2',
        'Shop.a@8 -> PercentOff.constructor@4',
        'Shop.d@11 -> library::java.util.ArrayList::<init>',
      ]);
    });

    test('arguments of new are still walked for calls', () => {
      const edges = edgesOf(javaAnalyzer, dir(), 'Args.java', [
        'class Box { Box(int n) {} }',
        'class Use {',
        '  int size() { return 1; }',
        '  Box make() { return new Box(size()); }',
        '}',
      ].join('\n'));
      assert.deepStrictEqual(edges, ['Use.make@4 -> Box.constructor@1', 'Use.make@4 -> Use.size@3']);
    });
  });
});

suite('constructor edges — C++', () => {
  suiteSetup(async () => { await cppAnalyzer.init(); });
  withTmp('cograph-ctor-cpp-', (dir) => {
    test('new X, new ns::X<T>, base initializer; a member initializer is not a base', () => {
      const edges = edgesOf(cppAnalyzer, dir(), 'a.cpp', [
        'namespace ns { template <typename T> struct E { E() {} }; }',
        'struct B { B(int x) {} };',
        'struct D : public B {',
        '  D(int x) : B(x), m(1) {}',
        '  int m;',
        '};',
        'void f() { auto a = new D(1); auto b = new ns::E<int>(); }',
      ].join('\n'));
      assert.deepStrictEqual(edges, [
        'D.constructor@4 -> B.constructor@2',
        'f@7 -> D.constructor@4',
        'f@7 -> E.constructor@1',
      ]);
    });
  });
});
