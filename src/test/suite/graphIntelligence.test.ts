import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { ClaudeCodeProvider } from '../../graphIntelligence/claudeCodeProvider';
import { CodexCliProvider, CodexStreamParser } from '../../graphIntelligence/codexCliProvider';
import { PROVIDER_CATALOG, getProviderInfo, findProviderForModel } from '../../graphIntelligence/provider';
import { StreamJsonParser, summarizeToolInput, ProgressEvent } from '../../graphIntelligence/progressParser';
import {
  sliceAtBalancedBrace,
  extractLastFencedBlock,
  extractCographResult,
  tryParseWithRepair,
} from '../../graphIntelligence/jsonRepair';
import type { GraphIntelligenceResult, GraphIntelligenceRequest } from '../../graphIntelligence/provider';
import type { GraphData } from '../../graphProvider';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawCp = require('child_process');

function makeFakeProc() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = sinon.stub();
  proc.pid = 1234;
  return proc;
}

const SAMPLE_GRAPH: GraphData = {
  nodes: [
    { id: 'a.py::foo::1', name: 'foo', file: '/tmp/a.py', line: 1, language: 'python' },
    { id: 'a.py::bar::5', name: 'bar', file: '/tmp/a.py', line: 5, language: 'python' },
  ],
  edges: [{ source: 'a.py::foo::1', target: 'a.py::bar::5' }],
};

const SAMPLE_RESULT: GraphIntelligenceResult = {
  graph: {
    nodes: [
      { id: 'a.py::foo_renamed::1', name: 'foo_renamed', file: '/tmp/a.py', line: 1, language: 'python' },
      { id: 'a.py::bar::5', name: 'bar', file: '/tmp/a.py', line: 5, language: 'python' },
    ],
    edges: [{ source: 'a.py::foo_renamed::1', target: 'a.py::bar::5' }],
  },
  text: 'Renamed foo to foo_renamed.',
};

