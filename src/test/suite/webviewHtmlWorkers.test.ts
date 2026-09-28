import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWebviewHtml } from '../../webviewHtmlBuilder';

/* eslint-disable @typescript-eslint/no-explicit-any */

function fakeWebview(): vscode.Webview {
  return {
    cspSource: 'https://webview.test',
    asWebviewUri: (u: vscode.Uri) => vscode.Uri.parse(`https://webview.test${u.path}`),
  } as any;
}

function bootConfigOf(html: string): any {
  const m = html.match(/window\.COGRAPH_CONFIG = (\{[^<]*\});<\/script>/);
  assert.ok(m, 'boot config script present');
  return JSON.parse((m as RegExpMatchArray)[1]);
}

function cspOf(html: string): string {
  const m = html.match(/<meta http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
  assert.ok(m, 'CSP meta present');
  return (m as RegExpMatchArray)[1].replace(/\s+/g, ' ');
}

suite('webview HTML: workers, CSP, vendored d3', () => {
  let dir: string;
  setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-html-')); });
  teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('bundled build: local d3, worker URI, CSP allows blob workers + own-origin fetch, no CDN', () => {
    fs.mkdirSync(path.join(dir, 'dist', 'webview'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'webview', 'd3.min.js'), '');
    fs.writeFileSync(path.join(dir, 'dist', 'webview', 'simWorker.js'), '');
    const html = getWebviewHtml(fakeWebview(), vscode.Uri.file(dir));
    const csp = cspOf(html);
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes('worker-src blob:;'));
    assert.ok(csp.includes('connect-src https://webview.test;'));
    assert.ok(/script-src 'nonce-[0-9a-f]+';/.test(csp), 'script-src stays nonce-only');
    assert.ok(!html.includes('cdnjs.cloudflare.com'), 'no CDN host anywhere');
    assert.ok(/<script nonce="[0-9a-f]+" src="https:\/\/webview\.test\/.*\/dist\/webview\/d3\.min\.js"><\/script>/.test(html));
    const cfg = bootConfigOf(html);
    assert.strictEqual(cfg.workers, 'auto');
    assert.ok(/\/dist\/webview\/simWorker\.js$/.test(cfg.workerUri));
  });

  test('unbundled checkout: CDN d3 (dev fallback) and no worker URI → sync simulations', () => {
    const html = getWebviewHtml(fakeWebview(), vscode.Uri.file(dir));
    assert.ok(cspOf(html).includes("script-src 'nonce-"));
    assert.ok(cspOf(html).includes('https://cdnjs.cloudflare.com'));
    assert.ok(html.includes('cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js'));
    assert.strictEqual(bootConfigOf(html).workerUri, null);
  });

  test('worker transport scripts load after the scheduler and before frameRender', () => {
    const html = getWebviewHtml(fakeWebview(), vscode.Uri.file(dir));
    const order = ['localSim.js', 'frameScheduler.js', 'simPool.js', 'localSimWorker.js', 'simBackend.js', 'frameRender.js']
      .map(n => html.indexOf(`/${n}?v=`));
    assert.ok(order.every(i => i > 0), 'all script tags present');
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order);
    assert.ok(!html.includes('simWorkerCore.js?v='), 'worker-only module is not a page script');
  });
});
