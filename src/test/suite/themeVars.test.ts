import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require('jsdom');

/* eslint-disable @typescript-eslint/no-explicit-any */

// rendering.js cannot be require()d (top-level d3/SVG), so the regression test
// evaluates the REAL getCSSVar source against the REAL stylesheet in jsdom.
const webviewDir = path.resolve(__dirname, '../../../src/webview');
const css = fs.readFileSync(path.join(webviewDir, 'styles.css'), 'utf8');
const renderingSrc = fs.readFileSync(path.join(webviewDir, 'rendering.js'), 'utf8');

function getCSSVarFrom(dom: any) {
  const m = renderingSrc.match(/function getCSSVar\([\s\S]*?\n\}/);
  assert.ok(m, 'getCSSVar found in rendering.js');
  const w = dom.window;
  return new Function(
    'document', 'getComputedStyle',
    `${m![0]}; return getCSSVar;`,
  )(w.document, w.getComputedStyle.bind(w));
}

function makeDom(bodyClass: string) {
  return new JSDOM(
    `<html><head><style>${css}</style></head><body class="${bodyClass}"></body></html>`,
  );
}

suite('theme variables — getCSSVar reads the body-scoped theme', () => {
  test('light theme: JS reads the body.vscode-light override, not the dark default', () => {
    const dom = makeDom('vscode-light');
    const w = dom.window;
    const lightVal = w.getComputedStyle(w.document.body).getPropertyValue('--cograph-node-default').trim();
    const darkVal = w.getComputedStyle(w.document.documentElement).getPropertyValue('--cograph-node-default').trim();
    assert.notStrictEqual(lightVal, darkVal,
      'sanity: styles.css must override --cograph-node-default under body.vscode-light');
    assert.strictEqual(getCSSVarFrom(dom)('--cograph-node-default'), lightVal,
      'getCSSVar must return the light value in a light theme');
  });

  test('getCSSVar reads from document.body, not documentElement', () => {
    // jsdom does not cascade :root custom properties down to body, so the
    // read scope is asserted directly with two competing inline values.
    // (In a real browser body inherits :root, so dark themes are unaffected.)
    const dom = new JSDOM('<html style="--t: #111"><body style="--t: #eee"></body></html>');
    assert.strictEqual(getCSSVarFrom(dom)('--t'), '#eee');
  });

  test('every dark --cograph colour has a light override (no half-themed palette)', () => {
    const dom = makeDom('vscode-light');
    const w = dom.window;
    const rootBlock = css.match(/:root\s*\{([\s\S]*?)\}/)![1];
    const names = [...rootBlock.matchAll(/(--cograph-[a-z-]+)\s*:/g)].map(x => x[1]);
    assert.ok(names.length >= 8, `expected a full palette, found ${names.length}`);
    for (const name of names) {
      const light = w.getComputedStyle(w.document.body).getPropertyValue(name).trim();
      assert.ok(light !== '', `${name} resolves under body.vscode-light`);
    }
  });
});

suite('theme variables: the canvas search bar (ux16)', () => {
  // The bar and its popover must look like the rest of the extension in every theme: each colour comes from
  // a --vscode-* variable (a literal is allowed only as that variable's fallback).
  const start = css.indexOf('/* ── Search bar (top right');
  const end = css.indexOf('/* ── Toggle rows ── */');

  /** Drops every var(...) call, nested fallbacks included, so only colours outside a variable remain. */
  function stripVars(value: string): string {
    let out = '';
    for (let i = 0; i < value.length; i++) {
      if (value.startsWith('var(', i)) {
        let depth = 0;
        for (; i < value.length; i++) {
          if (value[i] === '(') { depth++; } else if (value[i] === ')' && --depth === 0) { break; }
        }
        continue;
      }
      out += value[i];
    }
    return out;
  }

  test('the search bar block exists in styles.css', () => {
    assert.ok(start > 0 && end > start, 'search bar section found before the toggle rows');
  });

  test('every colour in the search bar rules comes from a theme variable', () => {
    const block = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
    const decls = [...block.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)];
    assert.ok(decls.length > 40, `expected the full bar styling, found ${decls.length} declarations`);
    const colourish = /^(color|background|background-color|border|border-color|border-left|box-shadow|outline|fill|stroke)$/;
    const literal = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black|red|blue|green|gray|grey)\b/i;
    let checked = 0;
    for (const [, prop, value] of decls) {
      if (!colourish.test(prop)) { continue; }
      checked++;
      assert.ok(!literal.test(stripVars(value)), `${prop}: ${value.trim()} has a colour outside a theme variable`);
    }
    assert.ok(checked >= 15, `expected many colour declarations, checked ${checked}`);
  });

  test('stripVars keeps a literal that is not a fallback (the check can fail)', () => {
    assert.strictEqual(literal('1px solid var(--a, #444)'), false);
    assert.strictEqual(literal('0 0 0 1px #000, 0 2px var(--b, rgba(0,0,0,.5))'), true);
    function literal(v: string): boolean { return /#[0-9a-f]{3,8}\b|rgba?\(/i.test(stripVars(v)); }
  });
});
