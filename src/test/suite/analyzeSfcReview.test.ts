import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isAnalyzablePath, isSfcFileName, listProjectSourceFiles } from '../../structureScanner';

/* eslint-disable @typescript-eslint/no-require-imports */
const sfc = require('../../../scripts/sfcScript.js');
const tsAnalyzer = require('../../../scripts/analyze_ts.js');
const jsAnalyzer = require('../../../scripts/analyze_js.js');
const fc = require('../../../src/webview/fileClusters.js');
/* eslint-enable @typescript-eslint/no-require-imports */

// The review findings on #121: attribute parsing outside quoted values, script
// languages neither analyzer parses, upper-case component extensions on the host's
// discovery paths, and the collapsed file element's language. Each case fails when
// its fix is reverted.

interface Node { id: string; name: string; file: string; line: number; language: string }

/** 1-based line of the first line of `src` containing `needle`. */
function lineOf(src: string, needle: string): number {
  const idx = src.split('\n').findIndex(l => l.includes(needle));
  assert.ok(idx >= 0, `fixture lacks "${needle}"`);
  return idx + 1;
}

function definitions(analyzer: any, files: string[]): Node[] {
  return Object.values(analyzer.collectDefinitions(files)) as Node[];
}

// ---------------------------------------------------------------------------
// Attributes: names are read between attributes, never inside a quoted value
// ---------------------------------------------------------------------------

