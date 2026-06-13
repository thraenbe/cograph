import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  AnalyzerRunner,
  type AnalyzerRunMeta,
  ANALYSIS_TIMEOUT_MS,
  MAX_ANALYSIS_RETRIES,
  RETRY_BACKOFF_MS,
} from '../../analyzerRunner';

// require() so sinon can stub the underlying CJS module (see memory note on the
// __importStar wrapper). The wrapper's getters read through to these stubs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawCp = require('child_process');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeProc() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = sinon.stub();
  proc.pid = 1234;
  return proc;
}

const EMPTY_JSON = JSON.stringify({ nodes: [], edges: [], files: [] });
function nodeJson(id = 'a::b::1') {
  return JSON.stringify({ nodes: [{ id, name: 'b', file: 'a.py', line: 1 }], edges: [], files: ['a.py'] });
}

const emitEmpty = (p: any) => { p.stdout.emit('data', Buffer.from(EMPTY_JSON)); p.emit('close', 0); };
const emitNode  = (p: any, id?: string) => { p.stdout.emit('data', Buffer.from(nodeJson(id))); p.emit('close', 0); };
const emitExit  = (p: any, code = 1, stderr = 'SyntaxError: boom') => { p.stderr.emit('data', Buffer.from(stderr)); p.emit('close', code); };
const emitBadJson = (p: any) => { p.stdout.emit('data', Buffer.from('not json {{{')); p.emit('close', 0); };

/** Make resolvePythonBin() resolve to 'python3' without touching the real env. */
function stubPythonResolution(sandbox: sinon.SinonSandbox) {
  sandbox.stub(vscode.extensions, 'getExtension').returns(undefined);
  sandbox.stub(vscode.workspace, 'getConfiguration').returns({ get: () => undefined } as any);
  sandbox.stub(vscode.workspace, 'workspaceFolders').value(undefined);
  sandbox.stub(rawCp, 'execFileSync').returns(Buffer.from('Python 3.11.0'));
}

/**
 * Stub spawn so every analyzer process is created fresh and auto-emits an
 * outcome on the next tick (across retry rounds). `emitForCall(idx, proc)`
 * receives the 0-based spawn-call index (idx % 5 = language, idx / 5 = round).
 */
function stubSpawnAuto(
  sandbox: sinon.SinonSandbox,
  realSetTimeout: typeof setTimeout,
  emitForCall: (idx: number, proc: any) => void,
): sinon.SinonStub {
  let calls = 0;
  return sandbox.stub(rawCp, 'spawn').callsFake(() => {
    const idx = calls++;
    const proc = makeFakeProc();
    realSetTimeout(() => emitForCall(idx, proc), 0);
    return proc;
  });
}

/** Collapse RETRY_BACKOFF_MS waits to ~0 so retry tests run fast; pass the analyzer timeout through. */
function stubFastBackoff(sandbox: sinon.SinonSandbox, realSetTimeout: typeof setTimeout) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sandbox.stub(global, 'setTimeout').callsFake((fn: any, ms?: number) =>
    realSetTimeout(fn, ms && (RETRY_BACKOFF_MS as number[]).includes(ms) ? 0 : (ms as number)));
}

