import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { funcSlice, readFuncSlice, FuncBrief, SIGNATURE_MAX_CHARS } from '../../funcBrief';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ok = (r: any): FuncBrief => { assert.strictEqual(r.ok, true, r.error); return r; };
const lineOf = (src: string, needle: string) => src.split('\n').findIndex(l => l.includes(needle)) + 1;

const PY = [
  'import os', '',
  '@cached', '@other(1)',
  'def echo(message=None, file=None,', '         nl=True):',
  '    """Print a message and newline.', '', '    Longer explanation here.', '    """',
  '    if file is None:', '        file = out()', '    return write(file, message)', '',
  'def short(x):', "    'One line doc.'", '    return x', '',
  'def nodoc():', '    return 1', '',
  'def one(): return 1', '',
].join('\n');

const TS = [
  '/**', ' * Copyright 2026 Example. Licensed under MIT.', ' */', '',
  '/**', ' * Adds two numbers.', ' * @param a first', ' */',
  'export function add(a: number,', '  b: number): number {', '  return a + b;', '}', '',
  '// Line comment doc', '// second line',
  '@Injectable()',
  'class S { }', '',
  'const twice = (x: number) => x * 2;', '',
  '/** One-liner. */ function k() { return 1; }',
].join('\n');

const JAVA = [
  'interface Shape {',
  '  /** Area in square units. */',
  '  @Deprecated',
  '  double area();',
  '  /**', '   * The name.', '   */',
  '  default String name() {', '    return "shape";', '  }', '}',
].join('\n');

const CPP = [
  '/// Adds.', '/// Returns the sum.', 'int add(int a, int b);', '',
  '// Subtracts.', 'int sub(int a, int b) {', '  return a - b;', '}',
].join('\n');

