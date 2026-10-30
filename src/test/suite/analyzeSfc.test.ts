import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { funcLangOf } from '../../funcEnd';
import { getFuncSource } from '../../sourceEditor';
import { isAnalyzablePath, listProjectSourceFiles } from '../../structureScanner';

/* eslint-disable @typescript-eslint/no-require-imports */
const sfc = require('../../../scripts/sfcScript.js');
const tsAnalyzer = require('../../../scripts/analyze_ts.js');
const jsAnalyzer = require('../../../scripts/analyze_js.js');
/* eslint-enable @typescript-eslint/no-require-imports */

// Vue and Svelte single-file components: the <script> blocks go through the TS/JS
// analyzers as a virtual source with the file's own line count, so every node line
// must equal the line of its declaration in the ORIGINAL file. Line correctness is
// the whole feature, so each case below locates the expected line by searching the
// fixture text rather than hard-coding it.

/** 1-based line of the first line of `src` containing `needle`. */
function lineOf(src: string, needle: string): number {
  const idx = src.split('\n').findIndex(l => l.includes(needle));
  assert.ok(idx >= 0, `fixture lacks "${needle}"`);
  return idx + 1;
}

// A Vue 3 component with two TS blocks, neither on line 1.
const VUE_TS = [
  '<template>',
  '  <button @click="save()">{{ label }}</button>',
  '</template>',
  '',
  '<!-- <script>commentedOut()</script> -->',
  '<script lang="ts">',
  'export function helper(): number {',
  '  return 1;',
  '}',
  '</script>',
  '',
  '<script setup lang="ts">',
  "import { fetchUser } from './api';",
  'const save = () => {',
  '  helper();',
  '  return fetchUser(1);',
  '};',
  '</script>',
  '',
  '<style scoped>.a { color: red; }</style>',
  '',
].join('\n');

// A Vue component with a plain JS block (no lang attribute).
const VUE_JS = [
  '<template><div>{{ n }}</div></template>',
  '',
  '<script>',
  "import { formatName } from './util.js';",
  'export default {',
  '  data() { return { n: 0 }; },',
  '};',
  'function tick() {',
  '  return formatName("x");',
  '}',
  '</script>',
  '',
].join('\n');

// A Svelte component with a module block and an instance block, plain JS.
const SVELTE_JS = [
  '<script context="module">',
  '  export function load() { return 1; }',
  '</script>',
  '',
  '<script>',
  "  import { formatName } from './util.js';",
  '  let n = 0;',
  '  function inc() {',
  '    n += 1;',
  '    load();',
  '    return formatName("y");',
  '  }',
  '</script>',
  '',
  '<button on:click={inc}>{n}</button>',
  '',
].join('\n');

// A Svelte 5 component whose script is TypeScript and does not start at line 1.
const SVELTE_TS = [
  '<svelte:options runes={true} />',
  '',
  '<script lang="ts">',
  "  import { fetchUser } from './api';",
  '  let count = $state(0);',
  '  function bump(by: number): void {',
  '    count += by;',
  '    fetchUser(count);',
  '  }',
  '</script>',
  '',
  '<button onclick={() => bump(1)}>{count}</button>',
  '',
].join('\n');

const API_TS = 'export function fetchUser(id: number): number {\n  return id;\n}\n';
const UTIL_JS = 'export function formatName(n) {\n  return n;\n}\n';

interface Node { id: string; name: string; file: string; line: number; language: string }
interface Edge { source: string; target: string }

function analyze(analyzer: any, files: string[]): { nodes: Node[]; edges: Edge[] } {
  const defs = analyzer.collectDefinitions(files);
  const { edges } = analyzer.collectCalls(files, defs, path.dirname(files[0]));
  return { nodes: Object.values(defs) as Node[], edges };
}

function nodeNamed(nodes: Node[], file: string, name: string): Node {
  const n = nodes.find(x => x.file === file && x.name === name);
  assert.ok(n, `no node ${name} in ${path.basename(file)}; got ${nodes.map(x => x.name).join(', ')}`);
  return n as Node;
}

function hasEdge(edges: Edge[], from: Node, to: Node): boolean {
  return edges.some(e => e.source === from.id && e.target === to.id);
}

// ---------------------------------------------------------------------------
// sfcScript.js — block extraction and the virtual source
// ---------------------------------------------------------------------------

