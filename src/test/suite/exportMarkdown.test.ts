import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runExport, parseArgs } from '../../export/cli';
import { ExportError } from '../../export/analyze';
import { escapeSegment, MANIFEST, Pages, sha256, symbolPath, wordCount, writeExport } from '../../export/output';
import { caseSafe, renderPages } from '../../export/render';
import { indexJavaFacts } from '../../export/javaFacts';
import { allClassNames, resolveEntry } from '../../export/entries';
import { buildIndex } from '../../mcp/graphIndex';
import type { GraphData } from '../../graphProvider';

// The Markdown export (src/export, docs/export-markdown.md): golden pages for a Java and a Python
// fixture, byte-identical runs, and one test per determinism and safety rule.
// UPDATE_GOLDEN=1 rewrites the expected pages after an intended format change.

const FIXTURES = path.resolve(__dirname, '../../../src/test/fixtures/export');
const CLI = path.resolve(__dirname, '../../export/cli.js');
const JAVA = path.join(FIXTURES, 'java-game');
const PY = path.join(FIXTURES, 'py-app');
const FEATURES = path.join(FIXTURES, 'features.json');

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cograph-export-test-${tag}-`));
}

function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); } else { out.set(path.relative(dir, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')); }
    }
  };
  walk(dir);
  return new Map([...out].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

function exportTo(repo: string, extra: string[] = []): string {
  const out = path.join(tmpDir('out'), 'export');
  runExport(parseArgs([repo, '--out', out, ...extra]));
  return out;
}

/** Pages whose text depends only on the analysed code (README and manifest also name the tool build). */
const codeOnly = (m: Map<string, string>) => new Map([...m].filter(([k]) => k !== 'README.md' && k !== MANIFEST));

function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) { copyTree(s, d); } else { fs.copyFileSync(s, d); }
  }
}

function golden(name: string, got: Map<string, string>): void {
  const dir = path.join(FIXTURES, 'expected', name);
  if (process.env.UPDATE_GOLDEN) {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [rel, text] of got) { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  }
  const want = tree(dir);
  assert.deepStrictEqual([...got.keys()], [...want.keys()], 'the set of pages changed');
  for (const [rel, text] of want) { assert.strictEqual(got.get(rel), text, `page ${rel} changed`); }
}

suite('Markdown export: golden pages', function () {
  this.timeout(60_000);

  test('Java fixture with features matches the expected pages', () => {
    golden('java-game', codeOnly(tree(exportTo(JAVA, ['--features', FEATURES]))));
  });

  test('Python fixture matches the expected pages', () => {
    golden('py-app', codeOnly(tree(exportTo(PY, ['--lang', 'python']))));
  });
});

suite('Markdown export: determinism', function () {
  this.timeout(120_000);

  test('two processes, two absolute paths, another locale and hash seed: identical bytes, no absolute path', () => {
    const base = tmpDir('det');
    const a = path.join(base, 'a', 'java-game');
    const b = path.join(base, 'elsewhere', 'deeper', 'java-game');
    copyTree(JAVA, a);
    copyTree(JAVA, b);
    const run = (repo: string, out: string, env: Record<string, string>) => {
      const r = cp.spawnSync(process.execPath, [CLI, repo, '--out', out, '--features', FEATURES], { cwd: os.tmpdir(), env: { ...process.env, ...env }, encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
    };
    run(a, path.join(base, 'o1'), { LC_ALL: 'C', TZ: 'UTC', PYTHONHASHSEED: '1' });
    run(b, path.join(base, 'o2'), { LC_ALL: 'de_DE.UTF-8', TZ: 'Asia/Tokyo', PYTHONHASHSEED: '99' });
    const t1 = tree(path.join(base, 'o1'));
    const t2 = tree(path.join(base, 'o2'));
    assert.deepStrictEqual([...t1.keys()], [...t2.keys()]);
    for (const [k, v] of t1) {
      assert.strictEqual(t2.get(k), v, `${k} differs between the two runs`);
      assert.ok(!v.includes(base) && !v.includes(os.homedir()), `${k} contains an absolute path`);
    }
  });

  test('node and edge order of the analyser output does not change a single page', () => {
    // Ties everywhere: two callers on one line, a fan-in of three, a library callee, a module node.
    const root = path.join(os.tmpdir(), 'cograph-export-synthetic');
    const f = (rel: string) => path.join(root, rel);
    const n = (file: string, name: string, line: number, cls?: string) => ({ id: `${f(file)}::${name}::${line}`, name, file: f(file), line, language: 'python' as const, className: cls });
    const nodes = [
      n('b.py', 'zeta', 3), n('b.py', 'alpha', 3), n('a.py', 'hub', 1), n('a.py', 'Beta', 9, 'K'), n('a.py', 'beta', 9, 'K'),
      { id: 'library::os::path', name: 'path', file: null, line: 0, isLibrary: true, libraryName: 'os', language: 'python' as const },
    ];
    const ids = nodes.map((x) => x.id);
    const edges = [[0, 2], [1, 2], [3, 2], [4, 2], [2, 5], [0, 3], [1, 4], [4, 1]].map(([s, t]) => ({ source: ids[s], target: ids[t] }));
    const render = (g: GraphData) => {
      const index = buildIndex(root, { schemaVersion: 1, savedAt: '', manifest: {}, graph: g }, { version: 0, provider: '', model: '', generatedAt: '', files: {}, folders: {} });
      const files = ['a.py', 'b.py'].map((rel) => ({ abs: f(rel), rel, language: 'python' as const }));
      const resolved = resolveEntry(index, 'a.py', new Set(['a.py', 'b.py']), allClassNames(index, []));
      return renderPages(root, index, files, indexJavaFacts(root, null), [], { depth: 3, source: false, symbols: null, features: [{ name: 'F', entries: [resolved] }] }).entries();
    };
    const forward = render({ nodes: [...nodes], edges: [...edges] });
    const backward = render({ nodes: [...nodes].reverse(), edges: [...edges].reverse() });
    const rotated = render({ nodes: [...nodes.slice(2), ...nodes.slice(0, 2)], edges: [...edges.slice(3), ...edges.slice(0, 3)] });
    assert.deepStrictEqual(backward, forward);
    assert.deepStrictEqual(rotated, forward);
  });
});

suite('Markdown export: Java call sites', function () {
  this.timeout(60_000);

  test('--export-info leaves nodes and edges byte-identical', () => {
    const script = path.resolve(__dirname, '../../../scripts/analyze_java.js');
    const plain = JSON.parse(cp.execFileSync(process.execPath, [script, JAVA], { encoding: 'utf8' }));
    const info = JSON.parse(cp.execFileSync(process.execPath, [script, JAVA, '--export-info'], { encoding: 'utf8' }));
    assert.ok(info.exportInfo && info.exportInfo.sites.length > 0);
    delete info.exportInfo;
    assert.deepStrictEqual(info, plain);
  });

  test('every linked call site has its edge; the lambda receiver and the anonymous library class are reported unresolved', () => {
    const out = tree(exportTo(JAVA));
    const edges = new Set(out.get('edges.tsv')!.split('\n').slice(1).map((l) => l.split('\t').slice(0, 2).join('\t')));
    const rows = out.get('callsites.tsv')!.split('\n');
    const head = rows[0].split('\t');
    const col = (r: string[], name: string) => r[head.indexOf(name)];
    let linked = 0;
    for (const r of rows.slice(1).map((l) => l.split('\t'))) {
      if (col(r, 'linked') !== '1') { continue; }
      for (const t of col(r, 'targets').split(' ')) { assert.ok(edges.has(`${col(r, 'caller')}\t${t}`), `no edge for ${r.join(' ')}`); linked++; }
    }
    assert.ok(linked >= 20, `only ${linked} linked sites`);
    assert.deepStrictEqual(out.get('unresolved.tsv')!.split('\n').slice(1).filter(Boolean),
      ['game/Player.java\t29\t28\tgame/Player.java::Player.update\tcall\tit\tuse\tthis\tlocal\tunknown-type',
        'game/Player.java\t30\t9\tgame/Player.java::Player.update\tnew\t\tThread\tr\tnew\tanonymous-class']);
  });

  test('class cards carry fields, URL and asset literals, and symbol pages the static reads with values', () => {
    const out = tree(exportTo(JAVA));
    const constants = out.get('files/game/Constants.java.md')!;
    assert.match(constants, /- L5 public static boolean ONLINE = true/);
    assert.match(constants, /- L6 url "http:\/\/example\.org\/save\.php"/);
    assert.match(constants, /- L7 asset "images\/player\.png"/);
    const update = out.get('symbols/game/Player.java/Player.update.md')!;
    assert.match(update, /- Constants\.ONLINE {2}\(boolean = true\)/);
    const save = out.get('symbols/game/io/Highscore.java/Highscore.save.md')!;
    assert.match(save, /new URL\(Constants\.SAVE_URL\) {2}\[-> library::java\.net\.URL::<init>\]/);
    assert.match(save, /w\.write\(String\.valueOf\(points\)\) {2}\[-> library::java\.io\.FileWriter::write\]/);
  });
});

suite('Markdown export: entries, names, writing', function () {
  this.timeout(60_000);

  test('a feature entry may be a method, a class or a file; an ambiguous name is an error', () => {
    const out = tree(exportTo(JAVA, ['--features', FEATURES]));
    const hs = out.get('features/Highscore.md')!;
    assert.match(hs, /- Highscore {2}\(class, 2 fn\)/);
    assert.match(hs, /- game\/Player\.java::Player\.update {2}\(method, 1 fn\)/);
    assert.match(out.get('features/Board.md')!, /- game\/Entity\.java {2}\(file, 5 fn\)/);
    const bad = path.join(tmpDir('feat'), 'f.json');
    fs.writeFileSync(bad, JSON.stringify({ X: ['move'] }));
    assert.throws(() => exportTo(JAVA, ['--features', bad]), (e: Error) => e instanceof ExportError && /names 2 functions; use one of: game\/Entity\.java::Entity\.move:10, game\/Entity\.java::Entity\.move:12/.test(e.message));
  });

  test('grouped feature files pick the set named after the repo folder', () => {
    const grouped = path.join(tmpDir('grp'), 'f.json');
    fs.writeFileSync(grouped, JSON.stringify({ 'java-game': { Only: ['Item'] }, other: { Never: ['Nope'] } }));
    const out = tree(exportTo(JAVA, ['--features', grouped]));
    assert.ok(out.has('features/Only.md') && !out.has('features/Never.md'));
  });

  test('--symbols limits the symbol pages; overloads get line suffixes', () => {
    const out = tree(exportTo(JAVA, ['--symbols', 'Entity']));
    const syms = [...out.keys()].filter((k) => k.startsWith('symbols/'));
    assert.deepStrictEqual(syms, ['symbols/game/Entity.java/Entity.clamp.md', 'symbols/game/Entity.java/Entity.constructor.md',
      'symbols/game/Entity.java/Entity.move-L10.md', 'symbols/game/Entity.java/Entity.move-L12.md', 'symbols/game/Entity.java/Entity.update.md']);
  });

  test('file names escape what Windows forbids, and %, so the mapping stays one to one', () => {
    assert.strictEqual(escapeSegment('a<b>:c"d|e?f*g\\h%i'), 'a%3Cb%3E%3Ac%22d%7Ce%3Ff%2Ag%5Ch%25i');
    assert.strictEqual(symbolPath({ id: 'x/y.py::f:3#2', rel: 'x/y.py' } as never), 'symbols/x/y.py/f-L3-2.md');
  });

  test('names that differ only in case get a deterministic suffix; a raw collision is still an error', () => {
    // Ordinal order: K.BETA < K.Beta < K.beta, so K.BETA keeps its name.
    assert.deepStrictEqual(caseSafe(['s/K.beta.md', 's/K.Beta.md', 's/x.md', 's/K.BETA.md']),
      ['s/K.beta-C3.md', 's/K.Beta-C2.md', 's/x.md', 's/K.BETA.md']);
    const p = new Pages();
    p.put('files/A.md', 'a');
    assert.throws(() => p.put('files/a.md', 'b'), /differ only in case/);
  });

  test('--clean replaces an earlier export, never a foreign folder; no stale page survives', () => {
    const out = exportTo(JAVA);
    fs.writeFileSync(path.join(out, 'files', 'stale.md'), 'old');
    assert.throws(() => runExport(parseArgs([JAVA, '--out', out])), /not empty; pass --clean/);
    runExport(parseArgs([JAVA, '--out', out, '--clean']));
    assert.ok(!fs.existsSync(path.join(out, 'files', 'stale.md')));
    const foreign = tmpDir('foreign');
    fs.writeFileSync(path.join(foreign, 'notes.txt'), 'mine');
    assert.throws(() => writeExport(foreign, new Pages(), true), /not an earlier export/);
    assert.strictEqual(fs.readFileSync(path.join(foreign, 'notes.txt'), 'utf8'), 'mine');
  });

  test('--clean puts the old export back when the final rename fails', () => {
    const out = exportTo(JAVA);
    const before = tree(out);
    const parent = path.dirname(out);
    // The `import * as fs` namespace only has getters; the module object behind it is patchable.
    const nodeFs: typeof fs = require('fs');
    const realRename = nodeFs.renameSync;
    let armed = true;
    // Let `target -> .old` through and fail the swap `tmp -> target` once, like EPERM on Windows.
    nodeFs.renameSync = (from, to) => {
      if (armed && path.resolve(String(to)) === out) {
        armed = false;
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      return realRename(from, to);
    };
    try {
      assert.throws(() => runExport(parseArgs([JAVA, '--out', out, '--clean'])), /EPERM/);
    } finally {
      nodeFs.renameSync = realRename;
    }
    assert.deepStrictEqual(tree(out), before);
    assert.deepStrictEqual(fs.readdirSync(parent), ['export']);
  });

  test('manifest: bytes, words and sha256 of every page as written', () => {
    const out = exportTo(JAVA);
    const m = JSON.parse(fs.readFileSync(path.join(out, MANIFEST), 'utf8'));
    const pages = tree(out);
    assert.strictEqual(m.files.length, pages.size - 1);
    for (const f of m.files) {
      const text = pages.get(f.path)!;
      assert.strictEqual(f.bytes, Buffer.byteLength(text));
      assert.strictEqual(f.words, wordCount(text));
      assert.strictEqual(f.sha256, sha256(text));
    }
    assert.ok(m.inputs.every((i: { path: string }) => !path.isAbsolute(i.path)));
    assert.ok(Object.keys(m.tool.analyzers).includes('scripts/analyze_java.js'));
    assert.strictEqual(wordCount('a  b\n\tc '), 3);
  });

  test('argument mistakes are usage errors with exit code 2', () => {
    for (const argv of [[JAVA], ['--out', 'x'], [JAVA, '--out', 'x', '--depth', '9'], [JAVA, '--out', 'x', '--lang', 'cobol']]) {
      assert.throws(() => parseArgs(argv), (e: Error) => e instanceof ExportError && e.exitCode === 2);
    }
  });
});
