import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnAnalyzers } from '../../analyzerSpawn';
import type { AnalyzerResult } from '../../analyzerSpawn';

/**
 * Finding F7 of the CI threat review: one file must not switch a language off. A poison file
 * is missing from the graph and counted; every other file of its language stays.
 */

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
const PYTHON = cp.spawnSync('python3', ['--version']).status === 0 ? 'python3' : 'python';

function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-poison-'));
  for (const [rel, text] of Object.entries(files)) { fs.writeFileSync(path.join(dir, rel), text); }
  return dir;
}

async function analyse(dir: string, lang: string): Promise<AnalyzerResult & { names: string[] }> {
  const { statuses } = await spawnAnalyzers(dir, { scriptsDir: SCRIPTS, pythonBin: PYTHON });
  const result = statuses.find(s => s.lang === lang) as AnalyzerResult;
  return { ...result, names: result.graph.nodes.filter(n => !n.isLibrary).map(n => n.name) };
}

/** One analyzer on an explicit list, so a path that does not exist can be listed. */
function runListed(script: string, dir: string, listed: string[]): { status: number | null; graph: { nodes: Array<{ name: string }>; stats?: { filesNotParsed?: number } } } {
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, listed.join('\n'));
  const res = cp.spawnSync(script.endsWith('.py') ? PYTHON : process.execPath, [path.join(SCRIPTS, script), dir, '--files', list], { encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  return { status: res.status, graph: JSON.parse(res.stdout) };
}

const PY_POISON: Array<[what: string, text: string]> = [
  ['a long sum (RecursionError)', `x = ${'1+'.repeat(200_000)}1\n`],
  ['a long attribute chain (RecursionError)', `x = a${'.b'.repeat(200_000)}\n`],
  ['a long run of not (MemoryError)', `x = ${'not '.repeat(200_000)}y\n`],
  ['nested lambdas (MemoryError)', `x = ${'lambda:'.repeat(200_000)}0\n`],
  ['a syntax error', 'def broken(:\n'],
  ['a NUL byte', 'def f():\n    pass\n\0\n'],
];

suite('analyzers: one poison file (F7)', () => {
  for (const [what, text] of PY_POISON) {
    test(`Python: ${what} costs that file, not the language`, async function () {
      this.timeout(60_000);
      const dir = project({ 'poison.py': text, 'backdoor.py': 'def backdoor():\n    run()\n\ndef run():\n    pass\n' });
      try {
        const r = await analyse(dir, 'python');
        assert.strictEqual(r.status, 'ok', r.detail);
        assert.deepStrictEqual(r.names.filter(n => n === 'backdoor' || n === 'run').sort(), ['backdoor', 'run']);
        assert.strictEqual(r.filesNotParsed, 1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('Python: two poison files count as two over the three passes', async function () {
    this.timeout(30_000);
    const dir = project({ 'a.py': 'def broken(:\n', 'b.py': 'def broken(:\n', 'c.py': 'def fine():\n    pass\n' });
    try {
      assert.strictEqual((await analyse(dir, 'python')).filesNotParsed, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('REGRESSION (F3): under a memory limit an enormous file costs that file, not the run, and the limit is the job\'s to set', function () {
    if (process.platform === 'win32') { this.skip(); } // no such limit there
    this.timeout(60_000);
    const huge = Array.from({ length: 120_000 }, (_, i) => `def fn${i}(): return 1\n`).join('');
    const dir = project({ 'kept.py': 'def kept():\n    pass\n', 'huge.py': huge });
    const run = (env: Record<string, string>) => {
      const res = cp.spawnSync(PYTHON, [path.join(SCRIPTS, 'analyze.py'), dir], { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...env } });
      assert.strictEqual(res.status, 0, res.stderr);
      return JSON.parse(res.stdout) as { nodes: Array<{ name: string }>; stats?: { filesNotParsed?: number } };
    };
    try {
      const limited = run({ COGRAPH_PYTHON_MEMORY_MB: '300' });
      assert.deepStrictEqual(limited.nodes.map(n => n.name), ['kept']);
      assert.strictEqual(limited.stats?.filesNotParsed, 1);
      assert.strictEqual(run({}).nodes.length, 120_001, 'without the limit, as in the extension, the file parses');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Python: a listed file that is gone is counted, the others stay', () => {
    const dir = project({ 'a.py': 'def kept():\n    pass\n' });
    try {
      const r = runListed('analyze.py', dir, [path.join(dir, 'a.py'), path.join(dir, 'gone.py')]);
      assert.strictEqual(r.status, 0);
      assert.ok(r.graph.nodes.some(n => n.name === 'kept'));
      assert.strictEqual(r.graph.stats?.filesNotParsed, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('TypeScript and JavaScript: a file that cannot be read or walked is counted, the others stay', function () {
    this.timeout(30_000);
    const deep = `export const x = ${'('.repeat(100_000)}1${')'.repeat(100_000)};\n`;
    const dir = project({ 'a.ts': 'export function kept() {}\n', 'deep.ts': deep, 'a.js': 'function kept() {}\n', 'deep.js': deep });
    try {
      for (const [script, ext] of [['analyze_ts.js', 'ts'], ['analyze_js.js', 'js']]) {
        const r = runListed(script, dir, [path.join(dir, `a.${ext}`), path.join(dir, `deep.${ext}`), path.join(dir, `gone.${ext}`)]);
        assert.strictEqual(r.status, 0);
        assert.ok(r.graph.nodes.some(n => n.name === 'kept'), script);
        assert.strictEqual(r.graph.stats?.filesNotParsed, 2, script);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Java: a file that will not parse is counted once over both passes, the others stay', function () {
    this.timeout(30_000);
    const dir = project({ 'Good.java': 'class Good { void kept() {} }\n', 'Bad.java': 'class Bad { void broken( }\n' });
    try {
      const r = runListed('analyze_java.js', dir, [path.join(dir, 'Good.java'), path.join(dir, 'Bad.java')]);
      assert.strictEqual(r.status, 0);
      assert.ok(r.graph.nodes.some(n => n.name === 'kept'));
      assert.strictEqual(r.graph.stats?.filesNotParsed, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('C and C++: a listed file that cannot be read is counted once, the others stay', function () {
    this.timeout(30_000);
    const dir = project({ 'a.c': 'int kept(void) { return 0; }\n', 'b.cpp': 'int kept() { return 0; }\n' });
    try {
      for (const [script, good, gone] of [['analyze_c.js', 'a.c', 'gone.c'], ['analyze_cpp.js', 'b.cpp', 'gone.cpp']]) {
        const r = runListed(script, dir, [path.join(dir, good), path.join(dir, gone)]);
        assert.strictEqual(r.status, 0);
        assert.ok(r.graph.nodes.some(n => n.name === 'kept'), script);
        assert.strictEqual(r.graph.stats?.filesNotParsed, 1, script);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with nothing skipped no counter appears, so the output stays as it was', function () {
    this.timeout(30_000);
    const dir = project({ 'a.py': 'def f():\n    pass\n', 'a.ts': 'export function f() {}\n', 'A.java': 'class A { void f() {} }\n', 'a.c': 'int f(void) { return 0; }\n', 'b.cpp': 'int g() { return 0; }\n' });
    try {
      for (const [script, file] of [['analyze.py', 'a.py'], ['analyze_ts.js', 'a.ts'], ['analyze_java.js', 'A.java'], ['analyze_c.js', 'a.c'], ['analyze_cpp.js', 'b.cpp']]) {
        const r = runListed(script, dir, [path.join(dir, file)]);
        assert.strictEqual(r.status, 0);
        assert.strictEqual(r.graph.stats, undefined, script);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
