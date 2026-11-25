import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import { AnalyzerRunner } from '../../analyzerRunner';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawCp = require('child_process');

// ---------------------------------------------------------------------------
// Analyzer `--files <listpath>` CLI contract (real subprocess)
// ---------------------------------------------------------------------------

suite('analyzer --files subset CLI', () => {
  let tmp: string;
  const tsScript = path.join(__dirname, '..', '..', '..', 'scripts', 'analyze_ts.js');

  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-subset-cli-')); });
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function runTs(args: string[]): any {
    const res = spawnSync(process.execPath, [tsScript, ...args], { encoding: 'utf8' });
    return JSON.parse(res.stdout);
  }

  test('--files restricts analysis to the listed files', () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export function foo(){ bar(); }\nfunction bar(){}\n');
    fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), 'export function other(){}\n');
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, path.join(tmp, 'src', 'a.ts') + '\n');

    const full = runTs([tmp]);
    assert.deepStrictEqual(full.nodes.map((n: any) => n.name).sort(), ['bar', 'foo', 'other']);

    const subset = runTs([tmp, '--files', list]);
    assert.deepStrictEqual(subset.nodes.map((n: any) => n.name).sort(), ['bar', 'foo'], 'only a.ts analyzed');
    assert.strictEqual(subset.files.length, 1);
  });

  test('--files self-filters foreign extensions (a .py passed to the TS analyzer is ignored)', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'export function keep(){}\n');
    fs.writeFileSync(path.join(tmp, 'b.py'), 'def drop(): pass\n');
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, [path.join(tmp, 'a.ts'), path.join(tmp, 'b.py')].join('\n'));

    const subset = runTs([tmp, '--files', list]);
    assert.deepStrictEqual(subset.nodes.map((n: any) => n.name), ['keep'], 'python file ignored by TS analyzer');
  });

  test('--files with an unreadable list → empty graph (no crash)', () => {
    const subset = runTs([tmp, '--files', path.join(tmp, 'missing.txt')]);
    assert.deepStrictEqual(subset.nodes, []);
  });
});

// ---------------------------------------------------------------------------
// AnalyzerRunner.runSubset()
// ---------------------------------------------------------------------------

function makeFakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = sinon.stub();
  proc.pid = 1;
  return proc;
}

suite('AnalyzerRunner.runSubset', () => {
  let sandbox: sinon.SinonSandbox;

  setup(() => { sandbox = sinon.createSandbox(); });
  teardown(() => { sandbox.restore(); });

  function makeRunner() {
    const context = { extensionPath: '/fake/ext', extensionUri: vscode.Uri.file('/fake/ext') } as unknown as vscode.ExtensionContext;
    return new AnalyzerRunner(context, sandbox.stub() as any, sandbox.stub() as any, sandbox.stub() as any);
  }

  test('empty file list → empty graph, nothing spawned', async () => {
    const spawn = sandbox.stub(rawCp, 'spawn');
    const runner = makeRunner();
    const result = await runner.runSubset('/ws', []);
    assert.deepStrictEqual(result, { nodes: [], edges: [], files: [] });
    assert.ok(spawn.notCalled, 'no analyzer spawned for an empty subset');
  });

  test('a file name with a line break stays out of the list: it would be two lines, the second of its own choosing', async function () {
    this.timeout(5000);
    sandbox.stub(vscode.extensions, 'getExtension').returns(undefined as any);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({ get: () => undefined } as any);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
    sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));
    const lists: string[] = [];
    sandbox.stub(rawCp, 'spawn').callsFake((_bin: any, args: any) => {
      lists.push(fs.readFileSync((args as string[])[(args as string[]).indexOf('--files') + 1], 'utf8'));
      const proc = makeFakeProc();
      setTimeout(() => { proc.stdout.emit('data', Buffer.from(JSON.stringify({ nodes: [], edges: [], files: [] }))); proc.emit('close', 0); }, 0);
      return proc;
    });
    await makeRunner().runSubset('/ws', ['/ws/a.py', '/ws/x\n/outside/b.py', '/ws/y\r/outside/c.py', '/ws/tab\there.py']);
    assert.ok(lists.length >= 4);
    assert.ok(lists.every(l => l === '/ws/a.py\n/ws/tab\there.py'), `each analyzer read: ${JSON.stringify(lists[0])}`);
  });

  test('spawns analyzers with --files and merges their output', async function () {
    this.timeout(5000);
    // Resolve python so all five analyzers run.
    sandbox.stub(vscode.extensions, 'getExtension').returns(undefined as any);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({ get: () => undefined } as any);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
    sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));

    const realSetTimeout = setTimeout;
    const seenArgs: string[][] = [];
    let i = 0;
    sandbox.stub(rawCp, 'spawn').callsFake((_bin: any, args: any) => {
      seenArgs.push(args as string[]);
      const idx = i++;
      const proc = makeFakeProc();
      realSetTimeout(() => {
        const payload = idx === 0
          ? JSON.stringify({ nodes: [{ id: 'x::f::1', name: 'f', file: '/ws/x.ts', line: 1 }], edges: [], files: ['/ws/x.ts'] })
          : JSON.stringify({ nodes: [], edges: [], files: [] });
        proc.stdout.emit('data', Buffer.from(payload));
        proc.emit('close', 0);
      }, 0);
      return proc;
    });

    const runner = makeRunner();
    const result = await runner.runSubset('/ws', ['/ws/x.ts']);

    assert.strictEqual(result.nodes.length, 1);
    assert.strictEqual(result.nodes[0].name, 'f');
    assert.ok(seenArgs.length >= 4, 'all JS-family analyzers spawned');
    assert.ok(seenArgs.every(a => a.includes('--files')), 'every analyzer invoked with --files');
    // The temp list file is passed right after --files and cleaned up afterwards.
    const listPath = seenArgs[0][seenArgs[0].indexOf('--files') + 1];
    assert.ok(typeof listPath === 'string' && listPath.length > 0);
    assert.strictEqual(fs.existsSync(listPath), false, 'temp list file removed in finally');
  });
});

suite('AnalyzerRunner — a hostile file name, with the real analyzers', () => {
  test('a name holding a line break and a path reads nothing outside the workspace', async function () {
    if (process.platform === 'win32') { this.skip(); } // NTFS has no such name
    this.timeout(30_000);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-hostile-name-'));
    try {
      const planted = path.join(tmp, 'outside', 'planted.py');
      fs.mkdirSync(path.dirname(planted));
      fs.writeFileSync(planted, 'def PLANTED_OUTSIDE():\n    pass\n');
      const workspace = path.join(tmp, 'ws');
      fs.mkdirSync(workspace);
      fs.writeFileSync(path.join(workspace, 'a.py'), 'def real():\n    pass\n');
      // Split at the line break, the second half of this path is the planted file's own.
      const hostile = path.join(workspace, 'x\n', planted);
      fs.mkdirSync(path.dirname(hostile), { recursive: true });
      fs.writeFileSync(hostile, 'def hidden():\n    pass\n');
      const context = { extensionPath: path.join(__dirname, '..', '..', '..') } as unknown as vscode.ExtensionContext;
      const noop = () => undefined;
      const graph = await new Promise<{ nodes: Array<{ name: string }> }>((resolve) => {
        new AnalyzerRunner(context, noop, noop, noop, noop, (g) => resolve(g)).run(workspace);
      });
      assert.deepStrictEqual(graph.nodes.map(n => n.name), ['real']);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});
