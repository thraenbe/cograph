import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getWebviewHtml } from '../../webviewHtmlBuilder';
import { renderBrowserPage, themeStyle, inlineJson, activeThemeKind } from '../../browserView/browserHtml';
import type { MirroredView, PageRequest } from '../../browserView/browserServer';

const TOKEN = 'f'.repeat(64);

function fakeView(root = '/repo/head'): MirroredView {
  return { attachView: () => () => undefined, receiveFromView: () => undefined, replayMessages: () => [], viewRoot: () => root };
}

function panelWebview(): vscode.Webview {
  return { asWebviewUri: (u: vscode.Uri) => u, cspSource: 'vscode-resource:' } as unknown as vscode.Webview;
}

/** src attributes of <script> tags in order, query stripped, relative to /ext/. */
function scripts(html: string): string[] {
  return [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1].replace(/\?.*$/, '').replace(/^.*\/ext\//, '').replace(/^.*\/src\/webview\//, 'src/webview/'));
}

function cspOf(html: string): string {
  return (/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? '').replace(/\s+/g, ' ');
}

suite('browserView: browser HTML', () => {
  let extRoot: string;

  setup(() => {
    extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-html-'));
  });

  teardown(() => fs.rmSync(extRoot, { recursive: true, force: true }));

  const page = (extra: Partial<PageRequest> = {}): PageRequest => ({ viewId: 'main', view: fakeView(), token: TOKEN, ...extra });

  test('the panel page is unchanged in kind: no bridge, the Open in browser button, the pill markup, no self in script-src', () => {
    const html = getWebviewHtml(panelWebview(), vscode.Uri.file(extRoot));
    assert.ok(!html.includes('browserBridge.js'));
    assert.ok(html.includes('id="btn-open-browser"'));
    assert.ok(html.includes('title="Open this graph in your browser"'));
    assert.ok(html.includes('id="browser-status"'));
    assert.ok(html.includes('id="tour-pill"'));
    assert.ok(!/script-src[^;]*'self'/.test(cspOf(html)));
    assert.ok(!html.includes('cg-browser'));
    assert.ok(/<body>/.test(html));
  });

  test('every cache-bust suffix stays a query of its own on panel URIs', () => {
    const html = getWebviewHtml(panelWebview(), vscode.Uri.file(extRoot));
    for (const m of html.matchAll(/src="([^"]+\.js[^"]*)"/g)) {
      if (m[1].startsWith('https://')) { continue; }
      assert.match(m[1], /\.js\?v=[0-9a-f]{32}$/, m[1]);
    }
  });

  test('browser page: bridge first, after the page config, before state.js; button hidden; body themed', () => {
    const html = renderBrowserPage(page(), extRoot, 'dark');
    const list = scripts(html);
    assert.strictEqual(list[1], 'src/webview/browserBridge.js', list.join(','));
    assert.ok(list.indexOf('src/webview/browserBridge.js') < list.indexOf('src/webview/state.js'));
    assert.ok(html.indexOf('window.COGRAPH_BROWSER') < html.indexOf('browserBridge.js'));
    assert.ok(!html.includes('id="btn-open-browser"'));
    assert.ok(html.includes('<body class="vscode-dark cg-browser">'));
  });

  test('browser page: every resource is /ext/<path>?token=…&v=…', () => {
    const html = renderBrowserPage(page(), extRoot, 'dark');
    const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(u => !u.startsWith('https://'));
    assert.ok(srcs.length > 40);
    for (const u of srcs) { assert.match(u, new RegExp(`^/ext/(src|dist)/webview/[^?]+\\?token=${TOKEN}&v=[0-9a-f]{32}$`), u); }
  });

  test('browser CSP: own origin only, no vscode-webview, nonce scripts plus self', () => {
    const csp = cspOf(renderBrowserPage(page(), extRoot, 'dark'));
    assert.match(csp, /default-src 'none';/);
    assert.match(csp, /script-src 'nonce-[0-9a-f]{32}' 'self'/);
    assert.match(csp, /style-src 'unsafe-inline' 'self';/);
    assert.match(csp, /img-src 'self' data:;/);
    assert.match(csp, /worker-src blob:;/);
    assert.match(csp, /connect-src 'self';/);
    assert.ok(!csp.includes('vscode-webview'));
  });

  test('cdnjs is allowed only while d3 is not vendored, as in the panel', () => {
    assert.ok(cspOf(renderBrowserPage(page(), extRoot, 'dark')).includes('https://cdnjs.cloudflare.com'));
    fs.mkdirSync(path.join(extRoot, 'dist', 'webview'), { recursive: true });
    fs.writeFileSync(path.join(extRoot, 'dist', 'webview', 'd3.min.js'), '');
    const html = renderBrowserPage(page(), extRoot, 'dark');
    assert.ok(!cspOf(html).includes('cdnjs'));
    assert.ok(scripts(html).includes('dist/webview/d3.min.js'));
  });

  test('the page config names the view and its token URLs; no tour config in mirror mode', () => {
    const html = renderBrowserPage(page({ viewId: 'pr-7' }), extRoot, 'light');
    const cfg = JSON.parse(/window\.COGRAPH_BROWSER = (\{.*?\});/.exec(html)?.[1] ?? 'null');
    assert.deepStrictEqual(cfg, { view: 'pr-7', eventsUrl: `/events?token=${TOKEN}&view=pr-7`, msgUrl: `/msg?token=${TOKEN}&view=pr-7` });
    assert.ok(!html.includes('COGRAPH_TOUR'));
    assert.ok(!html.includes('/tour-assets/'));
    assert.ok(html.includes('<body class="vscode-light cg-browser">'));
  });

  test('tour mode: COGRAPH_TOUR before the stage with every URL tokened and stageRoot; assets after every stage script', () => {
    const html = renderBrowserPage(page({ viewId: 'pr-104', view: fakeView('/g/pr-trees/r/3f1c'), tour: { tourId: 'pr-104-3f1c', assets: true } }), extRoot, 'dark');
    const cfg = JSON.parse(/window\.COGRAPH_TOUR = (\{.*?\});<\/script>/.exec(html)?.[1] ?? 'null');
    assert.deepStrictEqual(cfg, {
      tourId: 'pr-104-3f1c',
      scriptUrl: `/tour/pr-104-3f1c/script?token=${TOKEN}`,
      graphUrl: `/tour/pr-104-3f1c/graph?token=${TOKEN}`,
      actionUrl: `/tour/pr-104-3f1c/action?token=${TOKEN}`,
      eventsUrl: `/events?token=${TOKEN}&view=pr-104`,
      msgUrl: `/msg?token=${TOKEN}&view=pr-104`,
      theme: 'dark', stageRoot: '/g/pr-trees/r/3f1c', version: 1,
    });
    assert.ok(html.indexOf('window.COGRAPH_TOUR') < html.indexOf('state.js'));
    const list = scripts(html);
    assert.strictEqual(list[list.length - 1], `/tour-assets/tour.js`);
    assert.ok(html.includes(`<link rel="stylesheet" href="/tour-assets/tour.css?token=${TOKEN}" />`));
    assert.ok(html.indexOf('/tour-assets/tour.css') > html.lastIndexOf('src/webview/'));
  });

  test('tour mode without assets: the config, no tour tags (the stub build)', () => {
    const html = renderBrowserPage(page({ tour: { tourId: 't', assets: false } }), extRoot, 'dark');
    assert.ok(html.includes('window.COGRAPH_TOUR'));
    assert.ok(!html.includes('/tour-assets/'));
  });

  test('inline JSON cannot close its script tag', () => {
    const html = renderBrowserPage(page({ view: fakeView('/x/</script><script>alert(1)</script>'), tour: { tourId: 't', assets: false } }), extRoot, 'dark');
    assert.ok(!html.includes('</script><script>alert(1)'));
    assert.strictEqual(inlineJson('a</b\u2028'), '"a\\u003c/b\\u2028"');
  });

  test('theme style: Dark+ and Light+ values as --vscode-* on :root', () => {
    assert.ok(themeStyle('dark').includes('--vscode-editor-background: #1f1f1f;'));
    assert.ok(themeStyle('light').includes('--vscode-editor-background: #ffffff;'));
    assert.ok(themeStyle('light').includes('--vscode-font-family:'), 'light inherits the font from dark');
    assert.ok(renderBrowserPage(page(), extRoot, 'light').includes('--vscode-button-background: #005fb8;'));
    assert.ok(['dark', 'light'].includes(activeThemeKind()));
  });
});
