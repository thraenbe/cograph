import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import { GraphProvider } from '../../graphProvider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeContext(extensionPath = '/fake/ext'): vscode.ExtensionContext {
  return { extensionPath } as unknown as vscode.ExtensionContext;
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
    onDidReceiveMessage: sinon.stub().returns({ dispose: () => {} }),
    postMessage: sinon.stub().resolves(true),
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

  // ── Test 1 ────────────────────────────────────────────────────────────────
  test('1. No workspace folder → shows error, no panel created', () => {
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

  // ── Test 2 ────────────────────────────────────────────────────────────────
  test('2. Panel already open → reveals existing panel', () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);

    const fakePanel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);

    const provider = new GraphProvider(makeFakeContext());
    provider.show(); // creates panel
    provider.show(); // should reveal, not create again

    assert.ok((vscode.window.createWebviewPanel as sinon.SinonStub).calledOnce, 'panel created once');
    assert.ok(fakePanel.reveal.calledOnce, 'reveal called on second show()');
  });

  // ── Test 3 ────────────────────────────────────────────────────────────────
  test('3. Python not found → showError with "Python not found"', () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
    const fakePanel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
    const showErr = sandbox.stub(vscode.window, 'showErrorMessage');

    // Make resolvePythonBin return null
    const fakeProc = makeFakeProc();
    sandbox.stub(cp, 'spawn').returns(fakeProc);
    sandbox.stub(cp, 'execFileSync').throws(new Error('not found'));

    const provider = new GraphProvider(makeFakeContext());
    provider.show();

    assert.ok(showErr.calledOnce, 'showErrorMessage called');
    assert.ok(
      showErr.firstCall.args[0].includes('Python not found'),
      'error should mention Python not found'
    );
  });

  // ── Test 4 ────────────────────────────────────────────────────────────────
  test('4. Process exits code 1 + stderr → showError with truncated stderr', () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
    const fakePanel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
    const showErr = sandbox.stub(vscode.window, 'showErrorMessage');
    sandbox.stub(cp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

    const fakeProc = makeFakeProc();
    sandbox.stub(cp, 'spawn').returns(fakeProc);

    const provider = new GraphProvider(makeFakeContext());
    provider.show();

    fakeProc.stderr.emit('data', Buffer.from('SyntaxError: invalid syntax'));
    fakeProc.emit('close', 1);

    assert.ok(showErr.calledOnce, 'showErrorMessage called');
    assert.ok(showErr.firstCall.args[0].includes('exit 1'), 'mentions exit code');
    assert.ok(showErr.firstCall.args[0].includes('SyntaxError'), 'includes stderr snippet');
  });

  // ── Test 5 ────────────────────────────────────────────────────────────────
  test('5. stdout > MAX_OUTPUT_BYTES → kills proc, shows size error', () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
    const fakePanel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
    const showErr = sandbox.stub(vscode.window, 'showErrorMessage');
    sandbox.stub(cp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

    const fakeProc = makeFakeProc();
    sandbox.stub(cp, 'spawn').returns(fakeProc);

    const provider = new GraphProvider(makeFakeContext());
    provider.show();

    // Emit a chunk slightly over 100 MB
    const bigChunk = Buffer.alloc(101 * 1024 * 1024);
    fakeProc.stdout.emit('data', bigChunk);

    assert.ok(fakeProc.kill.calledOnce, 'process should be killed');
    assert.ok(showErr.calledOnce, 'showErrorMessage called');
    assert.ok(showErr.firstCall.args[0].includes('too large'), 'message mentions too large');
  });

  // ── Test 6 ────────────────────────────────────────────────────────────────
  test('6. Timeout exceeded → shows timeout error', function (done) {
    this.timeout(5000);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
    const fakePanel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
    const showErr = sandbox.stub(vscode.window, 'showErrorMessage');
    sandbox.stub(cp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

    const fakeProc = makeFakeProc();
    sandbox.stub(cp, 'spawn').returns(fakeProc);

    // Use a very short timeout to avoid test slowness
    const TIMEOUT_MS = 100;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sandbox.stub(global, 'setTimeout').callsFake((fn: any, ms?: number) => {
      if (ms === 60_000) {
        // Replace the analysis timeout with 100ms
        return global.setTimeout(fn, TIMEOUT_MS) as unknown as ReturnType<typeof setTimeout>;
      }
      return (global.setTimeout as typeof setTimeout)(fn, ms);
    });

    const provider = new GraphProvider(makeFakeContext());
    provider.show();

    setTimeout(() => {
      assert.ok(fakeProc.kill.calledOnce, 'process killed on timeout');
      assert.ok(showErr.calledOnce, 'showErrorMessage called');
      assert.ok(showErr.firstCall.args[0].toLowerCase().includes('timed out'), 'message mentions timeout');
      done();
    }, TIMEOUT_MS + 200);
  });

  // ── Test 7 ────────────────────────────────────────────────────────────────
  test('7. Valid JSON with nodes → posts graph message to webview', function (done) {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
    const fakePanel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
    sandbox.stub(cp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

    // stub fs.readFileSync so getWebviewHtml doesn't fail
    const fs = require('fs');
    sandbox.stub(fs, 'readFileSync').returns('<html></html>');

    const fakeProc = makeFakeProc();
    sandbox.stub(cp, 'spawn').returns(fakeProc);

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

  // ── Test 8 ────────────────────────────────────────────────────────────────
  test('8. Valid JSON, zero nodes → sets empty state HTML', () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
    const fakePanel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
    sandbox.stub(cp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

    const fakeProc = makeFakeProc();
    sandbox.stub(cp, 'spawn').returns(fakeProc);

    const provider = new GraphProvider(makeFakeContext());
    provider.show();

    fakeProc.stdout.emit('data', Buffer.from(JSON.stringify({ nodes: [], edges: [] })));
    fakeProc.emit('close', 0);

    assert.ok(fakePanel.webview.html.includes('No Python functions'), 'empty state HTML set');
  });

  // ── Test 9 ────────────────────────────────────────────────────────────────
  test('9. Invalid JSON → shows parse error', () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
    const fakePanel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
    const showErr = sandbox.stub(vscode.window, 'showErrorMessage');
    sandbox.stub(cp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

    const fakeProc = makeFakeProc();
    sandbox.stub(cp, 'spawn').returns(fakeProc);

    const provider = new GraphProvider(makeFakeContext());
    provider.show();

    fakeProc.stdout.emit('data', Buffer.from('not json {{{'));
    fakeProc.emit('close', 0);

    assert.ok(showErr.calledOnce, 'showErrorMessage called');
    assert.ok(showErr.firstCall.args[0].includes('Failed to parse'), 'parse error message');
  });

  // ── Test 10 ───────────────────────────────────────────────────────────────
  test('10. navigateTo() → calls openTextDocument + showTextDocument', async () => {
    const fakeDoc = {};
    const fakeEditor = {
      selection: undefined as unknown,
      revealRange: sinon.stub(),
    };
    const openDoc = sandbox.stub(vscode.workspace, 'openTextDocument').resolves(fakeDoc as any);
    const showDoc = sandbox.stub(vscode.window, 'showTextDocument').resolves(fakeEditor as any);

    const provider = new GraphProvider(makeFakeContext());
    // Access private method via cast
    await (provider as any).navigateTo('/some/file.py', 42);

    assert.ok(openDoc.calledOnce, 'openTextDocument called once');
    assert.strictEqual(openDoc.firstCall.args[0] as unknown as string, '/some/file.py', 'openTextDocument called with file');
    assert.ok(showDoc.calledOnce, 'showTextDocument called');
    assert.ok(fakeEditor.revealRange.calledOnce, 'revealRange called');
  });
});
