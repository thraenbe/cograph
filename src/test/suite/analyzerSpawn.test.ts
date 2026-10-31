import * as assert from 'assert';
import * as cp from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as sinon from 'sinon';
import { ANALYZER_SCRIPTS, analysisFailed, analyzerScriptPath, probePython, spawnAnalyzer, spawnAnalyzers } from '../../analyzerSpawn';
import type { AnalyzerResult } from '../../analyzerSpawn';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawCp = require('child_process');

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
/** The production resolver's order: python3, then python (Windows often has only that). */
const PYTHON = cp.spawnSync('python3', ['--version']).status === 0 ? 'python3' : 'python';

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
      const { graph, statuses } = await spawnAnalyzers(dir, { scriptsDir: SCRIPTS, pythonBin: PYTHON });
      assert.deepStrictEqual(statuses.map(s => s.lang), ANALYZER_SCRIPTS.map(s => s.lang));
      const names = graph.nodes.filter(n => !n.isLibrary).map(n => n.name).sort();
      for (const name of ['helper', 'main', 'run', 'step']) { assert.ok(names.includes(name), `${name} in ${names.join(',')}`); }
      assert.ok(graph.edges.length >= 2);
      assert.ok(statuses.every(s => s.status === 'ok' || s.status === 'empty'), JSON.stringify(statuses.map(s => [s.lang, s.status, s.detail])));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('REGRESSION: a full pass runs every analyzer in scripts/, so a new language cannot be left out', () => {
    const onDisk = fs.readdirSync(SCRIPTS).filter(f => /^analyze(_\w+)?\.(js|py)$/.test(f)).sort();
    assert.deepStrictEqual(ANALYZER_SCRIPTS.map(s => s.script).sort(), onDisk);
  });

  test('a full pass outside VS Code reaches C, Vue and Svelte', async function () {
    this.timeout(60_000);
    const dir = tempProject({
      'c/tool.c': 'static int step(void) { return 1; }\nint run(void) { return step(); }\n',
      'web/Card.vue': '<script lang="ts">\nexport function cardSetup(): number { return 1; }\n</script>\n',
      'web/Chip.svelte': '<script>\nexport function chipSetup() { return 1; }\n</script>\n',
    });
    try {
      const { graph } = await spawnAnalyzers(dir, { scriptsDir: SCRIPTS, pythonBin: PYTHON });
      const byName = new Map(graph.nodes.filter(n => !n.isLibrary).map(n => [n.name, n]));
      assert.strictEqual(byName.get('run')?.language, 'c');
      assert.strictEqual(byName.get('cardSetup')?.language, 'typescript');
      assert.strictEqual(byName.get('chipSetup')?.language, 'javascript');
      assert.ok(graph.edges.some(e => e.source === byName.get('run')?.id && e.target === byName.get('step')?.id));
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

  test('REGRESSION: a signal aborted before the call starts nothing and throws at once', async () => {
    const scripts = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scripts-'));
    const ran = path.join(scripts, 'ran');
    for (const { script } of ANALYZER_SCRIPTS) { fs.writeFileSync(path.join(scripts, script), `require('fs').writeFileSync(${JSON.stringify(ran)}, 'x');\n`); }
    const dir = tempProject({ 'a.ts': 'export function f() {}\n' });
    try {
      await assert.rejects(spawnAnalyzers(dir, { scriptsDir: scripts, pythonBin: null, signal: AbortSignal.abort() }), /Cancelled\./);
      assert.strictEqual(fs.existsSync(ran), false, 'no analyzer may have run');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(scripts, { recursive: true, force: true });
    }
  });

  test('REGRESSION: a character split across two pipe chunks survives, in stdout and in the stderr of a failure', async () => {
    const sandbox = sinon.createSandbox();
    const fakeProc = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
    try {
      const spawn = sandbox.stub(rawCp, 'spawn');
      const ok = fakeProc();
      spawn.returns(ok);
      const good = spawnAnalyzer('node', [], 'x', { log: () => undefined });
      const json = Buffer.from(JSON.stringify({ nodes: [{ name: 'prüfe€' }], edges: [], files: [] }));
      const cut = json.indexOf(Buffer.from('€')) + 1; // inside the three bytes of the euro sign
      ok.stdout.emit('data', json.subarray(0, cut));
      ok.stdout.emit('data', json.subarray(cut));
      ok.emit('close', 0);
      assert.strictEqual((await good).graph.nodes[0].name, 'prüfe€');

      const bad = fakeProc();
      spawn.returns(bad);
      const failed = spawnAnalyzer('node', [], 'x', { log: () => undefined });
      const text = Buffer.from('Fehler: prüfe€');
      bad.stderr.emit('data', text.subarray(0, text.length - 1));
      bad.stderr.emit('data', text.subarray(text.length - 1));
      bad.emit('close', 1);
      assert.ok((await failed).detail?.endsWith('Fehler: prüfe€'));
    } finally {
      sandbox.restore();
    }
  });

  /** A scripts folder whose analyzers report what they were given, instead of analysing. */
  function probeScripts(): string {
    const scripts = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-probe-'));
    const probe = `const fs = require('fs');
      const [, script, root, , list] = process.argv;
      fs.writeFileSync(script + '.seen', JSON.stringify({ root, cwd: process.cwd(), canary: process.env.CG_CANARY ?? null, execArgv: process.execArgv, list, listed: fs.readFileSync(list, 'utf8') }));
      process.stdout.write('{"nodes":[],"edges":[],"files":[]}');`;
    for (const { script } of ANALYZER_SCRIPTS) { fs.writeFileSync(path.join(scripts, script), probe); }
    return scripts;
  }
  const seenBy = (scripts: string, script: string) => JSON.parse(fs.readFileSync(path.join(scripts, `${script}.seen`), 'utf8'));

  test('REGRESSION (F6): a name holding a line break stays off the list of a full pass, a tab stays on it', async function () {
    if (process.platform === 'win32') { this.skip(); }
    const dir = tempProject({ 'plain.py': 'def a(): pass\n', 'tab\there.py': 'def b(): pass\n', 'x\n/outside/evil.py': 'def c(): pass\n', 'y\r/outside/evil.py': 'def d(): pass\n' });
    const scripts = probeScripts();
    const logged: string[] = [];
    try {
      await spawnAnalyzers(dir, { scriptsDir: scripts, pythonBin: process.execPath, log: l => logged.push(l) });
      assert.deepStrictEqual(seenBy(scripts, 'analyze.py').listed.split('\n').sort(), [path.join(dir, 'plain.py'), path.join(dir, 'tab\there.py')]);
      assert.ok(logged.some(l => l.includes('2 files with a line break')), logged.join('|'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(scripts, { recursive: true, force: true });
    }
  });

  test('a run with its own cwd, environment and node flags: the analyzers get those and nothing of this process, the list stays in that cwd', async () => {
    const dir = tempProject({ 'a.py': 'def a(): pass\n' });
    const scripts = probeScripts();
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cwd-')));
    process.env.CG_CANARY = 'secret-of-the-job';
    try {
      await spawnAnalyzers(dir, { scriptsDir: scripts, pythonBin: process.execPath, cwd, env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' }, nodeArgs: ['--max-old-space-size=1234'] });
      const node = seenBy(scripts, 'analyze_ts.js');
      assert.strictEqual(node.cwd, cwd);
      assert.strictEqual(node.canary, null, 'the environment is the given one, not an addition to this process\'s');
      assert.deepStrictEqual(node.execArgv, ['--max-old-space-size=1234']);
      assert.ok(node.list.startsWith(cwd + path.sep), node.list);
      assert.deepStrictEqual(seenBy(scripts, 'analyze.py').execArgv, [], 'node flags are for node analyzers');
      assert.deepStrictEqual(fs.readdirSync(cwd), [], 'the list is gone afterwards');
    } finally {
      delete process.env.CG_CANARY;
      for (const d of [dir, scripts, cwd]) { fs.rmSync(d, { recursive: true, force: true }); }
    }
  });

  test('without its own environment a run inherits this process\'s, as the extension does', async () => {
    const dir = tempProject({ 'a.py': 'def a(): pass\n' });
    const scripts = probeScripts();
    process.env.CG_CANARY = 'inherited';
    try {
      await spawnAnalyzers(dir, { scriptsDir: scripts, pythonBin: process.execPath });
      assert.strictEqual(seenBy(scripts, 'analyze_ts.js').canary, 'inherited');
    } finally {
      delete process.env.CG_CANARY;
      for (const d of [dir, scripts]) { fs.rmSync(d, { recursive: true, force: true }); }
    }
  });

  test('REGRESSION (F3): output over the caller\'s cap kills the analyzer; the default cap would not have', async () => {
    const hooks = { log: () => undefined };
    const twoMb = ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024)); setTimeout(() => process.stdout.write("y"), 50);'];
    const capped = await spawnAnalyzer(process.execPath, twoMb, 'x', hooks, { maxOutputBytes: 1024 * 1024 });
    assert.deepStrictEqual([capped.status, capped.detail], ['output-too-large', '> 1 MB']);
    assert.strictEqual((await spawnAnalyzer(process.execPath, twoMb, 'x', hooks)).status, 'parse-error');
  });

  test('REGRESSION: stderr past what a string can hold neither throws nor grows without limit', async function () {
    this.timeout(60_000);
    // 600 MiB, then the exit: V8 strings end at 512 MiB, and the append sits in an event handler nothing catches.
    const flood = 'const b = Buffer.alloc(1 << 24, 120); let n = 0; const go = () => { while (n < 36) { n++; if (!process.stderr.write(b)) { process.stderr.once("drain", go); return; } } process.exitCode = 1; }; go();';
    const r = await spawnAnalyzer(process.execPath, ['-e', flood], 'x', { log: () => undefined });
    assert.strictEqual(r.status, 'exit-nonzero');
    assert.ok((r.detail ?? '').length < 320, `detail is ${(r.detail ?? '').length} long`);
  });

  test('REGRESSION: the Python analyzer writes no warning, which would print the whole line once per string literal', async function () {
    this.timeout(30_000);
    const dir = tempProject({ 'w.py': `x = [${'"\\d",'.repeat(2000)}]\n\ndef kept():\n    pass\n` });
    try {
      const out = cp.spawnSync(PYTHON, [path.join(SCRIPTS, 'analyze.py'), dir], { encoding: 'utf8', maxBuffer: 1 << 28 });
      assert.strictEqual(out.stderr, '');
      assert.ok(JSON.parse(out.stdout).nodes.some((n: { name: string }) => n.name === 'kept'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a script is the bundled one when the package holds it, else the source', () => {
    const root = tempProject({ 'scripts/analyze.py': '', 'scripts/analyze_ts.js': '', 'dist/scripts/analyze_ts.js': '' });
    try {
      assert.strictEqual(analyzerScriptPath(root, 'analyze_ts.js'), path.join(root, 'dist', 'scripts', 'analyze_ts.js'));
      assert.strictEqual(analyzerScriptPath(root, 'analyze.py'), path.join(root, 'scripts', 'analyze.py'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('the Python probe takes the first candidate that runs and skips the rest', () => {
    assert.strictEqual(probePython([undefined, '/no/such/python', process.execPath, 'python3']), process.execPath);
    assert.strictEqual(probePython([undefined, '/no/such/python']), null);
  });

  test('an analysis failed when it found nothing and an analyzer did not run cleanly, not otherwise', () => {
    const empty = { nodes: [], edges: [], files: [] };
    const node = { id: 'a', name: 'a', file: 'a.py', line: 1 };
    const result = (status: AnalyzerResult['status'], detail?: string): AnalyzerResult => ({ graph: empty, status, lang: 'python', detail });
    assert.strictEqual(analysisFailed(empty, [result('empty')]), null);
    assert.strictEqual(analysisFailed({ ...empty, nodes: [node] }, [result('timeout')]), null);
    assert.strictEqual(analysisFailed(empty, [result('empty'), result('timeout', 'exceeded 300s')]), 'Analysis failed: python timeout (exceeded 300s)');
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
