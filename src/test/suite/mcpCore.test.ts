import * as assert from 'assert';
import * as fs from 'fs';
import { readCacheFile } from '../../cacheStore';
import { loadAnnotations } from '../../graphIntelligence/annotationStore';
import { buildIndex, IndexHolder, resolveSymbol, fileChangedSinceAnalysis, type GraphIndex } from '../../mcp/graphIndex';
import { splitLine } from '../../mcp/ids';
import { overviewOf } from '../../mcp/overview';
import { ToolError } from '../../mcp/paths';
import { findSymbols, impactOf, isTestPath, seedsForPath, walk } from '../../mcp/queries';
import { makeFixture, type Fixture } from './mcpFixture';

function indexOf(fx: Fixture): GraphIndex {
  return buildIndex(fx.root, readCacheFile(fx.root)!, loadAnnotations(fx.root));
}

suite('MCP graph index and ids', () => {
  let fx: Fixture;
  let index: GraphIndex;
  setup(() => { fx = makeFixture({ annotate: true }); index = indexOf(fx); });
  teardown(() => fx.cleanup());

  test('agent ids are workspace-relative, class-qualified, and line-suffixed only when ambiguous', () => {
    const ids = index.symbols.map((s) => s.id).sort();
    assert.ok(ids.includes('src/a.ts::main'));
    assert.ok(ids.includes('src/c.ts::Svc.start'));
    assert.ok(ids.includes('src/dup.py::cli:1') && ids.includes('src/dup.py::cli:4'));
    assert.ok(ids.includes('library::lodash::map'), 'library ids are already path-free');
    assert.ok(ids.includes('MAIN'));
    assert.ok(!ids.some((i) => i.includes(fx.root)), 'no absolute paths leak into ids');
  });

  test('edges: self loops and edges to unknown nodes are dropped, duplicates collapse', () => {
    const main = index.byId.get('src/a.ts::main')!;
    assert.deepStrictEqual([...index.callees.get(main.rawId)!].sort(), [fx.raw('src/a.ts', 'helper', 5), 'library::lodash::map'].sort());
    const x = index.byId.get('src/cycle.ts::x')!;
    assert.ok(!index.callers.get(x.rawId)!.has(x.rawId));
  });

  test('resolveSymbol: agent id, raw id, class-less guess, drifted line, ambiguity, unknown', () => {
    assert.strictEqual(resolveSymbol(index, 'src/a.ts::helper').name, 'helper');
    assert.strictEqual(resolveSymbol(index, fx.raw('src/a.ts', 'leaf', 8)).id, 'src/a.ts::leaf');
    assert.strictEqual(resolveSymbol(index, 'src/c.ts::start').id, 'src/c.ts::Svc.start');
    assert.strictEqual(resolveSymbol(index, 'src/dup.py::cli:3').line, 4, 'nearest line wins after drift');
    assert.strictEqual(resolveSymbol(index, ' src/a.ts::main ').name, 'main', 'whitespace is trimmed');
    assert.throws(() => resolveSymbol(index, 'src/dup.py::cli'), (e: Error) => e instanceof ToolError && /names 2 functions/.test(e.message) && /cli:1/.test(e.message));
    assert.throws(() => resolveSymbol(index, 'src/a.ts::nope'), /find_symbol/);
  });

  test('splitLine handles a #n duplicate suffix and plain ids', () => {
    assert.deepStrictEqual(splitLine('a.ts::f:12#2'), { base: 'a.ts::f', line: 12 });
    assert.deepStrictEqual(splitLine('a.ts::f'), { base: 'a.ts::f', line: null });
  });

  test('IndexHolder: null without a cache, reloads when the cache file changes, picks up new annotations', () => {
    const bare = makeFixture({ cache: false });
    try { assert.strictEqual(new IndexHolder(bare.root).get(), null); } finally { bare.cleanup(); }

    const holder = new IndexHolder(fx.root);
    const first = holder.get()!;
    assert.strictEqual(holder.get(), first, 'same object while nothing changed');
    assert.strictEqual(first.annotations.folders.src.summary, 'Application code.');

    const cacheFile = `${fx.root}/.cograph/graph-cache.json`;
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(cacheFile, later, later);
    assert.notStrictEqual(holder.get(), first, 'rebuilt after the cache mtime changed');

    const annFile = `${fx.root}/.cograph/annotations/annotations.json`;
    const ann = JSON.parse(fs.readFileSync(annFile, 'utf8'));
    ann.folders.src.summary = 'Changed.';
    fs.writeFileSync(annFile, JSON.stringify(ann));
    fs.utimesSync(annFile, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    assert.strictEqual(holder.get()!.annotations.folders.src.summary, 'Changed.');

    fs.rmSync(cacheFile);
    assert.strictEqual(holder.get(), null, 'a deleted cache yields null, not a stale index');
  });

  test('staleness: clean right after analysis, counts edits, throttled between checks', () => {
    let now = 1_000_000;
    const holder = new IndexHolder(fx.root, () => now);
    assert.strictEqual(holder.staleness(), null, 'nothing before the first get()');
    holder.get();
    assert.deepStrictEqual(holder.staleness(), { changed: 0, removed: 0 });
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(fx.abs('src/b.py'), later, later);
    assert.deepStrictEqual(holder.staleness(), { changed: 0, removed: 0 }, 'cached inside the throttle window');
    now += 6000;
    assert.deepStrictEqual(holder.staleness(), { changed: 1, removed: 0 });
    assert.strictEqual(fileChangedSinceAnalysis(index, fx.abs('src/b.py')), true);
    assert.strictEqual(fileChangedSinceAnalysis(index, fx.abs('src/a.ts')), false);
    assert.strictEqual(fileChangedSinceAnalysis(index, fx.abs('gone.ts')), true);
  });
});

suite('MCP queries', () => {
  let fx: Fixture;
  let index: GraphIndex;
  setup(() => { fx = makeFixture({ annotate: true }); index = indexOf(fx); });
  teardown(() => fx.cleanup());

  const find = (query: string, extra: Partial<Parameters<typeof findSymbols>[1]> = {}) =>
    findSymbols(index, { query, limit: 20, includeLibraries: false, ...extra });

  test('find_symbol ranks exact before prefix before substring, and honours path and limit', () => {
    assert.deepStrictEqual(find('helper').items.map((s) => s.id), ['src/a.ts::helper', 'src/b.py::helper_py']);
    assert.deepStrictEqual(find('Svc.start').items.map((s) => s.id), ['src/c.ts::Svc.start']);
    assert.deepStrictEqual(find('per').items.map((s) => s.name).sort(), ['helper', 'helper_py']);
    assert.deepStrictEqual(find('helper', { path: 'src/b.py' }).items.map((s) => s.id), ['src/b.py::helper_py']);
    const limited = find('e', { limit: 1 });
    assert.strictEqual(limited.items.length, 1);
    assert.ok(limited.total > 1);
    assert.strictEqual(find('src/a.ts::leaf').items[0].id, 'src/a.ts::leaf', 'an id is an exact hit');
  });

  test('find_symbol skips libraries and module code unless asked, and rejects blank queries', () => {
    assert.strictEqual(find('map').total, 0);
    assert.strictEqual(find('map', { includeLibraries: true }).items[0].id, 'library::lodash::map');
    const mainHits = find('MAIN').items.map((s) => s.id);
    assert.strictEqual(mainHits[0], 'src/a.ts::main', 'case-insensitive exact name first');
    assert.ok(!mainHits.includes('MAIN'), 'the module-level pseudo node is never a hit');
    assert.throws(() => find('  '), ToolError);
    assert.throws(() => find('x', { path: '../outside' }), /outside the workspace/);
  });

  test('walk: callers by depth with via, limit keeps the total, cycles terminate', () => {
    const leaf = resolveSymbol(index, 'src/a.ts::leaf');
    const r = walk(index, leaf, 'callers', 3, 50, false);
    const byDepth = r.items.map((i) => `${i.depth}:${i.sym.name}`);
    assert.deepStrictEqual(byDepth, ['1:helper', '1:helper_py', '2:main', '2:run', '2:start', '3:MAIN', '3:testMain']);
    assert.strictEqual(r.items.find((i) => i.sym.name === 'main')!.via!.name, 'helper');
    assert.strictEqual(r.maxDepthHit, false);
    const capped = walk(index, leaf, 'callers', 3, 2, false);
    assert.strictEqual(capped.items.length, 2);
    assert.strictEqual(capped.total, 7);
    assert.strictEqual(walk(index, leaf, 'callers', 1, 50, false).maxDepthHit, true);
    const x = resolveSymbol(index, 'src/cycle.ts::x');
    assert.deepStrictEqual(walk(index, x, 'callees', 5, 50, false).items.map((i) => i.sym.name), ['y']);
  });

  test('walk: callees hide libraries unless includeLibraries', () => {
    const main = resolveSymbol(index, 'src/a.ts::main');
    assert.deepStrictEqual(walk(index, main, 'callees', 1, 50, false).items.map((i) => i.sym.name), ['helper']);
    assert.ok(walk(index, main, 'callees', 1, 50, true).items.some((i) => i.sym.isLibrary));
  });

  test('impact of a function: transitive callers, files nearest first, tests and entry points', () => {
    const r = impactOf(index, [resolveSymbol(index, 'src/a.ts::helper')]);
    assert.deepStrictEqual(r.affected.map((a) => a.sym.name).sort(), ['main', 'start', 'testMain']);
    assert.deepStrictEqual(r.files.map((f) => f.rel), ['src/a.ts', 'src/c.ts', 'tests/test_a.ts']);
    assert.deepStrictEqual(r.tests.map((s) => s.name), ['testMain']);
    assert.deepStrictEqual(r.entryPoints.map((s) => s.id), ['src/c.ts::Svc.start'], 'tests are not entry points');
    assert.strictEqual(r.maxDepth, 2);
  });

  test('impact of a path seeds every function in it; empty or escaping paths are errors', () => {
    const seeds = seedsForPath(index, 'src/b.py');
    assert.deepStrictEqual(seeds.map((s) => s.name), ['run', 'helper_py']);
    const r = impactOf(index, seeds);
    assert.deepStrictEqual(r.affected.map((a) => a.sym.id), ['MAIN']);
    assert.deepStrictEqual(r.files.map((f) => f.rel), ['(module-level code)']);
    assert.throws(() => seedsForPath(index, 'docs'), /No analysed functions/);
    assert.throws(() => seedsForPath(index, '/etc'), /outside the workspace/);
  });

  test('isTestPath recognises the common layouts and nothing else', () => {
    for (const p of ['tests/a.py', 'pkg/test/x.java', 'src/__tests__/a.js', 'a/test_x.py', 'a/x_test.go', 'a/x.test.ts', 'a/x.spec.js']) {
      assert.ok(isTestPath(p), p);
    }
    for (const p of ['src/latest.ts', 'src/contest.py', 'src/testing.ts']) { assert.ok(!isTestPath(p), p); }
    assert.strictEqual(isTestPath(null), false);
  });

  test('overview: tree with counts and summaries, entry points, hot spots; file and empty scopes', () => {
    const o = overviewOf(index, undefined, 2);
    assert.strictEqual(o.functions, 12);
    assert.strictEqual(o.tree!.summary, 'The fixture workspace.');
    const src = o.tree!.children.find((c) => c.name === 'src')!;
    assert.strictEqual(src.functions, 11);
    assert.strictEqual(src.files, 5);
    assert.strictEqual(src.summary, 'Application code.');
    assert.ok(o.entryPoints.every((s) => s.rel !== 'tests/test_a.ts'));
    assert.deepStrictEqual(o.hotSpots.slice(0, 2).map((s) => s.name), ['helper', 'leaf'], 'ties on 2 callers break by location');
    assert.deepStrictEqual(o.languages.map((l) => l.language), ['typescript', 'python']);

    const file = overviewOf(index, 'src/a.ts', 2);
    assert.strictEqual(file.isFile, true);
    assert.strictEqual(file.fileSummary, 'Entry point and helpers.');
    assert.deepStrictEqual(file.fileFunctions.map((s) => s.name), ['main', 'helper', 'leaf', 'orphan']);
    assert.strictEqual(overviewOf(index, 'docs', 2).functions, 0);
    assert.strictEqual(overviewOf(index, '.', 1).tree!.children.every((c) => c.children.length === 0), true, 'depth bounds the tree');
  });
});