suite('funcBrief (shared with the MCP server: vscode-free, fs-free, never throws)', () => {
  test('module imports neither vscode nor fs nor path', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/funcBrief.ts'), 'utf8');
    assert.ok(!/from ['"](vscode|fs|path|node:fs|node:path)['"]/.test(src));
    assert.ok(!/require\(/.test(src));
  });

  test('Python: decorators, multi-line signature, multi-line docstring inside the body', () => {
    const r = ok(funcSlice(PY, { startLine: lineOf(PY, '@cached'), maxLines: 80, lang: 'python' }));
    assert.strictEqual(r.signature, 'def echo(message=None, file=None, nl=True)');
    assert.strictEqual(r.doc, 'Print a message and newline.\n\nLonger explanation here.');
    assert.strictEqual(r.body.split('\n')[0], '    if file is None:');
    assert.strictEqual(r.endReason, 'detected');
    assert.strictEqual(r.source.split('\n')[0], '@cached');
    assert.strictEqual(r.source.split('\n').pop(), '    return write(file, message)', 'trailing blanks trimmed, as the MCP slice does');
  });

  test('Python: single-quoted one-line docstring, no docstring, one-liner', () => {
    const s = ok(funcSlice(PY, { startLine: lineOf(PY, 'def short'), maxLines: 80, file: 'a.py' }));
    assert.deepStrictEqual([s.signature, s.doc, s.body.split('\n')[0]], ['def short(x)', 'One line doc.', '    return x']);
    const n = ok(funcSlice(PY, { startLine: lineOf(PY, 'def nodoc'), maxLines: 80, file: 'a.py' }));
    assert.deepStrictEqual([n.doc, n.body.split('\n')[0]], ['', '    return 1']);
    const o = ok(funcSlice(PY, { startLine: lineOf(PY, 'def one'), maxLines: 80, file: 'a.py' }));
    assert.strictEqual(o.doc, '');
    assert.ok(o.signature.startsWith('def one()'));
  });

  test('TS: JSDoc above (licence header ignored), multi-line signature, line-comment doc above a decorator', () => {
    const a = ok(funcSlice(TS, { startLine: lineOf(TS, 'export function add'), maxLines: 80, file: 'a.ts' }));
    assert.strictEqual(a.signature, 'export function add(a: number, b: number): number');
    assert.strictEqual(a.doc, 'Adds two numbers.\n@param a first');
    assert.strictEqual(a.body, '  return a + b;\n}');
    const c = ok(funcSlice(TS, { startLine: lineOf(TS, '@Injectable'), maxLines: 80, file: 'a.ts' }));
    assert.strictEqual(c.doc, 'Line comment doc\nsecond line');
    const lic = ok(funcSlice(TS.split('\n').slice(0, 13).join('\n').replace('/**\n * Adds two numbers.\n * @param a first\n */\n', ''),
      { startLine: 5, maxLines: 80, file: 'a.ts' }));
    assert.strictEqual(lic.doc, '', 'a licence block is not a doc comment');
  });

  test('TS: brace-less arrow, and a one-liner with a doc comment on the same line', () => {
    const t = ok(funcSlice(TS, { startLine: lineOf(TS, 'const twice'), maxLines: 80, file: 'a.ts' }));
    assert.strictEqual(t.totalLines, 1);
    assert.strictEqual(t.endReason, 'detected');
    const k = ok(funcSlice(TS, { startLine: lineOf(TS, 'function k()'), maxLines: 80, file: 'a.ts' }));
    assert.strictEqual(k.totalLines, 1);
    assert.strictEqual(k.body, '/** One-liner. */ function k() { return 1; }');
  });

  test('Java: javadoc above an annotation; abstract method ends at its own ";" (the Java/C++ gap)', () => {
    const a = ok(funcSlice(JAVA, { startLine: lineOf(JAVA, 'double area'), maxLines: 80, file: 'S.java' }));
    assert.deepStrictEqual([a.signature, a.doc, a.totalLines, a.body], ['double area()', 'Area in square units.', 1, '']);
    const n = ok(funcSlice(JAVA, { startLine: lineOf(JAVA, 'default String name'), maxLines: 80, file: 'S.java' }));
    assert.deepStrictEqual([n.signature, n.doc, n.totalLines], ['default String name()', 'The name.', 3]);
  });

  test('C++: /// doc on a prototype, // doc on a definition', () => {
    const p = ok(funcSlice(CPP, { startLine: 3, maxLines: 80, file: 'a.cpp' }));
    assert.deepStrictEqual([p.signature, p.doc, p.totalLines], ['int add(int a, int b)', 'Adds.\nReturns the sum.', 1]);
    const d = ok(funcSlice(CPP, { startLine: lineOf(CPP, 'int sub'), maxLines: 80, file: 'a.cpp' }));
    assert.deepStrictEqual([d.doc, d.endLine, d.endReason], ['Subtracts.', 8, 'detected']);
  });

  test('maxLines is the caller\'s: 8 for the peek, 80 for get_symbol; capped slices say so', () => {
    const big = ['function big() {', ...Array.from({ length: 100 }, (_, i) => `  s${i}();`), '}'].join('\n');
    const peek = ok(funcSlice(big, { startLine: 1, maxLines: 8, file: 'a.ts' }));
    assert.deepStrictEqual([peek.source.split('\n').length, peek.body.split('\n').length, peek.endLine, peek.totalLines, peek.endReason],
      [8, 8, 8, 102, 'maxLines']);
    const slice = ok(funcSlice(big, { startLine: 1, maxLines: 80, file: 'a.ts' }));
    assert.deepStrictEqual([slice.endLine, slice.endReason], [80, 'maxLines']);
    const all = ok(funcSlice(big, { startLine: 1, maxLines: 500, file: 'a.ts' }));
    assert.deepStrictEqual([all.endLine, all.endReason], [102, 'detected']);
  });

  test('unclosed: fallback only when detection hits EOF; otherwise eof', () => {
    const src = 'function broken() {\n  a();\n  b();\nfunction next() {\n  c();\n';
    const eof = ok(funcSlice(src, { startLine: 1, maxLines: 80, file: 'a.ts' }));
    assert.deepStrictEqual([eof.endReason, eof.endLine], ['eof', 5], 'the trailing empty line is trimmed');
    const fb = ok(funcSlice(src, { startLine: 1, maxLines: 80, file: 'a.ts', nextStartLine: 4 }));
    assert.deepStrictEqual([fb.endReason, fb.endLine, fb.source], ['fallback', 3, 'function broken() {\n  a();\n  b();']);
    const fb2 = ok(funcSlice(src, { startLine: 1, maxLines: 80, file: 'a.ts', fallbackEndLine: 2 }));
    assert.strictEqual(fb2.endLine, 2);
    // a CLOSED function ignores the fallback, even when a nested function would be the "next symbol"
    const nested = 'def outer():\n    def inner():\n        return 1\n    return inner()\n';
    const r = ok(funcSlice(nested, { startLine: 1, maxLines: 80, file: 'a.py', nextStartLine: 2 }));
    assert.deepStrictEqual([r.endReason, r.endLine], ['detected', 4]);
  });

  test('errors come back as values, never thrown', () => {
    assert.deepStrictEqual(funcSlice('a\nb', { startLine: 9, maxLines: 8 }).ok, false);
    assert.ok(/out of range/.test((funcSlice('a', { startLine: 0, maxLines: 8 }) as any).error));
    assert.ok(/maxLines/.test((funcSlice('a', { startLine: 1, maxLines: 0 }) as any).error));
    const gone = readFuncSlice('/w/gone.py', () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); }, { startLine: 1, maxLines: 8 });
    assert.deepStrictEqual(gone, { ok: false, error: 'could not read /w/gone.py: ENOENT: no such file' });
    assert.strictEqual(readFuncSlice('/w/x.py', () => undefined as any, { startLine: 1, maxLines: 8 }).ok, false);
    assert.strictEqual(readFuncSlice('/w/x.py', () => { throw 'boom'; }, { startLine: 1, maxLines: 8 }).ok, false);
  });

  test('readFuncSlice hands the caller\'s path to readText verbatim (no resolution of its own)', () => {
    const seen: string[] = [];
    const weird = '../../etc/../w/./a.py';
    const r = ok(readFuncSlice(weird, p => { seen.push(p); return 'def f():\n    return 1\n'; }, { startLine: 1, maxLines: 8 }));
    assert.deepStrictEqual(seen, [weird]);
    assert.strictEqual(r.signature, 'def f()', 'language still derived from the extension');
  });

  test('CRLF text and very long signatures', () => {
    const r = ok(funcSlice('def f(a,\r\n      b):\r\n    """Doc."""\r\n    return a\r\n', { startLine: 1, maxLines: 8, file: 'a.py' }));
    assert.deepStrictEqual([r.signature, r.doc], ['def f(a, b)', 'Doc.']);
    assert.ok(!r.source.includes('\r'));
    const long = 'function f(' + Array.from({ length: 80 }, (_, i) => `arg${i}: number`).join(', ') + ') {\n}\n';
    assert.ok(ok(funcSlice(long, { startLine: 1, maxLines: 8, file: 'a.ts' })).signature.length <= SIGNATURE_MAX_CHARS);
  });
});

