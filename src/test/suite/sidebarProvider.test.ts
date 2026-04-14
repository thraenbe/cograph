import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SidebarProvider, GraphController, SavedGraphMeta } from '../../sidebarProvider';

// The `import * as fs` wrapper has non-configurable descriptors, so sinon
// cannot stub properties on it directly. Use the raw CJS module for stubbing;
// the wrapper's getters still delegate to the underlying module.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawFs = require('fs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeWebviewView {
  view: vscode.WebviewView;
  webview: {
    options: object;
    html: string;
    postMessage: sinon.SinonStub;
    onDidReceiveMessage: sinon.SinonStub;
  };
  received: Array<(msg: unknown) => void | Promise<void>>;
}

function makeFakeWebviewView(): FakeWebviewView {
  const received: Array<(msg: unknown) => void | Promise<void>> = [];
  const webview = {
    options: {} as object,
    html: '',
    postMessage: sinon.stub().resolves(true),
    onDidReceiveMessage: sinon.stub().callsFake((cb: (m: unknown) => void) => {
      received.push(cb);
      return { dispose: () => {} };
    }),
  };
  const view = { webview } as unknown as vscode.WebviewView;
  return { view, webview, received };
}

function makeFakeController(overrides: Partial<GraphController> = {}): GraphController & {
  _calls: string[];
  _openState: boolean;
} {
  const calls: string[] = [];
  const ctrl = {
    _calls: calls,
    _openState: false,
    show: sinon.stub().callsFake(() => { calls.push('show'); }),
    isOpen: sinon.stub().callsFake(function (this: { _openState: boolean }) { return this._openState; }),
    reloadLayout: sinon.stub().callsFake(() => { calls.push('reload'); }),
    loadGraph: sinon.stub().resolves(),
    ...overrides,
  };
  return ctrl as unknown as GraphController & { _calls: string[]; _openState: boolean };
}

