import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { ChatStore, ChatMessage } from '../../graphIntelligence/chatStore';
import { ClaudeCodeProvider } from '../../graphIntelligence/claudeCodeProvider';
import { CodexCliProvider, CodexStreamParser } from '../../graphIntelligence/codexCliProvider';
import { SidebarProvider, GraphController } from '../../sidebarProvider';
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

// ── ChatStore ─────────────────────────────────────────────────────────────────

suite('ChatStore', () => {
  let tmpDir: string;
  let store: ChatStore;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-test-chat-'));
    store = new ChatStore(tmpDir);
  });

  teardown(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('load returns empty array when no file exists', () => {
    assert.deepStrictEqual(store.load(), []);
  });

  test('append and load round-trip', () => {
    const msg: ChatMessage = { role: 'user', text: 'hello', at: '2026-01-01T00:00:00Z' };
    store.append(msg);
    const loaded = store.load();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].text, 'hello');
  });

  test('append creates per-graph chat directory', () => {
    const msg: ChatMessage = { role: 'user', text: 'hi', at: '2026-01-01T00:00:00Z' };
    store.append(msg);
    assert.ok(fs.existsSync(path.join(tmpDir, '.cograph', 'chats', '__default__.json')));
  });

  test('clear removes the file', () => {
    store.append({ role: 'user', text: 'hi', at: '2026-01-01T00:00:00Z' });
    store.clear();
    assert.deepStrictEqual(store.load(), []);
  });

  test('caps at 200 messages', () => {
    for (let i = 0; i < 210; i++) {
      store.append({ role: 'user', text: `msg${i}`, at: '2026-01-01T00:00:00Z' });
    }
    const loaded = store.load();
    assert.strictEqual(loaded.length, 200);
    assert.strictEqual(loaded[0].text, 'msg10');
  });

  test('tolerates malformed JSON', () => {
    const dir = path.join(tmpDir, '.cograph', 'chats');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '__default__.json'), 'not json', 'utf8');
    assert.deepStrictEqual(store.load(), []);
  });

  test('per-graph: keys isolate messages', () => {
    store.setActive('Graph A');
    store.append({ role: 'user', text: 'a-only', at: '2026-01-01T00:00:00Z' });
    store.setActive('Graph B');
    store.append({ role: 'user', text: 'b-only', at: '2026-01-01T00:00:00Z' });
    store.setActive('Graph A');
    assert.deepStrictEqual(store.load().map(m => m.text), ['a-only']);
    store.setActive('Graph B');
    assert.deepStrictEqual(store.load().map(m => m.text), ['b-only']);
  });

  test('sessionId round-trip per key, per provider', () => {
    store.setActive('G');
    assert.strictEqual(store.getSessionId('claude-code'), null);
    store.setSessionId('claude-code', 'uuid-claude');
    store.setSessionId('codex', 'uuid-codex');
    assert.strictEqual(store.getSessionId('claude-code'), 'uuid-claude');
    assert.strictEqual(store.getSessionId('codex'), 'uuid-codex');
    // Clearing just one provider leaves the other untouched.
    store.clearSession('claude-code');
    assert.strictEqual(store.getSessionId('claude-code'), null);
    assert.strictEqual(store.getSessionId('codex'), 'uuid-codex');
    // Clearing with no provider wipes all sessions for this key.
    store.clearSession();
    assert.strictEqual(store.getSessionId('codex'), null);
  });

  test('legacy sessionId field is migrated to claude-code slot', () => {
    store.setActive('Legacy');
    const dir = path.join(tmpDir, '.cograph', 'chats');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'Legacy.json'),
      JSON.stringify({ sessionId: 'old-uuid', messages: [] }),
      'utf8',
    );
    assert.strictEqual(store.getSessionId('claude-code'), 'old-uuid');
  });

  test('migrates legacy .cograph/chat.json on construction', () => {
    // Start fresh so the per-default file doesn't already exist.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-migrate-'));
    try {
      fs.mkdirSync(path.join(fresh, '.cograph'), { recursive: true });
      const legacyMsgs = [{ role: 'user', text: 'legacy-hi', at: '2026-01-01T00:00:00Z' }];
      fs.writeFileSync(path.join(fresh, '.cograph', 'chat.json'), JSON.stringify(legacyMsgs), 'utf8');

      const migrated = new ChatStore(fresh);
      assert.deepStrictEqual(migrated.load().map(m => m.text), ['legacy-hi']);
      assert.ok(fs.existsSync(path.join(fresh, '.cograph', 'chat.json.bak')), 'legacy file should be renamed to .bak');
      assert.ok(!fs.existsSync(path.join(fresh, '.cograph', 'chat.json')), 'old chat.json should be removed');
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

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

// ── Sidebar chat handler ──────────────────────────────────────────────────────

suite('Sidebar chat handler', () => {
  let sandbox: sinon.SinonSandbox;
  let tmpDir: string;

  setup(() => {
    sandbox = sinon.createSandbox();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-test-sidebar-'));
  });

  teardown(() => {
    sandbox.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeFakeWebviewView() {
    const received: Array<(msg: unknown) => void | Promise<void>> = [];
    const webview = {
      options: {} as object,
      html: '',
      postMessage: sinon.stub().resolves(true),
      onDidReceiveMessage: sinon.stub().callsFake((cb: (m: unknown) => void) => {
        received.push(cb);
        return { dispose: () => {} };
      }),
      asWebviewUri: sinon.stub().callsFake((uri: vscode.Uri) => uri),
      cspSource: 'vscode-resource:',
    };
    const view = {
      webview,
      onDidDispose: sinon.stub().returns({ dispose: () => {} }),
    } as unknown as vscode.WebviewView;
    return { view, webview, received };
  }

  // Opt into AI features so chat-send isn't short-circuited by the consent gate.
  // Other keys fall back to their provided default.
  function enableAi() {
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, def: unknown) => (key === 'graphIntelligence.enabled' ? true : def),
      update: sinon.stub().resolves(),
      has: () => false,
      inspect: () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);
  }

  test('chat-send posts user bubble, calls runGraphIntelligence, posts AI bubble', async () => {
    enableAi();
    const chatStore = new ChatStore(tmpDir);
    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
      runGraphIntelligence: sinon.stub().resolves(SAMPLE_RESULT),
    };

    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, webview, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    provider.setCurrentGraph({ name: 'TestGraph', file: path.join(tmpDir, '.cograph', 'TestGraph.json') });

    const handler = received[0];
    await handler({ type: 'chat-send', prompt: 'rename foo' });

    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const types = calls.map((c: { type: string }) => c.type);

    assert.ok(types.includes('chat-append'), 'should post chat-append');
    assert.ok(types.includes('chat-status'), 'should post chat-status');

    const appends = calls.filter((c: { type: string }) => c.type === 'chat-append');
    assert.strictEqual(appends.length, 2);
    assert.strictEqual(appends[0].message.role, 'user');
    assert.strictEqual(appends[1].message.role, 'assistant');
    assert.strictEqual(appends[1].message.text, 'Renamed foo to foo_renamed.');

    const statuses = calls.filter((c: { type: string }) => c.type === 'chat-status');
    assert.ok(statuses.some((s: { stage: string }) => s.stage === 'thinking'));
    assert.ok(statuses.some((s: { stage: string }) => s.stage === 'idle'));
  });

  test('chat-send forwards provider progress events as chat-progress messages', async () => {
    enableAi();
    const chatStore = new ChatStore(tmpDir);
    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
      runGraphIntelligence: async (_p: string, _pid: string, _sid: string | null, onProgress?: (e: ProgressEvent) => void) => {
        onProgress?.({ kind: 'init', model: 'sonnet', tools: [] });
        onProgress?.({ kind: 'text', delta: 'Working…' });
        onProgress?.({ kind: 'result', text: SAMPLE_RESULT.text, structured: SAMPLE_RESULT });
        return SAMPLE_RESULT;
      },
    };

    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, webview, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    provider.setCurrentGraph({ name: 'TestGraph', file: path.join(tmpDir, '.cograph', 'TestGraph.json') });

    const handler = received[0];
    await handler({ type: 'chat-send', prompt: 'hi' });

    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const progress = calls.filter((c: { type: string }) => c.type === 'chat-progress');
    assert.strictEqual(progress.length, 3);
    assert.strictEqual(progress[0].event.kind, 'init');
    assert.strictEqual(progress[1].event.kind, 'text');
    assert.strictEqual(progress[2].event.kind, 'result');
  });

  test('chat-send is blocked when no graph is selected; opens picker, restores input', async () => {
    enableAi();
    const chatStore = new ChatStore(tmpDir);
    const runStub = sinon.stub().resolves(SAMPLE_RESULT);
    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
      runGraphIntelligence: runStub,
    };

    // User cancels the picker.
    const pickerStub = sandbox.stub(vscode.window, 'showQuickPick').resolves(undefined);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file(tmpDir) }]);

    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, webview, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    // No setCurrentGraph call — _currentGraph stays null.

    const handler = received[0];
    await handler({ type: 'chat-send', prompt: 'will be blocked' });

    assert.strictEqual(runStub.callCount, 0, 'runGraphIntelligence should NOT be invoked');
    assert.ok(pickerStub.calledOnce, 'graph picker should open');

    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const types = calls.map((c: { type: string }) => c.type);
    assert.ok(types.includes('chat-status'), 'chat-status should be posted');
    const idle = calls.find((c: { type: string; stage?: string }) => c.type === 'chat-status' && c.stage === 'idle');
    assert.ok(idle, 'chat-status: idle should be posted');
    const restore = calls.find((c: { type: string; text?: string }) => c.type === 'chat-input-restore');
    assert.ok(restore, 'chat-input-restore should be posted');
    assert.strictEqual((restore as { text: string }).text, 'will be blocked');
  });

  test('chat-send posts error bubble when provider rejects', async () => {
    enableAi();
    const chatStore = new ChatStore(tmpDir);
    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
      runGraphIntelligence: sinon.stub().rejects(new Error('boom')),
    };

    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, webview, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    provider.setCurrentGraph({ name: 'TestGraph', file: path.join(tmpDir, '.cograph', 'TestGraph.json') });

    const handler = received[0];
    await handler({ type: 'chat-send', prompt: 'test' });

    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const appends = calls.filter((c: { type: string }) => c.type === 'chat-append');
    assert.strictEqual(appends.length, 2);
    assert.strictEqual(appends[0].message.role, 'user');
    assert.strictEqual(appends[1].message.role, 'error');
    assert.ok(appends[1].message.text.includes('boom'));
  });

  test('ready posts chat-history and chat-model-set', async () => {
    const chatStore = new ChatStore(tmpDir);
    chatStore.append({ role: 'user', text: 'hello', at: '2026-01-01T00:00:00Z' });

    sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { uri: vscode.Uri.file(tmpDir) },
    ]);

    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
    };

    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, webview, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

    const handler = received[0];
    await handler({ type: 'ready' });

    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const history = calls.find((c: { type: string }) => c.type === 'chat-history');
    assert.ok(history, 'should post chat-history');
    assert.strictEqual(history.messages.length, 1);
    assert.strictEqual(history.messages[0].text, 'hello');

    const modelSet = calls.find((c: { type: string }) => c.type === 'chat-model-set');
    assert.ok(modelSet, 'should post chat-model-set');
    assert.ok(typeof modelSet.model === 'string');
    assert.ok(typeof modelSet.provider === 'string', 'chat-model-set should include provider id');

    const catalog = calls.find((c: { type: string }) => c.type === 'provider-catalog');
    assert.ok(catalog, 'ready should also push the provider catalog');
    assert.ok(Array.isArray(catalog.catalog) && catalog.catalog.length >= 2);
  });

  test('chat-set-session writes session id and appends a system bubble', async () => {
    const chatStore = new ChatStore(tmpDir);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file(tmpDir) }]);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (_k: string, def: unknown) => def,
      update: sinon.stub().resolves(),
      has: () => false,
      inspect: () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);
    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
    };
    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, webview, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    provider.setCurrentGraph({ name: 'G', file: path.join(tmpDir, '.cograph', 'G.json') });

    const handler = received[0];
    await handler({ type: 'chat-set-session', sessionId: 'sess-12345678abc' });

    // Stored under the active key + active provider (default: claude-code).
    assert.strictEqual(chatStore.getSessionId('claude-code'), 'sess-12345678abc');
    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const sys = calls.find((c: { type: string; message?: ChatMessage }) =>
      c.type === 'chat-append' && c.message?.role === 'system' && /Resume:/.test(c.message.text),
    );
    assert.ok(sys, 'should append a system bubble describing the attach');
  });

  test('chat-show-cost without prior usage emits a system "no usage" message', async () => {
    const chatStore = new ChatStore(tmpDir);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file(tmpDir) }]);
    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
    };
    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, webview, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    const handler = received[0];

    await handler({ type: 'chat-show-cost' });

    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const sys = calls.find((c: { type: string; message?: ChatMessage }) =>
      c.type === 'chat-append' && c.message?.role === 'system' && /no usage data yet/.test(c.message.text),
    );
    assert.ok(sys, 'should emit the no-data message');
  });

  test('chat-show-cost after a successful turn reports tokens + cost', async () => {
    const chatStore = new ChatStore(tmpDir);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file(tmpDir) }]);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, def: unknown) => {
        if (key === 'graphIntelligence.enabled') { return true; }
        if (key === 'graphIntelligence.provider') { return 'claude-code'; }
        if (key === 'graphIntelligence.model') { return 'sonnet'; }
        return def;
      },
      update: sinon.stub().resolves(),
      has: () => false,
      inspect: () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);
    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
      runGraphIntelligence: async (_p: string, _pid: string, _sid: string | null, onProgress?: (e: ProgressEvent) => void) => {
        onProgress?.({
          kind: 'result',
          text: SAMPLE_RESULT.text,
          structured: SAMPLE_RESULT,
          usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0.042 },
        });
        return SAMPLE_RESULT;
      },
    };
    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, webview, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    provider.setCurrentGraph({ name: 'G', file: path.join(tmpDir, '.cograph', 'G.json') });
    const handler = received[0];

    await handler({ type: 'chat-send', prompt: 'q' });
    webview.postMessage.resetHistory();
    await handler({ type: 'chat-show-cost' });

    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const sys = calls.find((c: { type: string; message?: ChatMessage }) =>
      c.type === 'chat-append' && c.message?.role === 'system' && /Cost:/.test(c.message.text),
    );
    assert.ok(sys, 'should emit a Cost: bubble');
    assert.ok(/1\.2k in/.test(sys.message.text));
    assert.ok(/\$0\.042/.test(sys.message.text));
  });

  test('chat-provider-change writes provider only and echoes chat-model-set', async () => {
    const chatStore = new ChatStore(tmpDir);
    const cfg = new Map<string, unknown>();
    const updateStub = sinon.stub().callsFake(async (k: string, v: unknown) => { cfg.set(k, v); });
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, def: unknown) => cfg.has(key) ? cfg.get(key) : def,
      update: updateStub,
      has: () => false,
      inspect: () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file(tmpDir) }]);
    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
    };
    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, webview, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    const handler = received[0];

    await handler({ type: 'chat-provider-change', provider: 'codex' });

    const writes = updateStub.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    assert.deepStrictEqual(writes, ['graphIntelligence.provider']);
    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const set = calls.find((c: { type: string; provider?: string }) => c.type === 'chat-model-set' && c.provider === 'codex');
    assert.ok(set, 'should echo chat-model-set with provider=codex');
  });

  test('chat-send threads provider+session through the controller and persists the new session id', async () => {
    const chatStore = new ChatStore(tmpDir);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([{ uri: vscode.Uri.file(tmpDir) }]);
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, def: unknown) => {
        if (key === 'graphIntelligence.enabled') { return true; }
        if (key === 'graphIntelligence.provider') { return 'codex'; }
        return def;
      },
      update: sinon.stub().resolves(),
      has: () => false,
      inspect: () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);

    const captured: { providerId?: string; sessionId?: string | null } = {};
    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
      runGraphIntelligence: async (_p: string, providerId: string, sessionId: string | null) => {
        captured.providerId = providerId;
        captured.sessionId = sessionId;
        return { ...SAMPLE_RESULT, sessionId: 'sess-new' };
      },
    };
    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    provider.setCurrentGraph({ name: 'G', file: path.join(tmpDir, '.cograph', 'G.json') });

    // Pre-seed a codex session for "G" so we can verify it's read on send.
    chatStore.setActive(ChatStore.keyFromName('G'));
    chatStore.setSessionId('codex', 'sess-old');

    const handler = received[0];
    await handler({ type: 'chat-send', prompt: 'hi' });

    assert.strictEqual(captured.providerId, 'codex', 'controller received provider id from settings');
    assert.strictEqual(captured.sessionId, 'sess-old', 'controller received the prior session id');
    // After the run, the new session id should be persisted under the same (graph, provider).
    assert.strictEqual(chatStore.getSessionId('codex'), 'sess-new');
    // Claude side untouched.
    assert.strictEqual(chatStore.getSessionId('claude-code'), null);
  });

  test('chat-model-change writes provider+model to config and echoes chat-model-set', async () => {
    const chatStore = new ChatStore(tmpDir);
    // Stand-in config: writes are persisted into a local map so subsequent reads
    // (used by _sendActiveModel) see the new values.
    const cfg = new Map<string, unknown>();
    const updateStub = sinon.stub().callsFake(async (k: string, v: unknown) => { cfg.set(k, v); });
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, def: unknown) => cfg.has(key) ? cfg.get(key) : def,
      update: updateStub,
      has: () => false,
      inspect: () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { uri: vscode.Uri.file(tmpDir) },
    ]);

    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
    };

    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, webview, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

    const handler = received[0];
    // Picking 'opus' implies provider=claude-code; the handler resolves it.
    await handler({ type: 'chat-model-change', model: 'opus' });

    const writes = updateStub.getCalls().map((c: sinon.SinonSpyCall) => ({ key: c.args[0], value: c.args[1] }));
    assert.deepStrictEqual(
      writes,
      [
        { key: 'graphIntelligence.provider', value: 'claude-code' },
        { key: 'graphIntelligence.model', value: 'opus' },
      ],
      'should write both provider and model settings',
    );

    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const modelSet = calls.find(
      (c: { type: string; provider?: string; model?: string }) =>
        c.type === 'chat-model-set' && c.provider === 'claude-code' && c.model === 'opus',
    );
    assert.ok(modelSet, 'should echo chat-model-set with new provider+model');
  });

  test('chat-model-change to a codex model switches provider AND writes codex.model', async () => {
    const chatStore = new ChatStore(tmpDir);
    const cfg = new Map<string, unknown>();
    const updateStub = sinon.stub().callsFake(async (k: string, v: unknown) => { cfg.set(k, v); });
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, def: unknown) => cfg.has(key) ? cfg.get(key) : def,
      update: updateStub,
      has: () => false,
      inspect: () => undefined,
    } as unknown as vscode.WorkspaceConfiguration);
    sandbox.stub(vscode.workspace, 'workspaceFolders').value([
      { uri: vscode.Uri.file(tmpDir) },
    ]);
    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
    };

    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, webview, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    const handler = received[0];

    await handler({ type: 'chat-model-change', model: 'gpt-5-codex' });

    const writes = updateStub.getCalls().map((c: sinon.SinonSpyCall) => ({ key: c.args[0], value: c.args[1] }));
    assert.deepStrictEqual(writes, [
      { key: 'graphIntelligence.provider', value: 'codex' },
      { key: 'graphIntelligence.codex.model', value: 'gpt-5-codex' },
    ]);

    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const modelSet = calls.find(
      (c: { type: string; provider?: string; model?: string }) =>
        c.type === 'chat-model-set' && c.provider === 'codex' && c.model === 'gpt-5-codex',
    );
    assert.ok(modelSet, 'should echo chat-model-set for codex/gpt-5-codex');
  });

  test('chat-open-settings executes workbench.action.openSettings', async () => {
    const chatStore = new ChatStore(tmpDir);
    const execStub = sandbox.stub(vscode.commands, 'executeCommand').resolves();

    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
    };

    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

    const handler = received[0];
    await handler({ type: 'chat-open-settings' });

    assert.ok(execStub.calledWith('workbench.action.openSettings', 'cograph.graphIntelligence'));
  });
});

