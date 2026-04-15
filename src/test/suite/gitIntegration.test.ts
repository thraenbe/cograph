import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { GraphProvider } from '../../graphProvider';
import { GitService } from '../../gitService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawCp = require('child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeContext(extensionPath = '/fake/ext'): vscode.ExtensionContext {
  return {
    extensionPath,
    extensionUri: vscode.Uri.file(extensionPath),
  } as unknown as vscode.ExtensionContext;
}

function makeFakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = sinon.stub();
  proc.pid = 1234;
  return proc;
}

/** Build a fake panel that captures the onDidReceiveMessage callback. */
function makeFakePanel() {
  let msgCallback: ((msg: any) => void) | undefined;
  const webview = {
    html: '',
    cspSource: 'vscode-resource:',
    onDidReceiveMessage: sinon.stub().callsFake((cb: (msg: any) => void) => {
      msgCallback = cb;
      return { dispose: () => {} };
    }),
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
    sendMessage: (msg: any) => msgCallback?.(msg),
  };
  return panel;
}

// ---------------------------------------------------------------------------
// parseGitDiff()
// ---------------------------------------------------------------------------

suite('parseGitDiff()', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => sandbox.restore());

  test('single hunk → correct start, end, isNew values', () => {
    const diff = [
      'diff --git a/foo.py b/foo.py',
      '--- a/foo.py',
      '+++ b/foo.py',
      '@@ -10,5 +10,5 @@',
    ].join('\n');
    sandbox.stub(rawCp, 'execFileSync').returns(diff);

    const provider = new GraphProvider(makeFakeContext());
    const map = (provider as any).parseGitDiff('/ws', false) as Map<string, any[]>;

    const hunks = map.get('/ws/foo.py');
    assert.ok(hunks, 'file should be in map');
    assert.strictEqual(hunks.length, 1);
    assert.strictEqual(hunks[0].start, 10);
    assert.strictEqual(hunks[0].end, 14);   // 10 + 5 - 1
    assert.strictEqual(hunks[0].isNew, false);
  });

  test('new-file hunk (oldCount=0) → isNew=true', () => {
    const diff = [
      '+++ b/newfile.py',
      '@@ -0,0 +1,3 @@',
    ].join('\n');
    sandbox.stub(rawCp, 'execFileSync').returns(diff);

    const provider = new GraphProvider(makeFakeContext());
    const map = (provider as any).parseGitDiff('/ws', false) as Map<string, any[]>;

    const hunks = map.get('/ws/newfile.py');
    assert.ok(hunks);
    assert.strictEqual(hunks[0].isNew, true);
    assert.strictEqual(hunks[0].start, 1);
    assert.strictEqual(hunks[0].end, 3);
  });

  test('hunk with no count defaults (no ,N) → count treated as 1', () => {
    const diff = [
      '+++ b/single.py',
      '@@ -5 +5 @@',
    ].join('\n');
    sandbox.stub(rawCp, 'execFileSync').returns(diff);

    const provider = new GraphProvider(makeFakeContext());
    const map = (provider as any).parseGitDiff('/ws', false) as Map<string, any[]>;

    const hunks = map.get('/ws/single.py');
    assert.ok(hunks);
    assert.strictEqual(hunks[0].start, 5);
    assert.strictEqual(hunks[0].end, 5);
    assert.strictEqual(hunks[0].isNew, false);
  });

  test('zero new-line count → end equals start', () => {
    const diff = [
      '+++ b/del.py',
      '@@ -10,3 +10,0 @@',
    ].join('\n');
    sandbox.stub(rawCp, 'execFileSync').returns(diff);

    const provider = new GraphProvider(makeFakeContext());
    const map = (provider as any).parseGitDiff('/ws', false) as Map<string, any[]>;

    const hunks = map.get('/ws/del.py');
    assert.ok(hunks);
    assert.strictEqual(hunks[0].start, 10);
    assert.strictEqual(hunks[0].end, 10);
  });

  test('multiple hunks in same file → all entries recorded', () => {
    const diff = [
      '+++ b/multi.py',
      '@@ -2,4 +2,4 @@',
      '@@ -20,3 +20,3 @@',
    ].join('\n');
    sandbox.stub(rawCp, 'execFileSync').returns(diff);

    const provider = new GraphProvider(makeFakeContext());
    const map = (provider as any).parseGitDiff('/ws', false) as Map<string, any[]>;

    const hunks = map.get('/ws/multi.py');
    assert.ok(hunks);
    assert.strictEqual(hunks.length, 2);
    assert.strictEqual(hunks[0].start, 2);
    assert.strictEqual(hunks[1].start, 20);
  });

  test('multiple files → each file has its own entries', () => {
    const diff = [
      '+++ b/a.py',
      '@@ -1,2 +1,2 @@',
      '+++ b/b.py',
      '@@ -5,3 +5,3 @@',
    ].join('\n');
    sandbox.stub(rawCp, 'execFileSync').returns(diff);

    const provider = new GraphProvider(makeFakeContext());
    const map = (provider as any).parseGitDiff('/ws', false) as Map<string, any[]>;

    assert.ok(map.has('/ws/a.py'));
    assert.ok(map.has('/ws/b.py'));
    assert.strictEqual(map.get('/ws/a.py')!.length, 1);
    assert.strictEqual(map.get('/ws/b.py')!.length, 1);
  });

  test('staged=true → passes --cached to execFileSync', () => {
    const stub = sandbox.stub(rawCp, 'execFileSync').returns('');
    const provider = new GraphProvider(makeFakeContext());
    (provider as any).parseGitDiff('/ws', true);

    assert.ok(stub.calledOnce);
    const args = stub.firstCall.args[1] as string[];
    assert.ok(args.includes('--cached'), '--cached should be in args for staged diff');
  });

  test('staged=false → does NOT pass --cached', () => {
    const stub = sandbox.stub(rawCp, 'execFileSync').returns('');
    const provider = new GraphProvider(makeFakeContext());
    (provider as any).parseGitDiff('/ws', false);

    const args = stub.firstCall.args[1] as string[];
    assert.ok(!args.includes('--cached'), '--cached should not be present for unstaged diff');
  });

  test('empty diff → empty Map', () => {
    sandbox.stub(rawCp, 'execFileSync').returns('');
    const provider = new GraphProvider(makeFakeContext());
    const map = (provider as any).parseGitDiff('/ws', false) as Map<string, any[]>;
    assert.strictEqual(map.size, 0);
  });

  test('exception (e.g. not a git repo) → returns empty Map without throwing', () => {
    sandbox.stub(rawCp, 'execFileSync').throws(new Error('not a git repo'));
    const provider = new GraphProvider(makeFakeContext());
    const map = (provider as any).parseGitDiff('/ws', false) as Map<string, any[]>;
    assert.strictEqual(map.size, 0);
  });

  test('file without +++ b/ line → not added to map', () => {
    const diff = [
      'diff --git a/foo.py b/foo.py',
      '--- a/foo.py',
      // no +++ b/ line
      '@@ -1,3 +1,3 @@',
    ].join('\n');
    sandbox.stub(rawCp, 'execFileSync').returns(diff);
    const provider = new GraphProvider(makeFakeContext());
    const map = (provider as any).parseGitDiff('/ws', false) as Map<string, any[]>;
    assert.strictEqual(map.size, 0, 'without +++ b/ the file should not be tracked');
  });
});

