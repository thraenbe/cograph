import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { GraphProvider } from '../../graphProvider';

// Use require() so sinon can stub the underlying CJS module properties.
// (The `import * as cp` wrapper uses getter-only descriptors that sinon cannot replace.)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawCp = require('child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeContext(extensionPath = '/fake/ext'): vscode.ExtensionContext {
  // extensionUri is required by getWebviewHtml → vscode.Uri.joinPath
  return {
    extensionPath,
    extensionUri: vscode.Uri.file(extensionPath),
  } as unknown as vscode.ExtensionContext;
}

/** Build a fake ChildProcess with controllable stdout/stderr/events. */
function makeFakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = sinon.stub();
  proc.pid = 1234;
  return proc;
}

/** Build a fake webview panel. */
function makeFakePanel() {
  const webview = {
    html: '',
    cspSource: 'vscode-resource:',
    onDidReceiveMessage: sinon.stub().returns({ dispose: () => {} }),
    postMessage: sinon.stub().resolves(true),
    asWebviewUri: sinon.stub().callsFake((uri: vscode.Uri) => uri),
  };
  const panel = {
    webview,
    reveal: sinon.stub(),
    onDidDispose: sinon.stub().callsFake((cb: () => void) => {
      (panel as any)._disposeCallback = cb;
      return { dispose: () => {} };
    }),
    dispose: sinon.stub(),
  };
  return panel;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('GraphProvider', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  // ── show() ────────────────────────────────────────────────────────────────

  suite('show()', () => {
    test('no workspace folder → shows error, no panel created', () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
      const showErr = sandbox.stub(vscode.window, 'showErrorMessage');

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      assert.ok(showErr.calledOnce, 'showErrorMessage should be called');
      assert.ok(
        showErr.firstCall.args[0].includes('No workspace folder'),
        'message should mention workspace folder'
      );
    });

    test('panel already open → reveals existing panel', () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));
      const fakeProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').returns(fakeProc);

      const fakePanel = makeFakePanel();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);

      const provider = new GraphProvider(makeFakeContext());
      provider.show(); // creates panel
      provider.show(); // should reveal, not create again

      assert.ok((vscode.window.createWebviewPanel as sinon.SinonStub).calledOnce, 'panel created once');
      assert.ok(fakePanel.reveal.calledOnce, 'reveal called on second show()');
    });
  });

  // ── runAnalyzer() ─────────────────────────────────────────────────────────

  suite('runAnalyzer()', () => {
    test('python not found → showError with "Python not found"', () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      const fakePanel = makeFakePanel();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
      const showErr = sandbox.stub(vscode.window, 'showErrorMessage');
      sandbox.stub(rawCp, 'execFileSync').throws(new Error('not found'));

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      assert.ok(showErr.calledOnce, 'showErrorMessage called');
      assert.ok(
        showErr.firstCall.args[0].includes('Python not found'),
        'error should mention Python not found'
      );
    });

    test('process exits code 1 + stderr → showError with truncated stderr', () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      const fakePanel = makeFakePanel();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
      const showErr = sandbox.stub(vscode.window, 'showErrorMessage');
      sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

      const fakeProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').returns(fakeProc);

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      fakeProc.stderr.emit('data', Buffer.from('SyntaxError: invalid syntax'));
      fakeProc.emit('close', 1);

      assert.ok(showErr.calledOnce, 'showErrorMessage called');
      assert.ok(showErr.firstCall.args[0].includes('exit 1'), 'mentions exit code');
      assert.ok(showErr.firstCall.args[0].includes('SyntaxError'), 'includes stderr snippet');
    });

    test('stdout > MAX_OUTPUT_BYTES → kills proc, shows size error', () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      const fakePanel = makeFakePanel();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
      const showErr = sandbox.stub(vscode.window, 'showErrorMessage');
      sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

      const fakeProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').returns(fakeProc);

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      // Emit a chunk slightly over 100 MB
      const bigChunk = Buffer.alloc(101 * 1024 * 1024);
      fakeProc.stdout.emit('data', bigChunk);

      assert.ok(fakeProc.kill.calledOnce, 'process should be killed');
      assert.ok(showErr.calledOnce, 'showErrorMessage called');
      assert.ok(showErr.firstCall.args[0].includes('too large'), 'message mentions too large');
    });

    test('timeout exceeded → shows timeout error', function (done) {
      this.timeout(5000);
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      const fakePanel = makeFakePanel();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
      const showErr = sandbox.stub(vscode.window, 'showErrorMessage');
      sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

      const fakeProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').returns(fakeProc);

      // Capture the real setTimeout BEFORE stubbing so the stub and the
      // test's own timer can call it without infinite recursion.
      const TIMEOUT_MS = 100;
      const realSetTimeout = setTimeout;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(global, 'setTimeout').callsFake((fn: any, ms?: number) => {
        // Replace only the 60 s analysis timeout; pass everything else through.
        return realSetTimeout(fn, ms === 60_000 ? TIMEOUT_MS : (ms as number));
      });

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      realSetTimeout(() => {
        assert.ok(fakeProc.kill.calledOnce, 'process killed on timeout');
        assert.ok(showErr.calledOnce, 'showErrorMessage called');
        assert.ok(showErr.firstCall.args[0].toLowerCase().includes('timed out'), 'message mentions timeout');
        done();
      }, TIMEOUT_MS + 200);
    });

    test('process error event → showError with start failure message', () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      const fakePanel = makeFakePanel();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
      const showErr = sandbox.stub(vscode.window, 'showErrorMessage');
      sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

      const fakeProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').returns(fakeProc);

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      fakeProc.emit('error', new Error('ENOENT'));

      assert.ok(showErr.calledOnce, 'showErrorMessage called');
      assert.ok(
        showErr.firstCall.args[0].includes('Failed to start Python'),
        'error should mention failed to start Python'
      );
    });

    test('stdout chunks are concatenated before parsing', function (done) {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      const fakePanel = makeFakePanel();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
      sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

      const fakeProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').returns(fakeProc);

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      const graph = {
        nodes: [{ id: 'a::b::1', name: 'b', file: 'a.py', line: 1 }],
        edges: [],
      };
      const jsonStr = JSON.stringify(graph);
      const mid = Math.floor(jsonStr.length / 2);

      fakeProc.stdout.emit('data', Buffer.from(jsonStr.slice(0, mid)));
      fakeProc.stdout.emit('data', Buffer.from(jsonStr.slice(mid)));
      fakeProc.emit('close', 0);

      // postMessage is delayed by 150 ms
      setTimeout(() => {
        assert.ok(fakePanel.webview.postMessage.calledOnce, 'postMessage called');
        const msg = fakePanel.webview.postMessage.firstCall.args[0];
        assert.strictEqual(msg.type, 'graph');
        assert.deepStrictEqual(msg.data, graph);
        done();
      }, 300);
    });
  });

  // ── handleAnalysisResult() ────────────────────────────────────────────────

  suite('handleAnalysisResult()', () => {
    test('valid graph → posts graph message to webview', function (done) {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      const fakePanel = makeFakePanel();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
      sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

      const fakeProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').returns(fakeProc);

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      const graph = {
        nodes: [{ id: 'a::b::1', name: 'b', file: 'a.py', line: 1 }],
        edges: [],
      };

      fakeProc.stdout.emit('data', Buffer.from(JSON.stringify(graph)));
      fakeProc.emit('close', 0);

      // postMessage is delayed by 150 ms
      setTimeout(() => {
        assert.ok(fakePanel.webview.postMessage.calledOnce, 'postMessage called');
        const msg = fakePanel.webview.postMessage.firstCall.args[0];
        assert.strictEqual(msg.type, 'graph');
        assert.deepStrictEqual(msg.data, graph);
        done();
      }, 300);
    });

    test('zero nodes → sets empty state HTML', () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      const fakePanel = makeFakePanel();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
      sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

      const fakeProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').returns(fakeProc);

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      fakeProc.stdout.emit('data', Buffer.from(JSON.stringify({ nodes: [], edges: [] })));
      fakeProc.emit('close', 0);

      assert.ok(fakePanel.webview.html.includes('No Python functions'), 'empty state HTML set');
    });

    test('invalid JSON → shows parse error', () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      const fakePanel = makeFakePanel();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
      const showErr = sandbox.stub(vscode.window, 'showErrorMessage');
      sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

      const fakeProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').returns(fakeProc);

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      fakeProc.stdout.emit('data', Buffer.from('not json {{{'));
      fakeProc.emit('close', 0);

      assert.ok(showErr.calledOnce, 'showErrorMessage called');
      assert.ok(showErr.firstCall.args[0].includes('Failed to parse'), 'parse error message');
    });
  });

  // ── navigateTo() ──────────────────────────────────────────────────────────

  suite('navigateTo()', () => {
    test('opens doc and reveals range', async () => {
      const fakeDoc = {};
      const fakeEditor = {
        selection: undefined as unknown,
        revealRange: sinon.stub(),
      };
      const openDoc = sandbox.stub(vscode.workspace, 'openTextDocument').resolves(fakeDoc as any);
      const showDoc = sandbox.stub(vscode.window, 'showTextDocument').resolves(fakeEditor as any);

      const provider = new GraphProvider(makeFakeContext());
      await (provider as any).navigateTo('/some/file.py', 42);

      assert.ok(openDoc.calledOnce, 'openTextDocument called once');
      assert.strictEqual(openDoc.firstCall.args[0] as unknown as string, '/some/file.py');
      assert.ok(showDoc.calledOnce, 'showTextDocument called');
      assert.ok(fakeEditor.revealRange.calledOnce, 'revealRange called');
    });
  });

  // ── panel lifecycle ───────────────────────────────────────────────────────

  suite('panel lifecycle', () => {
    test('panel dispose callback clears internal panel reference', () => {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

      const fakeProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').returns(fakeProc);

      const fakePanel = makeFakePanel();
      const createPanel = sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);

      const provider = new GraphProvider(makeFakeContext());
      provider.show(); // creates panel #1

      // Fire the dispose callback — clears provider's internal reference
      (fakePanel as any)._disposeCallback();

      // show() should now create a brand-new panel instead of revealing
      provider.show();
      assert.ok(createPanel.calledTwice, 'createWebviewPanel should be called twice');
    });

    test('getErrorHtml escapes HTML special characters', () => {
      const provider = new GraphProvider(makeFakeContext());
      const html = (provider as any).getErrorHtml('<script>&</script>');
      assert.ok(html.includes('&lt;script&gt;&amp;'), 'HTML entities should be escaped');
    });
  });
});