suite('webview/markdown.js', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const { renderMarkdown } = require('../../../src/webview/markdown.js') as { renderMarkdown: (s?: string) => string };

  test('empty / undefined input returns empty string', () => {
    assert.strictEqual(renderMarkdown(''), '');
    assert.strictEqual(renderMarkdown(undefined), '');
  });

  test('plain text becomes a <p>', () => {
    assert.strictEqual(renderMarkdown('hello world'), '<p>hello world</p>');
  });

  test('## heading → <h2>, ### → <h3>', () => {
    assert.ok(renderMarkdown('## Title').includes('<h2>Title</h2>'));
    assert.ok(renderMarkdown('### Sub').includes('<h3>Sub</h3>'));
  });

  test('unordered list', () => {
    const out = renderMarkdown('- a\n- b');
    assert.ok(out.includes('<ul>'));
    assert.ok(out.includes('<li>a</li>'));
    assert.ok(out.includes('<li>b</li>'));
  });

  test('ordered list', () => {
    const out = renderMarkdown('1. a\n2. b');
    assert.ok(out.startsWith('<ol>'));
    assert.ok(out.includes('<li>a</li><li>b</li>'));
  });

  test('fenced code block preserves content and emits copy button + lang class', () => {
    const out = renderMarkdown('```ts\nconst x = 1;\n```');
    assert.ok(out.includes('<pre>'));
    assert.ok(out.includes('class="code-copy"'));
    assert.ok(out.includes('<code class="lang-ts">'));
    assert.ok(out.includes('const x = 1;'));
  });

  test('inline code is wrapped in <code>; surrounding text is not', () => {
    const out = renderMarkdown('a `b` c');
    assert.ok(out.includes('<code>b</code>'));
    assert.ok(/<p>a <code>b<\/code> c<\/p>/.test(out));
  });

  test('bold and italic', () => {
    assert.ok(renderMarkdown('**big**').includes('<strong>big</strong>'));
    assert.ok(renderMarkdown('an *emph* word').includes('<em>emph</em>'));
  });

  test('link syntax → anchor with target/rel', () => {
    const out = renderMarkdown('see [docs](https://example.com)');
    assert.ok(out.includes('<a href="https://example.com" target="_blank" rel="noreferrer">docs</a>'));
  });

  test('escapes HTML — no live <script> in output', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    assert.ok(!/[<]script[>]/i.test(out));
    assert.ok(out.includes('&lt;script&gt;'));
  });

  test('unsafe content inside code fence stays escaped', () => {
    const out = renderMarkdown('```\n<script>x</script>\n```');
    assert.ok(!/[<]script[>]/i.test(out));
    assert.ok(out.includes('&lt;script&gt;x&lt;/script&gt;'));
  });

  test('mixed real example contains heading, paragraph, list, fenced code in order', () => {
    const out = renderMarkdown('## Title\n\nsome prose\n\n- one\n- two\n\n```ts\nx\n```');
    const i1 = out.indexOf('<h2>');
    const i2 = out.indexOf('<p>');
    const i3 = out.indexOf('<ul>');
    const i4 = out.indexOf('<pre>');
    assert.ok(i1 >= 0 && i2 > i1 && i3 > i2 && i4 > i3, 'blocks should appear in markdown order');
  });

  test('horizontal rule', () => {
    assert.ok(renderMarkdown('---').includes('<hr/>'));
  });

  test('blockquote', () => {
    assert.ok(renderMarkdown('> quoted').includes('<blockquote>quoted</blockquote>'));
  });
});