suite('sfcScript: script block extraction', () => {
  test('isSfcPath accepts .vue and .svelte (any case) and nothing else', () => {
    assert.ok(sfc.isSfcPath('/a/App.vue'));
    assert.ok(sfc.isSfcPath('/a/Widget.svelte'));
    assert.ok(sfc.isSfcPath('/a/UPPER.VUE'));
    assert.ok(!sfc.isSfcPath('/a/app.ts'));
    assert.ok(!sfc.isSfcPath('/a/vue'));
    assert.ok(!sfc.isSfcPath('/a/component.vue.ts'));
  });

  test('a Vue file with <script> and <script setup> yields two blocks with lang, code and start line', () => {
    const blocks = sfc.extractScriptBlocks(VUE_TS);
    assert.strictEqual(blocks.length, 2);
    assert.deepStrictEqual(blocks.map((b: any) => b.lang), ['ts', 'ts']);
    assert.strictEqual(blocks[0].line, lineOf(VUE_TS, '<script lang="ts">'));
    assert.strictEqual(blocks[1].line, lineOf(VUE_TS, '<script setup lang="ts">'));
    assert.ok(blocks[0].code.includes('export function helper'));
    assert.ok(blocks[1].code.includes('const save'));
    assert.ok(!blocks[1].code.includes('</script>'), 'the closing tag is not part of the code');
  });

  test('Svelte module + instance blocks are both found; a missing lang means js', () => {
    const blocks = sfc.extractScriptBlocks(SVELTE_JS);
    assert.strictEqual(blocks.length, 2);
    assert.deepStrictEqual(blocks.map((b: any) => b.lang), ['js', 'js']);
    assert.strictEqual(blocks[0].line, 1);
    assert.strictEqual(blocks[1].line, lineOf(SVELTE_JS, '<script>'));
  });

  test('lang is read from double quotes, single quotes and bare values; `<script module>` (Svelte 5) is a block', () => {
    const src = "<script module lang='ts'>\nexport const a = 1;\n</script>\n<script lang=ts>\nconst b = 2;\n</script>\n";
    const blocks = sfc.extractScriptBlocks(src);
    assert.deepStrictEqual(blocks.map((b: any) => b.lang), ['ts', 'ts']);
  });

  test('a `>` inside a quoted attribute (Vue generic="T extends Foo<Bar>") does not end the tag', () => {
    const src = '<script setup lang="ts" generic="T extends Foo<Bar>">\nfunction pick(x: T) { return x; }\n</script>\n';
    const blocks = sfc.extractScriptBlocks(src);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].lang, 'ts');
    assert.strictEqual(blocks[0].code, '\nfunction pick(x: T) { return x; }\n', 'the code starts after the real `>`');
  });

  test('attribute names match whole words: data-lang / data-src are not lang / src', () => {
    const blocks = sfc.extractScriptBlocks('<script data-lang="ts" data-src="x">\nconst a = 1;\n</script>\n');
    assert.strictEqual(blocks.length, 1, 'data-src is not an external script');
    assert.strictEqual(blocks[0].lang, 'js', 'data-lang is not the lang attribute');
  });

  test('a <script> inside an HTML comment and a <script src="…"> are not blocks', () => {
    const src = '<!-- <script>\nnope()\n</script> -->\n<script src="./external.js"></script>\n<template></template>\n';
    assert.deepStrictEqual(sfc.extractScriptBlocks(src), []);
    assert.strictEqual(sfc.sfcScriptLanguage([]), null);
  });

  test('a file without any script block yields no blocks and a null language', () => {
    assert.deepStrictEqual(sfc.extractScriptBlocks('<template><p>static</p></template>\n'), []);
  });

  test('an unterminated opening tag (`<script lang="ts"` without `>`) yields no block, no throw', () => {
    assert.deepStrictEqual(sfc.extractScriptBlocks('<template></template>\n<script lang="ts"\nfunction f() {}\n'), []);
  });

  test('an unterminated <script> block runs to the end of the file (no throw)', () => {
    const blocks = sfc.extractScriptBlocks('<script>\nfunction f() {}\n');
    assert.strictEqual(blocks.length, 1);
    assert.ok(blocks[0].code.includes('function f'));
  });

  test('sfcScriptLanguage: any ts block makes the file ts; tsx wins over ts; else js', () => {
    assert.strictEqual(sfc.sfcScriptLanguage([{ lang: 'js' }, { lang: 'ts' }]), 'ts');
    assert.strictEqual(sfc.sfcScriptLanguage([{ lang: 'ts' }, { lang: 'tsx' }]), 'tsx');
    assert.strictEqual(sfc.sfcScriptLanguage([{ lang: 'js' }]), 'js');
  });

  test('the virtual source keeps the line count and line starts, and blanks everything outside the blocks', () => {
    const blocks = sfc.extractScriptBlocks(VUE_TS);
    const virtual: string = sfc.sfcVirtualSource(VUE_TS, blocks);
    const origLines = VUE_TS.split('\n');
    const virtLines = virtual.split('\n');
    assert.strictEqual(virtLines.length, origLines.length, 'same number of lines');
    for (let i = 0; i < origLines.length; i++) {
      assert.strictEqual(virtLines[i].length, origLines[i].length, `line ${i + 1} keeps its length`);
    }
    assert.strictEqual(virtLines[lineOf(VUE_TS, 'export function helper') - 1], 'export function helper(): number {');
    assert.strictEqual(virtLines[lineOf(VUE_TS, '<template>') - 1].trim(), '', 'template line is blank');
    assert.strictEqual(virtLines[lineOf(VUE_TS, 'commentedOut') - 1].trim(), '', 'HTML comment is blank');
    assert.strictEqual(virtLines[lineOf(VUE_TS, '<style scoped>') - 1].trim(), '', 'style line is blank');
    assert.ok(!virtual.includes('<script'), 'no tag survives');
  });

  test('a CRLF file keeps its CR characters so byte offsets still line up', () => {
    const crlf = '<template></template>\r\n<script>\r\nfunction f() {}\r\n</script>\r\n';
    const virtual: string = sfc.sfcVirtualSource(crlf, sfc.extractScriptBlocks(crlf));
    assert.strictEqual(virtual.length, crlf.length);
    assert.strictEqual(virtual.split('\r\n').length, crlf.split('\r\n').length);
  });
});