function writeJsonFile(dir: string, filename: string, data: unknown): string {
  const p = path.join(dir, filename);
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('SidebarProvider', () => {
  let sandbox: sinon.SinonSandbox;
  let tmpDir: string;

  setup(() => {
    sandbox = sinon.createSandbox();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-sidebar-test-'));
  });

  teardown(() => {
    sandbox.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── resolveWebviewView() ─────────────────────────────────────────────────

  suite('resolveWebviewView()', () => {
    test('enables scripts and assigns non-empty HTML', () => {
      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      const { view, webview } = makeFakeWebviewView();

      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      assert.deepStrictEqual(webview.options, { enableScripts: true }, 'scripts must be enabled');
      assert.ok(webview.html.length > 0, 'html should be set');
      assert.ok(webview.html.includes('Saved Graphs'), 'html should include Saved Graphs section header');
      assert.ok(webview.html.includes('Chat'), 'html should include Chat section header');
      assert.ok(webview.html.includes('id="btn-new-graph"'), 'html should include new-graph button');
      assert.ok(webview.html.includes('id="search"'), 'html should include search input');
      assert.ok(webview.html.includes('id="graph-list"'), 'html should include graph-list container');
    });

    test('registers exactly one onDidReceiveMessage handler', () => {
      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      const { view, webview, received } = makeFakeWebviewView();

      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      assert.strictEqual(webview.onDidReceiveMessage.callCount, 1);
      assert.strictEqual(received.length, 1);
    });
  });

  // ── _listCographFiles() ──────────────────────────────────────────────────

  suite('_listCographFiles()', () => {
    test('no workspace folder → returns []', () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (provider as any)._listCographFiles() as SavedGraphMeta[];
      assert.deepStrictEqual(result, []);
    });

    test('workspace without .cograph directory → returns []', () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (provider as any)._listCographFiles() as SavedGraphMeta[];
      assert.deepStrictEqual(result, []);
    });

    test('reads valid JSON files, returns sorted entries', () => {
      const cographDir = path.join(tmpDir, '.cograph');
      fs.mkdirSync(cographDir);
      writeJsonFile(cographDir, 'beta.json', {
        name: 'Beta Layout', description: 'second', savedAt: '2026-04-10T00:00:00Z',
      });
      writeJsonFile(cographDir, 'alpha.json', {
        name: 'Alpha Layout', description: 'first', savedAt: '2026-04-09T00:00:00Z',
      });
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);

      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (provider as any)._listCographFiles() as SavedGraphMeta[];

      assert.strictEqual(result.length, 2);
      // Sorted by filename → alpha.json first, beta.json second
      assert.strictEqual(result[0].name, 'Alpha Layout');
      assert.strictEqual(result[0].description, 'first');
      assert.strictEqual(result[0].savedAt, '2026-04-09T00:00:00Z');
      assert.strictEqual(result[0].file, path.join(cographDir, 'alpha.json'));
      assert.strictEqual(result[1].name, 'Beta Layout');
    });

    test('ignores non-.json files', () => {
      const cographDir = path.join(tmpDir, '.cograph');
      fs.mkdirSync(cographDir);
      writeJsonFile(cographDir, 'real.json', { name: 'Real' });
      fs.writeFileSync(path.join(cographDir, 'README.md'), '# not a graph', 'utf8');
      fs.writeFileSync(path.join(cographDir, 'config.yaml'), 'foo: bar', 'utf8');
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);

      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (provider as any)._listCographFiles() as SavedGraphMeta[];

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'Real');
    });

    test('skips malformed JSON files but still returns valid ones', () => {
      const cographDir = path.join(tmpDir, '.cograph');
      fs.mkdirSync(cographDir);
      writeJsonFile(cographDir, 'good.json', { name: 'Good' });
      fs.writeFileSync(path.join(cographDir, 'broken.json'), '{not valid json', 'utf8');
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);

      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (provider as any)._listCographFiles() as SavedGraphMeta[];

      assert.strictEqual(result.length, 1, 'broken.json should be skipped');
      assert.strictEqual(result[0].name, 'Good');
    });

    test('missing data.name falls back to filename without .json', () => {
      const cographDir = path.join(tmpDir, '.cograph');
      fs.mkdirSync(cographDir);
      writeJsonFile(cographDir, 'nameless.json', { description: 'no name here' });
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);

      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (provider as any)._listCographFiles() as SavedGraphMeta[];

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].name, 'nameless', 'should fall back to basename minus .json');
      assert.strictEqual(result[0].description, 'no name here');
    });
  });

  // ── Message routing ──────────────────────────────────────────────────────

  suite('message routing', () => {
    test('ready → posts graph-list with current files', async () => {
      const cographDir = path.join(tmpDir, '.cograph');
      fs.mkdirSync(cographDir);
      writeJsonFile(cographDir, 'one.json', { name: 'One', description: 'd1', savedAt: 't1' });
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);

      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      const { view, webview, received } = makeFakeWebviewView();
      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      await received[0]({ type: 'ready' });

      assert.ok(webview.postMessage.calledOnce);
      const sent = webview.postMessage.firstCall.args[0];
      assert.strictEqual(sent.type, 'graph-list');
      assert.strictEqual(sent.files.length, 1);
      assert.strictEqual(sent.files[0].name, 'One');
    });

    test('open-graph with valid file → loads JSON and calls controller.loadGraph', async () => {
      const cographDir = path.join(tmpDir, '.cograph');
      fs.mkdirSync(cographDir);
      const filePath = writeJsonFile(cographDir, 'layout.json', {
        name: 'Layout', nodePositions: { 'a::1': { x: 10, y: 20 } },
      });
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);

      const controller = makeFakeController();
      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller);
      const { view, received } = makeFakeWebviewView();
      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      await received[0]({ type: 'open-graph', file: filePath });

      const loadGraph = controller.loadGraph as unknown as sinon.SinonStub;
      assert.ok(loadGraph.calledOnce, 'loadGraph should be called');
      assert.deepStrictEqual(loadGraph.firstCall.args[0], {
        name: 'Layout', nodePositions: { 'a::1': { x: 10, y: 20 } },
      });
      assert.strictEqual(loadGraph.firstCall.args[1], filePath, 'file path should be passed as 2nd arg');
    });

    test('open-graph with unreadable file → shows error, does not call loadGraph', async () => {
      const showErr = sandbox.stub(vscode.window, 'showErrorMessage');

      const controller = makeFakeController();
      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller);
      const { view, received } = makeFakeWebviewView();
      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      await received[0]({ type: 'open-graph', file: '/nonexistent/path.json' });

      const loadGraph = controller.loadGraph as unknown as sinon.SinonStub;
      assert.strictEqual(loadGraph.callCount, 0, 'loadGraph should NOT be called on error');
      assert.ok(showErr.calledOnce, 'error message should be shown');
      assert.ok(
        String(showErr.firstCall.args[0]).includes('Failed to load graph'),
        'error should mention "Failed to load graph"',
      );
    });

    test('new-graph when controller is open → reloadLayout()', async () => {
      const controller = makeFakeController();
      controller._openState = true;
      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller);
      const { view, received } = makeFakeWebviewView();
      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      await received[0]({ type: 'new-graph' });

      assert.ok((controller.reloadLayout as unknown as sinon.SinonStub).calledOnce);
      assert.strictEqual((controller.show as unknown as sinon.SinonStub).callCount, 0);
    });

    test('new-graph when controller is closed → show()', async () => {
      const controller = makeFakeController();
      controller._openState = false;
      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller);
      const { view, received } = makeFakeWebviewView();
      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      await received[0]({ type: 'new-graph' });

      assert.ok((controller.show as unknown as sinon.SinonStub).calledOnce);
      assert.strictEqual((controller.reloadLayout as unknown as sinon.SinonStub).callCount, 0);
    });

    test('delete-graph confirmed → unlinks file and refreshes list', async () => {
      const cographDir = path.join(tmpDir, '.cograph');
      fs.mkdirSync(cographDir);
      const filePath = writeJsonFile(cographDir, 'kill-me.json', { name: 'Kill me' });
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(vscode.window, 'showWarningMessage').resolves('Delete' as any);

      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      const { view, webview, received } = makeFakeWebviewView();
      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      await received[0]({ type: 'delete-graph', file: filePath, name: 'Kill me' });

      assert.strictEqual(fs.existsSync(filePath), false, 'file should be unlinked');
      // After delete, sidebar should post an updated (empty) graph-list
      assert.ok(webview.postMessage.called, 'graph-list should be posted after delete');
      const lastMsg = webview.postMessage.lastCall.args[0];
      assert.strictEqual(lastMsg.type, 'graph-list');
      assert.strictEqual(lastMsg.files.length, 0);
    });

    test('delete-graph dismissed → does NOT unlink', async () => {
      const cographDir = path.join(tmpDir, '.cograph');
      fs.mkdirSync(cographDir);
      const filePath = writeJsonFile(cographDir, 'keep-me.json', { name: 'Keep me' });
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(vscode.window, 'showWarningMessage').resolves(undefined as any);

      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      const { view, received } = makeFakeWebviewView();
      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      await received[0]({ type: 'delete-graph', file: filePath, name: 'Keep me' });

      assert.strictEqual(fs.existsSync(filePath), true, 'file should still exist');
    });

    test('delete-graph with unlink error → shows error message', async () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(vscode.window, 'showWarningMessage').resolves('Delete' as any);
      const showErr = sandbox.stub(vscode.window, 'showErrorMessage');
      sandbox.stub(rawFs, 'unlinkSync').throws(new Error('EACCES'));

      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      const { view, received } = makeFakeWebviewView();
      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      await received[0]({ type: 'delete-graph', file: '/some/file.json', name: 'X' });

      assert.ok(showErr.calledOnce);
      assert.ok(String(showErr.firstCall.args[0]).includes('Failed to delete'));
    });

    test('export-graph: user picks target → copies source file and shows info', async () => {
      const cographDir = path.join(tmpDir, '.cograph');
      fs.mkdirSync(cographDir);
      const srcPath = writeJsonFile(cographDir, 'exported.json', { name: 'Exported', v: 1 });
      const destPath = path.join(tmpDir, 'copy.json');

      sandbox.stub(vscode.window, 'showSaveDialog').resolves(vscode.Uri.file(destPath));
      const showInfo = sandbox.stub(vscode.window, 'showInformationMessage');

      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      const { view, received } = makeFakeWebviewView();
      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      await received[0]({ type: 'export-graph', file: srcPath, name: 'Exported' });

      assert.strictEqual(fs.existsSync(destPath), true, 'dest file should exist');
      assert.deepStrictEqual(
        JSON.parse(fs.readFileSync(destPath, 'utf8')),
        JSON.parse(fs.readFileSync(srcPath, 'utf8')),
        'dest content should equal source',
      );
      assert.ok(showInfo.calledOnce);
      assert.ok(String(showInfo.firstCall.args[0]).includes('Exported'));
    });

    test('export-graph: user cancels dialog → nothing written, no info toast', async () => {
      const cographDir = path.join(tmpDir, '.cograph');
      fs.mkdirSync(cographDir);
      const srcPath = writeJsonFile(cographDir, 'source.json', { name: 'S' });

      sandbox.stub(vscode.window, 'showSaveDialog').resolves(undefined);
      const showInfo = sandbox.stub(vscode.window, 'showInformationMessage');
      const copySync = sandbox.stub(rawFs, 'copyFileSync');

      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      const { view, received } = makeFakeWebviewView();
      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      await received[0]({ type: 'export-graph', file: srcPath, name: 'S' });

      assert.strictEqual(copySync.callCount, 0);
      assert.strictEqual(showInfo.callCount, 0);
    });

    test('export-graph: copy throws → shows error message', async () => {
      sandbox.stub(vscode.window, 'showSaveDialog').resolves(vscode.Uri.file('/nope/dest.json'));
      sandbox.stub(rawFs, 'copyFileSync').throws(new Error('EACCES'));
      const showErr = sandbox.stub(vscode.window, 'showErrorMessage');

      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      const { view, received } = makeFakeWebviewView();
      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      await received[0]({ type: 'export-graph', file: '/some/src.json', name: 'X' });

      assert.ok(showErr.calledOnce);
      assert.ok(String(showErr.firstCall.args[0]).includes('Failed to export'));
    });
  });

  // ── refresh() ────────────────────────────────────────────────────────────

  suite('refresh()', () => {
    test('before resolveWebviewView → does not throw, no postMessage', () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());

      assert.doesNotThrow(() => provider.refresh());
    });

    test('after resolveWebviewView → posts graph-list', () => {
      const cographDir = path.join(tmpDir, '.cograph');
      fs.mkdirSync(cographDir);
      writeJsonFile(cographDir, 'x.json', { name: 'X' });
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);

      const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), makeFakeController());
      const { view, webview } = makeFakeWebviewView();
      provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

      // Clear any initial postMessage calls (none expected since we didn't send 'ready')
      webview.postMessage.resetHistory();

      provider.refresh();

      assert.ok(webview.postMessage.calledOnce);
      const msg = webview.postMessage.firstCall.args[0];
      assert.strictEqual(msg.type, 'graph-list');
      assert.strictEqual(msg.files.length, 1);
      assert.strictEqual(msg.files[0].name, 'X');
    });
  });
});
