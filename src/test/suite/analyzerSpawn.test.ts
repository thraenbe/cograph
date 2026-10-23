import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ANALYZER_SCRIPTS, spawnAnalyzer, spawnAnalyzers } from '../../analyzerSpawn';

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');

function tempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spawn-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

suite('analyzerSpawn', () => {
  test('a full pass outside VS Code merges every language the directory holds', async function () {
    this.timeout(60_000);
    const dir = tempProject({
      'src/app.ts': 'export function main() { helper(); }\nexport function helper() {}\n',
      'py/tool.py': 'def run():\n    step()\n\ndef step():\n    pass\n',
    });
    try {
      const { graph, statuses } = await spawnAnalyzers(dir, { scriptsDir: SCRIPTS, pythonBin: 'python3' });
      assert.deepStrictEqual(statuses.map(s => s.lang), ANALYZER_SCRIPTS.map(s => s.lang));
      const names = graph.nodes.filter(n => !n.isLibrary).map(n => n.name).sort();
      for (const name of ['helper', 'main', 'run', 'step']) { assert.ok(names.includes(name), `${name} in ${names.join(',')}`); }
      assert.ok(graph.edges.length >= 2);
      assert.ok(statuses.every(s => s.status === 'ok' || s.status === 'empty'), JSON.stringify(statuses.map(s => [s.lang, s.status, s.detail])));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without a Python interpreter the Python analyzer is a spawn error, the rest still run', async function () {
    this.timeout(60_000);
    const dir = tempProject({ 'a.ts': 'export function f() {}\n' });
    try {
      const { graph, statuses } = await spawnAnalyzers(dir, { scriptsDir: SCRIPTS, pythonBin: null });
      assert.strictEqual(statuses.find(s => s.lang === 'python')?.status, 'spawn-error');
      assert.ok(graph.nodes.some(n => n.name === 'f'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing binary, a non-zero exit and non-JSON output come back as statuses, never as a rejection', async () => {
    const hooks = { log: () => undefined };
    assert.strictEqual((await spawnAnalyzer('/no/such/binary-cg', [], 'x', hooks)).status, 'spawn-error');
    assert.strictEqual((await spawnAnalyzer(process.execPath, ['-e', 'process.exit(3)'], 'x', hooks)).status, 'exit-nonzero');
    assert.strictEqual((await spawnAnalyzer(process.execPath, ['-e', 'process.stdout.write("nope")'], 'x', hooks)).status, 'parse-error');
  });

  test('an abort kills the children and rejects as cancelled', async function () {
    this.timeout(20_000);
    const dir = tempProject({ 'a.ts': 'export function f() {}\n' });
    const slow = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-slow-'));
    for (const s of ANALYZER_SCRIPTS) { fs.writeFileSync(path.join(slow, s.script), 'setTimeout(() => {}, 60000);\n'); }
    const ac = new AbortController();
    try {
      const run = spawnAnalyzers(dir, { scriptsDir: slow, pythonBin: process.execPath, signal: ac.signal });
      setTimeout(() => ac.abort(), 300);
      await assert.rejects(run, /Cancelled/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(slow, { recursive: true, force: true });
    }
  });
});
