import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { getWebviewHtml } from '../../webviewHtmlBuilder';

/* eslint-disable @typescript-eslint/no-explicit-any */

// U1: cograph.display.sameFileEdgesOnly — only calls within one file are drawn (default on).
const ROOT = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function html(sameFile?: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-u1-'));
  const stub = sameFile === undefined ? null : sinon.stub(vscode.workspace, 'getConfiguration').callsFake(() => ({
    get: (k: string, d: unknown) => (k === 'display.sameFileEdgesOnly' ? sameFile : d),
  }) as any);
  try {
    return getWebviewHtml({ cspSource: 'x', asWebviewUri: (u: vscode.Uri) => vscode.Uri.parse('https://w' + u.path) } as any, vscode.Uri.file(dir));
  } finally { stub?.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const boot = (h: string) => JSON.parse((h.match(/window\.COGRAPH_CONFIG = (\{[^<]*\});<\/script>/) as RegExpMatchArray)[1]);
const box = (h: string) => (h.match(/<input type="checkbox" id="toggle-same-file-edges"[^>]*>/) as RegExpMatchArray)[0];

suite('U1: only calls within a file', () => {
  test('package.json: setting declared, default on, description names what it hides', () => {
    const pkg = JSON.parse(read('package.json'));
    const p = pkg.contributes.configuration.properties['cograph.display.sameFileEdgesOnly'];
    assert.ok(p, 'setting declared');
    assert.strictEqual(p.type, 'boolean');
    assert.strictEqual(p.default, true);
    for (const word of ['different files', 'library', 'collapsed', 'Hover', 'layout is the same']) {
      assert.ok(p.markdownDescription.includes(word), `description mentions "${word}"`);
    }
  });

  test('boot config + panel toggle: on by default, off when the setting is off', () => {
    const on = html();
    assert.strictEqual(boot(on).sameFileEdgesOnly, true);
    assert.ok(/ checked /.test(box(on)), 'toggle checked');
    const off = html(false);
    assert.strictEqual(boot(off).sameFileEdgesOnly, false);
    assert.ok(!/ checked /.test(box(off)), 'toggle unchecked');
    assert.ok(on.includes('Only calls within a file'));
  });

  test('wiring contract: lines marked, one root class, CSS hides cross-file lines but not hovered ones', () => {
    const rendering = read('src/webview/rendering.js');
    assert.ok(rendering.includes(".classed('xfile', d => !isSameFileLink(d, fileOf))"), 'renderLinks marks cross-file lines');
    assert.ok(/g\.classed\('same-file-only', !!settings\.sameFileEdgesOnly && state\.viewMode !== 'workflow'\)/.test(rendering),
      'one class on the zoom root; Workflow view exempt');
    assert.ok(/applySameFileEdges\(\);[\s\S]{0,160}updateWorkflowDivider\(\);/.test(rendering), 'applied after every render');
    // the simulation still gets every link: the layout is identical with the setting on or off
    assert.ok(rendering.includes('startSimulation(drawLinks);'));
    assert.ok(!/sameFileEdgesOnly/.test(rendering.slice(rendering.indexOf('function startSimulation'), rendering.indexOf('function startWorkflowSimulation'))));
    const css = read('src/webview/styles.css');
    assert.ok(/#graph g\.same-file-only line\.xfile:not\(\.cg-hl\),\s+#graph g\.same-file-only line\.cross-bundle \{\s+display: none;/.test(css));
  });
});
