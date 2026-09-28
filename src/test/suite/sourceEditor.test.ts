import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanFuncEnd, funcLangOf, FuncLang } from '../../funcEnd';
import { getFuncSource, saveFuncSource, UNCLOSED_READ_CAP } from '../../sourceEditor';

// ── The 1.3.0 finders, verbatim, as the reference for "well-formed code is unchanged" ──
function legacyPy(lines: string[], startIdx: number): number {
  const baseIndent = lines[startIdx].match(/^(\s*)/)?.[1].length ?? 0;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { continue; }
    if ((lines[i].match(/^(\s*)/)?.[1].length ?? 0) <= baseIndent) { return i - 1; }
  }
  return lines.length - 1;
}
function legacyJs(lines: string[], startIdx: number): number {
  let depth = 0, foundOpen = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; foundOpen = true; } else if (ch === '}') { depth--; }
    }
    if (!foundOpen && i > startIdx) { return startIdx; }
    if (foundOpen && depth === 0) { return i; }
  }
  return lines.length - 1;
}

const L = (src: string) => src.split('\n');
/** 1-based line of the first line containing `needle`. */
const lineOf = (src: string, needle: string) => L(src).findIndex(l => l.includes(needle)) + 1;
function endOf(src: string, needle: string, lang: FuncLang) {
  const lines = L(src);
  const r = scanFuncEnd(lines, lineOf(src, needle) - 1, lang);
  return { text: lines.slice(lineOf(src, needle) - 1, r.end + 1).join('\n'), closed: r.closed, end: r.end };
}

const PY = [
  'import os', '', '', 'def alpha(x):', '    """Doc."""', '    if x:', '        return 1', '', '    return 2', '', '',
  'class K:', '    def m(self):', '        return self', '', '    def n(self, a,', '          b):', '        return a + b', '',
  'def last():', '    pass', '',
].join('\n');
const TS = [
  'export function a(x: number): number {', '  if (x) { return 1; }', '  return 2;', '}', '',
  'class C {', '  m(): void {', '    this.n();', '  }', '  n() { return 1; }', '}', '',
  'const f = (y: string) => {', '  return y;', '};', '', 'function z() {}',
].join('\n');

