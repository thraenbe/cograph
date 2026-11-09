import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Declared-type resolution of Java calls (scripts/javaTypes.js + scripts/javaResolve.js).
// The fixture is a two-package mini game with one case per receiver form; its expected
// edges were checked by hand and confirmed with javac (see the TSV header).

// eslint-disable-next-line @typescript-eslint/no-require-imports
const javaAnalyzer = require('../../../scripts/analyze_java.js');
const { collectJavaFiles, collectDefinitions, collectCalls } = javaAnalyzer;

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/java-resolve');

interface Edge { source: string; target: string; isLibraryEdge?: boolean }
interface Site { file: string; line: number; name: string; form: string; targets: string[]; reason: string | null }

function analyze(root: string, files?: string[]) {
  const list: string[] = files ?? collectJavaFiles(root);
  const defs = collectDefinitions(list);
  const res = collectCalls(list, defs, root);
  const rel = (id: string) => (id.startsWith('library::') ? id : path.relative(root, id).split(path.sep).join('/'));
  const edges: string[] = (res.edges as Edge[]).map(e => `${rel(e.source)}\t${rel(e.target)}`).sort();
  return { defs, res, edges, rel };
}

function expectedEdges(): string[] {
  return fs.readFileSync(path.join(FIXTURE, 'expected-edges.tsv'), 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#') && l !== 'caller\tcallee').sort();
}

const has = (edges: string[], from: string, to: string) => edges.includes(`${from}\t${to}`);
const outOf = (edges: string[], from: string) => edges.filter(e => e.startsWith(from + '\t')).map(e => e.split('\t')[1]);

suite('declared-type resolution (Java fixture)', () => {
  test('edge set equals the javac-confirmed expected edges exactly', () => {
    const { edges } = analyze(FIXTURE);
    assert.deepStrictEqual(edges, expectedEdges());
  });

  test('every edge source and internal target is a definition node (schema unchanged)', () => {
    const { defs, res } = analyze(FIXTURE);
    for (const e of res.edges as Edge[]) {
      assert.ok(defs[e.source], `source ${e.source} is a node`);
      if (!e.isLibraryEdge) { assert.ok(defs[e.target], `target ${e.target} is a node`); }
    }
    for (const n of res.libraryNodes) {
      assert.deepStrictEqual(Object.keys(n).sort(), ['file', 'id', 'isLibrary', 'language', 'libraryName', 'line', 'name']);
    }
  });

  test('input file order does not change the edges', () => {
    const files: string[] = collectJavaFiles(FIXTURE).sort();
    const a = analyze(FIXTURE, files).edges;
    const b = analyze(FIXTURE, [...files].reverse()).edges;
    assert.deepStrictEqual(a, b);
  });

  test('receiver forms: local, param, this-field, container element, array, for-each, cast, chained, static', () => {
    const { edges } = analyze(FIXTURE);
    const u = 'game/Player.java::update::20';
    assert.ok(has(edges, u, 'game/util/Vec.java::len::12'), 'local v.len() and this.pos.len()');
    assert.ok(has(edges, u, 'game/util/Vec.java::add::10'), 'chained getPos().add(..)');
    assert.ok(has(edges, u, 'game/Item.java::use::4'), 'items.get(0).use, slots[1].use, ((Item) o).use');
    assert.ok(has(edges, u, 'game/Item.java::use::6'), 'for-each it.use(this, 2)');
    assert.ok(has(edges, u, 'game/util/Tools.java::clamp::6'), 'Tools.clamp(float..) by argument types');
    assert.ok(has(edges, u, 'game/util/Tools.java::clamp::4'), 'static import clamp(int..)');
    assert.ok(has(edges, u, 'game/util/Tools.java::name::10'), 'name(String) for a String argument');
    assert.ok(has(edges, 'game/Player.java::hit::40', 'game/Item.java::use::4'), 'parameter receiver');
  });

  test('overloads: a project-class argument never selects a String parameter', () => {
    const { edges } = analyze(FIXTURE);
    assert.deepStrictEqual(outOf(edges, 'game/Player.java::draw::17').filter(t => t.includes('Tools')), ['game/util/Tools.java::name::8']);
  });

  test('constructors: new X(..), super(..), this(..) and the overload by argument count', () => {
    const { edges } = analyze(FIXTURE);
    assert.ok(has(edges, 'game/Player.java::constructor::13', 'game/Entity.java::constructor::8'), 'super(..)');
    assert.ok(has(edges, 'game/Player.java::constructor::13', 'game/util/Vec.java::constructor::6'), 'new Vec(1, 2)');
    assert.ok(has(edges, 'game/util/Vec.java::constructor::8', 'game/util/Vec.java::constructor::6'), 'this(0, 0)');
    assert.ok(has(edges, 'game/util/Vec.java::zero::14', 'game/util/Vec.java::constructor::8'), 'new Vec()');
  });

  test('inner and anonymous classes call the outer class', () => {
    const { edges } = analyze(FIXTURE);
    assert.ok(has(edges, 'game/Player.java::ping::50', 'game/Player.java::hit::40'));
    assert.ok(has(edges, 'game/Player.java::ping::50', 'game/Player.java::schedule::42'));
    assert.ok(has(edges, 'game/Player.java::run::44', 'game/Player.java::area::15'));
  });

  test('implicit super() links the base class no-argument constructor', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-java-implicit-'));
    try {
      fs.writeFileSync(path.join(dir, 'Base.java'), 'class Base {\n  Base() { }\n}\n');
      fs.writeFileSync(path.join(dir, 'Sub.java'), 'class Sub extends Base {\n  Sub(int x) { }\n}\n');
      const { edges } = analyze(dir);
      assert.deepStrictEqual(edges, ['Sub.java::constructor::2\tBase.java::constructor::2']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a receiver of unknown type gets no edge and is recorded as unknown-type', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-java-unknown-'));
    try {
      fs.writeFileSync(path.join(dir, 'A.java'), [
        'import java.util.function.Consumer;',
        'class A {',
        '  void go() { }',
        '  void run() { Consumer<A> c = a -> a.go(); }',
        '}',
      ].join('\n'));
      const { edges, res } = analyze(dir);
      assert.deepStrictEqual(edges.filter(e => !e.includes('library::')), []);
      const site = (res.sites as Site[]).find(s => s.name === 'go');
      assert.ok(site);
      assert.strictEqual(site.reason, 'unknown-type');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// One test per defect of the name-based analyzer (each fails on v1.4.0's analyze_java.js).
suite('Java analyzer regressions (declared-type resolution)', () => {
  test('defect 1: x.m() resolves by declared type, not by name and not only after `this`', () => {
    const { edges } = analyze(FIXTURE);
    const u = outOf(edges, 'game/Player.java::update::20');
    assert.ok(u.includes('game/util/Vec.java::len::12'), 'v.len() on a local links');
    assert.ok(!u.includes('game/Hud.java::len::9'), 'this.pos.len() does not link Hud.len');
    assert.ok(!u.includes('game/Hud.java::use::11'), 'it.use(..) does not link Hud.use');
  });

  test('defect 2: super.m() links the base class method only', () => {
    const { edges } = analyze(FIXTURE);
    const u = outOf(edges, 'game/Player.java::update::20');
    assert.ok(u.includes('game/Entity.java::update::14'));
    assert.ok(!u.includes('game/Hud.java::update::5'));
  });

  test('defect 3: bare calls follow the class hierarchy', () => {
    const { edges } = analyze(FIXTURE);
    assert.deepStrictEqual(outOf(edges, 'game/Entity.java::update::14').sort(),
      ['game/Entity.java::move::12', 'game/util/Vec.java::zero::14']);
    assert.ok(!outOf(edges, 'game/Player.java::update::20').includes('game/Hud.java::move::7'));
  });

  test('defect 4: library nodes are keyed by class', () => {
    const { res } = analyze(FIXTURE);
    const enc = res.libraryNodes.find((n: { name: string }) => n.name === 'encode');
    assert.ok(enc);
    assert.strictEqual(enc.id, 'library::java.net.URLEncoder::encode');
    assert.strictEqual(enc.libraryName, 'java.net.URLEncoder');
  });

  test('defect 5: calls on imported project classes never become library nodes', () => {
    const { res } = analyze(FIXTURE);
    const projectLib = res.libraryNodes.filter((n: { libraryName: string }) => n.libraryName.startsWith('game'));
    assert.deepStrictEqual(projectLib, []);
  });
});

// Review findings on PR #142 (CodeRabbit): local class bindings leaked across methods, and
// pickClass compared paths with a forward slash only.
suite('Java analyzer: local class scope and path separators', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { pickClass } = require('../../../scripts/javaTypes.js');

  test('a local class is bound in its block only: two methods may each declare Helper', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-java-local-'));
    try {
      fs.writeFileSync(path.join(dir, 'A.java'), [
        'class A {',                                                        // 1
        '  void m1() {',                                                    // 2
        '    class Helper { void go() { } }',                               // 3
        '    new Helper().go();',                                           // 4
        '  }',                                                              // 5
        '  void m2() {',                                                    // 6
        '    class Helper { void go() { } }',                               // 7
        '    new Helper().go();',                                           // 8
        '  }',                                                              // 9
        '  void m3() {',                                                    // 10
        '    class Helper { void go() { } }',                               // 11
        '    Runnable r = new Runnable() { public void run() { new Helper().go(); } };', // 12
        '  }',                                                              // 13
        '}',
      ].join('\n'));
      const { edges } = analyze(dir);
      assert.deepStrictEqual(outOf(edges, 'A.java::m1::2').filter(t => t.endsWith('::go::3') || t.endsWith('::go::7')), ['A.java::go::3']);
      assert.deepStrictEqual(outOf(edges, 'A.java::m2::6').filter(t => t.endsWith('::go::3') || t.endsWith('::go::7')), ['A.java::go::7']);
      assert.ok(has(edges, 'A.java::run::12', 'A.java::go::11'), 'an anonymous class in the block sees the local class');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a local class does not shadow a same-named class in another method', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-java-shadow-'));
    try {
      fs.writeFileSync(path.join(dir, 'Helper.java'), 'class Helper {\n  void go() { }\n}\n');
      fs.writeFileSync(path.join(dir, 'A.java'), [
        'class A {',                                                        // 1
        '  void m1() {',                                                    // 2
        '    class Helper { void go() { } }',                               // 3
        '    new Helper().go();',                                           // 4
        '  }',                                                              // 5
        '  void m2() { new Helper().go(); }',                               // 6
        '}',
      ].join('\n'));
      const { edges } = analyze(dir);
      assert.ok(has(edges, 'A.java::m1::2', 'A.java::go::3'), 'm1 uses its local class');
      assert.ok(has(edges, 'A.java::m2::6', 'Helper.java::go::2'), 'm2 uses the top-level class');
      assert.ok(!has(edges, 'A.java::m2::6', 'A.java::go::3'), 'm2 never sees m1\'s local class');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a local class may extend, or be instantiated anonymously as, another local class of its block', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-java-localsuper-'));
    try {
      fs.writeFileSync(path.join(dir, 'Helper.java'), 'class Helper {\n  void go() { }\n}\n');
      fs.writeFileSync(path.join(dir, 'A.java'), [
        'class A {',                                                        // 1
        '  void m1() {',                                                    // 2
        '    class Base { void go() { } }',                                 // 3
        '    class Impl extends Base { }',                                  // 4
        '    new Impl().go();',                                             // 5
        '  }',                                                              // 6
        '  void m2() {',                                                    // 7
        '    class Helper { void go() { } }',                               // 8
        '    Helper h = new Helper() { void run() { go(); } };',            // 9
        '  }',                                                              // 10
        '}',
      ].join('\n'));
      const { edges } = analyze(dir);
      assert.ok(has(edges, 'A.java::m1::2', 'A.java::go::3'), 'Impl inherits go from the local Base');
      assert.ok(has(edges, 'A.java::run::9', 'A.java::go::8'), 'the anonymous subclass calls the local Helper');
      assert.ok(!has(edges, 'A.java::run::9', 'Helper.java::go::2'), 'not the top-level Helper');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a local class member typed with a sibling local class resolves later (lazy member types)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-java-locallazy-'));
    try {
      fs.writeFileSync(path.join(dir, 'A.java'), [
        'class A {',                                                        // 1
        '  void self() {',                                                  // 2
        '    class P { void p() { } }',                                     // 3
        '    class Q { P field; void q() { field.p(); } }',                 // 4
        '    new Q().q();',                                                 // 5
        '  }',                                                              // 6
        '}',
      ].join('\n'));
      const { edges } = analyze(dir);
      assert.ok(has(edges, 'A.java::q::4', 'A.java::p::3'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('pickClass prefers the class under the caller\'s directory with either path separator', () => {
    const a = { file: 'C:\\p\\a\\A.java' };
    const b = { file: 'C:\\p\\b\\sub\\B.java' };
    const table = { byFqn: new Map([['X', [a, b]]]) };
    assert.strictEqual(pickClass(table, 'X', 'C:\\p\\b\\Other.java'), b);
    assert.strictEqual(pickClass(table, 'X', 'C:\\p\\a\\Other.java'), a);
    const pa = { file: '/p/a/A.java' };
    const pb = { file: '/p/b/sub/B.java' };
    assert.strictEqual(pickClass({ byFqn: new Map([['X', [pa, pb]]]) }, 'X', '/p/b/Other.java'), pb);
    assert.strictEqual(pickClass({ byFqn: new Map([['X', [pa, pb]]]) }, 'X', 'Other.java'), pa, 'no directory: first declaration');
  });
});
