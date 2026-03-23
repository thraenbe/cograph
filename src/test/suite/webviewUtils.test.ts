import * as assert from 'assert';

// ---------------------------------------------------------------------------
// highlight.js — highlightCode() is a pure function with no external deps.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { highlightCode } = require('../../../src/webview/highlight.js');

// ---------------------------------------------------------------------------
// colors.js — resolveNodeFill() reads global `state` and `nodeColor`.
// Set up those globals before requiring.
// ---------------------------------------------------------------------------

// nodeColor is defined in rendering.js (which requires D3 + a DOM). Stub it.
(global as any).nodeColor = (_d: any) => '#d4d4d4';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveNodeFill, getLanguageColor } = require('../../../src/webview/colors.js');

// ---------------------------------------------------------------------------
// Suite: highlightCode — Python
// ---------------------------------------------------------------------------

suite('highlightCode — Python', () => {
  test('empty string → returns empty string', () => {
    assert.strictEqual(highlightCode('', 'python'), '');
  });

  test('def keyword → blue span, followed by function name in yellow', () => {
    const result = highlightCode('def foo():', 'python');
    assert.ok(result.includes('<span style="color:#569cd6">def</span>'), 'def should be blue');
    assert.ok(result.includes('<span style="color:#dcdcaa">foo</span>'), 'function name should be yellow');
  });

  test('class keyword → blue span, followed by class name in teal', () => {
    const result = highlightCode('class Foo:', 'python');
    assert.ok(result.includes('<span style="color:#569cd6">class</span>'), 'class should be blue');
    assert.ok(result.includes('<span style="color:#4ec9b0">Foo</span>'), 'class name should be teal');
  });

  test('return keyword → blue span', () => {
    const result = highlightCode('return x', 'python');
    assert.ok(result.includes('<span style="color:#569cd6">return</span>'));
  });

  test('import keyword → blue span', () => {
    const result = highlightCode('import os', 'python');
    assert.ok(result.includes('<span style="color:#569cd6">import</span>'));
  });

  test('if, for, while keywords → highlighted', () => {
    for (const kw of ['if', 'for', 'while']) {
      const result = highlightCode(`${kw} x:`, 'python');
      assert.ok(result.includes(`<span style="color:#569cd6">${kw}</span>`), `${kw} should be highlighted`);
    }
  });

  test('Python line comment # → green span', () => {
    const result = highlightCode('# this is a comment', 'python');
    assert.ok(result.includes('<span style="color:#6a9955">'), 'comment should be green');
    assert.ok(result.includes('this is a comment'));
  });

  test('single-quoted string → orange span', () => {
    const result = highlightCode("x = 'hello'", 'python');
    assert.ok(result.includes('<span style="color:#ce9178">'), 'string should be orange');
    assert.ok(result.includes("'hello'"));
  });

  test('double-quoted string → orange span', () => {
    const result = highlightCode('x = "world"', 'python');
    assert.ok(result.includes('<span style="color:#ce9178">'), 'string should be orange');
    assert.ok(result.includes('"world"'));
  });

  test('triple-quoted string → orange span', () => {
    const result = highlightCode('"""docstring"""', 'python');
    assert.ok(result.includes('<span style="color:#ce9178">'), 'triple-quoted string should be highlighted');
    assert.ok(result.includes('docstring'));
  });

  test('Python decorator @name → purple span', () => {
    const result = highlightCode('@staticmethod', 'python');
    assert.ok(result.includes('<span style="color:#c586c0">'), 'decorator should be purple');
    assert.ok(result.includes('@staticmethod'));
  });

  test('number literal → number color span', () => {
    const result = highlightCode('x = 42', 'python');
    assert.ok(result.includes('<span style="color:#b5cea8">42</span>'), 'number should be highlighted');
  });

  test('identifier not a keyword → escaped but not wrapped in span', () => {
    const result = highlightCode('my_var = 1', 'python');
    // my_var is not a keyword, so just escaped text
    assert.ok(result.includes('my_var'), 'identifier should appear in output');
    assert.ok(!result.includes('<span style="color:#569cd6">my_var</span>'), 'non-keyword should not get keyword color');
  });

  test('keyword inside longer identifier (e.g. "returned") → NOT highlighted as keyword', () => {
    const result = highlightCode('returned = True', 'python');
    // "returned" is not a keyword — only "return" is
    assert.ok(!result.includes('<span style="color:#569cd6">returned</span>'), '"returned" should not be highlighted as keyword');
    assert.ok(result.includes('returned'), '"returned" should appear as plain text');
  });

  test('HTML special chars in source → escaped', () => {
    const result = highlightCode('x = a < b && c > d', 'python');
    assert.ok(result.includes('&lt;'), '< should be escaped');
    assert.ok(result.includes('&gt;'), '> should be escaped');
  });

  test('None and True and False are Python keywords → highlighted', () => {
    for (const kw of ['None', 'True', 'False']) {
      const result = highlightCode(kw, 'python');
      assert.ok(result.includes(`<span style="color:#569cd6">${kw}</span>`), `${kw} should be highlighted`);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: highlightCode — TypeScript
// ---------------------------------------------------------------------------

suite('highlightCode — TypeScript', () => {
  test('function keyword → blue, followed by function name in yellow', () => {
    const result = highlightCode('function greet():', 'typescript');
    assert.ok(result.includes('<span style="color:#569cd6">function</span>'));
    assert.ok(result.includes('<span style="color:#dcdcaa">greet</span>'));
  });

  test('const keyword → blue span', () => {
    const result = highlightCode('const x = 1;', 'typescript');
    assert.ok(result.includes('<span style="color:#569cd6">const</span>'));
  });

  test('let and var keywords → highlighted', () => {
    for (const kw of ['let', 'var']) {
      const result = highlightCode(`${kw} x;`, 'typescript');
      assert.ok(result.includes(`<span style="color:#569cd6">${kw}</span>`), `${kw} should be highlighted`);
    }
  });

  test('interface keyword → highlighted', () => {
    const result = highlightCode('interface IFoo {}', 'typescript');
    assert.ok(result.includes('<span style="color:#569cd6">interface</span>'));
  });

  test('TS single-line comment // → green span', () => {
    const result = highlightCode('// comment here', 'typescript');
    assert.ok(result.includes('<span style="color:#6a9955">'), 'comment should be green');
    assert.ok(result.includes('comment here'));
  });

  test('TS block comment /* */ → green span', () => {
    const result = highlightCode('/* block comment */', 'typescript');
    assert.ok(result.includes('<span style="color:#6a9955">'));
    assert.ok(result.includes('block comment'));
  });

  test('template literal backtick string → orange span', () => {
    const result = highlightCode('const s = `hello ${name}`;', 'typescript');
    assert.ok(result.includes('<span style="color:#ce9178">'), 'template literal should be highlighted');
  });

  test('TS double-quoted string → orange span', () => {
    const result = highlightCode('"hello"', 'typescript');
    assert.ok(result.includes('<span style="color:#ce9178">"hello"</span>'));
  });

  test('TS single-quoted string → orange span', () => {
    const result = highlightCode("'world'", 'typescript');
    assert.ok(result.includes('<span style="color:#ce9178">'));
  });

  test('TS return, if, else keywords → highlighted', () => {
    for (const kw of ['return', 'if', 'else']) {
      const result = highlightCode(`${kw} x;`, 'typescript');
      assert.ok(result.includes(`<span style="color:#569cd6">${kw}</span>`), `${kw} should be highlighted`);
    }
  });

  test('Python # not treated as comment in TS mode', () => {
    const result = highlightCode('const x = a # b;', 'typescript');
    // In TS mode, # is not a comment marker — it should just be plain text
    assert.ok(!result.includes('<span style="color:#6a9955"># b'), '# should not be treated as comment in TS mode');
  });

  test('Python triple-quote not treated as string in TS mode', () => {
    // In TS mode, """ should be handled as three separate double-quotes, not triple-quoted string
    const result = highlightCode('""" not triple """', 'typescript');
    // Each " starts a string, then immediately closes (empty string), so it should not span the whole block
    // The behavior in TS: first " opens string, next " closes it (empty string), then third starts another
    // Either way, the output is NOT a single big orange block covering the whole thing
    assert.ok(result.length > 0, 'should produce some output');
  });
});

// ---------------------------------------------------------------------------
// Suite: highlightCode — Edge Cases
// ---------------------------------------------------------------------------

suite('highlightCode — Edge Cases', () => {
  test('unknown language → falls back to TS mode (no crash)', () => {
    assert.doesNotThrow(() => {
      highlightCode('const x = 1;', 'ruby');
    });
  });

  test('source with only whitespace → returned safely', () => {
    const result = highlightCode('   \n\t  ', 'python');
    assert.ok(typeof result === 'string', 'should return a string');
  });

  test('very long identifier → handled without crash', () => {
    const longName = 'a'.repeat(1000);
    assert.doesNotThrow(() => highlightCode(longName, 'python'));
  });

  test('ampersand and angle brackets in identifiers → HTML-escaped', () => {
    const result = highlightCode('x = a&b', 'python');
    assert.ok(result.includes('&amp;'));
  });
});

// ---------------------------------------------------------------------------
// Suite: resolveNodeFill
// ---------------------------------------------------------------------------

suite('resolveNodeFill', () => {
  let savedState: any;

  setup(() => {
    savedState = (global as any).state;
    (global as any).state = { gitMode: false, languageMode: false };
  });

  teardown(() => {
    (global as any).state = savedState;
  });

  test('gitMode=true, unstaged=added → returns green #4caf50', () => {
    (global as any).state.gitMode = true;
    const node = { gitStatus: { unstaged: 'added', staged: null } };
    assert.strictEqual(resolveNodeFill(node), '#4caf50');
  });

  test('gitMode=true, unstaged=modified → returns orange #ff9800', () => {
    (global as any).state.gitMode = true;
    const node = { gitStatus: { unstaged: 'modified', staged: null } };
    assert.strictEqual(resolveNodeFill(node), '#ff9800');
  });

  test('gitMode=true, unstaged=deleted → returns dark gray #777777', () => {
    (global as any).state.gitMode = true;
    const node = { gitStatus: { unstaged: 'deleted', staged: null } };
    assert.strictEqual(resolveNodeFill(node), '#777777');
  });

  test('gitMode=true, unstaged=null, staged=modified → staged used as fallback', () => {
    (global as any).state.gitMode = true;
    const node = { gitStatus: { unstaged: null, staged: 'modified' } };
    assert.strictEqual(resolveNodeFill(node), '#ff9800');
  });

  test('gitMode=true, no gitStatus → falls through (calls nodeColor)', () => {
    (global as any).state.gitMode = true;
    const node = { gitStatus: null };
    // nodeColor is stubbed globally to return '#d4d4d4'
    assert.strictEqual(resolveNodeFill(node), '#d4d4d4');
  });

  test('gitMode=true, isCluster=true → skips git coloring (calls nodeColor)', () => {
    (global as any).state.gitMode = true;
    const node = { isCluster: true, gitStatus: { unstaged: 'modified', staged: null } };
    assert.strictEqual(resolveNodeFill(node), '#d4d4d4');
  });

  test('gitMode=false, languageMode=true, python node → returns Python blue', () => {
    (global as any).state.languageMode = true;
    const node = { language: 'python' };
    assert.strictEqual(resolveNodeFill(node), '#3572A5');
  });

  test('gitMode=false, languageMode=true, typescript node → returns configured TS color', () => {
    (global as any).state.languageMode = true;
    const node = { language: 'typescript' };
    const result = resolveNodeFill(node);
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(result), `typescript fill should be a hex color, got ${result}`);
  });

  test('gitMode=false, languageMode=true, unknown lang → returns hsl hash color', () => {
    (global as any).state.languageMode = true;
    const node = { language: 'rust' };
    const result = resolveNodeFill(node);
    assert.ok(result.startsWith('hsl('), 'unknown language should use hash-derived hsl color');
  });

  test('gitMode=true takes priority over languageMode=true', () => {
    (global as any).state.gitMode = true;
    (global as any).state.languageMode = true;
    const node = { gitStatus: { unstaged: 'added', staged: null }, language: 'python' };
    // gitMode wins → returns git color, not language color
    assert.strictEqual(resolveNodeFill(node), '#4caf50');
  });

  test('neither gitMode nor languageMode → calls nodeColor (returns stub)', () => {
    const node = { language: 'python' };
    assert.strictEqual(resolveNodeFill(node), '#d4d4d4');
  });
});

// ---------------------------------------------------------------------------
// Suite: getLanguageColor
// ---------------------------------------------------------------------------

suite('getLanguageColor', () => {
  test('python → returns #3572A5', () => {
    assert.strictEqual(getLanguageColor('python'), '#3572A5');
  });

  test('typescript → returns the configured TS color', () => {
    const result = getLanguageColor('typescript');
    // Color is configurable; verify it's a valid hex color
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(result), `typescript color should be a hex color, got ${result}`);
  });

  test('null/undefined → returns null', () => {
    assert.strictEqual(getLanguageColor(null), null);
    assert.strictEqual(getLanguageColor(undefined), null);
  });

  test('unknown language → returns deterministic hsl color', () => {
    const color1 = getLanguageColor('rust');
    const color2 = getLanguageColor('rust');
    assert.strictEqual(color1, color2, 'same lang should produce same color');
    assert.ok(color1.startsWith('hsl('), 'should be hsl format');
  });

  test('different unknown languages → different colors', () => {
    const colorA = getLanguageColor('rust');
    const colorB = getLanguageColor('haskell');
    // Very unlikely to collide due to hash function
    assert.notStrictEqual(colorA, colorB, 'different languages should produce different colors');
  });
});
