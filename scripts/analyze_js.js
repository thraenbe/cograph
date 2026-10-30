/**
 * CoGraph JavaScript AST analyzer.
 *
 * Usage: node analyze_js.js <workspace_root>
 *
 * Outputs a JSON call graph to stdout:
 *   { "nodes": [{id, name, file, line, language}], "edges": [{source, target}] }
 *
 * Scope: workspace .js/.jsx/.mjs/.cjs files, plus the `<script>` blocks of .vue /
 * .svelte single-file components that are not `lang="ts"` (sfcScript.js; a
 * component is parsed as a virtual source with the file's own line numbers).
 * Template expressions (`@click="save()"`, `{handler()}`) are not analyzed.
 * Best-effort static analysis. Handles both ESM (import) and CommonJS (require()) imports.
 */

'use strict';

const path = require('path');
const ts   = require('typescript');
const core = require('./tsJsAnalyzer.js');

const JS_EXTENSIONS  = new Set(['.js', '.jsx', '.mjs', '.cjs']);

const options = {
  language: 'javascript',
  scriptName: 'analyze_js.js',
  scriptKind: ts.ScriptKind.JS,
  cjsRequire: true,
  sfcAnalyzer: 'js',
  isSourceFile: (file) => JS_EXTENSIONS.has(path.extname(file)),
};

function collectJsFiles(root) {
  return core.collectFiles(root, options);
}

/** A file this analyzer parses: .js/.jsx/.mjs/.cjs or a component whose script is JavaScript. */
function isJsPath(file) {
  return core.isAnalyzedFile(file, options);
}

function collectDefinitions(files) {
  return core.collectDefinitions(files, options);
}

function collectCalls(files, definitions, root) {
  return core.collectCalls(files, definitions, root, options);
}

if (require.main === module) {
  core.main(options);
}

if (typeof module !== 'undefined') {
  module.exports = { collectJsFiles, collectDefinitions, collectCalls, isJsPath };
}
