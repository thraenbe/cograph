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
        assert.deepStrictEqual(msg.data, graph);
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
