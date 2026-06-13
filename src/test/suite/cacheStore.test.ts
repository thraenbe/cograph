import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanStructure } from '../../structureScanner';
import { loadCache, writeCache } from '../../cacheStore';

const NODE = (file: string) => ({ id: 'n', name: 'n', file, line: 1 });
function graphWith(file: string) {
  return { nodes: [NODE(file)], edges: [], files: [file] };
}

suite('cacheStore', () => {
  let tmp: string;

  setup(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-cache-')); });
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function setupRepo() {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export function a(){}');
    fs.writeFileSync(path.join(tmp, 'src', 'b.ts'), 'export function b(){}');
    return scanStructure(tmp);
  }

  test('round-trip: write then load → valid, no changes', () => {
    const structure = setupRepo();
    writeCache(tmp, graphWith(path.join(tmp, 'src', 'a.ts')), structure);

    const res = loadCache(tmp, structure)!;
    assert.ok(res, 'cache loads');
    assert.strictEqual(res.valid, true);
    assert.deepStrictEqual(res.changed, []);
    assert.deepStrictEqual(res.removed, []);
    assert.deepStrictEqual(res.graph.nodes.map(n => n.id), ['n']);
  });

  test('a changed mtime → invalid, lists the changed file', () => {
    const structure = setupRepo();
    writeCache(tmp, graphWith(path.join(tmp, 'src', 'a.ts')), structure);

    const aTs = path.join(tmp, 'src', 'a.ts');
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(aTs, future, future);

    const res = loadCache(tmp, scanStructure(tmp))!;
    assert.strictEqual(res.valid, false);
    assert.deepStrictEqual(res.changed, [aTs]);
    assert.deepStrictEqual(res.removed, []);
  });

  test('a new file → invalid, listed as changed', () => {
    const structure = setupRepo();
    writeCache(tmp, graphWith(path.join(tmp, 'src', 'a.ts')), structure);

    const cTs = path.join(tmp, 'src', 'c.ts');
    fs.writeFileSync(cTs, 'export function c(){}');

    const res = loadCache(tmp, scanStructure(tmp))!;
    assert.strictEqual(res.valid, false);
    assert.ok(res.changed.includes(cTs), 'new file is in changed');
  });

  test('a removed file → invalid, listed as removed', () => {
    const structure = setupRepo();
    writeCache(tmp, graphWith(path.join(tmp, 'src', 'a.ts')), structure);

    const bTs = path.join(tmp, 'src', 'b.ts');
    fs.rmSync(bTs);

    const res = loadCache(tmp, scanStructure(tmp))!;
    assert.strictEqual(res.valid, false);
    assert.deepStrictEqual(res.removed, [bTs]);
  });

  test('corrupt cache file → null (graceful miss)', () => {
    setupRepo();
    fs.mkdirSync(path.join(tmp, '.cograph'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.cograph', 'graph-cache.json'), '{ not valid json');
    assert.strictEqual(loadCache(tmp, scanStructure(tmp)), null);
  });

  test('schema-version mismatch → null', () => {
    const structure = setupRepo();
    fs.mkdirSync(path.join(tmp, '.cograph'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.cograph', 'graph-cache.json'),
      JSON.stringify({ schemaVersion: 999, savedAt: '', manifest: {}, graph: { nodes: [], edges: [] } }),
    );
    assert.strictEqual(loadCache(tmp, structure), null);
  });

  test('missing cache → null', () => {
    assert.strictEqual(loadCache(tmp, setupRepo()), null);
  });

  test('empty graph is not cached', () => {
    const structure = setupRepo();
    writeCache(tmp, { nodes: [], edges: [], files: [] }, structure);
    assert.strictEqual(fs.existsSync(path.join(tmp, '.cograph', 'graph-cache.json')), false);
  });

  test('writeCache on a non-existent root is a no-op (no throw, no dir created)', () => {
    const ghost = path.join(tmp, 'does', 'not', 'exist');
    assert.doesNotThrow(() => writeCache(ghost, graphWith('/x'), scanStructure(tmp)));
    assert.strictEqual(fs.existsSync(ghost), false);
  });
});
