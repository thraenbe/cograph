import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { GraphProvider, MAX_OUTPUT_BYTES, ANALYSIS_TIMEOUT_MS } from '../../graphProvider';

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
      const fakeTsProc = makeFakeProc();
      const fakeJsProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').onFirstCall().returns(fakeProc).onSecondCall().returns(fakeTsProc).onThirdCall().returns(fakeJsProc);

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
      const fakeTsProc = makeFakeProc();
      const fakeJsProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').onFirstCall().returns(fakeProc).onSecondCall().returns(fakeTsProc).onThirdCall().returns(fakeJsProc);

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
      const fakeTsProc = makeFakeProc();
      const fakeJsProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').onFirstCall().returns(fakeProc).onSecondCall().returns(fakeTsProc).onThirdCall().returns(fakeJsProc);

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      // Emit a chunk slightly over 100 MB on the Python proc only
      const bigChunk = Buffer.alloc(MAX_OUTPUT_BYTES + 1);
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
      const fakeTsProc = makeFakeProc();
      const fakeJsProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').onFirstCall().returns(fakeProc).onSecondCall().returns(fakeTsProc).onThirdCall().returns(fakeJsProc);

      // Capture the real setTimeout BEFORE stubbing so the stub and the
      // test's own timer can call it without infinite recursion.
      const TIMEOUT_MS = 100;
      const realSetTimeout = setTimeout;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sandbox.stub(global, 'setTimeout').callsFake((fn: any, ms?: number) => {
        // Replace only the 60 s analysis timeout; pass everything else through.
        return realSetTimeout(fn, ms === ANALYSIS_TIMEOUT_MS ? TIMEOUT_MS : (ms as number));
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
      const fakeTsProc = makeFakeProc();
      const fakeJsProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').onFirstCall().returns(fakeProc).onSecondCall().returns(fakeTsProc).onThirdCall().returns(fakeJsProc);

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      fakeProc.emit('error', new Error('ENOENT'));

      assert.ok(showErr.calledOnce, 'showErrorMessage called');
      assert.ok(
        showErr.firstCall.args[0].includes('Failed to start analyzer'),
        'error should mention failed to start analyzer'
      );
    });

    test('stdout chunks are concatenated before parsing', function (done) {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      const fakePanel = makeFakePanel();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
      sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

      const fakeProc = makeFakeProc();
      const fakeTsProc = makeFakeProc();
      const fakeJsProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').onFirstCall().returns(fakeProc).onSecondCall().returns(fakeTsProc).onThirdCall().returns(fakeJsProc);

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      // TS proc completes with no nodes so merged result = Python nodes only
      fakeJsProc.stdout.emit('data', Buffer.from(JSON.stringify({ nodes: [], edges: [] })));
      fakeJsProc.emit('close', 0);

      fakeTsProc.stdout.emit('data', Buffer.from(JSON.stringify({ nodes: [], edges: [] })));
      fakeTsProc.emit('close', 0);

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
        assert.deepStrictEqual(msg.data, { ...graph, files: [] });
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
      const fakeTsProc = makeFakeProc();
      const fakeJsProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').onFirstCall().returns(fakeProc).onSecondCall().returns(fakeTsProc).onThirdCall().returns(fakeJsProc);

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      const graph = {
        nodes: [{ id: 'a::b::1', name: 'b', file: 'a.py', line: 1 }],
        edges: [],
      };

      // TS proc completes with no nodes so merged result = Python nodes only

      fakeJsProc.stdout.emit('data', Buffer.from(JSON.stringify({ nodes: [], edges: [] })));
      fakeJsProc.emit('close', 0);

      fakeTsProc.stdout.emit('data', Buffer.from(JSON.stringify({ nodes: [], edges: [] })));
      fakeTsProc.emit('close', 0);

      fakeProc.stdout.emit('data', Buffer.from(JSON.stringify(graph)));
      fakeProc.emit('close', 0);

      // postMessage is delayed by 150 ms
      setTimeout(() => {
        assert.ok(fakePanel.webview.postMessage.calledOnce, 'postMessage called');
        const msg = fakePanel.webview.postMessage.firstCall.args[0];
        assert.strictEqual(msg.type, 'graph');
        assert.deepStrictEqual(msg.data, { ...graph, files: [] });
        done();
      }, 300);
    });

    test('zero nodes → sets empty state HTML', function (done) {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
      const fakePanel = makeFakePanel();
      sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
      sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

      const fakeProc = makeFakeProc();
      const fakeTsProc = makeFakeProc();
      const fakeJsProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').onFirstCall().returns(fakeProc).onSecondCall().returns(fakeTsProc).onThirdCall().returns(fakeJsProc);

      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      // Both procs must close before Promise.all resolves
      fakeProc.stdout.emit('data', Buffer.from(JSON.stringify({ nodes: [], edges: [] })));
      fakeProc.emit('close', 0);
      fakeTsProc.stdout.emit('data', Buffer.from(JSON.stringify({ nodes: [], edges: [] })));
      fakeTsProc.emit('close', 0);
      fakeJsProc.stdout.emit('data', Buffer.from(JSON.stringify({ nodes: [], edges: [] })));
      fakeJsProc.emit('close', 0);

      // Wait for Promise.all microtask to settle
      setTimeout(() => {
        assert.ok(fakePanel.webview.html.includes('No functions found'), 'empty state HTML set');
        done();
      }, 50);
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
      const fakeTsProc = makeFakeProc();
      const fakeJsProc = makeFakeProc();
      sandbox.stub(rawCp, 'spawn').onFirstCall().returns(fakeProc).onSecondCall().returns(fakeTsProc).onThirdCall().returns(fakeJsProc);

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

// ---------------------------------------------------------------------------
// parseGitStatus() — P3-A: regex filters bare rename-old-path fragments
// ---------------------------------------------------------------------------

suite('parseGitStatus()', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('modified, added, deleted, untracked entries are parsed correctly', () => {
    // Null-separated porcelain: modified, added (untracked), deleted
    const porcelain = 'M  modified.py\0?? untracked.py\0D  deleted.py\0';
    sandbox.stub(rawCp, 'execFileSync').returns(porcelain);

    const provider = new GraphProvider(makeFakeContext());
    const map = (provider as any).parseGitStatus('/ws') as Map<string, any>;

    assert.ok(map !== null, 'should return a map');
    assert.ok(map.has('/ws/modified.py'), 'modified.py should be in map');
    assert.ok(map.has('/ws/untracked.py'), 'untracked.py should be in map');
    assert.ok(map.has('/ws/deleted.py'), 'deleted.py should be in map');
    assert.strictEqual(map.get('/ws/modified.py').staged, 'modified');
    assert.strictEqual(map.get('/ws/untracked.py').unstaged, 'added');
    assert.strictEqual(map.get('/ws/deleted.py').staged, 'deleted');
  });

  test('rename entry: renamed-to path is included, bare old-path fragment is excluded', () => {
    // git -z porcelain for rename: "R  newfile.ts\0oldfile.ts\0M  other.ts\0"
    // "R  newfile.ts" has XY prefix → included
    // "oldfile.ts"    has no XY prefix → filtered by /^[A-Z? ][A-Z? ] /
    // "M  other.ts"   has XY prefix → included
    const porcelain = 'R  newfile.ts\0oldfile.ts\0M  other.ts\0';
    sandbox.stub(rawCp, 'execFileSync').returns(porcelain);

    const provider = new GraphProvider(makeFakeContext());
    const map = (provider as any).parseGitStatus('/ws') as Map<string, any>;

    assert.ok(map !== null);
    assert.ok(map.has('/ws/newfile.ts'), 'renamed-to path should be included');
    assert.ok(!map.has('/ws/oldfile.ts'), 'bare old-path fragment must be excluded');
    assert.ok(map.has('/ws/other.ts'), 'other.ts should be included');
  });

  test('empty null-separated entries are skipped', () => {
    // Leading/trailing/double nulls produce empty strings
    const porcelain = '\0M  real.py\0\0';
    sandbox.stub(rawCp, 'execFileSync').returns(porcelain);

    const provider = new GraphProvider(makeFakeContext());
    const map = (provider as any).parseGitStatus('/ws') as Map<string, any>;

    assert.ok(map !== null);
    assert.strictEqual(map.size, 1, 'only one real entry should be parsed');
    assert.ok(map.has('/ws/real.py'));
  });
});

// ---------------------------------------------------------------------------
// getFuncSource() — P2-A: CRLF normalisation
// ---------------------------------------------------------------------------

suite('getFuncSource()', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('CRLF file: returned source contains no \\r characters', () => {
    const filePath = path.join(tmpDir, 'hello.py');
    // Write a simple Python function with CRLF line endings
    fs.writeFileSync(filePath, 'def hello():\r\n    return 1\r\n', 'utf8');

    const provider = new GraphProvider(makeFakeContext());
    const source: string = (provider as any).getFuncSource(filePath, 1);

    assert.ok(!source.includes('\r'), 'returned source should not contain \\r');
    assert.ok(source.includes('def hello()'), 'source should contain function definition');
  });

  test('LF file: returned source is correct', () => {
    const filePath = path.join(tmpDir, 'hello.py');
    fs.writeFileSync(filePath, 'def hello():\n    return 1\n', 'utf8');

    const provider = new GraphProvider(makeFakeContext());
    const source: string = (provider as any).getFuncSource(filePath, 1);

    assert.ok(source.includes('def hello()'), 'source should contain function definition');
    assert.ok(source.includes('return 1'), 'source should include function body');
  });
});

