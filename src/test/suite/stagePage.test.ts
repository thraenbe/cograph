import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { STAGE_SCRIPTS, renderStagePage, themeDeclarations, StagePageInput } from '../../stagePage';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const WEBVIEW = path.join(ROOT, 'src', 'webview');

/** In src/webview, on purpose not stage scripts of a page without the timeline. */
const NOT_STAGE = ['browserBridge.js', 'sidebar-vcs.js', 'simWorker.js', 'simWorkerCore.js', 'timeline.js'];

function input(extra: Partial<StagePageInput> = {}): StagePageInput {
  return {
    nonce: 'n'.repeat(32), cspSource: 'https://webview.test', asset: (file) => `/w/${file}`,
    d3Src: '/w/d3.min.js', d3IsLocal: true, timelineMode: false, browser: false, inject: {},
    bootConfig: { defaultEngine: 'shelf', defaultMode: 'static', perf: false, workers: 'auto', workerUri: null, sameFileEdgesOnly: true },
    ...extra,
  };
}

const scriptsOf = (html: string): string[] =>
  [...html.matchAll(/<script[^>]*\ssrc="\/w\/([^"]+)"/g)].map(m => m[1]).filter(f => f !== 'd3.min.js');

suite('stagePage: the page without vscode', () => {
  test('no module of the page imports vscode: scripts/build-stage.js loads them in plain Node', () => {
    for (const file of ['stagePage.ts', 'stageMarkup.ts']) {
      const text = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
      assert.ok(!/from\s+'vscode'|require\('vscode'\)/.test(text), file);
    }
  });

  test('STAGE_SCRIPTS: state.js first, stageApi.js last, no file twice, every file exists', () => {
    assert.strictEqual(STAGE_SCRIPTS[0], 'state.js');
    assert.strictEqual(STAGE_SCRIPTS[STAGE_SCRIPTS.length - 1], 'stageApi.js');
    assert.strictEqual(new Set(STAGE_SCRIPTS).size, STAGE_SCRIPTS.length);
    for (const file of STAGE_SCRIPTS) { assert.ok(fs.existsSync(path.join(WEBVIEW, file)), file); }
  });

  test('a new file in src/webview is a stage script or named here, so the static page cannot miss one', () => {
    const onDisk = fs.readdirSync(WEBVIEW).filter(f => f.endsWith('.js') && f !== 'staticBridge.js').sort();
    assert.deepStrictEqual(onDisk, [...STAGE_SCRIPTS, ...NOT_STAGE].sort());
  });

  test('the page loads exactly STAGE_SCRIPTS, in that order', () => {
    assert.deepStrictEqual(scriptsOf(renderStagePage(input())), [...STAGE_SCRIPTS]);
  });

  test('the bridge loads before every stage script, the timeline between slotDrag.js and hoverCard.js', () => {
    const list = scriptsOf(renderStagePage(input({ browser: true, timelineMode: true })));
    assert.strictEqual(list[0], 'browserBridge.js');
    assert.strictEqual(list.indexOf('timeline.js'), list.indexOf('slotDrag.js') + 1);
    assert.strictEqual(list.indexOf('hoverCard.js'), list.indexOf('timeline.js') + 1);
  });

  test('theme declarations: both sets name every variable, and the values differ where the themes do', () => {
    const names = (s: string) => [...s.matchAll(/--vscode-[\w-]+/g)].map(m => m[0]).sort();
    assert.deepStrictEqual(names(themeDeclarations('light')), names(themeDeclarations('dark')));
    assert.ok(themeDeclarations('dark').includes('--vscode-editor-background: #1f1f1f;'));
    assert.ok(themeDeclarations('light').includes('--vscode-editor-background: #ffffff;'));
  });
});
