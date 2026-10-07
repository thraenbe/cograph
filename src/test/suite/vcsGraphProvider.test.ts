import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphProvider } from '../../graphProvider';
import { SidebarProvider } from '../../sidebarProvider';
import { scanStructure } from '../../structureScanner';
import { writeCache } from '../../cacheStore';
import { NO_SCOPE, specForFolder } from '../../subgraphScope';
import type { PrGraphView } from '../../vcs/prController';
import { PR_DOCUMENT_SCHEME, prDocumentFile, prDocumentUri, registerPrDocuments } from '../../vcs/prDocuments';
import type { VcsSidebar } from '../../vcs/vcsSidebar';

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

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) { throw new Error('waitFor timed out'); }
    await new Promise(r => setTimeout(r, 20));
  }
}

const FILES = ['src/main.ts', 'src/server/api.ts', 'src/ui/view.ts', 'tools/gen.ts'];

suite('GraphProvider — pull-request view', () => {
  let sandbox: sinon.SinonSandbox;
  let root: string;
  let panel: ReturnType<typeof makeFakePanel>;
  let provider: GraphProvider;
  let info: sinon.SinonStub;
  let aiEnabled: boolean;

  const abs = (rel: string) => path.join(root, ...rel.split('/'));
  const fwd = (rel: string) => abs(rel).replace(/\\/g, '/');
  const posted = (type?: string) => panel.webview.postMessage.getCalls().map((c: any) => c.args[0]).filter((m: any) => !type || m.type === type);
  const types = (...keep: string[]) => posted().map((m: any) => m.type).filter((t: string) => keep.includes(t));
  const onMessage = () => panel.webview.onDidReceiveMessage.firstCall.args[0];

  /** A view of PR #n that modified `src/server/api.ts` and added `tools/gen.ts`. */
  function prView(n = 69, include = ['.']): PrGraphView {
    const statuses = new Map([
      [fwd('src/server/api.ts'), { unstaged: 'modified' as const, staged: null }],
      [fwd('tools/gen.ts'), { unstaged: 'added' as const, staged: null }],
    ]);
    const name = `PR #${n} · a change`;
    return {
      number: n, name, spec: { include, exclude: [] },
      override: { files: statuses, hunks: new Map([[fwd('src/server/api.ts'), [{ start: 1, end: 1, isNew: false }]]]) },
      message: {
        type: 'pr-view', active: true, number: n, name, title: 'a change', headRef: 'feat', baseRef: 'main',
        tree: { kind: 'checkout', branch: 'main' },
        expand: [root, abs('src'), abs('src/server'), abs('tools')], fileGitStatus: Object.fromEntries(statuses),
        counts: { total: 2, inGraph: 2, exact: 2, fileLevel: 0, missing: 0, other: 0 },
      },
    };
  }

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-pr-host-'));
    for (const rel of FILES) {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), 'export function f() {}\n');
    }
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: root } }]);
    sandbox.stub(rawCp, 'execFileSync').returns('');          // git: a clean working tree
    sandbox.stub(rawCp, 'spawn');
    aiEnabled = false;
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((() => ({
      get: (k: string, d?: unknown) => (k === 'graphIntelligence.enabled' ? aiEnabled : d),
      has: () => false, inspect: () => undefined, update: async () => undefined,
    })) as unknown as typeof vscode.workspace.getConfiguration);
    info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    panel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
    provider = new GraphProvider({ extensionPath: '/fake/ext', extensionUri: vscode.Uri.file('/fake/ext') } as unknown as vscode.ExtensionContext);
    const nodes = FILES.map(rel => ({ id: `n:${rel}`, name: 'f', file: abs(rel), line: 1 }));
    writeCache(root, { nodes, edges: [], files: nodes.map(n => n.file) } as any, scanStructure(root));
  });

  teardown(() => {
    panel._disposeCallback?.();
    sandbox.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function openPanel(start: () => void = () => provider.show()) {
    start();
    onMessage()({ type: 'ready' });
    await waitFor(() => posted('graph').length > 0);
  }
  const statusOf = (nodes: any[], rel: string) => nodes.find(n => n.id === `n:${rel}`)?.gitStatus?.unstaged ?? null;

  test('a panel opened for a PR: subgraph, pr-view, structure, graph — and the graph already carries the PR\'s colours', async () => {
    const changes: Array<number | null> = [];
    provider.onPullRequestChange(n => changes.push(n));
    await openPanel(() => { assert.strictEqual(provider.showPullRequest(prView()), true); });
    assert.deepStrictEqual(types('subgraph', 'pr-view', 'structure', 'graph'), ['subgraph', 'pr-view', 'structure', 'graph']);
    assert.deepStrictEqual([posted('subgraph')[0].include, posted('subgraph')[0].name], [['.'], 'PR #69 · a change']);
    const g = posted('graph')[0];
    assert.strictEqual(statusOf(g.data.nodes, 'src/server/api.ts'), 'modified');
    assert.strictEqual(statusOf(g.data.nodes, 'tools/gen.ts'), 'added');
    assert.strictEqual(statusOf(g.data.nodes, 'src/main.ts'), null);
    assert.deepStrictEqual(Object.keys(g.fileGitStatus).sort(), [fwd('src/server/api.ts'), fwd('tools/gen.ts')].sort());
    assert.strictEqual(g.gitAvailable, true);
    assert.strictEqual(panel.title, 'PR #69 · a change');
    assert.deepStrictEqual([provider.getScope().source, provider.activePullRequest()], ['pr', 69]);
    assert.deepStrictEqual(changes, [69]);
  });

  test('on an open panel: pr-view goes first (the webview snapshots), then the scope, then every node\'s status', async () => {
    await openPanel();
    panel.webview.postMessage.resetHistory();
    provider.showPullRequest(prView());
    assert.deepStrictEqual(types('pr-view', 'subgraph', 'git-update'), ['pr-view', 'subgraph', 'git-update']);
    assert.strictEqual(posted('pr-view')[0].active, true);
    const update = posted('git-update')[0];
    assert.strictEqual(statusOf(update.nodes, 'src/server/api.ts'), 'modified');
    assert.strictEqual(update.nodes.length, 4, 'a full update, not a delta: the baseline changed');
    assert.ok(panel.reveal.called);
  });

  test('leaving restores the scope, the title and the working tree\'s statuses, and tells the webview to restore', async () => {
    await openPanel(() => provider.showScoped(specForFolder('src'), 'subgraph', 'Backend'));
    assert.strictEqual(panel.title, 'Backend');
    provider.showPullRequest(prView());
    const changes: Array<number | null> = [];
    provider.onPullRequestChange(n => changes.push(n));
    panel.webview.postMessage.resetHistory();

    provider.exitPullRequest();
    assert.deepStrictEqual(types('subgraph', 'git-update', 'pr-view'), ['subgraph', 'git-update', 'pr-view']);
    assert.deepStrictEqual([posted('subgraph')[0].include, posted('subgraph')[0].name], [['src'], 'Backend']);
    const off = posted('pr-view')[0];
    assert.deepStrictEqual([off.active, off.restore, off.fileGitStatus], [false, true, {}]);
    assert.ok(posted('git-update')[0].nodes.every((n: any) => n.gitStatus.unstaged === null), 'the PR\'s colours are gone');
    assert.strictEqual(panel.title, 'Backend');
    assert.deepStrictEqual([provider.getScope().source, provider.getScope().name, provider.activePullRequest()], ['subgraph', 'Backend', null]);
    assert.deepStrictEqual(changes, [null]);
    provider.exitPullRequest(); // a second exit is a no-op
    assert.deepStrictEqual(changes, [null]);
  });

  test('the webview\'s own subgraph-exit leaves the PR view — back to the whole project it replaced', async () => {
    await openPanel();
    provider.showPullRequest(prView(69, ['src/server', 'tools']));
    assert.strictEqual(provider.getScope().spec.include.length, 2);
    onMessage()({ type: 'subgraph-exit' });
    assert.strictEqual(provider.getScope(), NO_SCOPE);
    assert.strictEqual(panel.title, 'CoGraph');
    assert.strictEqual(provider.activePullRequest(), null);
  });

  test('one PR after another keeps what came before the first', async () => {
    await openPanel(() => provider.showScoped(specForFolder('src'), 'subgraph', 'Backend'));
    provider.showPullRequest(prView(69));
    provider.showPullRequest(prView(70));
    assert.deepStrictEqual([provider.activePullRequest(), panel.title], [70, 'PR #70 · a change']);
    provider.exitPullRequest();
    assert.deepStrictEqual([provider.getScope().name, panel.title], ['Backend', 'Backend']);
  });

  test('a PR view is not saved', async () => {
    await openPanel();
    provider.showPullRequest(prView());
    const askName = sandbox.stub(vscode.window, 'showInputBox').resolves('Should never be asked');
    await onMessage()({ type: 'save-graph', mode: 'save-as', payload: { settings: {}, nodePositions: {} } });
    assert.ok(info.calledOnce && String(info.firstCall.args[0]).includes('pull-request view is not saved'));
    assert.ok(askName.notCalled, 'refused before a name is asked for or a file written');
    assert.strictEqual(fs.existsSync(path.join(root, '.cograph', 'Should never be asked.json')), false);
  });

  test('another view taking over ends the PR view without asking the webview to restore', async () => {
    await openPanel();
    provider.showPullRequest(prView());
    const changes: Array<number | null> = [];
    provider.onPullRequestChange(n => changes.push(n));
    panel.webview.postMessage.resetHistory();
    provider.showScoped(specForFolder('src/ui'));
    const off = posted('pr-view')[0];
    assert.deepStrictEqual([off.active, off.restore], [false, false]);
    assert.deepStrictEqual([provider.getScope().source, provider.activePullRequest()], ['folder', null]);
    assert.strictEqual(panel.title, 'ui · scoped');
    assert.deepStrictEqual(changes, [null]);
    assert.ok(posted('git-update')[0].nodes.every((n: any) => n.gitStatus.unstaged === null));
  });

  test('closing the panel ends the PR view; the next panel shows working-tree colours again', async () => {
    await openPanel(() => { provider.showPullRequest(prView()); });
    const changes: Array<number | null> = [];
    provider.onPullRequestChange(n => changes.push(n));
    panel._disposeCallback();
    assert.deepStrictEqual([changes, provider.activePullRequest(), provider.getScope()], [[null], null, NO_SCOPE]);
    panel.webview.postMessage.resetHistory();
    panel.webview.onDidReceiveMessage.resetHistory();
    await openPanel();
    assert.strictEqual(posted('pr-view').length, 0);
    assert.ok(posted('graph')[0].data.nodes.every((n: any) => n.gitStatus.unstaged === null));
  });

  // The AI Workflow Graph replaces whatever is on the canvas; a PR view must not leave its
  // banner and colours on it. Two paths draw one: the saved card and a fresh generation.
  const workflowGraph = () => ({
    nodes: [{ id: 'n:src/main.ts', name: 'f', file: abs('src/main.ts'), line: 1, workflow: { stage: 0, tier: 'backend', cluster: 'core', clusterName: 'Core' } }],
    edges: [], files: [abs('src/main.ts')], workflow: { stageCount: 1, dividerStage: 0 },
  });

  test('opening the saved Workflow Graph ends the PR view before the graph is posted', async () => {
    await openPanel(() => provider.showScoped(specForFolder('src'), 'subgraph', 'Backend'));
    provider.showPullRequest(prView());
    panel.webview.postMessage.resetHistory();
    await provider.showWorkflowGraph(workflowGraph() as any, path.join(root, '.cograph', '__workflow__.json'), 'Workflow');
    assert.deepStrictEqual(types('pr-view', 'graph'), ['pr-view', 'graph'], 'the PR dressing is gone before the workflow graph arrives');
    assert.deepStrictEqual([posted('pr-view')[0].active, posted('pr-view')[0].restore], [false, false]);
    assert.deepStrictEqual([provider.activePullRequest(), provider.getScope().name, panel.title], [null, 'Backend', 'Workflow']);
    assert.strictEqual(posted('graph')[0].data.nodes[0].gitStatus.unstaged, null, 'working-tree colours, not the PR\'s');
  });

  test('a generated Workflow Graph ends the PR view; a failed generation leaves it exactly as it was', async () => {
    aiEnabled = true;
    await openPanel();
    provider.showPullRequest(prView());
    panel.webview.postMessage.resetHistory();

    provider.setProviderFactoryForTesting((() => ({ run: sinon.stub().rejects(new Error('the CLI refused the file')) })) as any);
    await assert.rejects(() => provider.generateWorkflow('claude-code'), /refused/);
    assert.deepStrictEqual([provider.activePullRequest(), provider.getScope().source, panel.title], [69, 'pr', 'PR #69 · a change']);
    assert.strictEqual(posted('pr-view').length, 0, 'nothing told the webview to leave');

    provider.setProviderFactoryForTesting((() => ({ run: sinon.stub().resolves({ graph: workflowGraph(), text: 'ok', sessionId: 's' }) })) as any);
    await provider.generateWorkflow('claude-code');
    assert.deepStrictEqual(types('pr-view', 'graph'), ['pr-view', 'graph']);
    assert.deepStrictEqual([provider.activePullRequest(), provider.getScope().source, panel.title], [null, 'none', 'Workflow']);
  });

  test('without a workspace nothing is half-opened', () => {
    sandbox.stub(vscode.window, 'showErrorMessage').resolves(undefined);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
    assert.strictEqual(provider.showPullRequest(prView()), false);
    assert.deepStrictEqual([provider.activePullRequest(), provider.getScope()], [null, NO_SCOPE]);
  });
});

