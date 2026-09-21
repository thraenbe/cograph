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
