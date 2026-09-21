import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { GraphProvider } from '../../graphProvider';
import { scanStructure } from '../../structureScanner';
import { writeCache } from '../../cacheStore';
import { annotationsPath } from '../../graphIntelligence/annotationStore';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawCp = require('child_process');

// Helpers mirror graphProviderWorkflow.test.ts.

function makeFakeContext(extensionPath = '/fake/ext'): vscode.ExtensionContext {
  return { extensionPath, extensionUri: vscode.Uri.file(extensionPath) } as unknown as vscode.ExtensionContext;
}

function makeFakePanel() {
  const webview = {
    html: '',
    cspSource: 'vscode-resource:',
    onDidReceiveMessage: sinon.stub().returns({ dispose: () => undefined }),
    postMessage: sinon.stub().resolves(true),
    asWebviewUri: sinon.stub().callsFake((uri: vscode.Uri) => uri),
  };
  const panel = {
    title: '',
    webview,
    reveal: sinon.stub(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onDidDispose: sinon.stub().callsFake((cb: () => void) => { (panel as any)._disposeCallback = cb; return { dispose: () => undefined }; }),
    dispose: sinon.stub(),
  };
  return panel;
}

function stubAiConfig(sandbox: sinon.SinonSandbox, enabled: boolean): void {
  sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((() => ({
    get: (key: string, dflt?: unknown) => (key === 'graphIntelligence.enabled' ? enabled : dflt),
    has: () => false,
    inspect: () => undefined,
    update: async () => undefined,
  })) as unknown as typeof vscode.workspace.getConfiguration);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) { throw new Error('waitFor timed out'); }
    await new Promise(r => setTimeout(r, 25));
  }
}

function pathsIn(prompt: string): string[] {
  return prompt.split('\n').filter(l => l.startsWith('### ')).map(l => l.slice(4).replace(/ \(.*$/, ''));
}

suite('GraphProvider — Annotate Graph', () => {
  let sandbox: sinon.SinonSandbox;
  let tmp: string | undefined;
  let fakePanel: ReturnType<typeof makeFakePanel> | undefined;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fakePanel as any)?._disposeCallback?.();
    fakePanel = undefined;
    sandbox.restore();
    if (tmp) { fs.rmSync(tmp, { recursive: true, force: true }); tmp = undefined; }
  });

  async function openGraph(enabled: boolean) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-annotate-'));
    fs.mkdirSync(path.join(tmp, 'src'));
    const file = path.join(tmp, 'src', 'a.ts');
    fs.writeFileSync(file, '// Adds numbers.\nexport function add(a: number, b: number) { return a + b; }\n');
    writeCache(tmp, {
      nodes: [{ id: 'add', name: 'add', file, line: 2 }], edges: [], files: [file],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, scanStructure(tmp));

    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmp } }]);
    sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));
    sandbox.stub(rawCp, 'spawn');
    fakePanel = makeFakePanel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
    stubAiConfig(sandbox, enabled);

    const provider = new GraphProvider(makeFakeContext());
    provider.show();
    await waitFor(() => fakePanel!.webview.postMessage.getCalls().some(c => c.args[0]?.type === 'graph'));
    return { provider, panel: fakePanel, root: tmp };
  }

  function annotationPosts(panel: ReturnType<typeof makeFakePanel>) {
    return panel.webview.postMessage.getCalls().map(c => c.args[0]).filter(m => m?.type === 'annotations');
  }

  test('host gate: AI disabled → rejects before the provider factory or a panel is touched', async () => {
    stubAiConfig(sandbox, false);
    const create = sandbox.stub(vscode.window, 'createWebviewPanel');
    const provider = new GraphProvider(makeFakeContext());
    provider.setProviderFactoryForTesting(() => { throw new Error('factory must not run while AI is disabled'); });
    await assert.rejects(() => provider.annotateGraph('claude-code'), /AI features are off/);
    assert.ok(create.notCalled);
  });

  test('get-annotations from the webview is answered, even with AI off and nothing generated', async () => {
    const { panel, root } = await openGraph(false);
    const onMessage = panel.webview.onDidReceiveMessage.firstCall.args[0];
    await onMessage({ type: 'get-annotations' });
    const msgs = annotationPosts(panel);
    assert.strictEqual(msgs.length, 1);
    assert.deepStrictEqual(msgs[0], { type: 'annotations', root, aiEnabled: false, files: {}, folders: {}, stale: [] });
  });

  test('confirmed run: digest goes to runJson, summaries reach the webview and the store', async () => {
    const { provider, panel, root } = await openGraph(true);
    const confirm = sandbox.stub(vscode.window, 'showInformationMessage').resolves('Annotate' as unknown as vscode.MessageItem);
    const runJson = sinon.stub().callsFake(async (req: { prompt: string }) => ({
      data: { summaries: pathsIn(req.prompt).map(p => ({ path: p, summary: `Summary of ${p}.` })) },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider.setProviderFactoryForTesting((() => ({ id: 'claude-code', displayName: 'Claude Code', runJson })) as any);

    const res = await provider.annotateGraph('claude-code');

    assert.strictEqual(res?.filesDone, 1);
    assert.ok(confirm.calledOnce);
    assert.deepStrictEqual(confirm.firstCall.args[1], { modal: true });
    const filePrompt: string = runJson.firstCall.args[0].prompt;
    assert.ok(filePrompt.includes('### src/a.ts') && filePrompt.includes('export function add(a: number, b: number)'));
    assert.ok(!filePrompt.includes('return a + b'), 'function bodies never leave the machine in digest mode');
    const last = annotationPosts(panel).pop();
    assert.strictEqual(last.files['src/a.ts'].summary, 'Summary of src/a.ts.');
    assert.strictEqual(last.folders['src'].summary, 'Summary of src.');
    assert.ok(fs.existsSync(annotationsPath(root)));
    assert.strictEqual(provider.annotationStatus().annotated, 2);
  });

  test('declined estimate: runJson is never called', async () => {
    const { provider } = await openGraph(true);
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    const runJson = sinon.stub();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provider.setProviderFactoryForTesting((() => ({ id: 'claude-code', displayName: 'Claude Code', runJson })) as any);
    assert.strictEqual(await provider.annotateGraph('claude-code'), null);
    assert.ok(runJson.notCalled);
  });

  test('isAnalyzing: false once a valid cache has painted the complete graph', async () => {
    const { provider } = await openGraph(false);
    assert.strictEqual(provider.isAnalyzing, false);
  });

  test('isAnalyzing: true while the first full pass runs, false again when the panel closes', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-annotate-'));
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export function a() {}\n'); // no cache → analyzer starts
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmp } }]);
    sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));
    sandbox.stub(rawCp, 'spawn').callsFake(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = new EventEmitter() as any; // never exits: the analysis stays "running"
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = sinon.stub();
      return proc;
    });
    fakePanel = makeFakePanel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
    stubAiConfig(sandbox, true);

    const provider = new GraphProvider(makeFakeContext());
    provider.show();
    assert.strictEqual(provider.isAnalyzing, true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fakePanel as any)._disposeCallback();
    assert.strictEqual(provider.isAnalyzing, false, 'a closed panel must release anyone waiting for the analysis');
  });

  test('status listeners are notified and can be disposed', async () => {
    const { provider, panel } = await openGraph(false);
    const seen: number[] = [];
    const sub = provider.onAnnotationStatus(s => seen.push(s.totalFiles));
    provider.refreshAnnotations();
    sub.dispose();
    provider.refreshAnnotations();
    assert.deepStrictEqual(seen, [1]);
    assert.strictEqual(annotationPosts(panel).length, 2);
  });
});
