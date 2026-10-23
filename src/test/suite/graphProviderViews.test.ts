import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphProvider } from '../../graphProvider';
import { scanStructure } from '../../structureScanner';
import { writeCache } from '../../cacheStore';
import { specForFolder } from '../../subgraphScope';
import type { ClientSink, ClientControl } from '../../browserView/viewHub';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawCp = require('child_process');

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeFakePanel() {
  const webview = {
    html: '', cspSource: 'vscode-resource:',
    onDidReceiveMessage: sinon.stub().returns({ dispose: () => undefined }),
    postMessage: sinon.stub().resolves(true),
    asWebviewUri: sinon.stub().callsFake((uri: vscode.Uri) => uri),
  };
  const panel: any = {
    title: 'CoGraph', webview, reveal: sinon.stub(), dispose: sinon.stub(),
    onDidDispose: sinon.stub().callsFake((cb: () => void) => { panel._disposeCallback = cb; return { dispose: () => undefined }; }),
  };
  return panel;
}

interface Tab extends ClientSink { got: any[]; controls: ClientControl[] }
function tab(): Tab {
  const t: Tab = { got: [], controls: [], write: (json) => { t.got.push(JSON.parse(json)); }, control: (k) => { t.controls.push(k); } };
  return t;
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) { throw new Error('waitFor timed out'); }
    await new Promise(r => setTimeout(r, 20));
  }
}

const FILES = ['src/main.ts', 'src/server/api.ts', 'tools/gen.ts'];

