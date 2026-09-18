import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { runCliStream, ensureCliBinary } from '../../graphIntelligence/cliProcess';
import { ClaudeCodeProvider, buildJsonArgs } from '../../graphIntelligence/claudeCodeProvider';
import { CodexCliProvider, buildCodexJsonArgs, buildCodexJsonPrompt } from '../../graphIntelligence/codexCliProvider';
import { extractJsonObject } from '../../graphIntelligence/jsonRepair';
import type { JsonRequest } from '../../graphIntelligence/provider';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawCp = require('child_process');

function makeFakeProc() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), { end: sinon.stub() });
  proc.kill = sinon.stub();
  return proc;
}

const SCHEMA = { type: 'object', required: ['files'], properties: { files: { type: 'object' } } };

function jsonReq(over: Partial<JsonRequest> = {}): JsonRequest {
  return { prompt: 'summarise', systemPrompt: 'be brief', schema: SCHEMA, workspaceRoot: '/ws', tools: 'none', ...over };
}

function baseOpts(over: Partial<Parameters<typeof runCliStream>[0]> = {}) {
  return { command: 'tool', args: ['-x'], cwd: '/ws', label: 'Tool', timeoutMs: 5000, onStdout: () => undefined, ...over };
}

suite('cliProcess.runCliStream', () => {
  let sandbox: sinon.SinonSandbox;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let proc: any;
  let spawn: sinon.SinonStub;

  setup(() => {
    sandbox = sinon.createSandbox();
    proc = makeFakeProc();
    spawn = sandbox.stub(rawCp, 'spawn').returns(proc);
  });
  teardown(() => sandbox.restore());

  test('streams stdout, flushes on end and resolves on exit 0', async () => {
    const chunks: string[] = [];
    const onEnd = sinon.stub();
    const p = runCliStream(baseOpts({ onStdout: t => chunks.push(t), onEnd }));
    proc.stdout.emit('data', Buffer.from('a'));
    proc.stdout.emit('data', Buffer.from('b'));
    proc.emit('close', 0);
    await p;
    assert.deepStrictEqual(chunks, ['a', 'b']);
    assert.ok(onEnd.calledOnce);
    assert.deepStrictEqual(spawn.firstCall.args[2].stdio, ['ignore', 'pipe', 'pipe']);
  });

  test('writes the prompt to stdin and closes it', async () => {
    const p = runCliStream(baseOpts({ stdin: 'hello' }));
    proc.emit('close', 0);
    await p;
    assert.deepStrictEqual(spawn.firstCall.args[2].stdio, ['pipe', 'pipe', 'pipe']);
    assert.ok(proc.stdin.end.calledOnceWithExactly('hello'));
  });

  test('forwards stderr', async () => {
    const errs: string[] = [];
    const p = runCliStream(baseOpts({ onStderr: t => errs.push(t) }));
    proc.stderr.emit('data', Buffer.from('warn'));
    proc.emit('close', 0);
    await p;
    assert.deepStrictEqual(errs, ['warn']);
  });

  test('rejects on non-zero exit', async () => {
    const p = runCliStream(baseOpts());
    proc.emit('close', 2);
    await assert.rejects(p, /Tool exited with code 2\./);
  });

  test('rejects when the process cannot start', async () => {
    const p = runCliStream(baseOpts());
    proc.emit('error', new Error('ENOENT'));
    await assert.rejects(p, /Failed to start Tool: ENOENT/);
  });

  test('times out with SIGTERM', async () => {
    const clock = sandbox.useFakeTimers();
    const p = runCliStream(baseOpts({ timeoutMs: 3000 }));
    clock.tick(3001);
    await assert.rejects(p, /Tool timed out after 3s\./);
    assert.ok(proc.kill.calledWith('SIGTERM'));
  });

  test('abort sends SIGTERM, then SIGKILL after the grace period', async () => {
    const clock = sandbox.useFakeTimers();
    const ctrl = new AbortController();
    const p = runCliStream(baseOpts({ signal: ctrl.signal }));
    ctrl.abort();
    await assert.rejects(p, /Request cancelled\./);
    assert.ok(proc.kill.calledWith('SIGTERM'));
    assert.ok(!proc.kill.calledWith('SIGKILL'));
    clock.tick(1001);
    assert.ok(proc.kill.calledWith('SIGKILL'));
  });

  test('an already-aborted signal cancels immediately', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(runCliStream(baseOpts({ signal: ctrl.signal })), /Request cancelled\./);
  });

  test('kills the process when output exceeds the size cap', async () => {
    const onEnd = sinon.stub();
    const p = runCliStream(baseOpts({ onEnd }));
    proc.stdout.emit('data', { length: 600 * 1024 * 1024, toString: () => '' });
    await assert.rejects(p, /Tool response exceeded maximum output size\./);
    proc.emit('close', null);
    assert.ok(proc.kill.calledWith('SIGTERM'));
    assert.ok(onEnd.notCalled, 'a killed process must not flush');
  });

  test('ensureCliBinary throws the given message when the binary is missing', () => {
    sandbox.stub(rawCp, 'spawnSync').returns({ error: new Error('ENOENT') });
    assert.throws(() => ensureCliBinary('nope', 'Nope not found'), /Nope not found/);
  });
});

