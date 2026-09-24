import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { GraphProvider } from '../../graphProvider';
import { GitService } from '../../gitService';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawCp = require('child_process');

/* eslint-disable @typescript-eslint/no-explicit-any */

const STATUS = ' M src/a.py\0?? src/new.py\0';
const DIFF = ['+++ b/src/a.py', '@@ -10,2 +10,3 @@', ''].join('\n');

/** Stub cp.execFile (callback style) with canned git output per sub-command. */
function stubGit(sandbox: sinon.SinonSandbox, over: { status?: string | Error; diff?: string; cached?: string } = {}) {
  const calls: string[][] = [];
  sandbox.stub(rawCp, 'execFile').callsFake((...a: any[]) => {
    const args: string[] = a[1];
    const cb = a[a.length - 1];
    calls.push(args);
    const status = over.status ?? STATUS;
    if (args[0] === 'status') {
      setImmediate(() => (status instanceof Error ? cb(status) : cb(null, status)));
    } else {
      setImmediate(() => cb(null, args.includes('--cached') ? (over.cached ?? '') : (over.diff ?? DIFF)));
    }
    return {} as any;
  });
  return calls;
}

function makeNodes() {
  return [
    { id: 'a1', name: 'a1', file: '/ws/src/a.py', line: 1 },
    { id: 'a2', name: 'a2', file: '/ws/src/a.py', line: 9 },
    { id: 'a3', name: 'a3', file: '/ws/src/a.py', line: 30 },
    { id: 'n1', name: 'n1', file: '/ws/src/new.py', line: 1 },
    { id: 'c1', name: 'c1', file: '/ws/src/clean.py', line: 1 },
  ] as any[];
}

suite('gitService async path', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => sandbox.restore());

  test('parseStatusOutput / parseDiffOutput are pure and match the sync parsers', () => {
    const svc = new GitService();
    const status = svc.parseStatusOutput(STATUS, '/ws');
    assert.deepStrictEqual(status.get('/ws/src/a.py'), { unstaged: 'modified', staged: null });
    assert.deepStrictEqual(status.get('/ws/src/new.py'), { unstaged: 'added', staged: null });
    sandbox.stub(rawCp, 'execFileSync').returns(DIFF);
    assert.deepStrictEqual([...svc.parseDiffOutput(DIFF, '/ws')], [...svc.parseGitDiff('/ws', false)]);
  });

  test('applyGitStatusesAsync: three git calls in parallel, same annotations as the sync path', async () => {
    const calls = stubGit(sandbox);
    const svc = new GitService();
    const asyncNodes = makeNodes();
    assert.strictEqual(await svc.applyGitStatusesAsync(asyncNodes, '/ws'), true);
    assert.deepStrictEqual(calls.map(c => c.join(' ')).sort(),
      ['diff --unified=0', 'diff --unified=0 --cached', 'status --porcelain -z']);

    const execSync = sandbox.stub(rawCp, 'execFileSync');
    execSync.callsFake((...a: any[]) => (a[1][0] === 'status' ? STATUS : (a[1].includes('--cached') ? '' : DIFF)));
    const syncNodes = makeNodes();
    new GitService().applyGitStatuses(syncNodes, '/ws');
    assert.deepStrictEqual(asyncNodes.map(n => n.gitStatus), syncNodes.map(n => n.gitStatus));
    assert.deepStrictEqual(asyncNodes.map(n => n.gitStatus.unstaged), [null, 'modified', null, 'added', null],
      'hunk at lines 10-12 belongs to a2 (9..29) only');
    assert.ok(svc.fileStatuses['/ws/src/new.py']);
  });

  test('not a repository → false, statuses cleared, nodes untouched', async () => {
    stubGit(sandbox, { status: new Error('fatal: not a git repository') });
    const svc = new GitService();
    svc.fileStatuses = { stale: { unstaged: 'added', staged: null } } as any;
    const nodes = makeNodes();
    assert.strictEqual(await svc.applyGitStatusesAsync(nodes, '/ws'), false);
    assert.deepStrictEqual(svc.fileStatuses, {});
    assert.strictEqual(nodes[0].gitStatus, undefined);
  });

  test('large files: definition end lines are computed once per file (no indexOf per node)', async () => {
    stubGit(sandbox, { status: ' M big.py\0', diff: ['+++ b/big.py', '@@ -0,0 +4999,1 @@', ''].join('\n') });
    const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: `f${i}`, name: `f${i}`, file: '/ws/big.py', line: i + 1 })) as any[];
    const t0 = Date.now();
    await new GitService().applyGitStatusesAsync(nodes, '/ws');
    assert.ok(Date.now() - t0 < 1500, 'linear, not quadratic');
    assert.strictEqual(nodes[4998].gitStatus.unstaged, 'added');
    assert.strictEqual(nodes[10].gitStatus.unstaged, null);
  });
});

