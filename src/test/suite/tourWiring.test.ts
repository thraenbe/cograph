import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

/* eslint-disable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../../../package.json');

suite('tour — contributions in the real extension host', () => {
  let sandbox: sinon.SinonSandbox;
  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => sandbox.restore());

  test('every cograph.tour.* setting reads back its declared default (no key is the prefix of another)', () => {
    const props = pkg.contributes.configuration.properties as Record<string, { default: unknown }>;
    const keys = Object.keys(props).filter(k => k.startsWith('cograph.tour.'));
    assert.deepStrictEqual(keys.sort(), [
      'cograph.tour.ai.maxBudgetUsd', 'cograph.tour.ai.mode', 'cograph.tour.ai.model', 'cograph.tour.ai.readSource',
      'cograph.tour.autoplay', 'cograph.tour.autoplaySeconds', 'cograph.tour.button', 'cograph.tour.chapters',
      'cograph.tour.maxStepsPerChapter', 'cograph.tour.security.allow', 'cograph.tour.security.blockCreateOnHigh', 'cograph.tour.security.rules',
    ]);
    for (const k of keys) {
      // A key that is also the prefix of another reads as its default object, and the deeper key reads null.
      assert.deepStrictEqual(vscode.workspace.getConfiguration().get(k), props[k].default, k);
      assert.ok(!keys.some(o => o !== k && o.startsWith(k + '.')), `${k} is the prefix of another key`);
    }
    assert.deepStrictEqual(props['cograph.tour.chapters'].default, ['overview', 'map', 'changes', 'blastRadius', 'removed', 'tests', 'security', 'description']);
  });

  test('the tour commands are contributed and activate the extension', () => {
    const commands = (pkg.contributes.commands as Array<{ command: string; title: string }>).filter(c => c.command.startsWith('cograph.tour'));
    assert.deepStrictEqual(commands.map(c => c.command), ['cograph.tourPullRequest', 'cograph.tourBranch']);
    for (const c of commands) { assert.ok(pkg.activationEvents.includes(`onCommand:${c.command}`), c.command); }
  });

  test('in the public build, Tour your branch says the stub sentence and opens nothing', async () => {
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined as any);
    const progress = sandbox.spy(vscode.window, 'withProgress');
    await vscode.commands.executeCommand('cograph.tourBranch');
    assert.ok(info.calledWith('CoGraph: The PR tour is part of the Marketplace build of CoGraph.'), JSON.stringify(info.args));
    assert.strictEqual(progress.callCount, 0);
  });
});
