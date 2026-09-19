import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanStructure } from '../../structureScanner';
import { annotationsPath } from '../../graphIntelligence/annotationStore';
import { AnnotationService, AI_OFF_MESSAGE, describePlan, describeResult } from '../../graphIntelligence/annotationService';
import type { AnnotationHost } from '../../graphIntelligence/annotationService';
import type { AnnotationsMessage, AnnotationStatus } from '../../graphIntelligence/annotationTypes';
import type { GraphIntelligenceProvider, JsonRequest, JsonResult } from '../../graphIntelligence/provider';

const FILES = ['src/main.ts', 'src/core/a.ts', 'src/core/b.ts'];

function pathsIn(prompt: string): string[] {
  return prompt.split('\n').filter(l => l.startsWith('### ')).map(l => l.slice(4).replace(/ \(.*$/, ''));
}

function stubConfig(sandbox: sinon.SinonSandbox, values: Record<string, unknown>): void {
  sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((() => ({
    get: (key: string, dflt?: unknown) => (key in values ? values[key] : dflt),
    has: () => false,
    inspect: () => undefined,
    update: async () => undefined,
  })) as unknown as typeof vscode.workspace.getConfiguration);
}

suite('AnnotationService', () => {
  let sandbox: sinon.SinonSandbox;
  let root: string;
  let posted: AnnotationsMessage[];
  let requests: JsonRequest[];
  let signals: AbortSignal[];
  let createProvider: sinon.SinonStub;
  let host: AnnotationHost;
  let respond: (req: JsonRequest) => Promise<JsonResult>;

  setup(() => {
    sandbox = sinon.createSandbox();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-svc-'));
    for (const rel of FILES) {
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `// ${rel}\nexport const x = 1;\n`);
    }
    posted = [];
    requests = [];
    signals = [];
    respond = async (req) => ({
      data: { summaries: pathsIn(req.prompt).map(p => ({ path: p, summary: `Does ${p}.`, role: 'role' })) },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
    });
    const provider: GraphIntelligenceProvider = {
      id: 'claude-code',
      displayName: 'Claude Code',
      run: async () => { throw new Error('annotate must never use the whole-graph run()'); },
      runJson: async (req, signal) => { requests.push(req); signals.push(signal!); return respond(req); },
    };
    createProvider = sinon.stub().returns(provider);
    host = {
      getRoot: () => root,
      getStructure: () => scanStructure(root),
      getGraph: () => ({ nodes: [], edges: [] }),
      post: (m) => posted.push(m),
      log: () => undefined,
      createProvider,
    };
  });

  teardown(() => {
    sandbox.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const yes = async () => true;

  test('gate: with AI off nothing is created, confirmed or sent', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': false });
    const confirm = sinon.stub().resolves(true);
    await assert.rejects(new AnnotationService(host).annotate('claude-code', confirm), new RegExp(AI_OFF_MESSAGE));
    assert.ok(createProvider.notCalled);
    assert.ok(confirm.notCalled);
  });

  test('declining the estimate sends nothing', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    const confirm = sinon.stub().resolves(false);
    const res = await new AnnotationService(host).annotate('claude-code', confirm);
    assert.strictEqual(res, null);
    assert.ok(confirm.calledOnce);
    assert.match(confirm.firstCall.args[0], /Annotate 3 files and up to 2 folders/);
    assert.ok(createProvider.notCalled);
    assert.ok(!fs.existsSync(annotationsPath(root)));
  });

  test('a run uses the narrow call with haiku, no tools, and writes the store', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    const svc = new AnnotationService(host);
    const res = await svc.annotate('claude-code', yes);
    assert.strictEqual(res?.filesDone, 3);
    assert.strictEqual(res?.foldersDone, 2);
    assert.ok(requests.every(r => r.model === 'haiku' && r.tools === 'none' && r.systemPrompt.length > 0));
    assert.ok(requests.every(r => r.maxBudgetUsd !== undefined && r.maxBudgetUsd <= 0.25));
    const onDisk = JSON.parse(fs.readFileSync(annotationsPath(root), 'utf8'));
    assert.strictEqual(onDisk.provider, 'claude-code');
    assert.strictEqual(onDisk.model, 'haiku');
    assert.strictEqual(onDisk.files['src/main.ts'].summary, 'Does src/main.ts.');
    assert.ok(onDisk.generatedAt);
  });

  test('the webview gets annotations after every batch, without hashes', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    await new AnnotationService(host).annotate('claude-code', yes);
    assert.ok(posted.length >= requests.length);
    const last = posted[posted.length - 1];
    assert.strictEqual(last.type, 'annotations');
    assert.strictEqual(last.root, root);
    assert.strictEqual(last.aiEnabled, true);
    assert.deepStrictEqual(last.files['src/core/a.ts'], { summary: 'Does src/core/a.ts.', role: 'role' });
    assert.deepStrictEqual(last.folders['src/core'], { summary: 'Does src/core.', role: 'role' });
    assert.deepStrictEqual(last.stale, []);
  });

  test('status: running with progress and cost, then idle with a result note', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    const svc = new AnnotationService(host);
    const seen: AnnotationStatus[] = [];
    svc.onStatus(s => seen.push(s));
    await svc.annotate('claude-code', yes);
    const running = seen.filter(s => s.state === 'running' && s.done !== undefined);
    assert.ok(running.length > 0);
    assert.strictEqual(running[running.length - 1].total, 5);
    assert.ok((running[running.length - 1].costUsd ?? 0) > 0);
    const final = svc.status();
    assert.strictEqual(final.state, 'idle');
    assert.strictEqual(final.annotated, 5);
    assert.strictEqual(final.pending, 0);
    assert.match(final.note ?? '', /3 files, 2 folders · \$0\.0[0-9]/);
  });

  test('editing a file only marks summaries outdated; refresh never calls the provider', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    const svc = new AnnotationService(host);
    await svc.annotate('claude-code', yes);
    const sent = requests.length;
    fs.writeFileSync(path.join(root, 'src', 'core', 'a.ts'), '// rewritten\nexport const y = 2;\n');
    svc.refresh();
    assert.strictEqual(requests.length, sent);
    assert.deepStrictEqual([...posted[posted.length - 1].stale].sort(), ['src', 'src/core', 'src/core/a.ts']);
    assert.strictEqual(svc.status().stale, 3);
    assert.strictEqual(posted[posted.length - 1].files['src/core/a.ts'].summary, 'Does src/core/a.ts.', 'the old summary stays visible');
  });

  test('a fresh service loads the store from disk', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    await new AnnotationService(host).annotate('claude-code', yes);
    const second = new AnnotationService(host);
    second.refresh();
    assert.strictEqual(second.status().annotated, 5);
    assert.strictEqual(second.plan()?.files.length, 0);
  });

  test('status before the graph panel exists: summaries on disk are counted, pending is unknown (0)', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    await new AnnotationService(host).annotate('claude-code', yes);
    const early = new AnnotationService({ ...host, getStructure: () => undefined });
    const st = early.status();
    assert.strictEqual(st.annotated, 5);
    assert.strictEqual(st.pending, 0);
    assert.strictEqual(st.totalFiles, 0);
  });

  test('a refresh in the middle of a run (file saved) does not detach the run from the stale set', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    const svc = new AnnotationService(host);
    await svc.annotate('claude-code', yes);
    fs.writeFileSync(path.join(root, 'src', 'core', 'a.ts'), '// rewritten\nexport const y = 2;\n');
    svc.refresh();
    let refreshed = false;
    respond = async (req) => {
      if (!refreshed) { refreshed = true; svc.refresh(); } // what reparseAndPatch does on save
      return { data: { summaries: pathsIn(req.prompt).map(p => ({ path: p, summary: `Now ${p}.` })) }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } };
    };
    const res = await svc.annotate('claude-code', yes);
    assert.deepStrictEqual(res?.pending, [], 'the result is computed from the live set, not a detached copy');
    assert.strictEqual(svc.status().stale, 0);
  });

  test('nothing to do: no confirm, no provider', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    const svc = new AnnotationService(host);
    await svc.annotate('claude-code', yes);
    createProvider.resetHistory();
    const confirm = sinon.stub().resolves(true);
    assert.strictEqual(await svc.annotate('claude-code', confirm), null);
    assert.ok(confirm.notCalled && createProvider.notCalled);
    assert.strictEqual(svc.status().note, 'Everything is up to date.');
  });

  test('readSource and the Codex model setting are honoured', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true, 'graphIntelligence.annotate.readSource': true });
    await new AnnotationService(host).annotate('codex', yes);
    assert.strictEqual(requests[0].tools, 'read-only');
    assert.strictEqual(requests[0].model, 'gpt-5-mini');
    assert.ok(requests.slice(1).every(r => r.tools === 'none'), 'folder calls never read source');
  });

  test('cancel aborts the in-flight call and the run ends as cancelled', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    const svc = new AnnotationService(host);
    respond = () => new Promise((_resolve, reject) => {
      signals[signals.length - 1].addEventListener('abort', () => reject(new Error('Request cancelled.')));
      setTimeout(() => svc.cancel(), 5);
    });
    const res = await svc.annotate('claude-code', yes);
    assert.strictEqual(res?.cancelled, true);
    assert.strictEqual(svc.running, false);
    assert.match(svc.status().note ?? '', /^Cancelled/);
  });

  test('a provider error is rethrown, noted, and leaves the service idle', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    const svc = new AnnotationService(host);
    respond = async () => { throw new Error('Claude Code CLI not found on PATH.'); };
    await assert.rejects(svc.annotate('claude-code', yes), /not found on PATH/);
    assert.strictEqual(svc.running, false);
    assert.match(svc.status().note ?? '', /^Stopped: Claude Code CLI not found/);
  });

  test('a provider without runJson is rejected', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    createProvider.returns({ id: 'x', displayName: 'Old Provider', run: async () => { throw new Error('no'); } });
    await assert.rejects(new AnnotationService(host).annotate('x', yes), /Old Provider does not support Annotate Graph/);
  });

  test('no workspace or structure: refresh is a no-op and annotate explains', async () => {
    stubConfig(sandbox, { 'graphIntelligence.enabled': true });
    const svc = new AnnotationService({ ...host, getStructure: () => undefined });
    svc.refresh();
    assert.strictEqual(posted.length, 0);
    await assert.rejects(svc.annotate('claude-code', yes), /Open the CoGraph graph first/);
  });

  test('describePlan says what leaves the machine in each mode', () => {
    const plan = { files: ['a', 'b'], folders: ['c'], requests: 2, estimatedInputTokens: 1 };
    const digest = describePlan(plan, { readSource: false, maxRunBudgetUsd: 2 }, 'claude-code', 'haiku');
    assert.match(digest, /Annotate 2 files and up to 1 folders in about 2 requests with haiku/);
    assert.match(digest, /No function bodies are sent and the AI cannot open files/);
    assert.match(digest, /stops at \$2\.00/);
    assert.match(describePlan(plan, { readSource: true, maxRunBudgetUsd: 2 }, 'claude-code', 'haiku'), /may also open and read your source files/);
    const codex = describePlan(plan, { readSource: false, maxRunBudgetUsd: 2 }, 'codex', 'gpt-5-mini');
    assert.match(codex, /Codex CLI itself can read files/);
    assert.match(codex, /does not report cost/);
  });

  test('describeResult covers done, pending, budget, cancel and unknown cost', () => {
    const base = { filesDone: 3, foldersDone: 2, pending: [], costUsd: 0.123, costKnown: true, stoppedAtBudget: false, cancelled: false };
    assert.strictEqual(describeResult(base), '3 files, 2 folders · $0.12');
    assert.strictEqual(describeResult({ ...base, pending: ['x'] }), '3 files, 2 folders · $0.12 · 1 pending');
    assert.strictEqual(describeResult({ ...base, stoppedAtBudget: true, pending: ['x', 'y'] }), 'Stopped at budget · 3 files, 2 folders · $0.12 · 2 pending');
    assert.strictEqual(describeResult({ ...base, cancelled: true }), 'Cancelled · 3 files, 2 folders · $0.12');
    assert.strictEqual(describeResult({ ...base, costKnown: false }), '3 files, 2 folders · cost not reported');
  });
});