// ---------------------------------------------------------------------------
// saveFuncSource() — P2-A: preserves line endings of the target file
// ---------------------------------------------------------------------------

suite('saveFuncSource()', () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-test-'));
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('CRLF file: written output uses CRLF line endings', () => {
    const filePath = path.join(tmpDir, 'hello.py');
    fs.writeFileSync(filePath, 'def hello():\r\n    return 1\r\n', 'utf8');

    const provider = new GraphProvider(makeFakeContext());
    (provider as any).saveFuncSource(filePath, 1, 'def hello():\n    return 42\n');

    const written = fs.readFileSync(filePath, 'utf8');
    assert.ok(written.includes('\r\n'), 'CRLF file should keep CRLF after save');
    assert.ok(written.includes('return 42'), 'new source content should be written');
  });

  test('LF file: written output uses LF line endings', () => {
    const filePath = path.join(tmpDir, 'hello.py');
    fs.writeFileSync(filePath, 'def hello():\n    return 1\n', 'utf8');

    const provider = new GraphProvider(makeFakeContext());
    (provider as any).saveFuncSource(filePath, 1, 'def hello():\n    return 42\n');

    const written = fs.readFileSync(filePath, 'utf8');
    assert.ok(!written.includes('\r\n'), 'LF file should keep LF after save');
    assert.ok(written.includes('return 42'), 'new source content should be written');
  });

  test('CRLF newSource in LF file: output preserves LF (not CRLF from source)', () => {
    const filePath = path.join(tmpDir, 'hello.py');
    fs.writeFileSync(filePath, 'def hello():\n    return 1\n', 'utf8');

    const provider = new GraphProvider(makeFakeContext());
    // newSource has CRLF — but the file is LF, so output must use LF
    (provider as any).saveFuncSource(filePath, 1, 'def hello():\r\n    return 99\r\n');

    const written = fs.readFileSync(filePath, 'utf8');
    assert.ok(!written.includes('\r\n'), 'LF file should remain LF even when newSource has CRLF');
    assert.ok(written.includes('return 99'), 'new source content should be written');
  });
});