function makeRunner(sandbox: sinon.SinonSandbox, extensionPath = '/fake/ext') {
  const context = { extensionPath, extensionUri: vscode.Uri.file(extensionPath) } as unknown as vscode.ExtensionContext;
  const showError = sandbox.stub();
  const log = sandbox.stub();
  const onRetry = sandbox.stub();
  let resolveResult: (v: { stdout: string; root: string; meta: AnalyzerRunMeta }) => void;
  const result = new Promise<{ stdout: string; root: string; meta: AnalyzerRunMeta }>(res => { resolveResult = res; });
  const onResult = sandbox.stub().callsFake((stdout: string, root: string, meta: AnalyzerRunMeta) =>
    resolveResult({ stdout, root, meta }));
  const runner = new AnalyzerRunner(context, showError as any, onResult as any, log as any, onRetry as any);
  return { runner, showError, log, onRetry, onResult, result };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('AnalyzerRunner', () => {
  let sandbox: sinon.SinonSandbox;
  let realSetTimeout: typeof setTimeout;

  setup(() => {
    sandbox = sinon.createSandbox();
    realSetTimeout = setTimeout;
  });

  teardown(() => {
    sandbox.restore();
  });

  test('all analyzers succeed → onResult with merged graph, statuses, no retry', async function () {
    this.timeout(5000);
    stubPythonResolution(sandbox);
    const spawn = stubSpawnAuto(sandbox, realSetTimeout, (idx, proc) => {
      // idx 0 = python → a node; the other four languages → empty
      idx % 5 === 0 ? emitNode(proc) : emitEmpty(proc);
    });
    const { runner, onRetry, result } = makeRunner(sandbox);

    runner.run('/ws', { allowRetry: true });
    const { stdout, meta } = await result;

    const graph = JSON.parse(stdout);
    assert.strictEqual(graph.nodes.length, 1, 'merged graph keeps the python node');
    assert.strictEqual(spawn.callCount, 5, 'exactly one round — success short-circuits retries');
    assert.ok(onRetry.notCalled, 'no retry on success');
    assert.strictEqual(meta.statuses.length, 5);
    assert.strictEqual(meta.statuses.find(s => s.lang === 'python')!.status, 'ok');
    assert.strictEqual(meta.statuses.find(s => s.lang === 'typescript')!.status, 'empty');
  });

  test('analyzer exit-nonzero is surfaced (logged + status), never swallowed', async function () {
    this.timeout(5000);
    stubPythonResolution(sandbox);
    stubSpawnAuto(sandbox, realSetTimeout, (idx, proc) => {
      // typescript (idx 1) fails with a non-zero exit; the rest produce a node so
      // the merged graph is non-empty (no retry) and we can assert the failure is reported.
      idx % 5 === 1 ? emitExit(proc, 1) : emitNode(proc);
    });
    const { runner, log, result } = makeRunner(sandbox);

    runner.run('/ws', { allowRetry: true });
    const { meta } = await result;

    const tsStatus = meta.statuses.find(s => s.lang === 'typescript')!;
    assert.strictEqual(tsStatus.status, 'exit-nonzero');
    assert.ok(tsStatus.detail?.includes('exit 1'), 'detail carries the exit code');
    assert.ok(tsStatus.detail?.includes('SyntaxError'), 'detail carries stderr snippet');
    const logged = log.getCalls().map(c => String(c.args[0]));
    assert.ok(logged.some(m => m.includes('typescript') && m.includes('exit-nonzero')), 'failure logged, not swallowed');
  });

  test('bad JSON from an analyzer → parse-error status (does not crash the run)', async function () {
    this.timeout(5000);
    stubPythonResolution(sandbox);
    stubSpawnAuto(sandbox, realSetTimeout, (idx, proc) => {
      idx % 5 === 0 ? emitBadJson(proc) : emitNode(proc);
    });
    const { runner, result } = makeRunner(sandbox);

    runner.run('/ws', { allowRetry: true });
    const { meta } = await result;

    assert.strictEqual(meta.statuses.find(s => s.lang === 'python')!.status, 'parse-error');
  });

  test('empty result is retried up to MAX_ANALYSIS_RETRIES, then resolves empty', async function () {
    this.timeout(5000);
    stubPythonResolution(sandbox);
    stubFastBackoff(sandbox, realSetTimeout);
    const spawn = stubSpawnAuto(sandbox, realSetTimeout, (_idx, proc) => emitEmpty(proc));
    const { runner, onRetry, result } = makeRunner(sandbox);

    runner.run('/ws', { allowRetry: true });
    const { stdout } = await result;

    assert.strictEqual(JSON.parse(stdout).nodes.length, 0);
    assert.strictEqual(onRetry.callCount, MAX_ANALYSIS_RETRIES, 'retried the configured number of times');
    assert.strictEqual(spawn.callCount, 5 * (MAX_ANALYSIS_RETRIES + 1), '1 initial + MAX retry rounds × 5 analyzers');
  });

  test('a non-empty later attempt wins (recovers a transient empty)', async function () {
    this.timeout(5000);
    stubPythonResolution(sandbox);
    stubFastBackoff(sandbox, realSetTimeout);
    const spawn = stubSpawnAuto(sandbox, realSetTimeout, (idx, proc) => {
      // Round 0 (idx 0..4) empty; round 1 python returns a node.
      if (idx < 5) { emitEmpty(proc); return; }
      idx === 5 ? emitNode(proc) : emitEmpty(proc);
    });
    const { runner, onRetry, result } = makeRunner(sandbox);

    runner.run('/ws', { allowRetry: true });
    const { stdout } = await result;

    assert.strictEqual(JSON.parse(stdout).nodes.length, 1, 'second-attempt graph is used');
    assert.strictEqual(onRetry.callCount, 1, 'one retry before success');
    assert.strictEqual(spawn.callCount, 10, 'two rounds × 5 analyzers');
  });

  test('reanalysis (no allowRetry) never retries on empty', async function () {
    this.timeout(5000);
    stubPythonResolution(sandbox);
    stubFastBackoff(sandbox, realSetTimeout);
    const spawn = stubSpawnAuto(sandbox, realSetTimeout, (_idx, proc) => emitEmpty(proc));
    const { runner, onRetry, result } = makeRunner(sandbox);

    runner.run('/ws'); // reanalysis-style: no opts
    const { stdout } = await result;

    assert.strictEqual(JSON.parse(stdout).nodes.length, 0);
    assert.ok(onRetry.notCalled, 'reanalysis must not loop');
    assert.strictEqual(spawn.callCount, 5, 'exactly one round');
  });

  test('timeout is NOT retried (would waste minutes)', async function () {
    this.timeout(5000);
    stubPythonResolution(sandbox);
    // Fire the analyzer's internal ANALYSIS_TIMEOUT_MS immediately; collapse backoff.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sandbox.stub(global, 'setTimeout').callsFake((fn: any, ms?: number) => {
      if (ms === ANALYSIS_TIMEOUT_MS) { return realSetTimeout(fn, 0); }
      return realSetTimeout(fn, ms && (RETRY_BACKOFF_MS as number[]).includes(ms) ? 0 : (ms as number));
    });
    // Procs never close — only the internal timeout resolves them.
    const spawn = stubSpawnAuto(sandbox, realSetTimeout, () => { /* never emits */ });
    const { runner, onRetry, result } = makeRunner(sandbox);

    runner.run('/ws', { allowRetry: true });
    const { stdout, meta } = await result;

    assert.strictEqual(JSON.parse(stdout).nodes.length, 0);
    assert.ok(onRetry.notCalled, 'timeout must not trigger retries');
    assert.strictEqual(spawn.callCount, 5, 'one round only');
    assert.ok(meta.statuses.every(s => s.status === 'timeout'), 'all analyzers reported timeout');
  });

  test('killAll() aborts an in-flight retry loop (no late onResult)', async function () {
    this.timeout(5000);
    stubPythonResolution(sandbox);
    stubFastBackoff(sandbox, realSetTimeout);
    stubSpawnAuto(sandbox, realSetTimeout, (_idx, proc) => emitEmpty(proc));
    const { runner, onResult } = makeRunner(sandbox);

    runner.run('/ws', { allowRetry: true });
    runner.killAll(); // bump runToken before the first round settles

    await new Promise<void>(r => realSetTimeout(r, 200));
    assert.ok(onResult.notCalled, 'superseded loop must not deliver a result');
  });

  // ── countCandidateSourceFiles ─────────────────────────────────────────────

  suite('countCandidateSourceFiles()', () => {
    let tmpDir: string;
    setup(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-probe-')); });
    teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    test('counts supported source files and skips node_modules / dot-dirs', () => {
      fs.mkdirSync(path.join(tmpDir, 'src'));
      fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), '');
      fs.writeFileSync(path.join(tmpDir, 'src', 'b.py'), '');
      fs.writeFileSync(path.join(tmpDir, 'README.md'), ''); // not a source ext
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'x'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'x', 'skip.ts'), '');
      fs.mkdirSync(path.join(tmpDir, '.hidden'));
      fs.writeFileSync(path.join(tmpDir, '.hidden', 'skip.js'), '');

      const { runner } = makeRunner(sandbox);
      assert.strictEqual(runner.countCandidateSourceFiles(tmpDir, 99), 2, 'only src/a.ts and src/b.py count');
    });

    test('early-exits at cap', () => {
      for (let i = 0; i < 10; i++) { fs.writeFileSync(path.join(tmpDir, `f${i}.js`), ''); }
      const { runner } = makeRunner(sandbox);
      assert.strictEqual(runner.countCandidateSourceFiles(tmpDir, 1), 1, 'stops at the cap');
    });

    test('missing directory → 0 (no throw)', () => {
      const { runner } = makeRunner(sandbox);
      assert.strictEqual(runner.countCandidateSourceFiles(path.join(tmpDir, 'nope'), 5), 0);
    });
  });

  test('meta.candidateFilesFound reflects the on-disk probe', async function () {
    this.timeout(5000);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-probe-meta-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'main.py'), 'def f(): pass\n');
      stubPythonResolution(sandbox);
      stubFastBackoff(sandbox, realSetTimeout);
      stubSpawnAuto(sandbox, realSetTimeout, (_idx, proc) => emitEmpty(proc));
      const { runner, result } = makeRunner(sandbox);

      runner.run(tmpDir, { allowRetry: true });
      const { meta } = await result;

      assert.strictEqual(meta.candidateFilesFound, true, 'a .py file on disk is detected');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
