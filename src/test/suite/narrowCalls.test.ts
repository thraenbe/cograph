import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const nc = require('../../../scripts/narrowCalls.js');

const ROOT = '/ws';
const FILES: Record<string, string> = {};
const fileOf = (id: string) => FILES[id];
function defs(spec: Record<string, number>): string[] {
  const ids: string[] = [];
  for (const [file, n] of Object.entries(spec)) {
    for (let i = 0; i < n; i++) { const id = `${file}::get::${i}`; FILES[id] = file; ids.push(id); }
  }
  return ids;
}

suite('narrowCalls (D6: ambiguous call names)', () => {
  test('≤ 8 candidates: untouched — the SAME array, no counters', () => {
    const { narrow, stats } = nc.createNarrower(fileOf, ROOT);
    const ids = defs({ '/ws/a/x.ts': 3, '/ws/b/y.ts': 5 });
    assert.strictEqual(narrow(ids, '/ws/c/z.ts'), ids);
    assert.strictEqual(narrow(undefined, '/ws/c/z.ts'), undefined);
    assert.deepStrictEqual(stats, { ambiguousNarrowed: 0, ambiguousDropped: 0 });
  });

  test('stage 1 — same file', () => {
    const { narrow, stats } = nc.createNarrower(fileOf, ROOT);
    const ids = defs({ '/ws/a/x.ts': 2, '/ws/a/w.ts': 4, '/ws/b/y.ts': 6 });
    assert.deepStrictEqual(narrow(ids, '/ws/a/x.ts'), ids.slice(0, 2));
    assert.deepStrictEqual(stats, { ambiguousNarrowed: 1, ambiguousDropped: 0 });
  });

  test('stage 2 — same directory when the caller\'s file defines none', () => {
    const { narrow } = nc.createNarrower(fileOf, ROOT);
    const ids = defs({ '/ws/a/w.ts': 4, '/ws/a/sub/v.ts': 3, '/ws/b/y.ts': 6 });
    assert.deepStrictEqual(narrow(ids, '/ws/a/x.ts'), ids.slice(0, 4), 'only /ws/a itself, not /ws/a/sub');
  });

  test('stage 3 — same top-level package', () => {
    const { narrow } = nc.createNarrower(fileOf, ROOT);
    const ids = defs({ '/ws/core/m/w.ts': 4, '/ws/core/n/v.ts': 3, '/ws/other/y.ts': 6 });
    assert.deepStrictEqual(narrow(ids, '/ws/core/x/caller.ts'), ids.slice(0, 7));
    assert.strictEqual(nc.topLevelOf('/ws/main.ts', ROOT), '', 'root files share the empty package');
    assert.strictEqual(nc.topLevelOf('/elsewhere/x.ts', ROOT), '');
  });

  test('stages compose: a too-large same-directory pool is narrowed further, never widened', () => {
    const { narrow } = nc.createNarrower(fileOf, ROOT);
    const ids = defs({ '/ws/a/x.ts': 9, '/ws/a/w.ts': 5 });
    assert.deepStrictEqual(narrow(ids, '/ws/a/x.ts'), [], 'same file has 9 > 8 and no later stage can shrink it');
  });

  test('still > 8 after every stage → dropped as unresolvable, counted', () => {
    const { narrow, stats } = nc.createNarrower(fileOf, ROOT);
    const ids = defs({ '/ws/lib/a.ts': 5, '/ws/lib/b.ts': 5, '/ws/lib2/c.ts': 5 });
    assert.deepStrictEqual(narrow(ids, '/ws/app/caller.ts'), []);
    assert.deepStrictEqual(stats, { ambiguousNarrowed: 0, ambiguousDropped: 1 });
  });

  test('withStats adds counters only when something happened (byte-identical otherwise)', () => {
    const g = { nodes: [], edges: [], files: [] };
    assert.strictEqual(nc.withStats(g, { ambiguousNarrowed: 0, ambiguousDropped: 0 }), g);
    assert.deepStrictEqual(nc.withStats(g, { ambiguousNarrowed: 2, ambiguousDropped: 1 }).stats, { ambiguousNarrowed: 2, ambiguousDropped: 1 });
  });
});

// ── End to end, all five analyzers ─────────────────────────────────────────────
const SCRIPTS = path.resolve(__dirname, '../../../scripts');
const ANALYZERS: Array<{ lang: string; bin: string; script: string; ext: string; def: (n: string) => string; call: (n: string) => string }> = [
  { lang: 'typescript', bin: process.execPath, script: 'analyze_ts.js', ext: 'ts', def: n => `export function ${n}() { return 1; }\n`, call: n => `export function caller() { return ${n}(); }\n` },
  { lang: 'javascript', bin: process.execPath, script: 'analyze_js.js', ext: 'js', def: n => `function ${n}() { return 1; }\nmodule.exports = { ${n} };\n`, call: n => `function caller() { return ${n}(); }\nmodule.exports = { caller };\n` },
  { lang: 'python', bin: 'python3', script: 'analyze.py', ext: 'py', def: n => `def ${n}():\n    return 1\n`, call: n => `def caller():\n    return ${n}()\n` },
  { lang: 'java', bin: process.execPath, script: 'analyze_java.js', ext: 'java', def: n => `class K { int ${n}() { return 1; } }\n`, call: n => `class C { int ${n}() { return 2; } int caller() { return ${n}(); } }\n` },
  { lang: 'cpp', bin: process.execPath, script: 'analyze_cpp.js', ext: 'cpp', def: n => `int ${n}() { return 1; }\n`, call: n => `int ${n}();\nint caller() { return ${n}(); }\n` },
];