// ---------------------------------------------------------------------------
// resolvePythonBin() — P1-A: Windows venv path selection
// ---------------------------------------------------------------------------

suite('resolvePythonBin() - venv path selection', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('win32: resolves .venv/Scripts/python.exe when only that path exists', () => {
    const origDesc = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: 'C:\\myproject' } }]);
      // VS Code Python extension not active
      sandbox.stub(vscode.extensions, 'getExtension').returns(undefined);
      // Python config returns nothing
      sandbox.stub(vscode.workspace, 'getConfiguration').returns({
        get: () => undefined,
      } as any);

      const winVenvPath = path.join('C:\\myproject', '.venv', 'Scripts', 'python.exe');
      sandbox.stub(rawCp, 'execFileSync').callsFake((...args: unknown[]) => {
        if (args[0] === winVenvPath) { return Buffer.from('Python 3.11.0'); }
        throw new Error('not found');
      });

      const provider = new GraphProvider(makeFakeContext());
      const result = provider.resolvePythonBin();

      assert.strictEqual(result, winVenvPath, 'should resolve Windows venv path');
    } finally {
      Object.defineProperty(process, 'platform', origDesc);
    }
  });

  test('unix: resolves .venv/bin/python when only that path exists', () => {
    const origDesc = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    try {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/home/user/myproject' } }]);
      sandbox.stub(vscode.extensions, 'getExtension').returns(undefined);
      sandbox.stub(vscode.workspace, 'getConfiguration').returns({
        get: () => undefined,
      } as any);

      const unixVenvPath = path.join('/home/user/myproject', '.venv', 'bin', 'python');
      sandbox.stub(rawCp, 'execFileSync').callsFake((...args: unknown[]) => {
        if (args[0] === unixVenvPath) { return Buffer.from('Python 3.11.0'); }
        throw new Error('not found');
      });

      const provider = new GraphProvider(makeFakeContext());
      const result = provider.resolvePythonBin();

      assert.strictEqual(result, unixVenvPath, 'should resolve Unix venv path');
    } finally {
      Object.defineProperty(process, 'platform', origDesc);
    }
  });
});