suite('GraphProvider — a read-only provider on another root (the PR head panel)', () => {
  let sandbox: sinon.SinonSandbox;
  let workspace: string;
  let headDir: string;
  let panel: ReturnType<typeof makeFakePanel>;
  let provider: GraphProvider;
  let info: sinon.SinonStub;
  let onSave: sinon.SinonStub;
  let watcher: sinon.SinonStub;
  const posted = (type?: string) => panel.webview.postMessage.getCalls().map((c: any) => c.args[0]).filter((m: any) => !type || m.type === type);
  const onMessage = () => panel.webview.onDidReceiveMessage.firstCall.args[0];

  setup(() => {
    sandbox = sinon.createSandbox();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-ro-ws-'));
    headDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-ro-head-'));
    fs.mkdirSync(path.join(workspace, 'src')); fs.writeFileSync(path.join(workspace, 'src', 'ws.ts'), 'export function ws() {}\n');
    fs.mkdirSync(path.join(headDir, 'src')); fs.writeFileSync(path.join(headDir, 'src', 'head.ts'), 'export function head() {}\n');
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: workspace } }]);
    sandbox.stub(rawCp, 'execFileSync').returns('');
    sandbox.stub(rawCp, 'spawn');
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((() => ({
      get: (_k: string, d?: unknown) => d, has: () => false, inspect: () => undefined, update: async () => undefined,
    })) as unknown as typeof vscode.workspace.getConfiguration);
    info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    onSave = sandbox.stub(vscode.workspace, 'onDidSaveTextDocument').returns({ dispose: () => undefined } as any);
    watcher = sandbox.stub(vscode.workspace, 'createFileSystemWatcher').returns({ onDidChange: () => undefined, onDidCreate: () => undefined, dispose: () => undefined } as any);
    panel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
    const ctx = { extensionPath: '/fake/ext', extensionUri: vscode.Uri.file('/fake/ext') } as unknown as vscode.ExtensionContext;
    // As extension.ts builds a head panel: a read-only root AND the read-only document scheme.
    provider = new GraphProvider(ctx, { root: headDir, readOnly: true, title: 'PR #7 · head abc1234', readOnlyUri: (file) => prDocumentUri(headDir, 'PR #7 · head abc1234', file) });
    const nodes = [{ id: 'n:head', name: 'head', file: path.join(headDir, 'src', 'head.ts'), line: 1 }];
    writeCache(headDir, { nodes, edges: [], files: nodes.map(n => n.file) } as any, scanStructure(headDir));
  });

  teardown(() => {
    panel._disposeCallback?.();
    sandbox.restore();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(headDir, { recursive: true, force: true });
  });

  test('it analyses its own root, not the workspace, and is titled by its tree', async () => {
    provider.show();
    onMessage()({ type: 'ready' });
    await waitFor(() => posted('graph').length > 0);
    assert.strictEqual((vscode.window.createWebviewPanel as sinon.SinonStub).firstCall.args[1], 'PR #7 · head abc1234');
    assert.strictEqual(posted('structure')[0].tree.root, path.join(headDir, 'src'));
    assert.deepStrictEqual(posted('graph')[0].data.nodes.map((n: any) => n.id), ['n:head']);
    assert.strictEqual(posted('subgraph')[0].root, headDir);
    assert.ok(fs.existsSync(path.join(headDir, '.cograph')), 'its cache lives under its own root');
    assert.ok(!fs.existsSync(path.join(workspace, '.cograph')), 'and never under the workspace');
  });

  test('nothing listens to workspace saves or the index, and every write is refused with a reason', async () => {
    provider.show();
    onMessage()({ type: 'ready' });
    await waitFor(() => posted('graph').length > 0);
    assert.ok(onSave.notCalled, 'no save listener');
    assert.ok(watcher.notCalled, 'no .git/index watcher');
    const askName = sandbox.stub(vscode.window, 'showInputBox').resolves('x');
    await onMessage()({ type: 'save-func-source', file: path.join(headDir, 'src', 'head.ts'), line: 1, newSource: 'export function head() { return 1; }', reqId: 5 });
    const reply = posted('func-source-saved')[0];
    assert.deepStrictEqual([reply.reqId, reply.ok], [5, false]);
    assert.ok(reply.reason.includes('copy of a commit'));
    assert.strictEqual(fs.readFileSync(path.join(headDir, 'src', 'head.ts'), 'utf8'), 'export function head() {}\n', 'untouched');
    await onMessage()({ type: 'request-new-file', folderPath: path.join(headDir, 'src') });
    await onMessage()({ type: 'request-rename-folder', folderPath: path.join(headDir, 'src') });
    await onMessage()({ type: 'save-graph', mode: 'save-as', payload: { settings: {}, nodePositions: {} } });
    assert.strictEqual(info.callCount, 3);
    assert.ok(askName.notCalled, 'never asked for a name');
    assert.deepStrictEqual(fs.readdirSync(path.join(headDir, 'src')), ['head.ts']);
  });

  test('navigate opens the copy\'s file as a read-only document of its own scheme, never the file on disk', async () => {
    const opened: vscode.Uri[] = [];
    sandbox.stub(vscode.workspace, 'openTextDocument').callsFake((async (u: vscode.Uri) => { opened.push(u); return { uri: u } as any; }) as any);
    sandbox.stub(vscode.window, 'showTextDocument').resolves({ selection: null, revealRange: () => undefined } as any);
    const ro = new GraphProvider({ extensionPath: '/fake/ext', extensionUri: vscode.Uri.file('/fake/ext') } as unknown as vscode.ExtensionContext,
      { root: headDir, readOnly: true, title: 'PR #7 · head abc1234', readOnlyUri: (file) => prDocumentUri(headDir, 'PR #7 · head abc1234', file) });
    ro.show();
    onMessage()({ type: 'ready' });
    await waitFor(() => posted('graph').length > 0);
    await onMessage()({ type: 'navigate', file: path.join(headDir, 'src', 'head.ts'), line: 1 });
    assert.strictEqual(opened.length, 1);
    const uri = opened[0];
    assert.strictEqual(uri.scheme, PR_DOCUMENT_SCHEME, 'not file:// — read-only by construction');
    assert.strictEqual(uri.path, '/PR #7 · head abc1234/src/head.ts', 'the tab\'s hover and description name the panel');
    assert.strictEqual(prDocumentFile(uri, [headDir]), path.join(headDir, 'src', 'head.ts'));
    assert.strictEqual(prDocumentFile(uri, [workspace]), null, 'a document is served only from under the registered roots');
    assert.strictEqual(prDocumentFile(vscode.Uri.parse(`${PR_DOCUMENT_SCHEME}:/x/y.ts?file=${encodeURIComponent(path.join(headDir, '..', 'escape.ts'))}`), [headDir]), null);
    const reg = registerPrDocuments([headDir]);
    reg.dispose();
    ro.close();
  });

  test('a panel that exists for one pull request closes on Leave instead of going back to anything', async () => {
    const ctx = { extensionPath: '/fake/ext', extensionUri: vscode.Uri.file('/fake/ext') } as unknown as vscode.ExtensionContext;
    const own = new GraphProvider(ctx, { root: headDir, readOnly: true, title: 'PR #7 · head abc1234', closeOnLeave: true });
    const changes: Array<number | null> = [];
    own.onPullRequestChange(n => changes.push(n));
    const view: PrGraphView = {
      number: 7, name: 'PR #7 · head abc1234', spec: { include: ['.'], exclude: [] }, override: { files: new Map(), hunks: new Map() },
      message: { type: 'pr-view', active: true, number: 7, name: 'PR #7 · head abc1234', title: 't', headRef: 'h', baseRef: 'main',
        tree: { kind: 'head', sha: 'abc1234' }, expand: [], fileGitStatus: {}, counts: { total: 0, inGraph: 0, exact: 0, fileLevel: 0, missing: 0, other: 0 } },
    };
    assert.strictEqual(own.showPullRequest(view), true);
    onMessage()({ type: 'ready' });
    await waitFor(() => posted('graph').length > 0);
    assert.deepStrictEqual([own.activePullRequest(), changes], [7, [7]]);
    onMessage()({ type: 'subgraph-exit' }); // the banner's Leave
    assert.ok(panel.dispose.calledOnce, 'the panel is closed');
    panel._disposeCallback();                // what VS Code does next
    assert.deepStrictEqual([own.isOpen(), own.activePullRequest(), changes], [false, null, [7, null]]);
  });

  test('a read-only panel on the WORKSPACE (the checkout view) refuses with a sentence that does not call it a copy', async () => {
    const ctx = { extensionPath: '/fake/ext', extensionUri: vscode.Uri.file('/fake/ext') } as unknown as vscode.ExtensionContext;
    const nodes = [{ id: 'n:ws', name: 'ws', file: path.join(workspace, 'src', 'ws.ts'), line: 1 }];
    writeCache(workspace, { nodes, edges: [], files: nodes.map(n => n.file) } as any, scanStructure(workspace));
    const co = new GraphProvider(ctx, { root: workspace, readOnly: true, title: 'PR #7 · your checkout', closeOnLeave: true });
    co.show();
    onMessage()({ type: 'ready' });
    await waitFor(() => posted('graph').length > 0);
    await onMessage()({ type: 'save-func-source', file: path.join(workspace, 'src', 'ws.ts'), line: 1, newSource: 'x', reqId: 1 });
    const reason: string = posted('func-source-saved')[0].reason;
    assert.ok(reason.includes('pull-request view') && reason.includes('double-click'), reason);
    assert.ok(!reason.includes('copy of a commit'), 'the checkout is not a copy');
    const opened: unknown[] = [];
    sandbox.stub(vscode.workspace, 'openTextDocument').callsFake((async (u: unknown) => { opened.push(u); return { uri: u } as any; }) as any);
    sandbox.stub(vscode.window, 'showTextDocument').resolves({ selection: null, revealRange: () => undefined } as any);
    await onMessage()({ type: 'navigate', file: path.join(workspace, 'src', 'ws.ts'), line: 1 });
    assert.strictEqual(opened[0], path.join(workspace, 'src', 'ws.ts'), 'without a labelled scheme: the file itself');
    // As extension.ts builds it: the checkout panel labels what it opens as the checkout's, not the PR's.
    const labelled = new GraphProvider(ctx, { root: workspace, readOnly: true, title: 'PR #7 · your checkout', closeOnLeave: true,
      readOnlyUri: (file) => prDocumentUri(workspace, 'your checkout · main (not PR #7)', file) });
    labelled.show();
    const second = panel.webview.onDidReceiveMessage.lastCall.args[0];
    second({ type: 'ready' });
    await waitFor(() => opened.length >= 1 && posted('graph').length >= 2);
    await second({ type: 'navigate', file: path.join(workspace, 'src', 'ws.ts'), line: 1 });
    const u = opened[opened.length - 1] as vscode.Uri;
    assert.deepStrictEqual([u.scheme, u.path], [PR_DOCUMENT_SCHEME, '/your checkout · main (not PR #7)/src/ws.ts']);
    assert.strictEqual(prDocumentFile(u, [workspace]), path.join(workspace, 'src', 'ws.ts'));
    labelled.close();
  });

  test('leaving a scope goes back to the tree\'s title, not "CoGraph"; close() disposes the panel', async () => {
    provider.show();
    onMessage()({ type: 'ready' });
    await waitFor(() => posted('graph').length > 0);
    provider.showScoped(specForFolder('src'));
    assert.strictEqual(panel.title, 'src · scoped');
    onMessage()({ type: 'subgraph-exit' });
    assert.strictEqual(panel.title, 'PR #7 · head abc1234');
    provider.close();
    assert.ok(panel.dispose.calledOnce);
  });
});