// ---------------------------------------------------------------------------
// Analyzer integration: node lines, edges, routing
// ---------------------------------------------------------------------------

suite('Vue / Svelte components through the TS and JS analyzers', () => {
  let tmp: string;
  let vueTs: string, vueJs: string, svelteJs: string, svelteTs: string, apiTs: string, utilJs: string;

  setup(() => {
    sfc.clearSfcCache();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-sfc-'));
    fs.mkdirSync(path.join(tmp, 'src'));
    const w = (name: string, text: string) => { const p = path.join(tmp, 'src', name); fs.writeFileSync(p, text); return p; };
    vueTs = w('User.vue', VUE_TS);
    vueJs = w('Tick.vue', VUE_JS);
    svelteJs = w('Counter.svelte', SVELTE_JS);
    svelteTs = w('Bump.svelte', SVELTE_TS);
    apiTs = w('api.ts', API_TS);
    utilJs = w('util.js', UTIL_JS);
  });

  teardown(() => {
    sfc.clearSfcCache();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('Vue, lang="ts", two blocks: node lines equal the declaration lines of the original file', () => {
    const { nodes } = analyze(tsAnalyzer, [vueTs, apiTs]);
    const helper = nodeNamed(nodes, vueTs, 'helper');
    const save = nodeNamed(nodes, vueTs, 'save');
    assert.strictEqual(helper.line, lineOf(VUE_TS, 'export function helper'));
    assert.strictEqual(save.line, lineOf(VUE_TS, 'const save'));
    assert.ok(helper.line > 1 && save.line > helper.line, 'neither block starts at line 1');
    assert.strictEqual(helper.id, `${vueTs}::helper::${helper.line}`, 'the id names the .vue file, not a temp file');
    assert.strictEqual(helper.language, 'typescript');
  });

  test('Vue, lang="ts": the component calls across blocks and into a sibling .ts module', () => {
    const { nodes, edges } = analyze(tsAnalyzer, [vueTs, apiTs]);
    const save = nodeNamed(nodes, vueTs, 'save');
    assert.ok(hasEdge(edges, save, nodeNamed(nodes, vueTs, 'helper')), 'setup block → script block');
    assert.ok(hasEdge(edges, save, nodeNamed(nodes, apiTs, 'fetchUser')), 'component → src module');
  });

  test('Vue, plain JS block: analyzed by the JS analyzer with the original line', () => {
    const { nodes, edges } = analyze(jsAnalyzer, [vueJs, utilJs]);
    const tick = nodeNamed(nodes, vueJs, 'tick');
    assert.strictEqual(tick.line, lineOf(VUE_JS, 'function tick'));
    assert.strictEqual(tick.language, 'javascript');
    assert.ok(hasEdge(edges, tick, nodeNamed(nodes, utilJs, 'formatName')));
  });

  test('Svelte, plain JS, module + instance blocks: node lines and the cross-block edge', () => {
    const { nodes, edges } = analyze(jsAnalyzer, [svelteJs, utilJs]);
    const load = nodeNamed(nodes, svelteJs, 'load');
    const inc = nodeNamed(nodes, svelteJs, 'inc');
    assert.strictEqual(load.line, lineOf(SVELTE_JS, 'export function load'));
    assert.strictEqual(inc.line, lineOf(SVELTE_JS, 'function inc'));
    assert.ok(hasEdge(edges, inc, load), 'instance block → module block');
    assert.ok(hasEdge(edges, inc, nodeNamed(nodes, utilJs, 'formatName')), 'component → src module');
  });

  test('Svelte, lang="ts", block not at line 1: node line and the edge into api.ts', () => {
    const { nodes, edges } = analyze(tsAnalyzer, [svelteTs, apiTs]);
    const bump = nodeNamed(nodes, svelteTs, 'bump');
    assert.strictEqual(bump.line, lineOf(SVELTE_TS, 'function bump'));
    assert.ok(bump.line > 1);
    assert.ok(hasEdge(edges, bump, nodeNamed(nodes, apiTs, 'fetchUser')));
  });

  test('every reported line really holds that declaration in the file on disk', () => {
    const ts = analyze(tsAnalyzer, [vueTs, svelteTs, apiTs]).nodes.filter(n => sfc.isSfcPath(n.file));
    const js = analyze(jsAnalyzer, [vueJs, svelteJs, utilJs]).nodes.filter(n => sfc.isSfcPath(n.file));
    assert.strictEqual(ts.length + js.length, 6, 'helper, save, bump, tick, load, inc');
    for (const n of [...ts, ...js]) {
      const line = fs.readFileSync(n.file, 'utf8').split('\n')[n.line - 1];
      assert.ok(line.includes(n.name), `${path.basename(n.file)}:${n.line} is "${line}", expected it to declare ${n.name}`);
    }
  });

  test('routing: the TS analyzer skips JS components and the JS analyzer skips TS components', () => {
    const tsNodes = analyze(tsAnalyzer, [vueTs, vueJs, svelteJs, svelteTs]).nodes;
    const jsNodes = analyze(jsAnalyzer, [vueTs, vueJs, svelteJs, svelteTs]).nodes;
    assert.deepStrictEqual([...new Set(tsNodes.map(n => path.basename(n.file)))].sort(), ['Bump.svelte', 'User.vue']);
    assert.deepStrictEqual([...new Set(jsNodes.map(n => path.basename(n.file)))].sort(), ['Counter.svelte', 'Tick.vue']);
  });

  test('routing: the walkers list each component for exactly one analyzer', () => {
    const tsFiles: string[] = tsAnalyzer.collectTsFiles(tmp).map((f: string) => path.basename(f)).sort();
    const jsFiles: string[] = jsAnalyzer.collectJsFiles(tmp).map((f: string) => path.basename(f)).sort();
    assert.deepStrictEqual(tsFiles, ['Bump.svelte', 'User.vue', 'api.ts']);
    assert.deepStrictEqual(jsFiles, ['Counter.svelte', 'Tick.vue', 'util.js']);
  });

  test('a component without a script block is listed by neither analyzer', () => {
    fs.writeFileSync(path.join(tmp, 'src', 'Static.vue'), '<template><p>hi</p></template>\n');
    assert.ok(!tsAnalyzer.isTsPath(path.join(tmp, 'src', 'Static.vue')));
    assert.ok(!jsAnalyzer.isJsPath(path.join(tmp, 'src', 'Static.vue')));
  });

  test('an SFC handed to the wrong analyzer via collectDefinitions is ignored, not misparsed', () => {
    const defs = tsAnalyzer.collectDefinitions([svelteJs]);
    assert.deepStrictEqual(Object.keys(defs), []);
  });

  test('--files CLI: a .vue path in the list is analyzed by the matching analyzer subprocess', () => {
    const tsScript = path.join(__dirname, '..', '..', '..', 'scripts', 'analyze_ts.js');
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, [vueTs, svelteJs, apiTs].join('\n'));
    const res = spawnSync(process.execPath, [tsScript, tmp, '--files', list], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, res.stderr);
    const graph = JSON.parse(res.stdout);
    const names = graph.nodes.map((n: Node) => n.name).sort();
    assert.deepStrictEqual(names, ['fetchUser', 'helper', 'save'], 'the JS svelte file is left to the JS analyzer');
    assert.deepStrictEqual(graph.files.map((f: string) => path.basename(f)).sort(), ['User.vue', 'api.ts']);
  });

  // The source popup reads the function at (file, line) from the ORIGINAL file.
  test('getFuncSource on a component returns exactly the function text at the reported line', () => {
    const tsNodes = analyze(tsAnalyzer, [vueTs, apiTs]).nodes;
    const save = nodeNamed(tsNodes, vueTs, 'save');
    assert.strictEqual(getFuncSource(vueTs, save.line), [
      'const save = () => {', '  helper();', '  return fetchUser(1);', '};',
    ].join('\n'));
    const helper = nodeNamed(tsNodes, vueTs, 'helper');
    assert.strictEqual(getFuncSource(vueTs, helper.line), 'export function helper(): number {\n  return 1;\n}');

    const jsNodes = analyze(jsAnalyzer, [svelteJs, utilJs]).nodes;
    const inc = nodeNamed(jsNodes, svelteJs, 'inc');
    assert.strictEqual(getFuncSource(svelteJs, inc.line), [
      '  function inc() {', '    n += 1;', '    load();', '    return formatName("y");', '  }',
    ].join('\n'));
  });

  test('the structure scanner lists components as project source files', () => {
    const listed = listProjectSourceFiles(tmp, () => null).map(f => path.basename(f.path)).sort();
    assert.deepStrictEqual(listed, ['Bump.svelte', 'Counter.svelte', 'Tick.vue', 'User.vue', 'api.ts', 'util.js']);
  });
});

// ---------------------------------------------------------------------------
// Host-side maps: one entry each, and the reverse direction for each rule
// ---------------------------------------------------------------------------

suite('Vue / Svelte in the host-side extension maps', () => {
  test('funcLangOf treats components as JS for the end-of-function scan (template literals, regex)', () => {
    assert.strictEqual(funcLangOf('/a/App.vue'), 'js');
    assert.strictEqual(funcLangOf('/a/Widget.svelte'), 'js');
    assert.strictEqual(funcLangOf('/a/page.html'), 'brace', 'other markup files stay generic');
  });

  test('isAnalyzablePath accepts components and still rejects unknown extensions', () => {
    assert.ok(isAnalyzablePath('src/components/App.vue'));
    assert.ok(isAnalyzablePath('src/routes/+page.svelte'));
    assert.ok(!isAnalyzablePath('src/App.astro'));
    assert.ok(!isAnalyzablePath('node_modules/x/App.vue'), 'skipped directories still apply');
  });

  test('the webview folder/file overlays colour components like TypeScript', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const folder = require('../../../src/webview/folder.js');
    const fc = require('../../../src/webview/fileClusters.js');
    /* eslint-enable @typescript-eslint/no-require-imports */
    assert.strictEqual(folder.inferLangFromPath('/p/App.vue'), 'typescript');
    assert.strictEqual(folder.inferLangFromPath('/p/Widget.svelte'), 'typescript');
    assert.strictEqual(folder.inferLangFromPath('/p/App.astro'), null, 'unknown markup stays uncoloured');

    // The file-cluster skeleton stamps each file element with its language.
    const tree = {
      root: '/p',
      folders: { '/p': { path: '/p', depth: 0, parent: null, childFolders: [], files: ['/p/App.vue', '/p/W.svelte', '/p/x.astro'], fileCount: 3 } },
      files: [], totalFiles: 3,
    };
    const els = fc.buildSkeletonElements(tree, new Set(['/p']), new Set(), null);
    const langOf = (file: string) => els.find((e: any) => e.data.file === file)?.data.language;
    assert.strictEqual(langOf('/p/App.vue'), 'typescript');
    assert.strictEqual(langOf('/p/W.svelte'), 'typescript');
    assert.strictEqual(langOf('/p/x.astro'), null);
  });
});