// ---------------------------------------------------------------------------
// applyGitStatuses()
// ---------------------------------------------------------------------------

suite('applyGitStatuses()', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => sandbox.restore());

  /** Stub execFileSync to return git status and diff outputs based on args. */
  function stubGit(
    statusOutput: string,
    unstagedDiff: string,
    stagedDiff: string,
  ) {
    sandbox.stub(rawCp, 'execFileSync').callsFake((...a: unknown[]) => {
      const args = a[1] as string[];
      if (args.includes('status')) { return statusOutput; }
      if (args.includes('--cached')) { return stagedDiff; }
      return unstagedDiff;
    });
  }

  test('parseGitStatus returns null (not a git repo) → returns false, nodes unchanged', () => {
    sandbox.stub(rawCp, 'execFileSync').throws(new Error('128'));
    const nodes: any[] = [{ id: 'n1', file: '/ws/foo.py', line: 1, gitStatus: undefined }];
    const provider = new GraphProvider(makeFakeContext());
    const result = (provider as any).applyGitStatuses(nodes, '/ws');
    assert.strictEqual(result, false);
  });

  test('node with no matching file in git status → gitStatus unstaged and staged are null', () => {
    stubGit('M  modified.py\0', '', '');
    const nodes: any[] = [{ id: 'n1', file: '/ws/other.py', line: 1 }];
    const provider = new GraphProvider(makeFakeContext());
    (provider as any).applyGitStatuses(nodes, '/ws');
    assert.deepStrictEqual(nodes[0].gitStatus, { unstaged: null, staged: null });
  });

  test('node in untracked (added) file → gitStatus.unstaged = added', () => {
    stubGit('?? newfile.py\0', '', '');
    const nodes: any[] = [{ id: 'n1', file: '/ws/newfile.py', line: 1 }];
    const provider = new GraphProvider(makeFakeContext());
    (provider as any).applyGitStatuses(nodes, '/ws');
    assert.strictEqual(nodes[0].gitStatus.unstaged, 'added');
  });

  test('node in staged-added file → gitStatus.staged = added', () => {
    stubGit('A  staged.py\0', '', '');
    const nodes: any[] = [{ id: 'n1', file: '/ws/staged.py', line: 1 }];
    const provider = new GraphProvider(makeFakeContext());
    (provider as any).applyGitStatuses(nodes, '/ws');
    assert.strictEqual(nodes[0].gitStatus.staged, 'added');
  });

  test('node in unstaged-deleted file → gitStatus.unstaged = deleted', () => {
    // ' D gone.py' → X=' ' (no staged change), Y='D' (unstaged deleted)
    stubGit(' D gone.py\0', '', '');
    const nodes: any[] = [{ id: 'n1', file: '/ws/gone.py', line: 1 }];
    const provider = new GraphProvider(makeFakeContext());
    (provider as any).applyGitStatuses(nodes, '/ws');
    assert.strictEqual(nodes[0].gitStatus.unstaged, 'deleted');
  });

  test('node in modified file, hunk overlaps node lines → unstaged=modified', () => {
    // M  means staged=modified (X=M), Y=' ' means unstaged=null per parseGitStatus logic
    // Use 'MM' for both staged and unstaged modified
    stubGit('MM file.py\0', '+++ b/file.py\n@@ -5,6 +5,6 @@\n', '');
    // Node at lines 5-10 (two siblings: node at line 5, next at line 20)
    const nodes: any[] = [
      { id: 'n1', file: '/ws/file.py', line: 5 },
      { id: 'n2', file: '/ws/file.py', line: 20 },
    ];
    const provider = new GraphProvider(makeFakeContext());
    (provider as any).applyGitStatuses(nodes, '/ws');
    assert.strictEqual(nodes[0].gitStatus.unstaged, 'modified', 'overlapping hunk should mark node as modified');
  });

  test('node in modified file, hunk falls entirely before node → unstaged=null', () => {
    stubGit('MM file.py\0', '+++ b/file.py\n@@ -1,3 +1,3 @@\n', '');
    // Node starts at line 10 – hunk covers lines 1-3, no overlap
    const nodes: any[] = [
      { id: 'n1', file: '/ws/file.py', line: 10 },
      { id: 'n2', file: '/ws/file.py', line: 30 },
    ];
    const provider = new GraphProvider(makeFakeContext());
    (provider as any).applyGitStatuses(nodes, '/ws');
    assert.strictEqual(nodes[0].gitStatus.unstaged, null, 'non-overlapping hunk should leave node unchanged');
  });

  test('node in modified file, hunk falls entirely after node → unstaged=null', () => {
    stubGit('MM file.py\0', '+++ b/file.py\n@@ -50,5 +50,5 @@\n', '');
    // Node covers lines 5-29 (next node at 30)
    const nodes: any[] = [
      { id: 'n1', file: '/ws/file.py', line: 5 },
      { id: 'n2', file: '/ws/file.py', line: 30 },
    ];
    const provider = new GraphProvider(makeFakeContext());
    (provider as any).applyGitStatuses(nodes, '/ws');
    assert.strictEqual(nodes[0].gitStatus.unstaged, null);
  });

  test('node with file=null → skipped gracefully', () => {
    stubGit('', '', '');
    const nodes: any[] = [{ id: 'n1', file: null, line: 1 }];
    const provider = new GraphProvider(makeFakeContext());
    // Should not throw
    (provider as any).applyGitStatuses(nodes, '/ws');
  });

  test('returns true when git is available', () => {
    stubGit('', '', '');
    const nodes: any[] = [];
    const provider = new GraphProvider(makeFakeContext());
    const result = (provider as any).applyGitStatuses(nodes, '/ws');
    assert.strictEqual(result, true);
  });
});