suite('funcEnd / sourceEditor (save must never destroy code)', () => {
  test('well-formed Python and TS/JS: same end as 1.3.0 (click popup unchanged)', () => {
    const py = L(PY), ts = L(TS);
    for (const needle of ['def alpha', 'def m(', 'def n(', 'def last']) {
      const i = lineOf(PY, needle) - 1;
      assert.strictEqual(scanFuncEnd(py, i, 'python').end, legacyPy(py, i), needle);
    }
    for (const needle of ['function a(', 'm(): void', 'n() {', 'const f =', 'function z']) {
      const i = lineOf(TS, needle) - 1;
      assert.strictEqual(scanFuncEnd(ts, i, 'js').end, legacyJs(ts, i), needle);
    }
  });

  test('language by extension', () => {
    assert.deepStrictEqual(['a.py', 'a.ts', 'a.jsx', 'a.java', 'a.hpp', 'a.cc', 'a.go'].map(funcLangOf),
      ['python', 'js', 'js', 'java', 'cpp', 'cpp', 'brace']);
  });

  test('Java abstract/interface method ends at its own ";" (was: swallowed the next method)', () => {
    const src = 'interface Shape {\n  double area();\n  default String name() {\n    return "shape";\n  }\n}';
    assert.deepStrictEqual(endOf(src, 'area()', 'java'), { text: '  double area();', closed: true, end: 1 });
    assert.strictEqual(endOf(src, 'name()', 'java').text, '  default String name() {\n    return "shape";\n  }');
  });

  test('C++ prototype followed by a real function', () => {
    const src = 'int add(int a, int b);\nint sub(int a, int b) {\n  return a - b;\n}';
    assert.strictEqual(endOf(src, 'add(', 'cpp').text, 'int add(int a, int b);');
    assert.strictEqual(endOf(src, 'sub(', 'cpp').text, 'int sub(int a, int b) {\n  return a - b;\n}');
  });

  test('a brace in a string, char, template, line comment, block comment or regex is not code', () => {
    const cases: [string, FuncLang][] = [
      ['function f() {\n  const s = "}";\n  return s;\n}', 'js'],
      ["function f() {\n  console.log('{');\n  return 1;\n}", 'js'],
      ['function f() {\n  const t = `a } ${x} {`;\n  return t;\n}', 'js'],
      ['function f() {\n  // TODO: handle { later\n  return 1;\n}', 'js'],
      ['function f() {\n  /* } */ const a = 1;\n  return a;\n}', 'js'],
      ['function f(s) {\n  const r = /\\{[^}]*/;\n  return s.replace(/\\}/g, "");\n}', 'js'],
      ["char f() {\n  char c = '}';\n  return c;\n}", 'cpp'],
      ['const char* f() {\n  return R"(a } b)";\n}', 'cpp'],
      ['String f() {\n  return """\n    }\n    """;\n}', 'java'],
    ];
    for (const [src, lang] of cases) {
      const r = endOf(src, 'f(', lang);
      assert.deepStrictEqual({ end: r.end, closed: r.closed }, { end: L(src).length - 1, closed: true }, src);
    }
  });

  test('multi-line TS signature with a type literal, and a brace-less arrow', () => {
    const src = 'function f(\n  opts: { a: number; b: string },\n): void {\n  go(opts);\n}\nconst g = (x: number) => x + 1\nconst h = 2;';
    assert.strictEqual(endOf(src, 'function f(', 'js').end, 4);
    assert.strictEqual(endOf(src, 'const g', 'js').end, 5);
  });

  test('Python: col-0 text inside a triple-quoted string, a col-0 comment and a col-0 bracket continuation stay in the body', () => {
    const src = 'def f():\n    s = """\ncol 0 text\n"""\n# a comment at col 0\n    x = foo(1,\n2)\n    return s\n\ndef g():\n    pass';
    assert.strictEqual(endOf(src, 'def f', 'python').text.split('\n').pop(), '');   // trailing blank kept, as before
    assert.strictEqual(endOf(src, 'def f', 'python').end, 8);
  });

  test('corpus regressions: "=>" inside a decorator, a backslash-continued Python string', () => {
    // nest: @Query(returns => [Recipe]) ended the scan at the decorator line
    const ts = '  @Query(returns => [Recipe])\n  recipes(): Recipe[] {\n    return [];\n  }\n  other() {}';
    assert.strictEqual(endOf(ts, '@Query', 'js').end, 3);
    // numpy: "…\\<newline>…" is one string; its quote must not open a new one
    const py = 'def main():\n    print(f"a\\\nb")\n    return 0\n\ndef g():\n    pass';
    assert.deepStrictEqual({ ...endOf(py, 'def main', 'python') }, { text: 'def main():\n    print(f"a\\\nb")\n    return 0\n', closed: true, end: 4 });
  });

  test('an unterminated body is reported, and the read path caps it', () => {
    const body = Array.from({ length: 400 }, (_, i) => `  x${i}();`);
    const src = ['function broken() {', ...body].join('\n');
    const r = endOf(src, 'broken', 'js');
    assert.strictEqual(r.closed, false);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-se-'));
    try {
      const file = path.join(tmp, 'a.ts');
      fs.writeFileSync(file, src);
      assert.strictEqual(getFuncSource(file, 1).split('\n').length, UNCLOSED_READ_CAP);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  suite('saveFuncSource round-trip guard', () => {
    let tmp: string;
    setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-se-')); });
    teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

    const write = (name: string, text: string) => { const f = path.join(tmp, name); fs.writeFileSync(f, text, 'utf8'); return f; };
    function assertRefuses(file: string, fn: () => void, re: RegExp) {
      const before = fs.readFileSync(file);
      assert.throws(fn, re);
      assert.ok(fs.readFileSync(file).equals(before), 'file must be byte-identical after a refused save');
    }

    test('happy path py / ts: only the function changes, the rest of the file is byte-identical', () => {
      const py = write('a.py', PY);
      const line = lineOf(PY, 'def m(');
      const shown = getFuncSource(py, line);
      saveFuncSource(py, line, shown.replace('return self', 'return 42'), shown);
      const after = fs.readFileSync(py, 'utf8');
      assert.strictEqual(after, PY.replace('        return self', '        return 42'));

      const ts = write('a.ts', TS);
      const tl = lineOf(TS, 'function a(');
      saveFuncSource(ts, tl, 'export function a(x: number): number {\n  return 3;\n}', getFuncSource(ts, tl));
      assert.strictEqual(fs.readFileSync(ts, 'utf8'), TS.replace('  if (x) { return 1; }\n  return 2;\n', '  return 3;\n'));
    });

    test('refuses when no original is sent', () => {
      const f = write('a.py', PY);
      assertRefuses(f, () => saveFuncSource(f, 4, 'def alpha(x):\n    pass', undefined), /not sent/);
      assertRefuses(f, () => saveFuncSource(f, 4, 'def alpha(x):\n    pass', null), /not sent/);
    });

    test('refuses when the end cannot be found (never "to the end of the file")', () => {
      const src = 'function broken() {\n  x();\nfunction after() {\n  keep();\n}\n';
      const f = write('a.ts', src);
      const shown = getFuncSource(f, 1);
      assertRefuses(f, () => saveFuncSource(f, 1, 'function broken() {}', shown), /could not find where/);
    });

    test('stray "}" in a string: an original cut short by the 1.3.0 finder no longer matches → refused', () => {
      const src = 'function f() {\n  const s = "}";\n  return s;\n}\nfunction g() {\n  keep();\n}\n';
      const f = write('a.ts', src);
      const shownBy130 = L(src).slice(0, legacyJs(L(src), 0) + 1).join('\n');   // what a 1.3.0 popup showed
      assert.strictEqual(shownBy130.split('\n').length, 2);
      assertRefuses(f, () => saveFuncSource(f, 1, 'function f() {\n  return 1;\n}', shownBy130), /changed/);
      // and with the text the popup shows now, the whole function is replaced, g() intact
      saveFuncSource(f, 1, 'function f() {\n  return 1;\n}', getFuncSource(f, 1));
      assert.strictEqual(fs.readFileSync(f, 'utf8'), 'function f() {\n  return 1;\n}\nfunction g() {\n  keep();\n}\n');
    });

    test('file edited in the editor while the popup was open → refused, editor edits survive', () => {
      const f = write('a.py', PY);
      const line = lineOf(PY, 'def alpha');
      const shown = getFuncSource(f, line);
      // 1) an edit inside the function
      const edited = PY.replace('    return 2', '    return 20');
      fs.writeFileSync(f, edited, 'utf8');
      assertRefuses(f, () => saveFuncSource(f, line, 'def alpha(x):\n    pass', shown), /changed/);
      // 2) lines inserted above it: the function moved, the old line now points elsewhere
      fs.writeFileSync(f, 'import sys\n' + PY, 'utf8');
      assertRefuses(f, () => saveFuncSource(f, line, 'def alpha(x):\n    pass', shown), /changed/);
    });

    test('two popups on one file: saving the first shifts lines, the second (stale line) is refused', () => {
      const f = write('a.py', PY);
      const la = lineOf(PY, 'def alpha'), lm = lineOf(PY, 'def m(');
      const shownA = getFuncSource(f, la), shownM = getFuncSource(f, lm);
      saveFuncSource(f, la, shownA.replace('    return 2', '    x = 1\n    y = 2\n    return 2'), shownA);   // +2 lines
      const afterA = fs.readFileSync(f);
      // 1.3.0 would now splice popup M's text over whatever sits at M's OLD line
      assertRefuses(f, () => saveFuncSource(f, lm, shownM.replace('return self', 'return 0'), shownM), /changed/);
      assert.ok(fs.readFileSync(f).equals(afterA));
    });

    test('CRLF files: the guard compares normalised text and keeps CRLF', () => {
      const f = write('a.py', 'def hello():\r\n    return 1\r\n\r\ndef other():\r\n    return 2\r\n');
      saveFuncSource(f, 1, 'def hello():\n    return 42\n', getFuncSource(f, 1));
      assert.strictEqual(fs.readFileSync(f, 'utf8'), 'def hello():\r\n    return 42\r\n\r\ndef other():\r\n    return 2\r\n');
    });
  });
});
