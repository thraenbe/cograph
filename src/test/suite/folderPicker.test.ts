import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanStructure } from '../../structureScanner';
import { buildFolderItems, pickFolder } from '../../folderPicker';

suite('folderPicker', () => {
  let sandbox: sinon.SinonSandbox;
  let root: string;

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-pick-'));
    for (const rel of ['top.ts', 'src/a.ts', 'src/server/b.ts', 'src/server/c.ts', 'tools/d.ts']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), 'export const x = 1;\n');
    }
  });
  teardown(() => { sandbox.restore(); fs.rmSync(root, { recursive: true, force: true }); });

  test('items: shallow first then by path, relative labels, recursive file counts, root marked', () => {
    const items = buildFolderItems(scanStructure(root), root);
    assert.deepStrictEqual(items.map(i => i.rel), ['.', 'src', 'tools', 'src/server']);
    assert.deepStrictEqual(items.map(i => i.description), ['5 files', '3 files', '1 file', '2 files']);
    assert.strictEqual(items[0].label, '$(root-folder) .');
    assert.match(items[0].detail ?? '', /whole project/);
    assert.strictEqual(items[1].label, '$(folder) src');
    assert.strictEqual(items[1].detail, undefined);
  });

  test('pickFolder returns the chosen relative path, null on dismiss, and informs when the tree is empty', async () => {
    const qp = sandbox.stub(vscode.window, 'showQuickPick');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    qp.onFirstCall().callsFake((async (items: unknown) => (items as Array<{ rel: string }>)[3]) as any);
    assert.strictEqual(await pickFolder(scanStructure(root), root), 'src/server');
    assert.strictEqual(qp.firstCall.args[1]?.title, 'CoGraph: Only visualize folder');
    assert.strictEqual(qp.firstCall.args[1]?.matchOnDescription, true);
    qp.onSecondCall().resolves(undefined);
    assert.strictEqual(await pickFolder(scanStructure(root), root), null);
    const info = sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    assert.strictEqual(await pickFolder({ root: '', folders: {}, files: [], totalFiles: 0 }, root), null);
    assert.ok(info.calledOnce && qp.calledTwice, 'no picker for an empty tree');
  });
});
