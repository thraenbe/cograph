import * as assert from 'assert';

// Repository text (language names, file and folder names) must reach the panel as
// text, never as markup: code scanning alert #2 and its unflagged sibling in the
// context menu. A file named like the payload below is legal on Linux and macOS.
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { JSDOM } = require('jsdom');
const { renderLanguageLegend } = require('../../../src/webview/colors.js');
const { showContextMenu } = require('../../../src/webview/folder.js');

const PAYLOAD = '<img src=x onerror="window.__pwned=1">.py';

suite('webview: repository text renders as text', () => {
  const g = global as any;
  let saved: Record<string, unknown>;
  let doc: Document;

  setup(() => {
    saved = { document: g.document, window: g.window, state: g.state };
    const dom = new JSDOM(`<!DOCTYPE html><body>
      <div id="language-legend"></div>
      <div id="ctx-menu"><ul id="ctx-menu-list"></ul></div>
    </body>`);
    doc = dom.window.document;
    g.document = doc;
    g.window = dom.window;
  });
  teardown(() => { Object.assign(g, saved); });

  test('language legend: a language name with markup is a label, not an element', () => {
    g.state = { graphData: { nodes: [{ language: PAYLOAD }, { language: 'python' }] } };
    renderLanguageLegend();
    const legend = doc.getElementById('language-legend') as HTMLElement;
    assert.strictEqual(legend.querySelector('img'), null, 'no <img> element was created');
    const labels = [...legend.querySelectorAll('.lang-label')].map(el => el.textContent);
    assert.deepStrictEqual(labels, [PAYLOAD, 'python']);
    const swatches = [...legend.querySelectorAll<HTMLInputElement>('input.lang-swatch')];
    assert.deepStrictEqual(swatches.map(s => s.dataset.lang), [PAYLOAD, 'python']);
    assert.strictEqual(swatches[1].value, '#3572a5', 'the python swatch keeps its colour');
  });

  test('context menu: a file-name header with markup is text; items still run their action', () => {
    let ran = 0;
    showContextMenu({ pageX: 1, pageY: 1 }, [
      { label: PAYLOAD, isHeader: true },
      { label: 'Go to File', action: () => { ran++; } },
    ]);
    const list = doc.getElementById('ctx-menu-list') as HTMLElement;
    assert.strictEqual(list.querySelector('img'), null, 'no <img> element was created');
    const header = list.querySelector('.ctx-menu-header') as HTMLElement;
    assert.strictEqual(header.textContent, PAYLOAD);
    const item = list.querySelector('.ctx-menu-item') as HTMLElement;
    assert.strictEqual(item.dataset.idx, '0');
    g.hideContextMenu = () => undefined;
    item.click();
    assert.strictEqual(ran, 1);
  });
});