// ---------------------------------------------------------------------------
// refreshGitStatus()
// ---------------------------------------------------------------------------

suite('refreshGitStatus()', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => sandbox.restore());

  test('no panel → returns without posting', () => {
    sandbox.stub(rawCp, 'execFileSync').returns('');
    const provider = new GraphProvider(makeFakeContext());
    // panel is undefined by default
    (provider as any).refreshGitStatus('/ws');
    // No assertion needed — just verifying it doesn't throw
  });

  test('empty cachedNodes → returns without posting', () => {
    sandbox.stub(rawCp, 'execFileSync').returns('');
    const fakePanel = makeFakePanel();
    const provider = new GraphProvider(makeFakeContext());
    (provider as any).panel = fakePanel;
    (provider as any).cachedNodes = [];
    (provider as any).refreshGitStatus('/ws');
    assert.ok(fakePanel.webview.postMessage.notCalled, 'postMessage should not be called with empty cachedNodes');
  });

  test('normal case → posts git-update message with node statuses', () => {
    sandbox.stub(rawCp, 'execFileSync').returns('');
    const fakePanel = makeFakePanel();
    const provider = new GraphProvider(makeFakeContext());
    (provider as any).panel = fakePanel;
    (provider as any).cachedNodes = [
      { id: 'n1', file: '/ws/foo.py', line: 1 },
    ];

    (provider as any).refreshGitStatus('/ws');

    assert.ok(fakePanel.webview.postMessage.calledOnce, 'postMessage should be called');
    const msg = fakePanel.webview.postMessage.firstCall.args[0];
    assert.strictEqual(msg.type, 'git-update');
    assert.ok(Array.isArray(msg.nodes), 'message should have nodes array');
    assert.strictEqual(msg.nodes[0].id, 'n1');
  });
});