suite('GraphProvider.refreshGitStatusAsync (delta git-update)', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => sandbox.restore());

  function makeProvider() {
    const provider = new GraphProvider({ extensionPath: '/fake/ext', extensionUri: vscode.Uri.file('/fake/ext') } as any);
    const postMessage = sinon.stub();
    (provider as any).panel = { webview: { postMessage } };
    (provider as any).cachedNodes = makeNodes();
    return { provider, postMessage };
  }

  test('first refresh sends every node, an unchanged repo sends nothing, a change sends only the delta', async () => {
    stubGit(sandbox);
    const { provider, postMessage } = makeProvider();
    await (provider as any).refreshGitStatusAsync('/ws');
    assert.strictEqual(postMessage.callCount, 1);
    assert.strictEqual(postMessage.firstCall.args[0].type, 'git-update');
    assert.strictEqual(postMessage.firstCall.args[0].nodes.length, 5);

    await (provider as any).refreshGitStatusAsync('/ws');
    assert.strictEqual(postMessage.callCount, 1, 'nothing changed → no message');

    sandbox.restore(); sandbox = sinon.createSandbox();
    stubGit(sandbox, { diff: ['+++ b/src/a.py', '@@ -30,1 +31,2 @@', ''].join('\n') });
    await (provider as any).refreshGitStatusAsync('/ws');
    assert.strictEqual(postMessage.callCount, 2);
    assert.deepStrictEqual(postMessage.secondCall.args[0].nodes.map((n: any) => n.id).sort(), ['a2', 'a3']);
    assert.ok(postMessage.secondCall.args[0].fileGitStatus);
  });

  test('a new graph (cachedNodes replaced) restarts the baseline; a superseded refresh is dropped', async () => {
    stubGit(sandbox);
    const { provider, postMessage } = makeProvider();
    await (provider as any).refreshGitStatusAsync('/ws');
    (provider as any).cachedNodes = makeNodes();
    await (provider as any).refreshGitStatusAsync('/ws');
    assert.strictEqual(postMessage.secondCall.args[0].nodes.length, 5, 'full payload for the new graph');

    const slow = (provider as any).refreshGitStatusAsync('/ws');
    const fast = (provider as any).refreshGitStatusAsync('/ws');
    await Promise.all([slow, fast]);
    assert.strictEqual(postMessage.callCount, 2, 'no status change and the older call was superseded');
  });

  test('no panel / no nodes / no repo → no message', async () => {
    stubGit(sandbox, { status: new Error('not a repo') });
    const { provider, postMessage } = makeProvider();
    await (provider as any).refreshGitStatusAsync('/ws');
    (provider as any).cachedNodes = [];
    await (provider as any).refreshGitStatusAsync('/ws');
    (provider as any).panel = undefined;
    await (provider as any).refreshGitStatusAsync('/ws');
    assert.ok(postMessage.notCalled);
  });
});
