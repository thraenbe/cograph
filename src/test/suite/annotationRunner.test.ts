import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanStructure } from '../../structureScanner';
import { emptyAnnotations, reconcile } from '../../graphIntelligence/annotationStore';
import { planRun, executeRun } from '../../graphIntelligence/annotationRunner';
import type { CallRequest, RunnerDeps, RunOptions } from '../../graphIntelligence/annotationRunner';
import type { AnnotationFile } from '../../graphIntelligence/annotationTypes';
import type { JsonResult } from '../../graphIntelligence/provider';

const FILES = ['src/main.ts', 'src/core/a.ts', 'src/core/b.ts', 'src/core/deep/c.ts', 'src/ui/view.ts'];

/** Paths a prompt asks about, read from its "### <path>" headings. */
function pathsIn(prompt: string): string[] {
  return prompt.split('\n').filter(l => l.startsWith('### ')).map(l => l.slice(4).replace(/ \(.*$/, ''));
}

interface Harness {
  deps: RunnerDeps;
  calls: CallRequest[];
  saves: number;
  ctrl: AbortController;
}

suite('annotationRunner', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-run-'));
    for (const rel of FILES) {
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `// ${rel}\nexport const x = 1;\n`);
    }
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  function harness(
    data: AnnotationFile,
    options: Partial<RunOptions> = {},
    respond?: (req: CallRequest, n: number) => Promise<JsonResult> | JsonResult,
  ): Harness {
    const tree = scanStructure(root);
    const h = { calls: [] as CallRequest[], saves: 0, ctrl: new AbortController() } as Harness;
    h.deps = {
      root, tree, data,
      graph: { nodes: [], edges: [] },
      stale: reconcile(root, tree, data).stale,
      signal: h.ctrl.signal,
      save: () => { h.saves++; },
      options: { readSource: false, maxRunBudgetUsd: 2, concurrency: 1, now: () => 'T', ...options },
      callJson: async (req) => {
        h.calls.push(req);
        if (respond) { return respond(req, h.calls.length); }
        return {
          data: { summaries: pathsIn(req.prompt).map(p => ({ path: p, summary: `Does ${p}.`, role: 'test role' })) },
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
        };
      },
    };
    return h;
  }

  test('plan: everything is pending on a fresh repo, shallow files first', () => {
    const tree = scanStructure(root);
    const plan = planRun(root, tree, emptyAnnotations(), new Set(), { readSource: false, maxRunBudgetUsd: 2 });
    assert.strictEqual(path.basename(plan.files[0]), 'main.ts');
    assert.strictEqual(path.basename(plan.files[plan.files.length - 1]), 'c.ts');
    assert.strictEqual(plan.files.length, 5);
    assert.strictEqual(plan.folders.length, 4); // src, src/core, src/core/deep, src/ui
    assert.strictEqual(plan.requests, 1 + 3, 'one file batch + one folder call per depth level');
    assert.ok(plan.estimatedInputTokens > 0);
  });

  test('plan: read-source mode uses small batches', () => {
    const plan = planRun(root, scanStructure(root), emptyAnnotations(), new Set(), { readSource: true, maxRunBudgetUsd: 2, fileBatchSize: 2 });
    assert.strictEqual(plan.requests, 3 + 3);
  });

  test('a full run annotates every file and folder, children before parents, saving after each batch', async () => {
    const data = emptyAnnotations();
    const h = harness(data);
    const progress: number[] = [];
    h.deps.onProgress = p => progress.push(p.done);
    const res = await executeRun(h.deps);

    assert.strictEqual(res.filesDone, 5);
    assert.strictEqual(res.foldersDone, 4);
    assert.deepStrictEqual(res.pending, []);
    assert.strictEqual(Object.keys(data.files).length, 5);
    assert.strictEqual(data.files['src/main.ts'].summary, 'Does src/main.ts.');
    assert.match(data.files['src/main.ts'].hash, /^[0-9a-f]{40}$/);
    assert.strictEqual(data.folders['src/core'].at, 'T');

    const order = h.calls.map(c => pathsIn(c.prompt));
    assert.deepStrictEqual(order[1], ['src/core/deep'], 'deepest folder level first');
    assert.deepStrictEqual(order[3], ['src'], 'root folder last');
    assert.ok(h.calls[2].prompt.includes('- deep/: Does src/core/deep.'), 'parents read their child folder summaries');
    assert.strictEqual(h.saves, h.calls.length);
    assert.ok(Math.abs(res.costUsd - 0.04) < 1e-9);
    assert.deepStrictEqual(progress, [...progress].sort((a, b) => a - b));
    assert.strictEqual(progress[progress.length - 1], 9);
    assert.ok(h.calls.every(c => c.tools === 'none'));
  });

  test('a second run is free: nothing is sent when everything is fresh', async () => {
    const data = emptyAnnotations();
    await executeRun(harness(data).deps);
    const again = harness(data);
    const res = await executeRun(again.deps);
    assert.strictEqual(again.calls.length, 0);
    assert.strictEqual(res.filesDone + res.foldersDone, 0);
  });

  test('an update re-annotates only the changed file and its ancestors', async () => {
    const data = emptyAnnotations();
    await executeRun(harness(data).deps);
    fs.writeFileSync(path.join(root, 'src', 'core', 'deep', 'c.ts'), '// rewritten\nexport const y = 2;\n');
    const upd = harness(data, {}, (req) => ({
      data: { summaries: pathsIn(req.prompt).map(p => ({ path: p, summary: `Now ${p}.` })) },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
    }));
    assert.deepStrictEqual([...upd.deps.stale].sort(), ['src', 'src/core', 'src/core/deep', 'src/core/deep/c.ts']);
    const res = await executeRun(upd.deps);
    assert.deepStrictEqual(upd.calls.map(c => pathsIn(c.prompt)), [['src/core/deep/c.ts'], ['src/core/deep'], ['src/core'], ['src']]);
    assert.strictEqual(data.files['src/main.ts'].summary, 'Does src/main.ts.', 'untouched file keeps its summary');
    assert.strictEqual(data.folders['src/ui'].summary, 'Does src/ui.', 'untouched folder keeps its summary');
    assert.deepStrictEqual(res.pending, []);
  });

  test('stops at the run budget and keeps what is done', async () => {
    const data = emptyAnnotations();
    const h = harness(data, { maxRunBudgetUsd: 1, fileBatchSize: 1 }, (req) => ({
      data: { summaries: pathsIn(req.prompt).map(p => ({ path: p, summary: 'S.' })) },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.6 },
    }));
    const res = await executeRun(h.deps);
    assert.strictEqual(h.calls.length, 2, '0.6 then 1.2 >= 1 → no third call');
    assert.strictEqual(res.stoppedAtBudget, true);
    assert.strictEqual(res.filesDone, 2);
    assert.strictEqual(Object.keys(data.files).length, 2);
    assert.ok(res.pending.length > 0);
  });

  test('each call gets a budget no larger than what is left of the run', async () => {
    const h = harness(emptyAnnotations(), { maxRunBudgetUsd: 0.1, fileBatchSize: 1 }, (req) => ({
      data: { summaries: pathsIn(req.prompt).map(p => ({ path: p, summary: 'S.' })) },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.04 },
    }));
    await executeRun(h.deps);
    assert.deepStrictEqual(h.calls.map(c => Number(c.maxBudgetUsd.toFixed(2))), [0.1, 0.06, 0.02]);
  });

  test('cancel is a normal outcome: no throw, partial results kept', async () => {
    const data = emptyAnnotations();
    const h = harness(data, { fileBatchSize: 2 }, async (req, n) => {
      if (n === 2) { h.ctrl.abort(); throw new Error('Request cancelled.'); }
      return { data: { summaries: pathsIn(req.prompt).map(p => ({ path: p, summary: 'S.' })) }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } };
    });
    const res = await executeRun(h.deps);
    assert.strictEqual(res.cancelled, true);
    assert.strictEqual(res.filesDone, 2);
    assert.strictEqual(h.calls.length, 2);
  });

  test('a provider error stops the run, keeps finished batches and is rethrown', async () => {
    const data = emptyAnnotations();
    const h = harness(data, { fileBatchSize: 2 }, (req, n) => {
      if (n === 2) { throw new Error('Claude Code: error_auth — not logged in'); }
      return { data: { summaries: pathsIn(req.prompt).map(p => ({ path: p, summary: 'S.' })) }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } };
    });
    await assert.rejects(executeRun(h.deps), /not logged in/);
    assert.strictEqual(h.calls.length, 2, 'no further batches after an error');
    assert.strictEqual(Object.keys(data.files).length, 2);
  });

  test('a path the model skips is retried once, then left pending', async () => {
    const data = emptyAnnotations();
    const h = harness(data, {}, (req) => ({
      data: { summaries: pathsIn(req.prompt).filter(p => p !== 'src/ui/view.ts').map(p => ({ path: p, summary: 'S.' })) },
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
    }));
    const res = await executeRun(h.deps);
    assert.deepStrictEqual(pathsIn(h.calls[1].prompt), ['src/ui/view.ts'], 'second call is the retry');
    assert.ok(res.pending.includes('src/ui/view.ts'));
    assert.ok(res.pending.includes('src/ui'), 'a folder with no summarised child stays pending');
    assert.strictEqual(data.files['src/ui/view.ts'], undefined);
  });

  test('a provider without usage: cost unknown, budget not enforced', async () => {
    const h = harness(emptyAnnotations(), { maxRunBudgetUsd: 0.0001 }, (req) => ({
      data: { summaries: pathsIn(req.prompt).map(p => ({ path: p, summary: 'S.' })) },
    }));
    const res = await executeRun(h.deps);
    assert.strictEqual(res.costKnown, false);
    assert.strictEqual(res.stoppedAtBudget, false);
    assert.deepStrictEqual(res.pending, []);
  });

  test('read-source mode grants read-only tools for files only', async () => {
    const h = harness(emptyAnnotations(), { readSource: true });
    await executeRun(h.deps);
    assert.strictEqual(h.calls[0].tools, 'read-only');
    assert.ok(h.calls.slice(1).every(c => c.tools === 'none'), 'folders never read source');
  });

  test('batches run in parallel up to the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const h = harness(emptyAnnotations(), { fileBatchSize: 1, concurrency: 3 }, async (req) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return { data: { summaries: pathsIn(req.prompt).map(p => ({ path: p, summary: 'S.' })) }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } };
    });
    await executeRun(h.deps);
    assert.strictEqual(peak, 3);
  });
});
