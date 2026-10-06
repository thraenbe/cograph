import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphProvider } from '../../graphProvider';
import { scanStructure } from '../../structureScanner';
import { writeCache } from '../../cacheStore';
import { buildWorkflowPrompt } from '../../graphIntelligence/workflowPrompt';

// Use require() so sinon can stub the underlying CJS module properties.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawCp = require('child_process');

// ---------------------------------------------------------------------------
// Helpers (mirrors graphProvider.test.ts patterns)
// ---------------------------------------------------------------------------

function makeFakeContext(extensionPath = '/fake/ext'): vscode.ExtensionContext {
  return {
    extensionPath,
    extensionUri: vscode.Uri.file(extensionPath),
  } as unknown as vscode.ExtensionContext;
}

function makeFakePanel() {
  const webview = {
    html: '',
    cspSource: 'vscode-resource:',
    onDidReceiveMessage: sinon.stub().returns({ dispose: () => {} }),
    postMessage: sinon.stub().resolves(true),
    asWebviewUri: sinon.stub().callsFake((uri: vscode.Uri) => uri),
  };
  const panel = {
    title: '',
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

/** Run GraphProvider's onDidDispose handler, as VS Code does when the panel
 *  closes — releases the save listener, file watcher, and any pending timers
 *  so no delayed work leaks into later tests. */
function disposePanel(fakePanel: ReturnType<typeof makeFakePanel>): void {
  (fakePanel as any)._disposeCallback?.();
}

/** Stub getConfiguration: graphIntelligence.enabled → `enabled`, all else → default. */
function stubAiConfig(sandbox: sinon.SinonSandbox, enabled: boolean): void {
  sandbox.stub(vscode.workspace, 'getConfiguration').callsFake(((..._args: unknown[]) => ({
    get: (key: string, dflt?: unknown) =>
      key === 'graphIntelligence.enabled' ? enabled : dflt,
    has: () => false,
    inspect: () => undefined,
    update: async () => {},
  })) as unknown as typeof vscode.workspace.getConfiguration);
}

/** Poll until `predicate` is truthy (test-host safe; index.ts timeout is 10 s). */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) { throw new Error('waitFor timed out'); }
    await new Promise(r => setTimeout(r, 25));
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('GraphProvider.generateWorkflow (AI gate + provider path)', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  test('AI disabled → throws before invoking the provider factory', async () => {
    stubAiConfig(sandbox, false);
    const provider = new GraphProvider(makeFakeContext());
    provider.setProviderFactoryForTesting(() => {
      throw new Error('factory must not run while AI features are disabled');
    });

    await assert.rejects(() => provider.generateWorkflow('claude-code'), /AI features are off/);
  });

  /** Shared enabled-path setup: tmp workspace with a valid cache so show()
   *  seeds cachedGraph synchronously and waitForGraphReady resolves instantly. */
  async function setupEnabled() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-workflow-'));
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export function a(){}');
    const structure = scanStructure(tmp);
    const cachedFile = path.join(tmp, 'src', 'a.ts');
    writeCache(tmp, {
      nodes: [{ id: 'cached', name: 'a', file: cachedFile, line: 1 }],
      edges: [], files: [cachedFile],
    } as any, structure);

    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: tmp } }]);
    sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));
    sandbox.stub(rawCp, 'spawn');
    const fakePanel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(fakePanel as any);
    stubAiConfig(sandbox, true);

    const provider = new GraphProvider(makeFakeContext());
    provider.show();
    // Cache-valid path posts the graph and sets cachedGraph; wait for it.
    await waitFor(() => fakePanel.webview.postMessage.getCalls()
      .some(c => c.args[0]?.type === 'graph'));

    return { tmp, provider, fakePanel };
  }

  test('AI enabled → factory invoked, workflow graph posted as reanalysis, title set', async () => {
    const { tmp, provider, fakePanel } = await setupEnabled();
    try {
      const workflowGraph = {
        nodes: [{
          id: 'cached', name: 'a', file: path.join(tmp, 'src', 'a.ts'), line: 1,
          workflow: { stage: 0, tier: 'backend', cluster: 'core', clusterName: 'Core' },
        }],
        edges: [], files: [],
        workflow: { stageCount: 2, dividerStage: 0 },
      };
      const run = sinon.stub().resolves({ graph: workflowGraph, text: 'ok', sessionId: 's1' });
      const seenIds: string[] = [];
      provider.setProviderFactoryForTesting(((id: string) => {
        seenIds.push(id);
        return { run } as any;
      }) as any);

      const result = await provider.generateWorkflow('claude-code');

      assert.deepStrictEqual(seenIds, ['claude-code'], 'factory invoked once with the provider id');
      assert.strictEqual(run.firstCall.args[0].prompt, buildWorkflowPrompt(), 'workflow prompt passed');
      assert.strictEqual(run.firstCall.args[0].graph.nodes[0].id, 'cached', 'cached graph passed to provider');

      const posted = fakePanel.webview.postMessage.getCalls()
        .map(c => c.args[0])
        .find(m => m?.type === 'graph' && m.isReanalysis === true && m.data?.workflow);
      assert.ok(posted, 'normalized workflow graph posted as a reanalysis render');
      assert.ok(Array.isArray(posted.data.workflow.clusters), 'workflow payload carries a clusters array');
      assert.strictEqual((fakePanel as any).title, 'Workflow', 'panel title set');
      assert.ok(Array.isArray(result.graph.workflow?.clusters), 'normalized graph returned to caller');
    } finally {
      disposePanel(fakePanel);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('provider rejection propagates to the caller', async () => {
    const { tmp, provider, fakePanel } = await setupEnabled();
    try {
      provider.setProviderFactoryForTesting((() => ({
        run: sinon.stub().rejects(new Error('boom')),
      })) as any);

      await assert.rejects(() => provider.generateWorkflow('claude-code'), /boom/);
    } finally {
      disposePanel(fakePanel);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
