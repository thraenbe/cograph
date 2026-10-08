import * as assert from 'assert';
import { CodexStreamParser } from '../../graphIntelligence/codexCliProvider';
import { StreamJsonParser, summarizeToolInput, ProgressEvent } from '../../graphIntelligence/progressParser';
import { sliceAtBalancedBrace } from '../../graphIntelligence/jsonRepair';

/** Any JSON object the CLI's final message may carry. */
const SAMPLE_REPLY = { summaries: [{ path: 'src/a.py', summary: 'Parses the config.' }] };

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

suite('CodexStreamParser', () => {
  test('session_configured emits init with the model', () => {
    const events: ProgressEvent[] = [];
    const parser = new CodexStreamParser((e) => events.push(e));
    parser.feed(JSON.stringify({
      id: 's',
      msg: { type: 'session_configured', session_id: 'abc-123', model: 'gpt-5-codex' },
    }) + '\n');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].kind, 'init');
    if (events[0].kind === 'init') {
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
      id: '1', msg: { type: 'task_complete', last_agent_message: JSON.stringify(SAMPLE_REPLY) },
    }) + '\n');
    assert.strictEqual(events.length, 1);
    if (events[0].kind === 'result') {
      assert.ok(events[0].text.includes('Parses the config'));
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
      id: '1', msg: { type: 'agent_message', message: JSON.stringify(SAMPLE_REPLY) },
    }) + '\n');
    parser.feed(JSON.stringify({ id: '1', msg: { type: 'task_complete' } }) + '\n');
    const result = events.find(e => e.kind === 'result');
    if (result && result.kind === 'result') {
      assert.ok(result.text.includes('Parses the config'));
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
