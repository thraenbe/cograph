import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanStructure } from '../../structureScanner';
import {
  annotationsPath, toRel, toAbs, emptyAnnotations, loadAnnotations, saveAnnotations,
  fingerprint, childrenHash, folderChildren, reconcile,
} from '../../graphIntelligence/annotationStore';
import type { AnnotationFile } from '../../graphIntelligence/annotationTypes';

function write(root: string, rel: string, content: string): string {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

/** Annotate every file and folder of the tree so reconcile starts from "all fresh". */
function annotateAll(root: string): AnnotationFile {
  const tree = scanStructure(root);
  const data = emptyAnnotations();
  for (const f of tree.files) {
    const fp = fingerprint(f.path)!;
    data.files[toRel(root, f.path)] = { summary: `does ${path.basename(f.path)}`, at: 'now', ...fp };
  }
  const deepestFirst = Object.keys(tree.folders).sort((a, b) => tree.folders[b].depth - tree.folders[a].depth);
  for (const abs of deepestFirst) {
    data.folders[toRel(root, abs)] = {
      summary: `holds ${path.basename(abs)}`, at: 'now',
      childrenHash: childrenHash(folderChildren(root, tree, abs, data)),
    };
  }
  return data;
}

suite('annotationStore', () => {
  let root: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-annot-'));
    write(root, 'src/a.ts', 'export const a = 1;\n');
    write(root, 'src/util/b.ts', 'export const b = 2;\n');
    write(root, 'src/util/c.ts', 'export const c = 3;\n');
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test('relative keys are POSIX and the root is "."', () => {
    assert.strictEqual(toRel(root, path.join(root, 'src', 'util', 'b.ts')), 'src/util/b.ts');
    assert.strictEqual(toRel(root, root), '.');
    assert.strictEqual(toAbs(root, 'src/util/b.ts'), path.join(root, 'src', 'util', 'b.ts'));
    assert.strictEqual(toAbs(root, '.'), root);
  });

  test('the store lives in a subdirectory, not next to saved graphs', () => {
    assert.strictEqual(annotationsPath(root), path.join(root, '.cograph', 'annotations', 'annotations.json'));
  });

  test('save then load round-trips and leaves no temp file behind', () => {
    const data = annotateAll(root);
    saveAnnotations(root, data);
    assert.deepStrictEqual(loadAnnotations(root), data);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(annotationsPath(root))), ['annotations.json']);
  });

  test('missing, corrupt and wrong-version files load as empty', () => {
    assert.deepStrictEqual(loadAnnotations(root), emptyAnnotations());
    fs.mkdirSync(path.dirname(annotationsPath(root)), { recursive: true });
    fs.writeFileSync(annotationsPath(root), '{not json');
    assert.deepStrictEqual(loadAnnotations(root), emptyAnnotations());
    fs.writeFileSync(annotationsPath(root), JSON.stringify({ version: 99, files: {}, folders: {} }));
    assert.deepStrictEqual(loadAnnotations(root), emptyAnnotations());
  });

  test('fingerprint is content-based and null for unreadable files', () => {
    const a = fingerprint(path.join(root, 'src', 'a.ts'))!;
    assert.match(a.hash, /^[0-9a-f]{40}$/);
    assert.strictEqual(a.size, 20);
    assert.strictEqual(fingerprint(path.join(root, 'nope.ts')), null);
  });

  test('childrenHash ignores order but sees names, kinds and summaries', () => {
    const x = { name: 'x.ts', kind: 'file' as const, summary: 's1' };
    const y = { name: 'y', kind: 'folder' as const, summary: 's2' };
    assert.strictEqual(childrenHash([x, y]), childrenHash([y, x]));
    assert.notStrictEqual(childrenHash([x, y]), childrenHash([x, { ...y, summary: 'changed' }]));
    assert.notStrictEqual(childrenHash([x]), childrenHash([{ ...x, kind: 'folder' }]));
  });

  test('a freshly annotated tree has nothing stale', () => {
    const data = annotateAll(root);
    const res = reconcile(root, scanStructure(root), data);
    assert.deepStrictEqual([...res.stale], []);
    assert.strictEqual(res.dirty, false);
  });

  test('an mtime flip with identical content is NOT stale and refreshes the shortcut', () => {
    const data = annotateAll(root);
    const abs = path.join(root, 'src', 'a.ts');
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(abs, later, later); // what a branch switch and back does
    const res = reconcile(root, scanStructure(root), data);
    assert.deepStrictEqual([...res.stale], []);
    assert.strictEqual(res.dirty, true);
    assert.strictEqual(data.files['src/a.ts'].mtimeMs, fs.statSync(abs).mtimeMs);
  });

  test('a content change marks the file and its whole ancestor chain stale', () => {
    const data = annotateAll(root);
    write(root, 'src/util/b.ts', 'export const b = 42; // changed\n');
    const res = reconcile(root, scanStructure(root), data);
    assert.deepStrictEqual([...res.stale].sort(), ['src', 'src/util', 'src/util/b.ts']);
  });

  test('a changed child summary makes the parent folder stale', () => {
    const data = annotateAll(root);
    data.files['src/util/c.ts'].summary = 'rewritten by an update run';
    const res = reconcile(root, scanStructure(root), data);
    assert.ok(res.stale.has('src/util'));
    assert.ok(!res.stale.has('src/util/c.ts'));
  });

  test('a new file makes its folder stale; a removed file is pruned', () => {
    // A second file keeps `src` the common root once a.ts is gone (the scanner
    // collapses the root to the deepest folder that still holds every file).
    write(root, 'src/z.ts', 'export const z = 0;\n');
    const data = annotateAll(root);
    write(root, 'src/util/d.ts', 'export const d = 4;\n');
    fs.rmSync(path.join(root, 'src', 'a.ts'));
    const res = reconcile(root, scanStructure(root), data);
    assert.ok(res.stale.has('src/util'), 'new child changes the children hash');
    assert.ok(res.stale.has('src'), 'removed child changes the children hash');
    assert.strictEqual(data.files['src/a.ts'], undefined);
    assert.strictEqual(res.dirty, true);
  });

  test('a removed folder is pruned from the store', () => {
    const data = annotateAll(root);
    fs.rmSync(path.join(root, 'src', 'util'), { recursive: true });
    reconcile(root, scanStructure(root), data);
    assert.strictEqual(data.folders['src/util'], undefined);
    assert.strictEqual(data.files['src/util/b.ts'], undefined);
  });

  test('unannotated paths are never reported stale', () => {
    const res = reconcile(root, scanStructure(root), emptyAnnotations());
    assert.strictEqual(res.stale.size, 0);
  });
});
