import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';
import { getWebviewHtml } from '../../webviewHtmlBuilder';

// ux16 search bar (Bela, 10 Nov: "I want the search/filter functions to move out of the settings"):
// the function filter and the three visibility switches sit in an always-visible bar on the canvas,
// the Settings panel keeps Display and Configuration. Checked on the page the extension really builds.

/* eslint-disable @typescript-eslint/no-explicit-any */

function fakeWebview(): vscode.Webview {
  return {
    cspSource: 'https://webview.test',
    asWebviewUri: (u: vscode.Uri) => vscode.Uri.parse(`https://webview.test${u.path}`),
  } as any;
}

suite('webview HTML: search bar on the canvas', () => {
  let dir: string;
  let doc: Document;
  let html: string;
  suiteSetup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-html-'));
    html = getWebviewHtml(fakeWebview(), vscode.Uri.file(dir));
    doc = new JSDOM(html).window.document;
  });
  suiteTeardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('the filter box, its cross and its count are in #search-bar, outside the settings panel', () => {
    const bar = doc.getElementById('search-bar');
    assert.ok(bar, '#search-bar exists');
    assert.strictEqual(bar!.closest('#settings-panel'), null);
    for (const id of ['search', 'btn-clear-search', 'search-count', 'btn-search-filters']) {
      const els = doc.querySelectorAll(`#${id}`);
      assert.strictEqual(els.length, 1, `exactly one #${id}`);
      assert.ok(els[0].closest('#search-bar'), `#${id} sits in the bar`);
    }
  });

  test('the visibility switches moved with it; the settings panel has no Filters section left', () => {
    for (const id of ['toggle-orphans', 'toggle-libraries', 'toggle-empty-files', 'libraries-hint']) {
      assert.strictEqual(doc.querySelectorAll(`#${id}`).length, 1, `exactly one #${id}`);
      assert.ok(doc.getElementById(id)!.closest('#search-filters'), `#${id} sits in the switches popover`);
    }
    const panel = doc.getElementById('settings-panel')!;
    const headings = [...panel.querySelectorAll('h4')].map(h => h.textContent?.trim());
    assert.deepStrictEqual(headings, ['Display', 'Configuration']);
    assert.strictEqual(panel.querySelector('input[type="text"]'), null, 'no text field left in the panel');
  });

  test('searchBar.js is loaded after controls.js (it extends controls.js\'s Escape chain)', () => {
    const controls = html.indexOf('/controls.js?v=');
    const bar = html.indexOf('/searchBar.js?v=');
    assert.ok(controls > 0 && bar > controls);
  });
});
