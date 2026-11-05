/**
 * CoGraph Java AST analyzer.
 *
 * Usage: node analyze_java.js <workspace_root>
 *
 * Outputs a JSON call graph to stdout:
 *   { "nodes": [{id, name, file, line, language}], "edges": [{source, target}] }
 *
 * Scope: workspace .java files. Best-effort static analysis using java-parser
 * (Chevrotain CST). Handles classes, interfaces, methods, constructors,
 * inheritance, and method calls (internal + library).
 */

'use strict';

const path = require('path');
const fs   = require('fs');
// Bare specifier so esbuild can inline it into the packaged bundle (dev runs
// resolve it from the repo's node_modules via normal module resolution).
const { parse, BaseJavaCstVisitorWithDefaults } = require('java-parser');
const { createNarrower, withStats } = require('./narrowCalls.js');
const { resolveCalls } = require('./javaResolve.js');
const { createTable, addFile } = require('./javaTypes.js');

const { collectSourceFiles, explicitFileList } = require('./sourceFiles.js');

// ── Parse cache (single-parse optimisation) ───────────────────────────────────
// collectDefinitions and collectCalls each need the CST of every file. Parsing
// dominates the analyzer's cost, so we parse each file once and reuse the CST
// across both passes instead of re-parsing it (which doubled analysis time — and
// reanalysis runs on every save). Mirrors the cache in analyze_cpp.js. Unlike
// web-tree-sitter, java-parser returns a Chevrotain CST that IS garbage-collected,
// so clearCstCache() only has to drop references — there is no WASM heap to free.
const cstCache = new Map(); // filepath -> CST | null

// The cache is BOUNDED by the amount of source text it represents. A Chevrotain
// CST weighs tens of times its source, so holding every file of a large repo
// (guava: ~3 300 files) between the two passes ran V8 out of memory after ~85 s.
// Files beyond the budget are simply parsed again in the second pass: typical
// workspaces stay at one parse per file, huge ones trade CPU for a flat heap.
let cstCacheSourceBudget = Number(process.env.COGRAPH_JAVA_CST_BUDGET) || 6 * 1024 * 1024;
/** Test hook: shrink the budget to exercise the re-parse path. */
function _setCstCacheBudget(bytes) { cstCacheSourceBudget = bytes; }
let cachedSourceBytes = 0;

// Diagnostic/test counters: `parses` = actual parse() invocations (N for a run
// over N files that fit the budget, up to 2N beyond it); `uncached` = parses
// whose CST was not retained.
const _stats = { parses: 0, uncached: 0 };

function getCst(filepath) {
  if (cstCache.has(filepath)) return cstCache.get(filepath);
  let cst = null;
  let bytes = 0;
  try {
    const source = fs.readFileSync(filepath, 'utf8');
    bytes = source.length;
    cst = parse(source);
    if (cst) _stats.parses++;
  } catch { cst = null; }
  if (cachedSourceBytes + bytes <= cstCacheSourceBudget) {
    cachedSourceBytes += bytes;
    cstCache.set(filepath, cst ?? null);
  } else {
    _stats.uncached++;
  }
  return cst ?? null;
}

/** Drop all cached CSTs (Chevrotain CSTs are GC'd once unreferenced). */
function clearCstCache() { cstCache.clear(); cachedSourceBytes = 0; }

function isJavaFile(file) {
  return file.endsWith('.java');
}

function collectJavaFiles(root) {
  return collectSourceFiles(root, isJavaFile);
}

// ── CST helpers ───────────────────────────────────────────────────────────────

function getTypeIdentifierName(typeIdentifierNode) {
  return typeIdentifierNode?.children?.Identifier?.[0]?.image ?? null;
}

/** classType → joined simple identifier (e.g. "Comparable" from "Comparable<Foo>"). */
function getClassTypeName(classTypeNode) {
  const ids = classTypeNode?.children?.Identifier;
  if (!ids || ids.length === 0) return null;
  return ids.map(t => t.image).join('.');
}

// ── Definitions pass ──────────────────────────────────────────────────────────

class DefinitionCollector extends BaseJavaCstVisitorWithDefaults {
  constructor(filepath) {
    super();
    this.validateVisitor();
    this.filepath = filepath;
    this.definitions = {};
    this.classStack = [];   // [{className, classExtends?, classImplements?}]
  }

  _classContext() {
    return this.classStack[this.classStack.length - 1] ?? null;
  }

  _enterClass(className, normalClassDeclCtx) {
    let classExtends;
    const classImplements = [];
    if (normalClassDeclCtx.superclass) {
      const cls = normalClassDeclCtx.superclass[0].children.classType?.[0];
      const name = cls ? getClassTypeName(cls) : null;
      if (name) classExtends = name;
    }
    if (normalClassDeclCtx.superinterfaces) {
      const list = normalClassDeclCtx.superinterfaces[0].children.interfaceTypeList?.[0];
      for (const it of (list?.children?.interfaceType ?? [])) {
        const ct = it.children.classType?.[0];
        const name = ct ? getClassTypeName(ct) : null;
        if (name) classImplements.push(name);
      }
    }
    this.classStack.push({ className, classExtends, classImplements });
  }