suite('jsonRepair.extractJsonObject', () => {
  test('prefers structured output', () => {
    const got = extractJsonObject({ kind: 'result', text: 'ignored', structured: { a: 1 } }, 'X');
    assert.deepStrictEqual(got, { a: 1 });
  });
  test('falls back to a fenced object in the text', () => {
    const got = extractJsonObject({ kind: 'result', text: 'Here:\n```json\n{"a":2}\n``` done' }, 'X');
    assert.deepStrictEqual(got, { a: 2 });
  });
  test('honours the predicate and throws with a preview when nothing matches', () => {
    const pred = (o: unknown) => typeof (o as { files?: unknown }).files === 'object';
    assert.deepStrictEqual(extractJsonObject({ kind: 'result', text: '{"x":1} {"files":{}}' }, 'X', pred), { files: {} });
    assert.throws(() => extractJsonObject({ kind: 'result', text: 'no json' }, 'X'), /Unable to extract a JSON object from X/);
  });
});

suite('ClaudeCodeProvider.runJson', () => {
  let sandbox: sinon.SinonSandbox;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let proc: any;
  let spawn: sinon.SinonStub;
  const channel = { append: sinon.stub() } as unknown as vscode.OutputChannel;

  setup(() => {
    sandbox = sinon.createSandbox();
    proc = makeFakeProc();
    spawn = sandbox.stub(rawCp, 'spawn').returns(proc);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
  });
  teardown(() => sandbox.restore());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function emitResult(msg: Record<string, any>) {
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', ...msg }) + '\n'));
    proc.emit('close', 0);
  }

  test('digest mode: tools off, lean flags, never a write-capable mode', () => {
    const args = buildJsonArgs(jsonReq({ model: 'haiku', maxBudgetUsd: 0.1 }));
    assert.strictEqual(args[args.indexOf('--tools') + 1], '');
    assert.strictEqual(args[args.indexOf('--system-prompt') + 1], 'be brief');
    assert.strictEqual(args[args.indexOf('--model') + 1], 'haiku');
    assert.strictEqual(args[args.indexOf('--max-budget-usd') + 1], '0.1');
    for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--json-schema']) {
      assert.ok(args.includes(flag), flag);
    }
    assert.ok(!args.includes('--permission-mode'));
    assert.ok(!args.includes('summarise'), 'the prompt must travel over stdin, not argv');
  });

  test('read-only mode grants only Read, Grep and Glob', () => {
    const args = buildJsonArgs(jsonReq({ tools: 'read-only', model: 'default' }));
    assert.strictEqual(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
    assert.ok(!args.includes('--model'), '"default" leaves the model to the CLI');
  });

  test('returns structured output and usage; sends the prompt over stdin', async () => {
    const p = new ClaudeCodeProvider(channel).runJson(jsonReq());
    emitResult({
      subtype: 'success', result: '', structured_output: { files: { 'a.ts': { summary: 's' } } },
      usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0.004,
    });
    const res = await p;
    assert.deepStrictEqual(res.data, { files: { 'a.ts': { summary: 's' } } });
    assert.deepStrictEqual(res.usage, { inputTokens: 10, outputTokens: 5, costUsd: 0.004 });
    assert.strictEqual(spawn.firstCall.args[0], 'claude');
    assert.ok(proc.stdin.end.calledOnceWithExactly('summarise'));
  });

  test('repairs JSON from the result text when structured output is absent', async () => {
    const p = new ClaudeCodeProvider(channel).runJson(jsonReq());
    emitResult({ subtype: 'success', result: '```json\n{"files":{}}\n```' });
    assert.deepStrictEqual((await p).data, { files: {} });
  });

  test('surfaces a provider error event', async () => {
    const p = new ClaudeCodeProvider(channel).runJson(jsonReq());
    emitResult({ subtype: 'error_max_budget', errors: [{ message: 'budget hit' }] });
    await assert.rejects(p, /Claude Code: error_max_budget — budget hit/);
  });

  test('rejects when the CLI closes without a result', async () => {
    const p = new ClaudeCodeProvider(channel).runJson(jsonReq());
    proc.emit('close', 0);
    await assert.rejects(p, /closed without emitting a result/);
  });
});