/** Emit a canonical Claude Code stream-json success sequence. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitSuccess(proc: any, resultText: string, structured?: unknown) {
  proc.stdout.emit('data', Buffer.from(
    JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet', tools: ['Read'] }) + '\n',
  ));
  proc.stdout.emit('data', Buffer.from(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: resultText,
      structured_output: structured,
      usage: { input_tokens: 120, output_tokens: 45 },
      total_cost_usd: 0.012,
    }) + '\n',
  ));
  proc.emit('close', 0);
}

// ── StreamJsonParser ──────────────────────────────────────────────────────────

suite('StreamJsonParser', () => {
  test('emits init for system/init messages', () => {
    const events: ProgressEvent[] = [];
    const parser = new StreamJsonParser((e) => events.push(e));
    parser.feed(JSON.stringify({ type: 'system', subtype: 'init', model: 'opus', tools: ['Read', 'Grep'] }) + '\n');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'init');
    if (events[0].kind === 'init') {
      assert.strictEqual(events[0].model, 'opus');
      assert.deepStrictEqual(events[0].tools, ['Read', 'Grep']);
    }
  });

  test('emits thinking truncated to 200 chars', () => {
    const events: ProgressEvent[] = [];
    const parser = new StreamJsonParser((e) => events.push(e));
    const big = 'x'.repeat(500);
    parser.feed(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: big }] },
    }) + '\n');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'thinking');
    if (events[0].kind === 'thinking') {
      assert.strictEqual(events[0].snippet.length, 200);
    }
  });

  test('emits tool-use events with summaries', () => {
    const events: ProgressEvent[] = [];
    const parser = new StreamJsonParser((e) => events.push(e));
    parser.feed(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'parseArgs' } },
        ],
      },
    }) + '\n');
    assert.strictEqual(events.length, 2);
    if (events[0].kind === 'tool-use') {
      assert.strictEqual(events[0].name, 'Read');
      assert.strictEqual(events[0].summary, 'Read app.ts');
    }
    if (events[1].kind === 'tool-use') {
      assert.strictEqual(events[1].name, 'Grep');
      assert.ok(events[1].summary.includes('parseArgs'));
    }
  });

  test('emits text deltas in order', () => {
    const events: ProgressEvent[] = [];
    const parser = new StreamJsonParser((e) => events.push(e));
    parser.feed(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }] },
    }) + '\n');
    const texts = events.filter(e => e.kind === 'text').map(e => (e as ProgressEvent & { kind: 'text' }).delta);
    assert.deepStrictEqual(texts, ['Hello', ' world']);
  });

  test('emits result with usage converted', () => {
    const events: ProgressEvent[] = [];
    const parser = new StreamJsonParser((e) => events.push(e));
    parser.feed(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: '{"graph":{"nodes":[],"edges":[]},"text":"ok"}',
      usage: { input_tokens: 50, output_tokens: 10 },
      total_cost_usd: 0.001,
    }) + '\n');
    assert.strictEqual(events.length, 1);
    const e = events[0];
    assert.strictEqual(e.kind, 'result');
    if (e.kind === 'result') {
      assert.strictEqual(e.usage?.inputTokens, 50);
      assert.strictEqual(e.usage?.outputTokens, 10);
      assert.strictEqual(e.usage?.costUsd, 0.001);
    }
  });

  test('emits error for non-success result subtype', () => {
    const events: ProgressEvent[] = [];
    const parser = new StreamJsonParser((e) => events.push(e));
    parser.feed(JSON.stringify({
      type: 'result',
      subtype: 'error_max_budget_usd',
      errors: [{ message: 'budget exceeded' }],
    }) + '\n');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'error');
    if (events[0].kind === 'error') {
      assert.strictEqual(events[0].subtype, 'error_max_budget_usd');
      assert.strictEqual(events[0].message, 'budget exceeded');
    }
  });

  test('tolerates chunk boundaries mid-line', () => {
    const events: ProgressEvent[] = [];
    const parser = new StreamJsonParser((e) => events.push(e));
    const line = JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet', tools: [] }) + '\n';
    parser.feed(line.slice(0, 15));
    parser.feed(line.slice(15));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'init');
  });

  test('ignores non-JSON banner lines', () => {
    const events: ProgressEvent[] = [];
    const parser = new StreamJsonParser((e) => events.push(e));
    parser.feed('Welcome to Claude Code CLI\n');
    parser.feed(JSON.stringify({ type: 'system', subtype: 'init', model: 'sonnet', tools: [] }) + '\n');
    assert.strictEqual(events.length, 1);
  });

  test('summarizeToolInput formats Bash, Edit, Write', () => {
    assert.strictEqual(summarizeToolInput('Bash', { command: 'ls -la' }), 'Bash ls -la');
    assert.strictEqual(summarizeToolInput('Edit', { file_path: '/a/b/c.ts' }), 'Edit c.ts');
    assert.strictEqual(summarizeToolInput('Write', { file_path: '/x/y.md' }), 'Write y.md');
    assert.strictEqual(summarizeToolInput('Unknown', {}), 'Unknown');
  });
});

// ── jsonRepair ────────────────────────────────────────────────────────────────

suite('jsonRepair.sliceAtBalancedBrace', () => {
  test('returns null when no opening brace', () => {
    assert.strictEqual(sliceAtBalancedBrace('no braces here'), null);
  });

  test('passes simple object unchanged', () => {
    assert.strictEqual(sliceAtBalancedBrace('{"a":1}'), '{"a":1}');
  });

  test('strips trailing garbage', () => {
    assert.strictEqual(
      sliceAtBalancedBrace('{"a":1}garbage\n```'),
      '{"a":1}',
    );
  });

  test('respects string quoting — inner } inside string is not a close', () => {
    const raw = '{"a":"}nope"}trail';
    assert.strictEqual(sliceAtBalancedBrace(raw), '{"a":"}nope"}');
  });

  test('respects escape sequences inside strings', () => {
    const raw = '{"a":"\\"hello\\""}extra';
    assert.strictEqual(sliceAtBalancedBrace(raw), '{"a":"\\"hello\\""}');
  });

  test('returns first balanced object when two concatenated', () => {
    assert.strictEqual(sliceAtBalancedBrace('{"a":1}{"b":2}'), '{"a":1}');
  });

  test('regression: JSON with nested ``` fence in a string value then trailing prose', () => {
    const inner = { graph: { nodes: [], edges: [] }, text: 'see:\n```py\nx=1\n```\ndone' };
    const wire = JSON.stringify(inner) + '\nsome trailing text\n```\n';
    const sliced = sliceAtBalancedBrace(wire);
    assert.ok(sliced);
    const parsed = JSON.parse(sliced!);
    assert.strictEqual(parsed.text, inner.text);
  });
});

suite('jsonRepair.extractLastFencedBlock', () => {
  test('finds last cograph-result block', () => {
    const text = 'preamble\n```cograph-result\n{"a":1}\n```\nand later\n```cograph-result\n{"b":2}\n```\n';
    assert.strictEqual(extractLastFencedBlock(text, ['cograph-result']), '{"b":2}');
  });

  test('falls back to json label', () => {
    const text = 'foo\n```json\n{"x":1}\n```\n';
    assert.strictEqual(extractLastFencedBlock(text, ['cograph-result', 'json']), '{"x":1}');
  });

  test('returns null when no matching block', () => {
    assert.strictEqual(extractLastFencedBlock('no fences', ['cograph-result']), null);
  });
});

suite('jsonRepair.extractCographResult', () => {
  test('tier-1: uses structured_output when valid', () => {
    const result = extractCographResult({
      kind: 'result',
      text: 'ignored',
      structured: SAMPLE_RESULT,
    });
    assert.strictEqual(result.text, SAMPLE_RESULT.text);
    assert.strictEqual(result.graph.nodes.length, SAMPLE_RESULT.graph.nodes.length);
  });

  test('tier-2: parses plain-JSON result text', () => {
    const result = extractCographResult({
      kind: 'result',
      text: JSON.stringify(SAMPLE_RESULT) + '   \n',
    });
    assert.strictEqual(result.text, SAMPLE_RESULT.text);
  });

  test('tier-2 repair: strips trailing garbage via balanced-brace', () => {
    const result = extractCographResult({
      kind: 'result',
      text: JSON.stringify(SAMPLE_RESULT) + '\ntrailing prose that broke the old regex\n```',
    });
    assert.strictEqual(result.text, SAMPLE_RESULT.text);
  });

  test('tier-3: extracts from cograph-result fence', () => {
    const result = extractCographResult({
      kind: 'result',
      text: 'Here is the result:\n```cograph-result\n' + JSON.stringify(SAMPLE_RESULT) + '\n```\nThanks!',
    });
    assert.strictEqual(result.text, SAMPLE_RESULT.text);
  });

  test('regression: result text contains nested python fence inside JSON string', () => {
    // This reproduces the shape that broke position 9840 in production:
    // a cograph-result block whose "text" string contains a ```python...``` fence.
    const inner = {
      graph: SAMPLE_RESULT.graph,
      text: 'Here is how:\n```python\ndef foo():\n    pass\n```\nThat renames the function.',
    };
    const text = 'Sure!\n```cograph-result\n' + JSON.stringify(inner) + '\n```\n';
    const result = extractCographResult({ kind: 'result', text });
    assert.strictEqual(result.text, inner.text);
    assert.strictEqual(result.graph.nodes.length, SAMPLE_RESULT.graph.nodes.length);
  });

  test('throws with preview when every tier fails', () => {
    assert.throws(
      () => extractCographResult({ kind: 'result', text: 'nothing structured here at all' }),
      /Unable to extract graph\/text/,
    );
  });

  test('tryParseWithRepair returns null on total garbage', () => {
    assert.strictEqual(tryParseWithRepair('complete garbage no braces'), null);
  });
});

// ── ClaudeCodeProvider ────────────────────────────────────────────────────────

suite('ClaudeCodeProvider', () => {
  let sandbox: sinon.SinonSandbox;
  let tmpDir: string;

  setup(() => {
    sandbox = sinon.createSandbox();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-test-claude-'));
  });

  teardown(() => {
    sandbox.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('happy path — parses stream-json result via structured_output', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new ClaudeCodeProvider(outputChannel);

    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });

    const fakeProc = makeFakeProc();
    sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    const promise = provider.run({ prompt: 'rename foo', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir });
    emitSuccess(fakeProc, JSON.stringify(SAMPLE_RESULT), SAMPLE_RESULT);

    const result = await promise;
    assert.strictEqual(result.text, 'Renamed foo to foo_renamed.');
    assert.strictEqual(result.graph.nodes[0].name, 'foo_renamed');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.cograph', '.intelligence-request.json')));
  });

  test('tier-2 fallback: structured absent, plain JSON in result text', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new ClaudeCodeProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
    const fakeProc = makeFakeProc();
    sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    const promise = provider.run({ prompt: 'x', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir });
    emitSuccess(fakeProc, JSON.stringify(SAMPLE_RESULT));

    const result = await promise;
    assert.strictEqual(result.text, SAMPLE_RESULT.text);
  });

  test('regression: position-9840-style trailing content after JSON recovers via balanced-brace', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new ClaudeCodeProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
    const fakeProc = makeFakeProc();
    sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    // Embed the bug-shape: valid JSON plus a trailing code fence inside the result text.
    const resultText = JSON.stringify({
      graph: SAMPLE_RESULT.graph,
      text: 'Rename complete. Example:\n```python\nfoo_renamed()\n```',
    }) + '\n```\n';

    const promise = provider.run({ prompt: 'x', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir });
    emitSuccess(fakeProc, resultText);

    const result = await promise;
    assert.ok(result.text.includes('Rename complete'));
    assert.strictEqual(result.graph.nodes.length, SAMPLE_RESULT.graph.nodes.length);
  });

  test('malformed stdout — rejects with descriptive error', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new ClaudeCodeProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
    const fakeProc = makeFakeProc();
    sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    const promise = provider.run({ prompt: 'test', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir });
    emitSuccess(fakeProc, 'not JSON and no fenced block');

    await assert.rejects(promise, /Unable to extract graph\/text/);
  });

  test('missing CLI — throws descriptive error', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new ClaudeCodeProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: new Error('not found') });

    await assert.rejects(
      () => provider.run({ prompt: 'test', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir }),
      /Claude Code CLI not found/,
    );
  });

  test('CLI error result — rejects with subtype + message', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new ClaudeCodeProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
    const fakeProc = makeFakeProc();
    sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    const promise = provider.run({ prompt: 'x', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir });
    fakeProc.stdout.emit('data', Buffer.from(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_budget_usd',
        errors: [{ message: 'budget exceeded' }],
      }) + '\n',
    ));
    fakeProc.emit('close', 0);

    await assert.rejects(promise, /error_max_budget_usd.*budget exceeded/);
  });

  test('non-zero exit code — rejects', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new ClaudeCodeProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
    const fakeProc = makeFakeProc();
    sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    const promise = provider.run({ prompt: 'test', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir });
    fakeProc.emit('close', 1);

    await assert.rejects(promise, /exited with code 1/);
  });

  test('argv carries model/schema/stream flags', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new ClaudeCodeProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
    const fakeProc = makeFakeProc();
    const spawnStub = sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    const promise = provider.run({
      prompt: 'test',
      graph: SAMPLE_GRAPH,
      workspaceRoot: tmpDir,
      model: 'opus',
      effort: 'high',
      maxTurns: 5,
      maxBudgetUsd: 1.5,
    });
    emitSuccess(fakeProc, JSON.stringify(SAMPLE_RESULT), SAMPLE_RESULT);
    await promise;

    const args = spawnStub.firstCall.args[1] as string[];
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('--verbose'));
    assert.ok(args.includes('--json-schema'));
    assert.ok(args.includes('--permission-mode'));
    assert.ok(args.includes('dontAsk'));
    const modelIdx = args.indexOf('--model');
    assert.strictEqual(args[modelIdx + 1], 'opus');
    const turnsIdx = args.indexOf('--max-turns');
    assert.strictEqual(args[turnsIdx + 1], '5');
    const budgetIdx = args.indexOf('--max-budget-usd');
    assert.strictEqual(args[budgetIdx + 1], '1.5');
    const effortIdx = args.indexOf('--effort');
    assert.strictEqual(args[effortIdx + 1], 'high');
  });

  test('effort flag omitted for non-opus models', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new ClaudeCodeProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
    const fakeProc = makeFakeProc();
    const spawnStub = sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    const promise = provider.run({
      prompt: 'test', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir,
      model: 'sonnet', effort: 'high',
    });
    emitSuccess(fakeProc, JSON.stringify(SAMPLE_RESULT), SAMPLE_RESULT);
    await promise;

    const args = spawnStub.firstCall.args[1] as string[];
    assert.ok(!args.includes('--effort'), 'effort should be omitted for sonnet');
  });

  test('onProgress receives init, then result events', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new ClaudeCodeProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
    const fakeProc = makeFakeProc();
    sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    const events: ProgressEvent[] = [];
    const promise = provider.run({
      prompt: 'x', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir,
      onProgress: (e) => events.push(e),
    });
    emitSuccess(fakeProc, JSON.stringify(SAMPLE_RESULT), SAMPLE_RESULT);
    await promise;

    assert.ok(events.some(e => e.kind === 'init'));
    assert.ok(events.some(e => e.kind === 'result'));
  });
});

// ── Provider catalog ──────────────────────────────────────────────────────────

suite('Provider catalog', () => {
  test('catalog lists claude-code and codex with non-empty models', () => {
    const ids = PROVIDER_CATALOG.map(p => p.id);
    assert.ok(ids.includes('claude-code'));
    assert.ok(ids.includes('codex'));
    for (const p of PROVIDER_CATALOG) {
      assert.ok(p.models.length > 0, `${p.id} should have at least one model`);
    }
  });

  test('getProviderInfo resolves by id; unknown returns undefined', () => {
    assert.strictEqual(getProviderInfo('claude-code')?.id, 'claude-code');
    assert.strictEqual(getProviderInfo('codex')?.id, 'codex');
    assert.strictEqual(getProviderInfo('nope'), undefined);
  });

  test('findProviderForModel maps a model to its owning provider', () => {
    assert.strictEqual(findProviderForModel('sonnet')?.id, 'claude-code');
    assert.strictEqual(findProviderForModel('opus')?.id, 'claude-code');
    assert.strictEqual(findProviderForModel('gpt-5-codex')?.id, 'codex');
    assert.strictEqual(findProviderForModel('gpt-5')?.id, 'codex');
    assert.strictEqual(findProviderForModel('nonexistent'), undefined);
  });
});

// ── CodexStreamParser ─────────────────────────────────────────────────────────

suite('CodexStreamParser', () => {
  test('session_configured emits init with sessionId + model', () => {
    const events: ProgressEvent[] = [];
    const parser = new CodexStreamParser((e) => events.push(e));
    parser.feed(JSON.stringify({
      id: 's',
      msg: { type: 'session_configured', session_id: 'abc-123', model: 'gpt-5-codex' },
    }) + '\n');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'init');
    if (events[0].kind === 'init') {
      assert.strictEqual(events[0].sessionId, 'abc-123');
      assert.strictEqual(events[0].model, 'gpt-5-codex');
    }
  });

  test('agent_message_delta emits text events', () => {
    const events: ProgressEvent[] = [];
    const parser = new CodexStreamParser((e) => events.push(e));
    parser.feed(JSON.stringify({ id: '1', msg: { type: 'agent_message_delta', delta: 'Hello ' } }) + '\n');
    parser.feed(JSON.stringify({ id: '1', msg: { type: 'agent_message_delta', delta: 'world' } }) + '\n');
    const deltas = events
      .filter(e => e.kind === 'text')
      .map(e => (e as ProgressEvent & { kind: 'text' }).delta);
    assert.deepStrictEqual(deltas, ['Hello ', 'world']);
  });

  test('agent_reasoning(_delta) emits thinking truncated to 200 chars', () => {
    const events: ProgressEvent[] = [];
    const parser = new CodexStreamParser((e) => events.push(e));
    parser.feed(JSON.stringify({
      id: '1', msg: { type: 'agent_reasoning_delta', delta: 'x'.repeat(500) },
    }) + '\n');
    assert.strictEqual(events.length, 1);
    if (events[0].kind === 'thinking') {
      assert.strictEqual(events[0].snippet.length, 200);
    }
  });

  test('exec_command_begin emits tool-use Bash with summary', () => {
    const events: ProgressEvent[] = [];
    const parser = new CodexStreamParser((e) => events.push(e));
    parser.feed(JSON.stringify({
      id: '1', msg: { type: 'exec_command_begin', command: ['bash', '-c', 'ls'] },
    }) + '\n');
    assert.strictEqual(events.length, 1);
    if (events[0].kind === 'tool-use') {
      assert.strictEqual(events[0].name, 'Bash');
      assert.ok(events[0].summary.startsWith('Bash'));
    }
  });

  test('task_complete emits result with last_agent_message', () => {
    const events: ProgressEvent[] = [];
    const parser = new CodexStreamParser((e) => events.push(e));
    parser.feed(JSON.stringify({
      id: '1', msg: { type: 'task_complete', last_agent_message: JSON.stringify(SAMPLE_RESULT) },
    }) + '\n');
    assert.strictEqual(events.length, 1);
    if (events[0].kind === 'result') {
      assert.ok(events[0].text.includes('Renamed foo'));
    }
  });

  test('error events surface as kind:error with message', () => {
    const events: ProgressEvent[] = [];
    const parser = new CodexStreamParser((e) => events.push(e));
    parser.feed(JSON.stringify({ id: '1', msg: { type: 'error', message: 'boom' } }) + '\n');
    assert.strictEqual(events.length, 1);
    if (events[0].kind === 'error') {
      assert.strictEqual(events[0].message, 'boom');
    }
  });

  test('falls back to last agent_message when task_complete has no last_agent_message', () => {
    const events: ProgressEvent[] = [];
    const parser = new CodexStreamParser((e) => events.push(e));
    parser.feed(JSON.stringify({
      id: '1', msg: { type: 'agent_message', message: JSON.stringify(SAMPLE_RESULT) },
    }) + '\n');
    parser.feed(JSON.stringify({ id: '1', msg: { type: 'task_complete' } }) + '\n');
    const result = events.find(e => e.kind === 'result');
    if (result && result.kind === 'result') {
      assert.ok(result.text.includes('Renamed foo'));
    } else {
      assert.fail('expected a result event');
    }
  });

  test('ignores non-JSON banner lines', () => {
    const events: ProgressEvent[] = [];
    const parser = new CodexStreamParser((e) => events.push(e));
    parser.feed('Welcome to Codex CLI\n');
    parser.feed(JSON.stringify({
      id: '1', msg: { type: 'session_configured', session_id: 'x', model: 'gpt-5' },
    }) + '\n');
    assert.strictEqual(events.length, 1);
  });
});

// ── CodexCliProvider ──────────────────────────────────────────────────────────

suite('CodexCliProvider', () => {
  let sandbox: sinon.SinonSandbox;
  let tmpDir: string;

  setup(() => {
    sandbox = sinon.createSandbox();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-test-codex-'));
  });

  teardown(() => {
    sandbox.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Emit a canonical Codex JSON success sequence. */
  function emitCodexSuccess(proc: { stdout: EventEmitter; emit: (event: string, ...args: unknown[]) => boolean }, finalJson: string, sessionId = 'sess-x') {
    proc.stdout.emit('data', Buffer.from(
      JSON.stringify({ id: 's', msg: { type: 'session_configured', session_id: sessionId, model: 'gpt-5-codex' } }) + '\n',
    ));
    proc.stdout.emit('data', Buffer.from(
      JSON.stringify({ id: 's', msg: { type: 'task_complete', last_agent_message: finalJson } }) + '\n',
    ));
    proc.emit('close', 0);
  }

  test('happy path — parses JSON from last_agent_message + returns sessionId', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new CodexCliProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
    const fakeProc = makeFakeProc();
    sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    const promise = provider.run({ prompt: 'rename foo', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir });
    emitCodexSuccess(fakeProc, JSON.stringify(SAMPLE_RESULT), 'sess-abc');

    const result = await promise;
    assert.strictEqual(result.text, SAMPLE_RESULT.text);
    assert.strictEqual(result.sessionId, 'sess-abc');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.cograph', '.intelligence-request.json')));
  });

  test('missing CLI — throws descriptive error', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new CodexCliProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: new Error('not found') });

    await assert.rejects(
      () => provider.run({ prompt: 'test', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir }),
      /Codex CLI not found/,
    );
  });

  test('argv carries --json, --full-auto, --cd, --model and prompt', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new CodexCliProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
    const fakeProc = makeFakeProc();
    const spawnStub = sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    const promise = provider.run({
      prompt: 'q', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir, model: 'gpt-5-codex',
    });
    emitCodexSuccess(fakeProc, JSON.stringify(SAMPLE_RESULT));
    await promise;

    const args = spawnStub.firstCall.args[1] as string[];
    assert.strictEqual(args[0], 'exec', 'first arg is "exec"');
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('--full-auto'));
    assert.ok(args.includes('--skip-git-repo-check'));
    const cdIdx = args.indexOf('--cd');
    assert.strictEqual(args[cdIdx + 1], tmpDir);
    const modelIdx = args.indexOf('--model');
    assert.strictEqual(args[modelIdx + 1], 'gpt-5-codex');
    // Last argv is the prompt
    assert.ok(typeof args[args.length - 1] === 'string' && args[args.length - 1].length > 0);
  });

  test('sessionId in request adds "resume <id>" to argv', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new CodexCliProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
    const fakeProc = makeFakeProc();
    const spawnStub = sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    const promise = provider.run({
      prompt: 'cont', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir, sessionId: 'sess-prev',
    });
    emitCodexSuccess(fakeProc, JSON.stringify(SAMPLE_RESULT));
    await promise;

    const args = spawnStub.firstCall.args[1] as string[];
    assert.strictEqual(args[0], 'exec');
    assert.strictEqual(args[1], 'resume');
    assert.strictEqual(args[2], 'sess-prev');
  });

  test('error event in stream rejects with Codex prefix', async () => {
    const outputChannel = { append: sinon.stub() } as unknown as vscode.OutputChannel;
    const provider = new CodexCliProvider(outputChannel);
    sandbox.stub(rawCp, 'spawnSync').returns({ error: null });
    const fakeProc = makeFakeProc();
    sandbox.stub(rawCp, 'spawn').returns(fakeProc);

    const promise = provider.run({ prompt: 'x', graph: SAMPLE_GRAPH, workspaceRoot: tmpDir });
    fakeProc.stdout.emit('data', Buffer.from(
      JSON.stringify({ id: '1', msg: { type: 'error', message: 'rate limited' } }) + '\n',
    ));
    fakeProc.emit('close', 0);

    await assert.rejects(promise, /Codex:.*rate limited/);
  });
});