// ---------------------------------------------------------------------------
// Message Handling
// ---------------------------------------------------------------------------

suite('Message Handling', () => {
  let sandbox: sinon.SinonSandbox;
  let tmpDir: string;

  setup(() => {
    sandbox = sinon.createSandbox();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-msg-'));
  });

  teardown(() => {
    sandbox.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function setupProvider() {
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: '/ws' } }]);
    sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));
    const fakeProc = makeFakeProc();
    const fakeTsProc = makeFakeProc();
    sandbox.stub(rawCp, 'spawn').onFirstCall().returns(fakeProc).onSecondCall().returns(fakeTsProc);

    const fakePanel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);

    const provider = new GraphProvider(makeFakeContext());
    provider.show();

    return { provider, fakePanel, fakeProc, fakeTsProc };
  }

  test('navigate → opens document at correct file and line', async () => {
    const { fakePanel } = setupProvider();

    const fakeDoc = {};
    const fakeEditor = { selection: undefined as unknown, revealRange: sinon.stub() };
    const openDoc = sandbox.stub(vscode.workspace, 'openTextDocument').resolves(fakeDoc as any);
    sandbox.stub(vscode.window, 'showTextDocument').resolves(fakeEditor as any);

    fakePanel.sendMessage({ type: 'navigate', file: '/ws/foo.py', line: 42 });

    await new Promise(r => setTimeout(r, 50));

    assert.ok(openDoc.calledOnce, 'openTextDocument should be called');
    assert.strictEqual(openDoc.firstCall.args[0] as unknown as string, '/ws/foo.py');
  });

  test('open-docs for Python library → opens docs.python.org URL', () => {
    const { fakePanel } = setupProvider();
    const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);

    fakePanel.sendMessage({
      type: 'open-docs',
      libraryName: 'os.path',
      functionName: 'join',
      language: 'python',
    });

    assert.ok(openExternal.calledOnce, 'openExternal should be called');
    const url = openExternal.firstCall.args[0].toString();
    assert.ok(url.includes('docs.python.org'), 'URL should use docs.python.org');
    assert.ok(url.includes('os'), 'URL should include the top-level module name');
  });

  test('open-docs for TypeScript library → opens npmjs.com URL', () => {
    const { fakePanel } = setupProvider();
    const openExternal = sandbox.stub(vscode.env, 'openExternal').resolves(true);

    fakePanel.sendMessage({
      type: 'open-docs',
      libraryName: 'lodash',
      functionName: 'debounce',
      language: 'typescript',
    });

    assert.ok(openExternal.calledOnce, 'openExternal should be called');
    const url = openExternal.firstCall.args[0].toString();
    assert.ok(url.includes('npmjs.com'), 'URL should use npmjs.com');
    assert.ok(url.includes('lodash'), 'URL should include the package name');
  });

  test('get-func-source → reads file and posts func-source message', async () => {
    const { fakePanel } = setupProvider();

    const filePath = path.join(tmpDir, 'hello.py');
    fs.writeFileSync(filePath, 'def hello():\n    return 1\n');

    fakePanel.sendMessage({ type: 'get-func-source', file: filePath, line: 1, reqId: 99 });

    // colorize() may be async; wait a tick for the promise to resolve
    await new Promise(r => setTimeout(r, 50));

    assert.ok(fakePanel.webview.postMessage.calledOnce, 'postMessage should be called');
    const msg = fakePanel.webview.postMessage.firstCall.args[0];
    assert.strictEqual(msg.type, 'func-source');
    assert.strictEqual(msg.reqId, 99);
    assert.ok(msg.source.includes('def hello()'), 'source should contain the function');
    assert.ok(!msg.error, 'error should not be set');
  });

  test('get-func-source for non-existent file → posts func-source with error', () => {
    const { fakePanel } = setupProvider();

    fakePanel.sendMessage({ type: 'get-func-source', file: '/nonexistent/file.py', line: 1, reqId: 42 });

    assert.ok(fakePanel.webview.postMessage.calledOnce);
    const msg = fakePanel.webview.postMessage.firstCall.args[0];
    assert.strictEqual(msg.type, 'func-source');
    assert.strictEqual(msg.reqId, 42);
    assert.ok(msg.error, 'error field should be set');
  });

  test('save-func-source → writes modified source to file', () => {
    const { fakePanel } = setupProvider();

    const filePath = path.join(tmpDir, 'save_test.py');
    fs.writeFileSync(filePath, 'def greet():\n    return "hello"\n');

    fakePanel.sendMessage({
      type: 'save-func-source',
      file: filePath,
      line: 1,
      newSource: 'def greet():\n    return "world"\n',
    });

    const written = fs.readFileSync(filePath, 'utf8');
    assert.ok(written.includes('return "world"'), 'modified source should be written to file');
  });

  test('save-func-source with bad path → shows error message', () => {
    const { fakePanel } = setupProvider();
    const showErr = sandbox.stub(vscode.window, 'showErrorMessage');

    fakePanel.sendMessage({
      type: 'save-func-source',
      file: '/nonexistent/path.py',
      line: 1,
      newSource: 'def foo(): pass',
    });

    assert.ok(showErr.calledOnce, 'showErrorMessage should be called on save failure');
    assert.ok(showErr.firstCall.args[0].includes('Failed to save'), 'message should mention failure');
  });
});

