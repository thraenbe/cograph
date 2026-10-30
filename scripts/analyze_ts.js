/**
 * CoGraph TypeScript AST analyzer.
 *
 * Usage: node analyze_ts.js <workspace_root>
 *
 * Outputs a JSON call graph to stdout:
 *   { "nodes": [{id, name, file, line, language}], "edges": [{source, target}] }
 *
 * Scope: workspace .ts/.tsx files (excludes .d.ts), plus the `<script lang="ts">`
 * blocks of .vue / .svelte single-file components (sfcScript.js; a component is
 * parsed as a virtual source with the file's own line numbers). Template
 * expressions (`@click="save()"`, `{handler()}`) are not analyzed.
 * Best-effort static analysis.
 */

'use strict';

const core = require('./tsJsAnalyzer.js');

const options = {
  language: 'typescript',
  scriptName: 'analyze_ts.js',
  scriptKind: undefined,
  cjsRequire: false,
  sfcAnalyzer: 'ts',
  isSourceFile: (file) => !file.endsWith('.d.ts') && (file.endsWith('.ts') || file.endsWith('.tsx')),
};

function collectTsFiles(root) {
  return core.collectFiles(root, options);
}

/** A file this analyzer parses: .ts/.tsx (not .d.ts) or a component whose script is TypeScript. */
function isTsPath(file) {
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
  module.exports = { collectTsFiles, collectDefinitions, collectCalls, isTsPath };
}