// ---------------------------------------------------------------------------
// save-graph message handler + loadGraph() + setSidebarProvider()
// ---------------------------------------------------------------------------

/**
 * Build a fake panel whose webview captures all onDidReceiveMessage callbacks
 * so tests can invoke them directly. Also stubs spawn/execFileSync so
 * provider.show() doesn't actually run the analyzer.
 */
function setupPanelWithCapturedMessages(sandbox: sinon.SinonSandbox) {
  sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));
  const fakeProc = makeFakeProc();
  const fakeTsProc = makeFakeProc();
  const fakeJsProc = makeFakeProc();
  sandbox.stub(rawCp, 'spawn')
    .onFirstCall().returns(fakeProc)
    .onSecondCall().returns(fakeTsProc)
    .onThirdCall().returns(fakeJsProc);

  const msgCallbacks: Array<(msg: unknown) => void | Promise<void>> = [];
  const webview = {
    html: '',
    cspSource: 'vscode-resource:',
    onDidReceiveMessage: sinon.stub().callsFake((cb: (m: unknown) => void) => {
      msgCallbacks.push(cb);
      return { dispose: () => {} };
    }),
    postMessage: sinon.stub().resolves(true),
    asWebviewUri: sinon.stub().callsFake((uri: vscode.Uri) => uri),
  };
  const panel = {
    webview,
    title: 'CoGraph',
    reveal: sinon.stub(),
    onDidDispose: sinon.stub().callsFake((cb: () => void) => {
      (panel as unknown as { _disposeCallback: () => void })._disposeCallback = cb;
      return { dispose: () => {} };
    }),
    dispose: sinon.stub(),
  };
  sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel as unknown as vscode.WebviewPanel);

  return { panel, webview, msgCallbacks };
}