suite('funcBrief and the MCP slice agree (one scanner, one range)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readSlice } = require('../../mcp/sourceSlice');
  const os = require('os');
  const cases: [string, string, number][] = [
    ['a.py', PY, lineOf(PY, '@cached')], ['a.py', PY, lineOf(PY, 'def short')], ['a.py', PY, lineOf(PY, 'def one')],
    ['a.ts', TS, lineOf(TS, 'export function add')], ['a.ts', TS, lineOf(TS, 'const twice')], ['a.ts', TS, lineOf(TS, '@Injectable')],
    ['S.java', JAVA, lineOf(JAVA, 'double area')], ['S.java', JAVA, lineOf(JAVA, 'default String name')],
    ['a.cpp', CPP, 3], ['a.cpp', CPP, lineOf(CPP, 'int sub')],
    ['b.ts', 'function broken() {\n  a();\n\n', 1],
    ['c.ts', ['function big() {', ...Array.from({ length: 100 }, (_, i) => `  s${i}();`), '}', '', ''].join('\n'), 1],
  ];
  for (const maxLines of [8, 80]) {
    test(`same source, endLine and endReason at maxLines ${maxLines}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-parity-'));
      try {
        for (const [name, text, line] of cases) {
          const file = path.join(dir, name);
          fs.writeFileSync(file, text);
          const a = ok(funcSlice(text, { startLine: line, maxLines, file }));
          const b = readSlice(file, line, { maxLines });
          assert.strictEqual(b.ok, true, name + ':' + line);
          assert.deepStrictEqual({ source: a.source, endLine: a.endLine, endReason: a.endReason },
            { source: b.source, endLine: b.endLine, endReason: b.endReason }, name + ':' + line);
        }
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