suite('SidebarProvider — Version Control pane', () => {
  function resolve(vcs: Partial<VcsSidebar> | null) {
    const listeners: Array<(m: any) => Promise<void>> = [];
    const webview: any = {
      options: {}, html: '', cspSource: 'x',
      asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: sinon.stub().resolves(true),
      onDidReceiveMessage: (cb: any) => { listeners.push(cb); return { dispose: () => undefined }; },
    };
    let dispose: () => void = () => undefined;
    const view: any = { webview, onDidDispose: (cb: () => void) => { dispose = cb; return { dispose: () => undefined }; } };
    const controller: any = { show: sinon.stub(), isOpen: () => false, reloadLayout: sinon.stub(), loadGraph: sinon.stub(), openTimeline: sinon.stub() };
    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, null, vcs as VcsSidebar | null);
    provider.resolveWebviewView(view, {} as any, {} as any);
    return { webview, controller, send: (m: any) => listeners[0](m), dispose: () => dispose() };
  }

  test('with the pane: its script is loaded after the inline one, with the nonce; the slot stays in the markup', () => {
    const attach = sinon.stub();
    const { webview } = resolve({ attach, handle: async () => false });
    const html: string = webview.html;
    const tag = /<script nonce="([0-9a-f]+)" src="[^"]*sidebar-vcs\.js"><\/script>/.exec(html);
    assert.ok(tag, 'script tag present');
    assert.ok(html.includes(`script-src 'nonce-${tag![1]}'`), 'same nonce as the CSP');
    assert.ok(html.indexOf(tag![0]) > html.indexOf("vscode.postMessage({ type: 'ready' })"));
    assert.ok(html.includes('id="pane-primary" hidden'));
    assert.strictEqual(typeof attach.firstCall.args[0], 'function');
  });

  test('without it the sidebar is exactly as before', () => {
    const { webview } = resolve(null);
    assert.ok(!/<script[^>]*sidebar-vcs\.js/.test(webview.html));
  });

  test('vcs-* messages go to the pane and nowhere else; the rest reach the sidebar; dispose detaches', async () => {
    const attach = sinon.stub();
    const handle = sinon.stub().callsFake(async (m: any) => String(m.type).startsWith('vcs-'));
    const { controller, send, dispose } = resolve({ attach, handle });
    await send({ type: 'vcs-refresh' });
    assert.ok(controller.show.notCalled);
    await send({ type: 'new-graph' });
    assert.ok(controller.show.calledOnce, 'an ordinary message still reaches the sidebar');
    dispose();
    assert.strictEqual(attach.lastCall.args[0], null);
  });
});
