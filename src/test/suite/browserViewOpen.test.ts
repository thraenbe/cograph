import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { configureBrowserServer, getBrowserServer, stopBrowserServer, browserServerStarted, browserViewEnabled } from '../../browserView/browserLifetime';
import { openInBrowser, BROWSER_DISABLED_NOTE } from '../../browserView/openInBrowser';
import { MAIN_VIEW } from '../../browserView/browserServer';
import type { GraphProvider } from '../../graphProvider';

/* eslint-disable @typescript-eslint/no-explicit-any */

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

function fakeProvider(open = true) {
  const p: any = {
    open,
    notes: [] as string[],
    isOpen: () => p.open,
    show: sinon.spy(() => { p.open = true; }),
    postBrowserNote: (n: string) => { p.notes.push(n); },
    attachView: () => () => undefined,
    receiveFromView: () => undefined,
    replayMessages: () => [{ type: 'subgraph' }],
    viewRoot: () => '/repo',
  };
  return p;
}

suite('browserView: lifetime and Open in browser', () => {
  let sandbox: sinon.SinonSandbox;
  let extRoot: string;
  let enabled: boolean;
  const logs: string[] = [];

  setup(() => {
    sandbox = sinon.createSandbox();
    enabled = true;
    logs.length = 0;
    extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-open-'));
    fs.mkdirSync(path.join(extRoot, 'src', 'webview'), { recursive: true });
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((() => ({
      get: (k: string, d?: unknown) => (k === 'browserView.enabled' ? enabled : d),
      has: () => false, inspect: () => undefined, update: async () => undefined,
    })) as unknown as typeof vscode.workspace.getConfiguration);
    configureBrowserServer({ extensionRoot: extRoot, log: (l) => logs.push(l) });
  });

  teardown(async () => {
    await stopBrowserServer();
    sandbox.restore();
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  test('switched off: no server, nothing started', async () => {
    enabled = false;
    assert.strictEqual(browserViewEnabled(), false);
    assert.strictEqual(await getBrowserServer(), null);
    assert.strictEqual(browserServerStarted(), false);
  });

  test('started lazily, once per extension host; stopped, the next use gets a new one', async () => {
    assert.strictEqual(browserServerStarted(), false);
    const [a, b] = await Promise.all([getBrowserServer(), getBrowserServer()]);
    assert.ok(a);
    assert.strictEqual(a, b, 'concurrent callers share one start');
    await stopBrowserServer();
    assert.strictEqual(browserServerStarted(), false);
    await assert.rejects(get(a.url('/')), 'the old port is closed');
    const c = await getBrowserServer();
    assert.ok(c && c !== a);
    assert.notStrictEqual(new URL(c.url('/')).searchParams.get('token'), new URL(a.url('/')).searchParams.get('token'));
  });

  test('the server renders real stage pages through browserHtml', async () => {
    const server = await getBrowserServer();
    assert.ok(server);
    server.registerView(MAIN_VIEW, fakeProvider() as any);
    const r = await get(server.url('/'));
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('browserBridge.js'));
    assert.ok(r.body.includes('window.COGRAPH_BROWSER'));
  });

  test('Open in browser: registers the main view, opens the tokened URL through asExternalUri, toast without the URL', async () => {
    const ext = sandbox.stub(vscode.env, 'asExternalUri').callsFake(async (u: vscode.Uri) => u);
    const openExt = sandbox.stub(vscode.env, 'openExternal').resolves(true);
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves('Copy URL' as any);
    const clip = sandbox.stub(vscode.env, 'clipboard').value({ writeText: sinon.stub().resolves(), readText: async () => '' });
    void clip;
    const provider = fakeProvider(false);
    await openInBrowser(provider as unknown as GraphProvider);
    assert.ok(provider.show.calledOnce, 'a closed panel is opened first: it owns the analysis');
    const server = await getBrowserServer();
    assert.ok(server?.hasView(MAIN_VIEW));
    const opened = openExt.firstCall.args[0].toString(true);
    assert.match(opened, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
    assert.strictEqual(ext.callCount, 1);
    assert.strictEqual(info.firstCall.args[0], 'CoGraph: Graph opened in your browser.');
    assert.ok(!String(info.firstCall.args[0]).includes('token'));
    assert.strictEqual((vscode.env.clipboard.writeText as sinon.SinonStub).firstCall.args[0], opened, 'Copy URL copies the tokened URL');
    for (const l of logs) { assert.ok(!/[0-9a-f]{64}/.test(l), l); }
  });

  test('Open in browser when the browser refuses: the toast says so and still offers Copy URL', async () => {
    sandbox.stub(vscode.env, 'asExternalUri').callsFake(async (u: vscode.Uri) => u);
    sandbox.stub(vscode.env, 'openExternal').resolves(false);
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    await openInBrowser(fakeProvider() as unknown as GraphProvider);
    assert.match(String(info.firstCall.args[0]), /did not open/);
    assert.strictEqual(info.firstCall.args[1], 'Copy URL');
  });

  test('Open in browser when switched off: one sentence in the panel and a toast, no server', async () => {
    enabled = false;
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    const provider = fakeProvider();
    await openInBrowser(provider as unknown as GraphProvider);
    assert.deepStrictEqual(provider.notes, [BROWSER_DISABLED_NOTE]);
    assert.strictEqual(info.firstCall.args[0], `CoGraph: ${BROWSER_DISABLED_NOTE}`);
    assert.strictEqual(browserServerStarted(), false);
  });

  test('Open in browser with no workspace: show() said so, nothing is opened', async () => {
    const openExt = sandbox.stub(vscode.env, 'openExternal').resolves(true);
    const provider = fakeProvider(false);
    provider.show = sinon.spy(() => undefined); // stays closed
    await openInBrowser(provider as unknown as GraphProvider);
    assert.strictEqual(openExt.callCount, 0);
  });

  test('a failure to open is an error message, not a throw', async () => {
    sandbox.stub(vscode.env, 'asExternalUri').rejects(new Error('no forwarding'));
    const err = sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    await openInBrowser(fakeProvider() as unknown as GraphProvider);
    assert.match(String(err.firstCall.args[0]), /Could not open the browser — no forwarding/);
  });
});