// ---------------------------------------------------------------------------
// parseBlamePorcelain() + getIntroductionTimes()
// ---------------------------------------------------------------------------

function makeBlamePorcelain(
  lines: Array<{ sha: string; finalLine: number; authorTime?: number; content: string }>,
): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    out.push(`${l.sha} ${l.finalLine} ${l.finalLine} 1`);
    if (!seen.has(l.sha) && l.authorTime !== undefined) {
      out.push('author Jane Doe');
      out.push('author-mail <jane@example.com>');
      out.push(`author-time ${l.authorTime}`);
      out.push('author-tz +0000');
      out.push('committer Jane Doe');
      out.push('committer-mail <jane@example.com>');
      out.push(`committer-time ${l.authorTime}`);
      out.push('committer-tz +0000');
      out.push('summary a commit');
      out.push(`filename ${'fixture.py'}`);
      seen.add(l.sha);
    }
    out.push(`\t${l.content}`);
  }
  return out.join('\n') + '\n';
}

suite('parseBlamePorcelain()', () => {
  test('single line with author-time → mapped correctly', () => {
    const svc = new GitService();
    const out = makeBlamePorcelain([
      { sha: 'a'.repeat(40), finalLine: 1, authorTime: 1700000000, content: 'def foo():' },
    ]);
    const map = svc.parseBlamePorcelain(out);
    assert.strictEqual(map.get(1), 1700000000);
  });

  test('multiple lines same commit → author-time reused from cache', () => {
    const svc = new GitService();
    const out = makeBlamePorcelain([
      { sha: 'a'.repeat(40), finalLine: 1, authorTime: 1700000000, content: 'def foo():' },
      { sha: 'a'.repeat(40), finalLine: 2, content: '    return 1' },
    ]);
    const map = svc.parseBlamePorcelain(out);
    assert.strictEqual(map.get(1), 1700000000);
    assert.strictEqual(map.get(2), 1700000000);
  });

  test('lines from different commits → each gets its own author-time', () => {
    const svc = new GitService();
    const out = makeBlamePorcelain([
      { sha: 'a'.repeat(40), finalLine: 1, authorTime: 1700000000, content: 'def foo():' },
      { sha: 'b'.repeat(40), finalLine: 2, authorTime: 1800000000, content: '    return 1' },
    ]);
    const map = svc.parseBlamePorcelain(out);
    assert.strictEqual(map.get(1), 1700000000);
    assert.strictEqual(map.get(2), 1800000000);
  });

  test('empty input → empty map', () => {
    const svc = new GitService();
    const map = svc.parseBlamePorcelain('');
    assert.strictEqual(map.size, 0);
  });
});

