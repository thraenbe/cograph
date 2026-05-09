import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { ChatStore, ChatMessage } from '../../graphIntelligence/chatStore';
import { ClaudeCodeProvider } from '../../graphIntelligence/claudeCodeProvider';
import { SidebarProvider, GraphController } from '../../sidebarProvider';
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

  test('append creates .cograph directory', () => {
    const msg: ChatMessage = { role: 'user', text: 'hi', at: '2026-01-01T00:00:00Z' };
    store.append(msg);
    assert.ok(fs.existsSync(path.join(tmpDir, '.cograph', 'chat.json')));
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
    const dir = path.join(tmpDir, '.cograph');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'chat.json'), 'not json', 'utf8');
    assert.deepStrictEqual(store.load(), []);
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

  test('chat-send posts user bubble, calls runGraphIntelligence, posts AI bubble', async () => {
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
    const chatStore = new ChatStore(tmpDir);
    const controller: GraphController = {
      show: sinon.stub(),
      isOpen: sinon.stub().returns(false),
      reloadLayout: sinon.stub(),
      loadGraph: sinon.stub().resolves(),
      openTimeline: sinon.stub(),
      runGraphIntelligence: async (_p: string, onProgress?: (e: ProgressEvent) => void) => {
        onProgress?.({ kind: 'init', model: 'sonnet', tools: [] });
        onProgress?.({ kind: 'text', delta: 'Working…' });
        onProgress?.({ kind: 'result', text: SAMPLE_RESULT.text, structured: SAMPLE_RESULT });
        return SAMPLE_RESULT;
      },
    };

    const provider = new SidebarProvider(vscode.Uri.file('/fake/ext'), controller, chatStore);
    const { view, webview, received } = makeFakeWebviewView();
    provider.resolveWebviewView(view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

    const handler = received[0];
    await handler({ type: 'chat-send', prompt: 'hi' });

    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const progress = calls.filter((c: { type: string }) => c.type === 'chat-progress');
    assert.strictEqual(progress.length, 3);
    assert.strictEqual(progress[0].event.kind, 'init');
    assert.strictEqual(progress[1].event.kind, 'text');
    assert.strictEqual(progress[2].event.kind, 'result');
  });

  test('chat-send posts error bubble when provider rejects', async () => {
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
  });

  test('chat-model-change writes to config and echoes chat-model-set', async () => {
    const chatStore = new ChatStore(tmpDir);
    const updateStub = sinon.stub().resolves();
    sandbox.stub(vscode.workspace, 'getConfiguration').returns({
      get: (key: string, def: unknown) => def,
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
    await handler({ type: 'chat-model-change', model: 'opus' });

    assert.ok(updateStub.calledOnce, 'should call config.update');
    assert.strictEqual(updateStub.firstCall.args[0], 'graphIntelligence.model');
    assert.strictEqual(updateStub.firstCall.args[1], 'opus');

    const calls = webview.postMessage.getCalls().map((c: sinon.SinonSpyCall) => c.args[0]);
    const modelSet = calls.find(
      (c: { type: string; model?: string }) => c.type === 'chat-model-set' && c.model === 'opus',
    );
    assert.ok(modelSet, 'should echo chat-model-set with new model');
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