suite('CodexCliProvider.runJson', () => {
  let sandbox: sinon.SinonSandbox;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let proc: any;
  const channel = { append: sinon.stub() } as unknown as vscode.OutputChannel;

  setup(() => {
    sandbox = sinon.createSandbox();
    proc = makeFakeProc();
    sandbox.stub(rawCp, 'spawn').returns(proc);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
  });
  teardown(() => sandbox.restore());

  test('always uses the read-only sandbox, never --full-auto; prompt comes from stdin', () => {
    const args = buildCodexJsonArgs(jsonReq({ model: 'gpt-5-mini' }));
    assert.strictEqual(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(!args.includes('--full-auto'));
    assert.strictEqual(args[args.indexOf('--model') + 1], 'gpt-5-mini');
    assert.strictEqual(args[args.length - 1], '-');
  });

  test('prompt carries the schema, and forbids file access in digest mode only', () => {
    const digest = buildCodexJsonPrompt(jsonReq());
    assert.ok(digest.includes('be brief') && digest.includes('summarise'));
    assert.ok(digest.includes(JSON.stringify(SCHEMA)));
    assert.ok(digest.includes('Do not open or search any files.'));
    assert.ok(!buildCodexJsonPrompt(jsonReq({ tools: 'read-only' })).includes('Do not open'));
  });

  test('parses the final agent message and reports no usage', async () => {
    const p = new CodexCliProvider(channel).runJson(jsonReq());
    proc.stdout.emit('data', Buffer.from(
      JSON.stringify({ id: '1', msg: { type: 'task_complete', last_agent_message: '{"files":{"a.ts":{"summary":"s"}}}' } }) + '\n',
    ));
    proc.emit('close', 0);
    const res = await p;
    assert.deepStrictEqual(res.data, { files: { 'a.ts': { summary: 's' } } });
    assert.strictEqual(res.usage, undefined);
  });

  test('surfaces a Codex error event', async () => {
    const p = new CodexCliProvider(channel).runJson(jsonReq());
    proc.stdout.emit('data', Buffer.from(JSON.stringify({ id: '1', msg: { type: 'error', message: 'boom' } }) + '\n'));
    proc.emit('close', 0);
    await assert.rejects(p, /Codex: .*boom/);
  });
});