suite('save-graph message handler', () => {
  let sandbox: sinon.SinonSandbox;
  let tmpDir: string;

  setup(() => {
    sandbox = sinon.createSandbox();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-save-test-'));
  });

  teardown(() => {
    sandbox.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('happy path: writes JSON file, sets panel title, refreshes sidebar, shows info', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
    sandbox.stub(vscode.window, 'showInputBox').resolves('My Layout');
    const showInfo = sandbox.stub(vscode.window, 'showInformationMessage');

    const { panel, msgCallbacks } = setupPanelWithCapturedMessages(sandbox);
    const provider = new GraphProvider(makeFakeContext());
    const sidebarRefresh = sinon.stub();
    provider.setSidebarProvider({ refresh: sidebarRefresh } as unknown as import('../../sidebarProvider').SidebarProvider);
    provider.show();

    assert.ok(msgCallbacks.length >= 1, 'message callback should be registered');
    await msgCallbacks[0]({
      type: 'save-graph',
      payload: {
        settings: {
          complexityLevel: 0.8,
          clusterGroupBy: 'class',
          layoutMode: 'static',
          gitMode: true,
          languageMode: false,
          folderMode: true,
          classMode: false,
        },
        nodePositions: { 'a::b::1': { x: 10, y: 20 } },
      },
    });

    // File created at .cograph/My Layout.json
    const writtenPath = path.join(tmpDir, '.cograph', 'My Layout.json');
    assert.ok(fs.existsSync(writtenPath), `file should exist at ${writtenPath}`);
    const written = JSON.parse(fs.readFileSync(writtenPath, 'utf8'));
    assert.strictEqual(written.version, 1);
    assert.strictEqual(written.name, 'My Layout');
    assert.strictEqual(written.description, '');
    assert.ok(typeof written.savedAt === 'string' && written.savedAt.length > 0);
    assert.ok(!Number.isNaN(new Date(written.savedAt).getTime()), 'savedAt should parse as a date');
    assert.deepStrictEqual(written.settings, {
      complexityLevel: 0.8,
      clusterGroupBy: 'class',
      layoutMode: 'static',
      gitMode: true,
      languageMode: false,
      folderMode: true,
      classMode: false,
    });
    assert.deepStrictEqual(written.nodePositions, { 'a::b::1': { x: 10, y: 20 } });

    // Panel title updated
    assert.strictEqual(panel.title, 'My Layout');
    // Sidebar refreshed
    assert.ok(sidebarRefresh.calledOnce, 'sidebar.refresh() should be called');
    // Info notification shown
    assert.ok(showInfo.calledOnce);
    assert.ok(String(showInfo.firstCall.args[0]).includes('My Layout'));
  });

  test('user cancels input → no file written, title unchanged, no refresh', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
    sandbox.stub(vscode.window, 'showInputBox').resolves(undefined);
    sandbox.stub(vscode.window, 'showInformationMessage');

    const { panel, msgCallbacks } = setupPanelWithCapturedMessages(sandbox);
    const provider = new GraphProvider(makeFakeContext());
    const sidebarRefresh = sinon.stub();
    provider.setSidebarProvider({ refresh: sidebarRefresh } as unknown as import('../../sidebarProvider').SidebarProvider);
    provider.show();

    await msgCallbacks[0]({ type: 'save-graph', payload: { settings: {}, nodePositions: {} } });

    assert.strictEqual(fs.existsSync(path.join(tmpDir, '.cograph')), false, '.cograph dir should not be created');
    assert.strictEqual(panel.title, 'CoGraph', 'title should not change');
    assert.strictEqual(sidebarRefresh.callCount, 0);
  });

  test('whitespace-only name → no file written', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
    sandbox.stub(vscode.window, 'showInputBox').resolves('   ');
    sandbox.stub(vscode.window, 'showInformationMessage');

    const { msgCallbacks } = setupPanelWithCapturedMessages(sandbox);
    const provider = new GraphProvider(makeFakeContext());
    provider.show();

    await msgCallbacks[0]({ type: 'save-graph', payload: { settings: {}, nodePositions: {} } });

    assert.strictEqual(fs.existsSync(path.join(tmpDir, '.cograph')), false);
  });

  test('creates .cograph directory when missing', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
    sandbox.stub(vscode.window, 'showInputBox').resolves('Fresh');
    sandbox.stub(vscode.window, 'showInformationMessage');

    const { msgCallbacks } = setupPanelWithCapturedMessages(sandbox);
    const provider = new GraphProvider(makeFakeContext());
    provider.show();

    assert.strictEqual(fs.existsSync(path.join(tmpDir, '.cograph')), false, 'precondition: dir missing');
    await msgCallbacks[0]({ type: 'save-graph', payload: { settings: {}, nodePositions: {} } });
    assert.strictEqual(fs.existsSync(path.join(tmpDir, '.cograph')), true, '.cograph dir should be created');
    assert.strictEqual(fs.existsSync(path.join(tmpDir, '.cograph', 'Fresh.json')), true);
  });

  test('filename sanitation: replaces invalid characters with _', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
    sandbox.stub(vscode.window, 'showInputBox').resolves('My/Weird:Layout*');
    sandbox.stub(vscode.window, 'showInformationMessage');

    const { msgCallbacks } = setupPanelWithCapturedMessages(sandbox);
    const provider = new GraphProvider(makeFakeContext());
    provider.show();

    await msgCallbacks[0]({ type: 'save-graph', payload: { settings: {}, nodePositions: {} } });

    // /, :, * should all be replaced; alphanumerics, _, - and space preserved
    const files = fs.readdirSync(path.join(tmpDir, '.cograph'));
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0], 'My_Weird_Layout_.json');
    // But the stored name inside the JSON keeps the trimmed original
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, '.cograph', files[0]), 'utf8'));
    assert.strictEqual(data.name, 'My/Weird:Layout*');
  });

  test('mode=save after loadGraph(data, filePath) overwrites silently, no prompt', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
    const showInputBox = sandbox.stub(vscode.window, 'showInputBox');
    sandbox.stub(vscode.window, 'showInformationMessage');

    // Prepare an existing saved file to "load" from
    const cographDir = path.join(tmpDir, '.cograph');
    fs.mkdirSync(cographDir);
    const existingPath = path.join(cographDir, 'Existing.json');
    fs.writeFileSync(existingPath, JSON.stringify({
      version: 1, name: 'Existing', savedAt: '2020-01-01T00:00:00.000Z',
      settings: {}, nodePositions: { 'old::1': { x: 0, y: 0 } },
    }), 'utf8');

    const { msgCallbacks } = setupPanelWithCapturedMessages(sandbox);
    const provider = new GraphProvider(makeFakeContext());
    provider.show();

    await provider.loadGraph({ name: 'Existing', nodePositions: {} }, existingPath);

    await msgCallbacks[0]({
      type: 'save-graph',
      mode: 'save',
      payload: { settings: { layoutMode: 'static' }, nodePositions: { 'new::1': { x: 9, y: 9 } } },
    });

    assert.strictEqual(showInputBox.callCount, 0, 'save mode must NOT prompt');
    const written = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
    assert.strictEqual(written.name, 'Existing', 'name preserved from existing file');
    assert.deepStrictEqual(written.nodePositions, { 'new::1': { x: 9, y: 9 } }, 'positions overwritten');
    // Only one file — no new file created
    assert.deepStrictEqual(fs.readdirSync(cographDir).sort(), ['Existing.json']);
  });

  test('mode=save with no current path falls back to prompt (save-as)', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
    const showInputBox = sandbox.stub(vscode.window, 'showInputBox').resolves('Named');
    sandbox.stub(vscode.window, 'showInformationMessage');

    const { msgCallbacks } = setupPanelWithCapturedMessages(sandbox);
    const provider = new GraphProvider(makeFakeContext());
    provider.show();

    await msgCallbacks[0]({
      type: 'save-graph',
      mode: 'save',
      payload: { settings: {}, nodePositions: {} },
    });

    assert.strictEqual(showInputBox.callCount, 1, 'must prompt when no current path');
    assert.strictEqual(fs.existsSync(path.join(tmpDir, '.cograph', 'Named.json')), true);
  });

  test('mode=save-as always prompts even after loadGraph', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
    const showInputBox = sandbox.stub(vscode.window, 'showInputBox').resolves('Renamed');
    sandbox.stub(vscode.window, 'showInformationMessage');

    const cographDir = path.join(tmpDir, '.cograph');
    fs.mkdirSync(cographDir);
    const existingPath = path.join(cographDir, 'Existing.json');
    fs.writeFileSync(existingPath, JSON.stringify({ name: 'Existing', settings: {}, nodePositions: {} }), 'utf8');

    const { msgCallbacks } = setupPanelWithCapturedMessages(sandbox);
    const provider = new GraphProvider(makeFakeContext());
    provider.show();
    await provider.loadGraph({ name: 'Existing', nodePositions: {} }, existingPath);

    await msgCallbacks[0]({
      type: 'save-graph',
      mode: 'save-as',
      payload: { settings: {}, nodePositions: {} },
    });

    assert.strictEqual(showInputBox.callCount, 1, 'save-as must always prompt');
    assert.strictEqual(fs.existsSync(path.join(cographDir, 'Renamed.json')), true, 'new file created');
    assert.strictEqual(fs.existsSync(existingPath), true, 'original file untouched');
  });
});