suite('getIntroductionTimes()', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => sandbox.restore());

  test('maps node ids to author-time from blame output', () => {
    const blame = makeBlamePorcelain([
      { sha: 'a'.repeat(40), finalLine: 3, authorTime: 1700000000, content: 'def foo():' },
      { sha: 'b'.repeat(40), finalLine: 10, authorTime: 1800000000, content: 'def bar():' },
    ]);
    sandbox.stub(rawCp, 'execFileSync').returns(blame);
    const svc = new GitService();
    const nodes: any[] = [
      { id: 'n1', file: '/ws/foo.py', line: 3 },
      { id: 'n2', file: '/ws/foo.py', line: 10 },
    ];
    const result = svc.getIntroductionTimes(nodes, '/ws');
    assert.strictEqual(result.get('n1'), 1700000000);
    assert.strictEqual(result.get('n2'), 1800000000);
  });

  test('nodes with no matching line in blame are omitted', () => {
    const blame = makeBlamePorcelain([
      { sha: 'a'.repeat(40), finalLine: 5, authorTime: 1700000000, content: 'def foo():' },
    ]);
    sandbox.stub(rawCp, 'execFileSync').returns(blame);
    const svc = new GitService();
    const nodes: any[] = [
      { id: 'n1', file: '/ws/foo.py', line: 5 },
      { id: 'n2', file: '/ws/foo.py', line: 99 },
    ];
    const result = svc.getIntroductionTimes(nodes, '/ws');
    assert.strictEqual(result.get('n1'), 1700000000);
    assert.strictEqual(result.has('n2'), false);
  });

  test('blame failure for one file → skips that file but processes others', () => {
    const blameFoo = makeBlamePorcelain([
      { sha: 'a'.repeat(40), finalLine: 1, authorTime: 1700000000, content: 'def foo():' },
    ]);
    sandbox.stub(rawCp, 'execFileSync').callsFake((...a: unknown[]) => {
      const args = a[1] as string[];
      if (args[args.length - 1] === 'bar.py') { throw new Error('untracked'); }
      return blameFoo;
    });
    const svc = new GitService();
    const nodes: any[] = [
      { id: 'n1', file: '/ws/foo.py', line: 1 },
      { id: 'n2', file: '/ws/bar.py', line: 1 },
    ];
    const result = svc.getIntroductionTimes(nodes, '/ws');
    assert.strictEqual(result.get('n1'), 1700000000);
    assert.strictEqual(result.has('n2'), false);
  });

  test('nodes with null file are skipped', () => {
    const stub = sandbox.stub(rawCp, 'execFileSync').returns('');
    const svc = new GitService();
    const nodes: any[] = [{ id: 'n1', file: null, line: 1 }];
    const result = svc.getIntroductionTimes(nodes, '/ws');
    assert.strictEqual(result.size, 0);
    assert.ok(stub.notCalled, 'execFileSync should not be called for file=null nodes');
  });

  test('nodes outside workspace root are skipped', () => {
    const stub = sandbox.stub(rawCp, 'execFileSync').returns('');
    const svc = new GitService();
    const nodes: any[] = [{ id: 'n1', file: '/other/path/foo.py', line: 1 }];
    const result = svc.getIntroductionTimes(nodes, '/ws');
    assert.strictEqual(result.size, 0);
    assert.ok(stub.notCalled, 'execFileSync should not be called for nodes outside workspace');
  });

  test('groups nodes by file → one blame call per file', () => {
    const stub = sandbox.stub(rawCp, 'execFileSync').returns(makeBlamePorcelain([
      { sha: 'a'.repeat(40), finalLine: 1, authorTime: 1700000000, content: 'x' },
    ]));
    const svc = new GitService();
    const nodes: any[] = [
      { id: 'n1', file: '/ws/foo.py', line: 1 },
      { id: 'n2', file: '/ws/foo.py', line: 5 },
      { id: 'n3', file: '/ws/bar.py', line: 1 },
    ];
    svc.getIntroductionTimes(nodes, '/ws');
    assert.strictEqual(stub.callCount, 2, 'one blame call per unique file');
  });
});

