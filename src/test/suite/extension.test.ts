import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../extension';
import { SidebarProvider } from '../../sidebarProvider';
import { GraphProvider } from '../../graphProvider';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Suite: extension activation wiring (commands, sidebar view, config listener)
// ---------------------------------------------------------------------------

suite('extension activate()', () => {
  let sandbox: sinon.SinonSandbox;
  let registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  let registeredViews: Map<string, vscode.WebviewViewProvider>;
  let configListeners: Array<(e: vscode.ConfigurationChangeEvent) => void>;
  let context: vscode.ExtensionContext;

  setup(() => {
    sandbox = sinon.createSandbox();
    registeredCommands = new Map();
    registeredViews = new Map();
    configListeners = [];

    sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
    sandbox.stub(vscode.commands, 'registerCommand').callsFake((id, cb) => {
      registeredCommands.set(id, cb);
      return { dispose: () => {} };
    });
    sandbox.stub(vscode.window, 'registerWebviewViewProvider').callsFake((viewType, provider) => {
      registeredViews.set(viewType, provider);
      return { dispose: () => {} };
    });
    sandbox.stub(vscode.workspace, 'onDidChangeConfiguration').callsFake(((
      listener: (e: vscode.ConfigurationChangeEvent) => void,
    ) => {
      configListeners.push(listener);
      return { dispose: () => {} };
    }) as unknown as typeof vscode.workspace.onDidChangeConfiguration);

    context = {
      subscriptions: [],
      extensionPath: '/fake/ext',
      extensionUri: vscode.Uri.file('/fake/ext'),
      workspaceState: { get: () => undefined, update: async () => {} },
    } as unknown as vscode.ExtensionContext;
  });

  teardown(() => {
    sandbox.restore();
  });

  test('registers exactly the commands declared in package.json', () => {
    activate(context);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../../../package.json');
    const declared = (pkg.contributes.commands as Array<{ command: string }>)
      .map(c => c.command).sort();
    assert.deepStrictEqual([...registeredCommands.keys()].sort(), declared);
  });

  test('cograph.visualizeFolder: the picked folder opens the panel scoped to it; dismissing does nothing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-cmd-'));
    fs.mkdirSync(path.join(tmp, 'src', 'server'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'server', 'a.ts'), 'export const a = 1;\n');
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: tmp } }];
    const showScoped = sandbox.stub(GraphProvider.prototype, 'showScoped');
    const qp = sandbox.stub(vscode.window, 'showQuickPick');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    qp.onFirstCall().callsFake((async (items: unknown) => (items as Array<{ rel: string }>).find(i => i.rel === 'src/server')) as any);
    qp.onSecondCall().resolves(undefined);
    try {
      activate(context);
      await registeredCommands.get('cograph.visualizeFolder')!();
      assert.ok(showScoped.calledOnce);
      assert.deepStrictEqual(showScoped.firstCall.args, [{ include: ['src/server'], exclude: [] }, 'folder']);
      await registeredCommands.get('cograph.visualizeFolder')!();
      assert.ok(showScoped.calledOnce, 'dismissed picker opens nothing');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('registers the sidebar webview view provider under its viewType', () => {
    activate(context);
    const provider = registeredViews.get(SidebarProvider.viewType);
    assert.ok(provider, 'view provider registered');
    assert.ok(provider instanceof SidebarProvider, 'provider is a SidebarProvider');
  });

  test('config listener: graphIntelligence.enabled change → refreshAiEnabled', () => {
    const spy = sandbox.spy(SidebarProvider.prototype, 'refreshAiEnabled');
    activate(context);
    assert.strictEqual(configListeners.length, 1, 'one config listener registered');

    configListeners[0]({
      affectsConfiguration: (k: string) => k === 'cograph.graphIntelligence.enabled',
    } as vscode.ConfigurationChangeEvent);

    assert.ok(spy.calledOnce, 'refreshAiEnabled re-pushes the gate state');
  });

  test('config listener ignores unrelated configuration changes', () => {
    const spy = sandbox.spy(SidebarProvider.prototype, 'refreshAiEnabled');
    activate(context);

    configListeners[0]({
      affectsConfiguration: () => false,
    } as unknown as vscode.ConfigurationChangeEvent);

    assert.ok(spy.notCalled, 'unrelated keys do not trigger a refresh');
  });

  test('all registrations are pushed onto context.subscriptions', () => {
    activate(context);
    // View provider + 4 commands + config listener.
    assert.ok(context.subscriptions.length >= 6,
      `expected >= 6 subscriptions, got ${context.subscriptions.length}`);
  });

  test('deactivate is a no-op (does not throw)', () => {
    assert.doesNotThrow(() => deactivate());
  });
});