suite('sfcScript: attribute parsing', () => {
  test('`src` inside a quoted generic constraint is not a src attribute', () => {
    const attrs = sfc.parseAttrs(' setup lang="ts" generic="T extends { src: string }"');
    assert.ok(!attrs.has('src'));
    assert.strictEqual(attrs.get('generic'), 'T extends { src: string }');
    assert.strictEqual(attrs.get('lang'), 'ts');
    assert.strictEqual(attrs.get('setup'), '');
  });

  test('a name needs a boundary: data-src and data-lang are their own names', () => {
    const attrs = sfc.parseAttrs(' data-src="x" data-lang=ts');
    assert.deepStrictEqual([...attrs.keys()], ['data-src', 'data-lang']);
  });

  test('names are case-insensitive; unquoted values may hold `/`; spaces around `=` are allowed', () => {
    const attrs = sfc.parseAttrs(' SRC=./lib/a.js LANG = "TS" ');
    assert.strictEqual(attrs.get('src'), './lib/a.js');
    assert.strictEqual(attrs.get('lang'), 'TS');
  });

  test('single quotes, the first occurrence wins, a stray quoted run is no name, an unclosed quote ends the text', () => {
    assert.strictEqual(sfc.parseAttrs(" lang='tsx' lang=js").get('lang'), 'tsx');
    assert.deepStrictEqual([...sfc.parseAttrs(' "a src b" module').keys()], ['module']);
    assert.strictEqual(sfc.parseAttrs(' lang="ts').get('lang'), 'ts');
    assert.deepStrictEqual([...sfc.parseAttrs(' =x').keys()], [], 'a value without a name is dropped');
  });

  test('a Vue generic block mentioning `src` keeps its function nodes on the right lines', () => {
    const vue = [
      '<template><p /></template>',
      '<script setup lang="ts" generic="T extends { src: string }">',
      'function pick(item: T): string {',
      '  return item.src;',
      '}',
      '</script>',
      '',
    ].join('\n');
    assert.strictEqual(sfc.extractScriptBlocks(vue).length, 1, 'the inline script is not taken for an external one');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-sfc-generic-'));
    try {
      sfc.clearSfcCache();
      const file = path.join(tmp, 'Pick.vue');
      fs.writeFileSync(file, vue);
      const pick = definitions(tsAnalyzer, [file]).find(n => n.name === 'pick');
      assert.ok(pick, 'pick is a node');
      assert.strictEqual(pick.line, lineOf(vue, 'function pick'));
    } finally {
      sfc.clearSfcCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Script languages: only JavaScript and TypeScript reach a parser
// ---------------------------------------------------------------------------

suite('sfcScript: unsupported script languages', () => {
  const COFFEE_ONLY = '<script lang="coffee">\nsquare = (x) -> x * x\n</script>\n<template><p /></template>\n';
  const COFFEE_AND_TS = [
    '<script lang="coffee">',
    'cube = (x) -> x * x * x',
    '</script>',
    '<script lang="ts">',
    'export function twice(n: number): number {',
    '  return n * 2;',
    '}',
    '</script>',
    '',
  ].join('\n');
  const COFFEE_AND_JS = '<script lang="coffee">\nfunction fromCoffee() {}\n</script>\n<script>\nfunction fromJs() {}\n</script>\n';
  let tmp: string;

  setup(() => {
    sfc.clearSfcCache();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-sfc-lang-'));
  });
  teardown(() => {
    sfc.clearSfcCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('accepted lang values map to the analyzer flavour; anything else is dropped', () => {
    const langOf = (attr: string) => sfc.extractScriptBlocks(`<script ${attr}>\nx\n</script>\n`).map((b: any) => b.lang);
    assert.deepStrictEqual(langOf('lang="typescript"'), ['ts']);
    assert.deepStrictEqual(langOf('lang="TSX"'), ['tsx']);
    assert.deepStrictEqual(langOf('lang="javascript"'), ['js']);
    assert.deepStrictEqual(langOf('lang="jsx"'), ['js']);
    assert.deepStrictEqual(langOf(''), ['js']);
    assert.deepStrictEqual(langOf('lang="coffee"'), []);
    assert.deepStrictEqual(langOf('lang="livescript"'), []);
  });

  test('a component whose only script is CoffeeScript belongs to neither analyzer', () => {
    const file = path.join(tmp, 'Square.vue');
    fs.writeFileSync(file, COFFEE_ONLY);
    assert.strictEqual(sfc.sfcAnalyzerFor(file), null);
    assert.ok(!jsAnalyzer.isJsPath(file), 'not sent to the JavaScript parser');
    assert.ok(!tsAnalyzer.isTsPath(file));
    assert.deepStrictEqual(jsAnalyzer.collectJsFiles(tmp), []);
  });

  test('next to a TS block, the CoffeeScript block is blank in the virtual source and the TS lines hold', () => {
    const blocks = sfc.extractScriptBlocks(COFFEE_AND_TS);
    assert.deepStrictEqual(blocks.map((b: any) => b.lang), ['ts']);
    const virtual: string = sfc.sfcVirtualSource(COFFEE_AND_TS, blocks);
    assert.strictEqual(virtual.length, COFFEE_AND_TS.length);
    assert.ok(!virtual.includes('cube'), 'the coffee code is not parsed');

    const file = path.join(tmp, 'Twice.vue');
    fs.writeFileSync(file, COFFEE_AND_TS);
    const twice = definitions(tsAnalyzer, [file]).find(n => n.name === 'twice');
    assert.ok(twice);
    assert.strictEqual(twice.line, lineOf(COFFEE_AND_TS, 'export function twice'));
  });

  test('next to a plain JS block, only the JS block yields nodes', () => {
    const file = path.join(tmp, 'Mixed.svelte');
    fs.writeFileSync(file, COFFEE_AND_JS);
    assert.deepStrictEqual(definitions(jsAnalyzer, [file]).map(n => n.name), ['fromJs']);
  });
});

// ---------------------------------------------------------------------------
// Upper-case component extensions on the host's discovery paths
// ---------------------------------------------------------------------------

suite('host discovery: component extensions in any case', () => {
  test('isSfcFileName matches .vue / .svelte in any case and nothing else', () => {
    assert.ok(isSfcFileName('App.VUE'));
    assert.ok(isSfcFileName('/p/Widget.Svelte'));
    assert.ok(isSfcFileName('App.vue'));
    assert.ok(!isSfcFileName('App.vue.bak'));
    assert.ok(!isSfcFileName('vue'));
    assert.ok(!isSfcFileName('App.astro'));
  });

  test('the structure scan and isAnalyzablePath accept App.VUE, as the analyzers do', () => {
    assert.ok(isAnalyzablePath('src/App.VUE'));
    assert.ok(isAnalyzablePath('src/Widget.SVELTE'));
    assert.ok(!isAnalyzablePath('src/App.TS'), 'the TS/JS extensions stay case-sensitive');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-sfc-case-'));
    try {
      fs.writeFileSync(path.join(tmp, 'App.VUE'), '<script lang="ts">\nexport function a() {}\n</script>\n');
      const listed = listProjectSourceFiles(tmp, () => null);
      assert.deepStrictEqual(listed.map(f => [path.basename(f.path), f.language]), [['App.VUE', 'typescript']]);
      sfc.clearSfcCache();
      assert.deepStrictEqual(tsAnalyzer.collectTsFiles(tmp).map((f: string) => path.basename(f)), ['App.VUE'],
        'the analyzer walk agrees with the structure scan');
    } finally {
      sfc.clearSfcCache();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The collapsed file element's language
// ---------------------------------------------------------------------------

suite('file clusters: a collapsed component takes its analyzed language', () => {
  const tree = {
    root: '/p',
    folders: { '/p': { path: '/p', depth: 0, parent: null, childFolders: [], files: ['/p/Tick.vue', '/p/User.vue'], fileCount: 2 } },
    files: [], totalFiles: 2,
  };
  const graph = { nodes: [{ id: '/p/Tick.vue::tick::8', name: 'tick', file: '/p/Tick.vue', line: 8, language: 'javascript' }], edges: [] };

  test('a JS component with graph nodes in an unparsed folder is javascript, not the extension guess', () => {
    const els = fc.buildSkeletonElements(tree, new Set(['/p']), new Set(), graph);
    const tick = els.find((e: any) => e.data.id === 'file::/p/Tick.vue');
    assert.ok(tick, 'a collapsed file element');
    assert.strictEqual(tick.data.language, 'javascript');
  });

  test('a component without graph nodes falls back to the parse-free extension guess', () => {
    const els = fc.buildSkeletonElements(tree, new Set(['/p']), new Set(), graph);
    assert.strictEqual(els.find((e: any) => e.data.id === 'file::/p/User.vue').data.language, 'typescript');
    const bare = fc.buildSkeletonElements(tree, new Set(['/p']), new Set(), null);
    assert.strictEqual(bare.find((e: any) => e.data.id === 'file::/p/Tick.vue').data.language, 'typescript');
  });
});