suite('GraphProvider — browser views', () => {
  let sandbox: sinon.SinonSandbox;
  let root: string;
  let panel: ReturnType<typeof makeFakePanel>;
  let provider: GraphProvider;
  const logged: string[] = [];

  const abs = (rel: string) => path.join(root, ...rel.split('/'));
  const posted = (type?: string) => panel.webview.postMessage.getCalls().map((c: any) => c.args[0]).filter((m: any) => !type || m.type === type);
  const onMessage = () => panel.webview.onDidReceiveMessage.firstCall.args[0];
  const types = (msgs: any[]) => msgs.map(m => m.type);

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-views-'));
    for (const rel of FILES) {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), `export function f_${rel.replace(/\W/g, '_')}() {}\n`);
    }
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: root } }]);
    sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));
    sandbox.stub(rawCp, 'spawn');
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((() => ({
      get: (_k: string, d?: unknown) => d, has: () => false, inspect: () => undefined, update: async () => undefined,
    })) as unknown as typeof vscode.workspace.getConfiguration);
    panel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
    logged.length = 0;
    const channel = { appendLine: (l: string) => logged.push(l) } as unknown as vscode.OutputChannel;
    provider = new GraphProvider({ extensionPath: '/fake/ext', extensionUri: vscode.Uri.file('/fake/ext') } as any, { outputChannel: channel });
  });

  teardown(() => {
    panel._disposeCallback?.();
    sandbox.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A valid cache so show() paints without spawning an analyzer. */
  function writeFullCache() {
    const nodes = FILES.map(rel => ({ id: `n:${rel}`, name: 'f', file: abs(rel), line: 1 }));
    const edges = [{ source: 'n:src/main.ts', target: 'n:src/server/api.ts' }, { source: 'n:tools/gen.ts', target: 'n:src/main.ts' }];
    writeCache(root, { nodes, edges, files: nodes.map(n => n.file) } as any, scanStructure(root));
  }

  async function open(how: () => void = () => provider.show()) {
    writeFullCache();
    how();
    onMessage()({ type: 'ready' });
    await waitFor(() => posted('graph').length > 0);
  }

  function joinTab(id = 't1'): Tab {
    const t = tab();
    provider.attachView(id, t);
    provider.receiveFromView(id, { type: 'ready' });
    return t;
  }

  test('a tab joining an open panel gets subgraph, structure, graph, git-update in that order, no config', async () => {
    await open();
    const t = joinTab();
    assert.deepStrictEqual(types(t.got), ['subgraph', 'structure', 'graph', 'git-update']);
    assert.strictEqual(t.got[2].isReanalysis, false);
    assert.strictEqual(t.got[2].data.nodes.length, 3);
    assert.deepStrictEqual(t.got.map(m => m.__seq), [1, 2, 3, 4], 'its own sequence space');
  });

  test('a tab joining while a scope is active never receives an unscoped graph', async () => {
    await open(() => provider.showScoped(specForFolder('src/server')));
    const t = joinTab();
    assert.deepStrictEqual(t.got[0].include, ['src/server'], 'scope first');
    const graphs = t.got.filter(m => m.type === 'graph');
    assert.strictEqual(graphs.length, 1);
    assert.deepStrictEqual(graphs[0].data.nodes.map((n: any) => n.id), ['n:src/server/api.ts']);
    assert.strictEqual(graphs[0].data.edges.length, 0, 'edges to out-of-scope files are cut too');
    const git = t.got.find(m => m.type === 'git-update');
    assert.ok(git.nodes.every((n: any) => n.id === 'n:src/server/api.ts'), 'git statuses scoped as well');
  });

  test('a scope change in the panel reaches the tab as the same subgraph + graph-patch the panel gets', async () => {
    await open(() => provider.showScoped({ include: ['src'], exclude: [] }));
    const t = joinTab();
    const n0 = t.got.length;
    const p0 = posted().length;
    await onMessage()({ type: 'subgraph-exclude', path: 'src/server' });
    const strip = (m: any) => { const { __seq, ...rest } = m; void __seq; return rest; };
    assert.deepStrictEqual(t.got.slice(n0).map(strip), posted().slice(p0).map(strip));
    assert.deepStrictEqual(types(t.got.slice(n0)), ['subgraph', 'graph-patch']);
  });

  test("a tab's message reaches the provider's handler: its scope edit re-scopes the panel too", async () => {
    await open(() => provider.showScoped({ include: ['src'], exclude: [] }));
    joinTab();
    const p0 = posted().length;
    provider.receiveFromView('t1', { type: 'subgraph-exclude', path: 'src/server' });
    await waitFor(() => posted().length > p0);
    assert.deepStrictEqual(posted().slice(p0)[0].exclude, ['src/server']);
    assert.ok(panel.title.startsWith('● '), 'dirty, as when the panel did it');
  });

  test('save-request goes to the view that spoke last: the tab, then the panel again', async () => {
    await open();
    const t = joinTab();
    provider.receiveFromView('t1', { type: 'dirty-state', dirty: true });
    const p0 = posted('save-request').length;
    provider.requestSave('save');
    assert.deepStrictEqual(types(t.got).filter(x => x === 'save-request'), ['save-request']);
    assert.strictEqual(posted('save-request').length, p0, 'the panel is not asked while the tab is active');
    await onMessage()({ type: 'dirty-state', dirty: false });
    provider.requestSave('save');
    assert.strictEqual(posted('save-request').length, p0 + 1);
    assert.strictEqual(types(t.got).filter(x => x === 'save-request').length, 1);
  });

  test('a new panel document reloads open tabs; closing the panel closes them', async () => {
    await open();
    const t = joinTab();
    (provider as any).loadGraphHtml([]);
    assert.deepStrictEqual(t.controls, ['reload']);
    panel._disposeCallback();
    panel._disposeCallback = undefined;
    assert.deepStrictEqual(t.controls, ['reload', 'closed']);
    assert.strictEqual(provider.browserTabs(), 0);
  });

  test('the panel hears how many tabs are connected', async () => {
    await open();
    const t = tab();
    const detach = provider.attachView('t1', t);
    assert.deepStrictEqual(posted('browser-status').at(-1), { type: 'browser-status', tabs: 1 });
    detach();
    assert.deepStrictEqual(posted('browser-status').at(-1), { type: 'browser-status', tabs: 0 });
    provider.postBrowserNote('Switched off.');
    assert.deepStrictEqual(posted('browser-status').at(-1), { type: 'browser-status', tabs: 0, note: 'Switched off.' });
  });

  test('replayMessages puts pr-view after subgraph and before structure', async () => {
    await open();
    (provider as any).prView = { view: { message: { type: 'pr-view', active: true, number: 7 } }, back: {} };
    assert.deepStrictEqual(types(provider.replayMessages()), ['subgraph', 'pr-view', 'structure', 'graph', 'git-update']);
    (provider as any).prView = undefined;
  });

  test('replay before any graph: subgraph only (the tab fills in when the panel does)', () => {
    assert.deepStrictEqual(types(provider.replayMessages()), ['subgraph']);
    assert.strictEqual(provider.viewRoot(), root);
  });

  test('open-browser runs the opener with this provider; without one the panel says so', async () => {
    await open();
    await onMessage()({ type: 'open-browser' });
    assert.ok(String(posted('browser-status').at(-1)?.note).includes('not available'));
    const opened: GraphProvider[] = [];
    provider.setBrowserOpener(async (p) => { opened.push(p); });
    await onMessage()({ type: 'open-browser' });
    assert.deepStrictEqual(opened, [provider]);
    provider.setBrowserOpener(async () => { throw new Error('no browser'); });
    await onMessage()({ type: 'open-browser' });
    await waitFor(() => logged.some(l => l.includes('[browser] open from panel failed: no browser')));
  });

  test('tour-start runs every listener until disposed; a throwing listener is logged', async () => {
    await open();
    let n = 0;
    const sub = provider.onTourStart(() => { n += 1; });
    provider.onTourStart(() => { throw new Error('boom'); });
    await onMessage()({ type: 'tour-start' });
    sub.dispose();
    await onMessage()({ type: 'tour-start' });
    assert.strictEqual(n, 1);
    assert.ok(logged.some(l => l.includes('[tour] start failed: boom')));
  });

  test('tour-availability is kept and re-sent after a panel ready; after tour-dismiss it is dropped', async () => {
    await open();
    const avail = { type: 'tour-availability', state: 'branch', label: 'feat/x vs main · 3 commits · 7 files' };
    provider.postToViews(avail);
    const n0 = posted('tour-availability').length;
    await onMessage()({ type: 'ready' });
    assert.strictEqual(posted('tour-availability').length, n0 + 1, 're-sent after ready');
    await onMessage()({ type: 'tour-dismiss' });
    provider.postToViews({ ...avail, label: 'later' });
    await onMessage()({ type: 'ready' });
    assert.strictEqual(posted('tour-availability').length, n0 + 1, 'nothing after the ×');
  });

  test('a read-only (pull-request) provider never posts tour-availability', () => {
    const pr = new GraphProvider({ extensionPath: '/fake/ext', extensionUri: vscode.Uri.file('/fake/ext') } as any, { root, readOnly: true });
    const p = makeFakePanel();
    (pr as any).panel = p;
    pr.postToViews({ type: 'tour-availability', state: 'pr', number: 4 });
    pr.postToViews({ type: 'git-update', nodes: [] });
    assert.deepStrictEqual(p.webview.postMessage.getCalls().map((c: any) => c.args[0].type), ['git-update']);
  });

  test("a tab's file-carrying message outside the view's root is refused and logged; inside, it goes through", async () => {
    await open();
    joinTab();
    const handler = sandbox.spy(provider, 'onViewMessage');
    provider.receiveFromView('t1', { type: 'get-func-source', file: path.join(os.tmpdir(), 'elsewhere.ts'), line: 1, reqId: 1 });
    provider.receiveFromView('t1', { type: 'save-func-source', file: path.join(root, '..', 'x.ts'), line: 1, newSource: 'x', reqId: 2 });
    assert.strictEqual(handler.callCount, 0);
    assert.strictEqual(logged.filter(l => l.startsWith('[browser] refused')).length, 2);
    provider.receiveFromView('t1', { type: 'get-func-source', file: abs('src/main.ts'), line: 1, reqId: 3, maxLines: 5 });
    assert.strictEqual(handler.callCount, 1);
  });

  test('the panel is not confined: the guard is for tabs only', async () => {
    await open();
    const p0 = posted('func-source').length;
    // The panel's webview runs in VS Code's own isolation; its messages take the path they always did.
    await onMessage()({ type: 'get-func-source', file: path.join(os.tmpdir(), 'not-in-root.ts'), line: 1, reqId: 9, maxLines: 5 });
    assert.strictEqual(posted('func-source').length, p0 + 1, 'answered (with the read error), not refused');
    assert.ok(!logged.some(l => l.startsWith('[browser] refused')));
  });

  test('browserViewId: main for the workspace graph, a fresh id for every provider with its own root', () => {
    const a = new GraphProvider({ extensionPath: '/x', extensionUri: vscode.Uri.file('/x') } as any, { root });
    const b = new GraphProvider({ extensionPath: '/x', extensionUri: vscode.Uri.file('/x') } as any, { root });
    assert.strictEqual(provider.browserViewId, 'main');
    assert.match(a.browserViewId, /^view-\d+$/);
    assert.notStrictEqual(a.browserViewId, b.browserViewId);
  });

  test("a failing handler for a tab's message is logged, not thrown into the server", async () => {
    await open();
    joinTab();
    sandbox.stub(provider, 'onViewMessage').rejects(new Error('kaput'));
    assert.doesNotThrow(() => provider.receiveFromView('t1', { type: 'navigate', file: abs('src/main.ts'), line: 1 }));
    await waitFor(() => logged.some(l => l.includes('[browser] navigate from t1 failed: kaput')));
  });
});
