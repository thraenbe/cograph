import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { TourAvailability } from '../../tour/tourAvailability';
import { NO_FOLDER_SENTENCE, NO_STORAGE_SENTENCE, TourRunner } from '../../tour/tourCommand';
import { registerTour } from '../../tour/tourWiring';
import { STUB_SENTENCE } from '../../tour/tourModule';

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

suite('tour — registerTour', () => {
  let sandbox: sinon.SinonSandbox;
  let extRoot: string;
  let commands: Map<string, () => unknown>;
  let pillClick: () => void;

  /** extRoot with or without a packaged tour; every effect faked but the wiring itself. */
  function wire(opts: { bundled?: boolean; storageDir?: string } = {}) {
    if (opts.bundled) {
      fs.mkdirSync(path.join(extRoot, 'dist', 'tour', 'host'), { recursive: true });
      fs.mkdirSync(path.join(extRoot, 'dist', 'tour', 'web'), { recursive: true });
      fs.writeFileSync(path.join(extRoot, 'dist', 'tour', 'host', 'index.js'), '');
    }
    return registerTour({
      context: { extensionPath: extRoot } as any,
      provider: { onTourStart: (l: () => void) => { pillClick = l; return { dispose: () => undefined }; }, postToViews: () => undefined } as any,
      prController: { list: async () => ({ ok: true, pullRequests: [] }) } as any,
      vcsSidebar: { onLoaded: () => ({ dispose: () => undefined }), loadedPullRequests: () => [] } as any,
      channel: { appendLine: () => undefined } as any,
      storageDir: opts.storageDir,
    });
  }

  setup(() => {
    sandbox = sinon.createSandbox();
    extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wiring-'));
    commands = new Map();
    sandbox.stub(vscode.commands, 'registerCommand').callsFake(((id: string, cb: () => unknown) => { commands.set(id, cb); return { dispose: () => undefined }; }) as any);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
  });
  teardown(() => {
    sandbox.restore();
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  const branchPill = { type: 'tour-availability', state: 'branch', branch: 'feat', baseRef: 'master', label: 'feat vs master · 3 commits · 1 file', counts: { commits: 3, files: 1 } } as const;

  test('REGRESSION: the pill, the command and the picker all tour against the base the pill names', async () => {
    const run = sandbox.stub(TourRunner.prototype, 'run').resolves('opened');
    sandbox.stub(TourAvailability.prototype, 'current').returns(branchPill);
    sandbox.stub(vscode.window, 'showQuickPick').callsFake((async (items: any[]) => items[0]) as any);
    wire();
    pillClick();
    await commands.get('cograph.tourBranch')?.();
    await commands.get('cograph.tourPullRequest')?.();
    for (const call of run.getCalls()) { assert.deepStrictEqual(call.args[0], { kind: 'branch', branch: 'feat', baseRef: 'master' }); }
    assert.strictEqual(run.callCount, 3);
  });

  test('a pill on a pull request still tours the pull request', () => {
    const run = sandbox.stub(TourRunner.prototype, 'run').resolves('opened');
    sandbox.stub(TourAvailability.prototype, 'current').returns({ type: 'tour-availability', state: 'pr', number: 7, branch: 'feat', baseRef: 'main' });
    wire();
    pillClick();
    assert.deepStrictEqual(run.firstCall.args[0], { kind: 'pr', number: 7 });
  });

  test('REGRESSION: with the package but no folder, the tour says so, not that it is missing from this build', async () => {
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined as any);
    wire({ bundled: true, storageDir: extRoot });
    await commands.get('cograph.tourBranch')?.();
    assert.deepStrictEqual(info.args, [[`CoGraph: ${NO_FOLDER_SENTENCE}`]]);
  });

  test('REGRESSION: with the package and a folder but no storage, the same', async () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: extRoot } }];
    sandbox.stub(vscode.workspace, 'createFileSystemWatcher').returns({ onDidChange: () => ({ dispose: () => undefined }), onDidCreate: () => ({ dispose: () => undefined }), onDidDelete: () => ({ dispose: () => undefined }), dispose: () => undefined } as any);
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined as any);
    wire({ bundled: true });
    await commands.get('cograph.tourBranch')?.();
    assert.deepStrictEqual(info.args, [[`CoGraph: ${NO_STORAGE_SENTENCE}`]]);
  });

  test('without the package the stub sentence stands, folder or not', async () => {
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined as any);
    wire();
    await commands.get('cograph.tourBranch')?.();
    assert.deepStrictEqual(info.args, [[`CoGraph: ${STUB_SENTENCE}`]]);
  });
});
