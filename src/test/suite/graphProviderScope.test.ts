import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphProvider } from '../../graphProvider';
import { scanStructure } from '../../structureScanner';
import { writeCache } from '../../cacheStore';
import { NO_SCOPE, specForFolder } from '../../subgraphScope';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawCp = require('child_process');

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeFakeContext(): vscode.ExtensionContext {
  return { extensionPath: '/fake/ext', extensionUri: vscode.Uri.file('/fake/ext') } as unknown as vscode.ExtensionContext;
}

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

const FILES = ['src/main.ts', 'src/server/api.ts', 'src/server/db/q.ts', 'src/ui/view.ts', 'tools/gen.ts'];

suite('GraphProvider — subgraph scope', () => {
  let sandbox: sinon.SinonSandbox;
  let root: string;
  let panel: ReturnType<typeof makeFakePanel>;
  let provider: GraphProvider;
  let spawn: sinon.SinonStub;

  const abs = (rel: string) => path.join(root, ...rel.split('/'));
  const posted = (type?: string) => panel.webview.postMessage.getCalls().map((c: any) => c.args[0]).filter((m: any) => !type || m.type === type);
  const onMessage = () => panel.webview.onDidReceiveMessage.firstCall.args[0];

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-scope-host-'));
    for (const rel of FILES) {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), `export function f_${rel.replace(/\W/g, '_')}() {}\n`);
    }
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: { fsPath: root } }]);
    sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));
    spawn = sandbox.stub(rawCp, 'spawn');
    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((() => ({
      get: (_k: string, d?: unknown) => d, has: () => false, inspect: () => undefined, update: async () => undefined,
    })) as unknown as typeof vscode.workspace.getConfiguration);
    panel = makeFakePanel();
    sandbox.stub(vscode.window, 'createWebviewPanel').returns(panel);
    provider = new GraphProvider(makeFakeContext());
  });

  teardown(() => {
    panel._disposeCallback?.();
    sandbox.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A valid cache for every file except `uncached`, so show() paints without spawning. */
  function writeFullCache(uncached: string[] = []) {
    const nodes = FILES.filter(r => !uncached.includes(r)).map(rel => ({ id: `n:${rel}`, name: 'f', file: abs(rel), line: 1 }));
    const lib = { id: 'lib', name: 'axios', file: null, line: 0, isLibrary: true, libraryName: 'axios' };
    const edges = [
      { source: 'n:src/main.ts', target: 'n:src/server/api.ts' },
      { source: 'n:src/server/api.ts', target: 'n:src/server/db/q.ts' },
      { source: 'n:src/ui/view.ts', target: 'lib', isLibraryEdge: true },
    ].filter(e => nodes.some(n => n.id === e.source) && (e.target === 'lib' || nodes.some(n => n.id === e.target)));
    writeCache(root, { nodes: [...nodes, lib], edges, files: nodes.map(n => n.file) } as any, scanStructure(root));
  }

  async function open(scoped?: () => void) {
    writeFullCache();
    if (scoped) { scoped(); } else { provider.show(); }
    onMessage()({ type: 'ready' }); // before the 150 ms fallback, so nothing is delivered twice
    await waitFor(() => posted('graph').length > 0);
  }

  test('an unscoped open posts subgraph {include:[]} first, then structure, then the full graph', async () => {
    await open();
    const types = posted().map((m: any) => m.type).filter((t: string) => ['subgraph', 'structure', 'graph'].includes(t));
    assert.deepStrictEqual(types, ['subgraph', 'structure', 'graph']);
    assert.deepStrictEqual(posted('subgraph')[0], { type: 'subgraph', name: null, root, include: [], exclude: [], __seq: 1 });
    assert.strictEqual(posted('graph')[0].data.nodes.length, 6);
    assert.strictEqual(provider.getScope(), NO_SCOPE);
  });

  test('showScoped on a closed panel: the first graph is already scoped, structure stays full', async () => {
    await open(() => provider.showScoped(specForFolder('src/server')));
    const sg = posted('subgraph')[0];
    assert.deepStrictEqual([sg.include, sg.exclude, sg.name], [['src/server'], [], null]);
    const g = posted('graph')[0].data;
    assert.deepStrictEqual(g.nodes.map((n: any) => n.id).sort(), ['n:src/server/api.ts', 'n:src/server/db/q.ts']);
    assert.strictEqual(g.edges.length, 1, 'the edge from main.ts (out of scope) is gone');
    assert.strictEqual(posted('structure')[0].tree.totalFiles, 5, 'full tree');
    assert.strictEqual(panel.title, 'server · scoped');
    assert.strictEqual(provider.getScope().source, 'folder');
  });

  test('subgraph-exclude prunes via replacedFiles and marks dirty; subgraph-include brings cached nodes back without spawning', async () => {
    await open(() => provider.showScoped({ include: ['src'], exclude: [] }));
    const n0 = posted().length;
    await onMessage()({ type: 'subgraph-exclude', path: 'src/ui' });
    const after = posted().slice(n0);
    assert.deepStrictEqual(after[0].include, ['src']);
    assert.deepStrictEqual(after[0].exclude, ['src/ui'], 'carve-out kept in the model even though v1 UI never writes one');
    assert.deepStrictEqual(after[1].type, 'graph-patch');
    assert.deepStrictEqual(after[1].patch, { nodes: [], edges: [] });
    assert.deepStrictEqual(after[1].replacedFiles, [abs('src/ui/view.ts')]);
    assert.ok(panel.title.startsWith('● '), 'dirty');

    const n1 = posted().length;
    await onMessage()({ type: 'subgraph-include', path: 'src/ui' });
    const back = posted().slice(n1);
    assert.deepStrictEqual(back[0].exclude, []);
    assert.strictEqual(back[1].type, 'graph-patch');
    assert.deepStrictEqual(back[1].patch.nodes.map((n: any) => n.id), ['n:src/ui/view.ts', 'lib'], 'cached nodes + referenced library');
    assert.ok(spawn.notCalled, 'no analyzer run for cached files');
  });

  test('including a folder the cache does not know runs the lazy parse for exactly those files', async () => {
    writeFullCache(['tools/gen.ts']);
    provider.showScoped(specForFolder('src/server'));
    onMessage()({ type: 'ready' });
    await waitFor(() => posted('graph').length > 0);
    const proc: any = { stdout: { on: sinon.stub() }, stderr: { on: sinon.stub() }, on: sinon.stub(), kill: sinon.stub(), pid: 1 };
    spawn.returns(proc);
    await onMessage()({ type: 'subgraph-include', path: 'tools' });
    assert.ok(spawn.called, 'analyzer spawned for the uncached folder');
    const listArg = spawn.getCalls().map((c: any) => c.args[1]).find((a: string[]) => a.includes('--files'));
    const listed = fs.readFileSync(listArg[listArg.indexOf('--files') + 1], 'utf8');
    assert.ok(listed.includes(abs('tools/gen.ts')) && !listed.includes(abs('src/ui/view.ts')), listed);
    assert.deepStrictEqual(posted('analysis-state').pop().parsingFolder, abs('tools'), 'absolute folder = the spinner row key');
  });

  test('expand-folder from the webview never parses files outside the scope', async () => {
    await open(() => provider.showScoped(specForFolder('src/server')));
    await onMessage()({ type: 'expand-folder', folderPath: abs('src/ui'), files: [abs('src/ui/view.ts')] });
    assert.ok(spawn.notCalled);
    await onMessage()({ type: 'parse-file', filePath: abs('tools/gen.ts') });
    assert.ok(spawn.notCalled);
  });

  test('subgraph-exit returns to the whole project: cached nodes come back, title resets, sidebar cleared', async () => {
    const sidebar = { setCurrentGraph: sinon.stub(), refresh: sinon.stub(), appendSystem: sinon.stub(), setChatOpen: sinon.stub() } as any;
    provider.setSidebarProvider(sidebar);
    await open(() => provider.showScoped(specForFolder('src/server')));
    assert.ok(sidebar.setCurrentGraph.calledWith(null), 'an unsaved scoped view clears the sidebar context');
    sidebar.setCurrentGraph.resetHistory();
    const n0 = posted().length;
    await onMessage()({ type: 'subgraph-exit' });
    const after = posted().slice(n0);
    assert.deepStrictEqual(after[0].include, []);
    assert.strictEqual(after[1].type, 'graph-patch');
    assert.deepStrictEqual(after[1].patch.nodes.map((n: any) => n.id).sort(), ['lib', 'n:src/main.ts', 'n:src/ui/view.ts', 'n:tools/gen.ts']);
    assert.strictEqual(panel.title, 'CoGraph');
    assert.ok(sidebar.setCurrentGraph.calledWith(null));
    assert.strictEqual(provider.getScope(), NO_SCOPE);
  });

  test('Save inside a scoped view writes the subgraph field, renames the scope and re-sends subgraph', async () => {
    await open(() => provider.showScoped(specForFolder('src/server')));
    sandbox.stub(vscode.window, 'showInputBox').resolves('backend');
    sandbox.stub(vscode.window, 'showInformationMessage').resolves(undefined);
    const n0 = posted().length;
    await onMessage()({ type: 'save-graph', mode: 'save', payload: { settings: {}, nodePositions: {}, subgraph: { include: ['bogus'] } } });
    const written = JSON.parse(fs.readFileSync(path.join(root, '.cograph', 'backend.json'), 'utf8'));
    assert.deepStrictEqual(written.subgraph, { include: ['src/server'], exclude: [] }, 'host state wins over the payload copy');
    assert.strictEqual(written.name, 'backend');
    const sg = posted().slice(n0).find((m: any) => m.type === 'subgraph');
    assert.deepStrictEqual([sg.name, sg.include], ['backend', ['src/server']]);
    assert.strictEqual(provider.getScope().source, 'subgraph');
    assert.strictEqual((vscode.window.showInputBox as any).firstCall.args[0].value, 'server', 'Save-As suggests the folder name');
  });

  test('loading a subgraph file scopes the open panel; loading a plain layout clears the scope', async () => {
    await open();
    const n0 = posted().length;
    await provider.loadGraph({ version: 2, name: 'backend', subgraph: { include: ['src/server'] }, settings: {}, nodePositions: {} }, path.join(root, 'x.json'));
    const after = posted().slice(n0);
    assert.deepStrictEqual([after[0].type, after[0].name, after[0].include], ['subgraph', 'backend', ['src/server']]);
    assert.strictEqual(after[1].type, 'graph-patch');
    assert.strictEqual(after[1].replacedFiles.length, 3, 'main, ui, tools leave');
    assert.strictEqual(after[after.length - 1].type, 'graph-loaded', 'graph-loaded comes last');

    const n1 = posted().length;
    await provider.loadGraph({ version: 2, name: 'plain', settings: {}, nodePositions: {} }, path.join(root, 'y.json'));
    const plain = posted().slice(n1);
    assert.deepStrictEqual([plain[0].type, plain[0].include], ['subgraph', []]);
    assert.strictEqual(provider.getScope(), NO_SCOPE);
  });

  test('git-update and reanalysis posts are scoped', async () => {
    await open(() => provider.showScoped(specForFolder('src/server')));
    sandbox.stub(provider as any, 'gitService').value({
      applyGitStatuses: () => true, applyGitStatusesAsync: async () => true,
      fileStatuses: { [abs('src/ui/view.ts')]: { unstaged: 'modified', staged: null }, [abs('src/server/api.ts')]: { unstaged: 'added', staged: null } },
    });
    (provider as any).refreshGitStatus(root);
    const gu = posted('git-update').pop();
    assert.deepStrictEqual(Object.keys(gu.fileGitStatus), [abs('src/server/api.ts')]);
    assert.ok(gu.nodes.every((n: any) => n.id.includes('src/server')));

    (provider as any).handleAnalysisResult({ nodes: [{ id: 'x', name: 'x', file: abs('tools/gen.ts'), line: 1 }, { id: 'y', name: 'y', file: abs('src/server/api.ts'), line: 2 }], edges: [], files: [abs('tools/gen.ts'), abs('src/server/api.ts')] }, root);
    const g = posted('graph').pop();
    assert.deepStrictEqual(g.data.nodes.map((n: any) => n.id), ['y']);
    assert.deepStrictEqual(g.data.files, [abs('src/server/api.ts')]);
  });
});