function run(a: typeof ANALYZERS[number], root: string, env: Record<string, string> = {}): { raw: string; graph: any } {
  const raw = cp.execFileSync(a.bin, [path.join(SCRIPTS, a.script), root],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
  return { raw, graph: JSON.parse(raw) };
}

suite('D6 end to end — every analyzer', function () {
  this.timeout(120000);
  let tmp: string;
  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-d6-')); });
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  for (const a of ANALYZERS) {
    test(`${a.lang}: a name with ≤ 8 definitions keeps fanning out exactly as before (no stats field)`, function () {
      if (a.lang === 'python') { try { cp.execFileSync('python3', ['--version']); } catch { this.skip(); } }
      // Java's caller class declares the method itself (bare calls resolve through `this`): 7 + 1 = 8.
      const others = a.lang === 'java' ? 7 : 8;
      for (let i = 0; i < others; i++) {
        fs.mkdirSync(path.join(tmp, `pkg${i}`), { recursive: true });
        fs.writeFileSync(path.join(tmp, `pkg${i}`, `d.${a.ext}`), a.def('helper'));
      }
      fs.mkdirSync(path.join(tmp, 'app'));
      fs.writeFileSync(path.join(tmp, 'app', `main.${a.ext}`), a.call('helper'));
      const { raw, graph } = run(a, tmp);
      assert.strictEqual(graph.stats, undefined, 'output format unchanged');
      assert.ok(!raw.includes('"stats"'));
      const caller = graph.nodes.find((n: any) => n.name === 'caller');
      const out = graph.edges.filter((e: any) => e.source === caller.id && !e.isLibraryEdge);
      assert.ok(out.length >= 8, `${a.lang}: all same-named definitions are linked (${out.length})`);
    });

    test(`${a.lang}: > 8 definitions → narrowed to the caller's own package, counted`, function () {
      if (a.lang === 'python') { try { cp.execFileSync('python3', ['--version']); } catch { this.skip(); } }
      for (let i = 0; i < 12; i++) {
        fs.mkdirSync(path.join(tmp, `pkg${i}`), { recursive: true });
        fs.writeFileSync(path.join(tmp, `pkg${i}`, `d.${a.ext}`), a.def('helper'));
      }
      fs.mkdirSync(path.join(tmp, 'pkg3', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'pkg3', 'sub', `main.${a.ext}`), a.call('helper'));
      const { graph } = run(a, tmp);
      const caller = graph.nodes.find((n: any) => n.name === 'caller');
      const targets = graph.edges.filter((e: any) => e.source === caller.id && !e.isLibraryEdge)
        .map((e: any) => graph.nodes.find((n: any) => n.id === e.target).file);
      assert.ok(targets.length >= 1 && targets.length <= 8, `${a.lang}: ${targets.length} targets`);
      assert.ok(targets.every((f: string) => f.startsWith(path.join(tmp, 'pkg3'))), `${a.lang}: only pkg3 (${targets.join(', ')})`);
      assert.ok(graph.stats && graph.stats.ambiguousNarrowed >= 1, `${a.lang}: counter present`);
    });
  }

  for (const a of ANALYZERS) {
    test(`${a.lang}: IDENTITY — no name above 8 → output byte-identical to a run with narrowing switched off`, function () {
      if (a.lang === 'python') { try { cp.execFileSync('python3', ['--version']); } catch { this.skip(); } }
      const pkgs = a.lang === 'java' ? 3 : 6;   // Java callers declare `helper` too: 3 + 3 = 6 definitions
      for (let i = 0; i < pkgs; i++) {
        fs.mkdirSync(path.join(tmp, `pkg${i}`), { recursive: true });
        fs.writeFileSync(path.join(tmp, `pkg${i}`, `d.${a.ext}`), a.def('helper') + a.def(`only${i}`).replace(/class K/, `class K${i}`));
        fs.writeFileSync(path.join(tmp, `pkg${i}`, `main.${a.ext}`), a.call('helper').replace(/class C/, `class C${i}`));
      }
      const withD6 = run(a, tmp).raw;
      const off = run(a, tmp, { COGRAPH_MAX_CANDIDATES: '1000000' }).raw;
      assert.strictEqual(withD6, off);
      assert.ok(JSON.parse(withD6).edges.length > 0, 'fixture really has calls');
    });
  }

  test('a name nobody can resolve (> 8 everywhere, none near the caller) is dropped and counted', () => {
    const a = ANALYZERS[0];
    for (let i = 0; i < 12; i++) {
      fs.mkdirSync(path.join(tmp, 'lib', `m${i}`), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'lib', `m${i}`, `d.${a.ext}`), a.def('helper'));
    }
    fs.mkdirSync(path.join(tmp, 'app'));
    fs.writeFileSync(path.join(tmp, 'app', `main.${a.ext}`), a.call('helper'));
    const { graph } = run(a, tmp);
    const caller = graph.nodes.find((n: any) => n.name === 'caller');
    assert.strictEqual(graph.edges.filter((e: any) => e.source === caller.id).length, 0);
    assert.deepStrictEqual(graph.stats, { ambiguousNarrowed: 0, ambiguousDropped: 1 });
  });
});