suite('loadGraph()', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => {
    sandbox = sinon.createSandbox();
  });

  teardown(() => {
    sandbox.restore();
  });

  test('with open panel: sets title, reveals, posts graph-loaded', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
    const { panel, webview } = setupPanelWithCapturedMessages(sandbox);

    const provider = new GraphProvider(makeFakeContext());
    provider.show(); // opens the panel

    const data = { name: 'Saved Snapshot', nodePositions: { 'a::1': { x: 5, y: 6 } } };
    await provider.loadGraph(data);

    assert.strictEqual(panel.title, 'Saved Snapshot', 'panel title should reflect graph name');
    assert.ok(panel.reveal.calledOnce, 'reveal should be called on the existing panel');
    // postMessage may have other unrelated calls (none in this test path); assert ours is present
    const loadedCalls = webview.postMessage.getCalls().filter(c => c.args[0]?.type === 'graph-loaded');
    assert.strictEqual(loadedCalls.length, 1, 'exactly one graph-loaded message should be posted');
    assert.deepStrictEqual(loadedCalls[0].args[0], { type: 'graph-loaded', payload: data });
  });

  test('data without name → does not overwrite existing panel title', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
    const { panel } = setupPanelWithCapturedMessages(sandbox);

    const provider = new GraphProvider(makeFakeContext());
    provider.show();
    panel.title = 'Original Title';

    await provider.loadGraph({ nodePositions: {} });

    assert.strictEqual(panel.title, 'Original Title');
  });

  test('closed panel: show() is called, graph-ready short-circuits the wait', async () => {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
    const { panel, webview, msgCallbacks } = setupPanelWithCapturedMessages(sandbox);

    // Avoid the 2s fallback — patch setTimeout so the analysis timeout stays real
    // but the loadGraph fallback fires quickly. Capture the real one first to
    // prevent infinite recursion (see memory: setTimeout stub pitfall).
    const realSetTimeout = setTimeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sandbox.stub(global, 'setTimeout').callsFake((fn: any, ms?: number) => {
      // Shorten the 2000 ms fallback only; pass everything else through.
      return realSetTimeout(fn, ms === 2000 ? 20 : (ms as number));
    });

    const provider = new GraphProvider(makeFakeContext());
    // Fire graph-ready from a microtask after loadGraph() subscribes,
    // so the awaited promise resolves before the 20 ms fallback.
    const loadPromise = provider.loadGraph({ name: 'Restored', nodePositions: {} });

    // Allow show() to run synchronously and register the message callback
    await new Promise<void>(r => realSetTimeout(r, 5));
    // The loadGraph() promise subscribes a SECOND callback (index 1)
    if (msgCallbacks.length > 1) {
      msgCallbacks[1]({ type: 'graph-ready' });
    }

    await loadPromise;

    assert.strictEqual(panel.title, 'Restored', 'title set after load');
    const loadedCalls = webview.postMessage.getCalls().filter(c => c.args[0]?.type === 'graph-loaded');
    assert.strictEqual(loadedCalls.length, 1);
  });
});

