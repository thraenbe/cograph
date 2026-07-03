import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { activate, deactivate } from '../../extension';
import { SidebarProvider } from '../../sidebarProvider';

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