  _enterInterface(className, normalInterfaceDeclCtx) {
    const classImplements = [];   // an interface's `extends` lists other interfaces
    if (normalInterfaceDeclCtx.extendsInterfaces) {
      const list = normalInterfaceDeclCtx.extendsInterfaces[0].children.interfaceTypeList?.[0];
      for (const it of (list?.children?.interfaceType ?? [])) {
        const ct = it.children.classType?.[0];
        const name = ct ? getClassTypeName(ct) : null;
        if (name) classImplements.push(name);
      }
    }
    this.classStack.push({ className, classImplements });
  }

  _exitClass() { this.classStack.pop(); }

  _addDefinition({ name, line }) {
    const id = `${this.filepath}::${name}::${line}`;
    const def = { id, name, file: this.filepath, line, language: 'java' };
    const ctx = this._classContext();
    if (ctx) {
      def.className = ctx.className;
      if (ctx.classExtends !== undefined) def.classExtends = ctx.classExtends;
      if (ctx.classImplements && ctx.classImplements.length) def.classImplements = ctx.classImplements;
    }
    this.definitions[id] = def;
  }

  normalClassDeclaration(ctx) {
    const className = getTypeIdentifierName(ctx.typeIdentifier?.[0]) ?? '(anonymous)';
    this._enterClass(className, ctx);
    try { this.visit(ctx.classBody); } finally { this._exitClass(); }
  }

  normalInterfaceDeclaration(ctx) {
    const className = getTypeIdentifierName(ctx.typeIdentifier?.[0]) ?? '(anonymous)';
    this._enterInterface(className, ctx);
    try { this.visit(ctx.interfaceBody); } finally { this._exitClass(); }
  }

  methodDeclaration(ctx) {
    try {
      const header = ctx.methodHeader?.[0];
      const declarator = header?.children?.methodDeclarator?.[0];
      const id = declarator?.children?.Identifier?.[0];
      if (id) this._addDefinition({ name: id.image, line: id.startLine });
    } catch { /* skip malformed */ }
    if (ctx.methodBody) this.visit(ctx.methodBody);
  }

  interfaceMethodDeclaration(ctx) {
    try {
      const header = ctx.methodHeader?.[0];
      const declarator = header?.children?.methodDeclarator?.[0];
      const id = declarator?.children?.Identifier?.[0];
      if (id) this._addDefinition({ name: id.image, line: id.startLine });
    } catch { /* skip malformed */ }
  }

  constructorDeclaration(ctx) {
    try {
      const decl   = ctx.constructorDeclarator?.[0];
      const simple = decl?.children?.simpleTypeName?.[0];
      const id     = simple?.children?.Identifier?.[0];
      if (id) this._addDefinition({ name: 'constructor', line: id.startLine });
    } catch { /* skip malformed */ }
    if (ctx.constructorBody) this.visit(ctx.constructorBody);
  }
}

// The project type table (javaTypes.js) is built from the same CSTs in this pass and
// handed to collectCalls, so every file is parsed once for both passes.
const typeTables = new WeakMap(); // definitions object → type table

function collectDefinitions(files) {
  const definitions = {};
  const table = createTable();
  for (const filepath of files) {
    const cst = getCst(filepath); // parsed once, reused by collectCalls
    if (!cst) { continue; }
    try {
      const collector = new DefinitionCollector(filepath);
      collector.visit(cst);
      Object.assign(definitions, collector.definitions);
    } catch { /* skip files that crash the visitor */ }
    addFile(table, filepath, cst);
  }
  typeTables.set(definitions, table);
  return definitions;
}

// ── Calls pass ────────────────────────────────────────────────────────────────
// Declared-type resolution (javaTypes.js builds the project type table, javaResolve.js
// walks the bodies with scopes): receivers, chains, constructors, super and outer
// classes resolve to the static target; library nodes are keyed by class
// (library::<package>.<Class>::<method>, constructors <init>); receivers of unknown
// type get no edge. `sites` records every call site's outcome (not part of the graph).

function collectCalls(files, definitions, root) {
  const narrower = createNarrower((id) => definitions[id] && definitions[id].file, root);
  const { edges, libraryNodes, sites } = resolveCalls(files, getCst, definitions, narrower.narrow, typeTables.get(definitions));
  return { edges, libraryNodes, stats: narrower.stats, sites };
}

// ── Entry ─────────────────────────────────────────────────────────────────────

function main() {
  if (process.argv.length < 3) {
    process.stderr.write('Usage: analyze_java.js <workspace_root> [--files <listpath>]\n');
    process.exit(1);
  }
  const root = process.argv[2];
  const files = explicitFileList(isJavaFile) ?? collectJavaFiles(root);
  try {
    const definitions = collectDefinitions(files);
    const { edges, libraryNodes, stats } = collectCalls(files, definitions, root);
    const nodes = [...Object.values(definitions), ...libraryNodes];
    require('./graphOutput.js').writeGraph(withStats({ nodes, edges, files }, stats));
  } finally {
    clearCstCache(); // drop cached CSTs
  }
}

// Only run main() when invoked as a script, not when require()'d by tests.
if (require.main === module) {
  main();
}

if (typeof module !== 'undefined') {
  module.exports = { collectJavaFiles, collectDefinitions, collectCalls, clearCstCache, _stats, _setCstCacheBudget };
}