// ---------------------------------------------------------------------------
// timeline-data message posting (GraphProvider)
// ---------------------------------------------------------------------------

suite('postTimelineData()', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => sandbox.restore());

  test('posts timeline-data message with entries from gitService', (done) => {
    const fakePanel = makeFakePanel();
    const provider = new GraphProvider(makeFakeContext());
    (provider as any).timelinePanel = fakePanel;
    sandbox.stub((provider as any).gitService, 'getIntroductionTimes').returns(
      new Map([['n1', 1700000000], ['n2', 1800000000]]),
    );
    const graph = { nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [] };

    (provider as any).postTimelineData(fakePanel, graph, '/ws');

    setImmediate(() => {
      const calls = fakePanel.webview.postMessage.getCalls();
      const tlCall = calls.find(c => c.args[0]?.type === 'timeline-data');
      assert.ok(tlCall, 'timeline-data message should be posted');
      const msg = tlCall!.args[0];
      assert.strictEqual(msg.nodes.length, 2);
      assert.ok(msg.nodes.some((e: any) => e.id === 'n1' && e.ts === 1700000000));
      assert.ok(msg.nodes.some((e: any) => e.id === 'n2' && e.ts === 1800000000));
      done();
    });
  });

  test('does not post if timeline panel no longer matches (was disposed)', (done) => {
    const fakePanel = makeFakePanel();
    const provider = new GraphProvider(makeFakeContext());
    sandbox.stub((provider as any).gitService, 'getIntroductionTimes').returns(new Map());
    const graph = { nodes: [], edges: [] };
    (provider as any).timelinePanel = undefined; // disposed / never assigned
    (provider as any).postTimelineData(fakePanel, graph, '/ws');
    setImmediate(() => {
      const calls = fakePanel.webview.postMessage.getCalls();
      const tlCall = calls.find(c => c.args[0]?.type === 'timeline-data');
      assert.strictEqual(tlCall, undefined, 'no timeline-data should be posted');
      done();
    });
  });
});