suite('setSidebarProvider()', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  test('stored sidebar is invoked by save-graph refresh', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-sidebar-inject-'));
    try {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
      sandbox.stub(vscode.window, 'showInputBox').resolves('Layout');
      sandbox.stub(vscode.window, 'showInformationMessage');

      const { msgCallbacks } = setupPanelWithCapturedMessages(sandbox);
      const provider = new GraphProvider(makeFakeContext());

      const refresh = sinon.stub();
      provider.setSidebarProvider({ refresh } as unknown as import('../../sidebarProvider').SidebarProvider);

      provider.show();
      await msgCallbacks[0]({ type: 'save-graph', payload: { settings: {}, nodePositions: {} } });

      assert.ok(refresh.calledOnce, 'sidebar.refresh() should fire after successful save');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('no sidebar set → save-graph still succeeds without throwing', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-no-sidebar-'));
    try {
      sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmpDir } }]);
      sandbox.stub(vscode.window, 'showInputBox').resolves('NoSidebar');
      sandbox.stub(vscode.window, 'showInformationMessage');

      const { msgCallbacks } = setupPanelWithCapturedMessages(sandbox);
      const provider = new GraphProvider(makeFakeContext());
      provider.show();

      await assert.doesNotReject(
        msgCallbacks[0]({ type: 'save-graph', payload: { settings: {}, nodePositions: {} } }) as Promise<void>,
      );
      assert.strictEqual(fs.existsSync(path.join(tmpDir, '.cograph', 'NoSidebar.json')), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
