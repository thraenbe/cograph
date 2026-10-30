import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require('jsdom');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { showLibDocPopup } = require('../../../src/webview/popups.js');

const css = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'webview', 'styles.css'), 'utf8');

/** True when styles.css has a rule whose selector list names `.className`. */
function hasRule(className: string): boolean {
  return new RegExp(`\\.${className}\\s*[{,]`).test(css);
}

suite('library popup language badge', () => {
  const g = global as any;
  const saved: Record<string, unknown> = {};
  let doc: any;

  suiteSetup(() => {
    for (const k of ['document', 'state', 'vscode']) { saved[k] = g[k]; }
    doc = new JSDOM(`<!DOCTYPE html><body>
      <div id="lib-doc-popup"></div><span id="lib-doc-title"></span><span id="lib-doc-lang-badge"></span>
      <span id="lib-doc-function"></span><span id="lib-doc-package"></span><span id="lib-doc-url"></span>
      <div id="lib-doc-desc-row"><span id="lib-doc-desc"></span></div></body>`).window.document;
    g.document = doc;
    g.state = {};
    g.vscode = { postMessage: () => undefined };
  });
  suiteTeardown(() => { for (const k of Object.keys(saved)) { g[k] = saved[k]; } });

  test('a C library node gets the "C" badge, and its class has a style rule', () => {
    showLibDocPopup({ language: 'c', libraryName: 'stdio', name: 'printf' });
    const badge = doc.getElementById('lib-doc-lang-badge');
    assert.strictEqual(badge.textContent, 'C');
    assert.deepStrictEqual([...badge.classList], ['lang-badge', 'lang-badge-c']);
    assert.ok(hasRule('lang-badge-c'), 'styles.css has no .lang-badge-c rule');
  });
});
