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
const { parse, BaseJavaCstVisitorWithDefaults } =
  require(path.join(__dirname, '..', 'node_modules', 'java-parser'));

const SKIP_DIR_NAMES = new Set(['node_modules', 'out', 'dist', 'target', 'build']);

function collectJavaFiles(root) {
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name) && !entry.name.startsWith('.')) walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.java')) {
        results.push(full);
      }
    }
  }
  walk(root);
  return results;
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

/** Get chain of identifiers from a fqnOrRefType node, e.g. ["System","out","println"]. */
function fqnIdentifiers(fqnNode) {
  const out = [];
  const first = fqnNode?.children?.fqnOrRefTypePartFirst?.[0];
  const firstId = first?.children?.fqnOrRefTypePartCommon?.[0]?.children?.Identifier?.[0];
  if (firstId) out.push(firstId.image);
  for (const rest of (fqnNode?.children?.fqnOrRefTypePartRest ?? [])) {
    const id = rest.children?.fqnOrRefTypePartCommon?.[0]?.children?.Identifier?.[0];
    if (id) out.push(id.image);
  }
  return out;
}

/**
 * Extract { calleeName, receiverName, line } from a `primary` node iff it is
 * a method invocation. Returns null otherwise.
 *
 * Patterns handled:
 *   helper()                        → callee=helper,  receiver=null
 *   xs.add("a")                     → callee=add,     receiver=xs
 *   System.out.println("hi")        → callee=println, receiver=System
 *   this.helper()                   → callee=helper,  receiver="this"
 *   StringUtils.isEmpty("x")        → callee=isEmpty, receiver=StringUtils
 */
function extractCallInfo(primaryNode) {
  const suffixes = primaryNode.children.primarySuffix ?? [];
  const invocationIdx = suffixes.findIndex(s => s.children.methodInvocationSuffix);
  if (invocationIdx < 0) return null;

  const chain = [];
  let line = null;
  const prefix = primaryNode.children.primaryPrefix?.[0];
  if (!prefix) return null;

  if (prefix.children.This) {
    chain.push('this');
    line = prefix.children.This[0].startLine;
  } else if (prefix.children.fqnOrRefType) {
    const fqn = prefix.children.fqnOrRefType[0];
    chain.push(...fqnIdentifiers(fqn));
    const firstTok = fqn.children?.fqnOrRefTypePartFirst?.[0]
      ?.children?.fqnOrRefTypePartCommon?.[0]?.children?.Identifier?.[0];
    line = firstTok?.startLine ?? null;
  } else {
    return null;
  }

  // Walk suffixes BEFORE the methodInvocationSuffix to extend the chain.
  for (let i = 0; i < invocationIdx; i++) {
    const s = suffixes[i];
    const ids = s.children?.Identifier;
    if (ids && ids.length) {
      chain.push(ids[0].image);
      if (line == null) line = ids[0].startLine;
    }
  }

  if (chain.length === 0) return null;
  const calleeName = chain[chain.length - 1];
  const receiverName = chain.length > 1 ? chain[0] : null;
  return { calleeName, receiverName, line };
}

/** Parse a Java file's import declarations into { typeImports, staticImports, wildcardPackages }. */
function parseImports(cst) {
  const typeImports    = {};   // simple class name → full package (e.g. "List" → "java.util")
  const staticImports  = {};   // member name → owner FQN (e.g. "PI" → "java.lang.Math")
  const wildcardPackages = []; // ["java.util", ...]
  const ocu = cst.children.ordinaryCompilationUnit?.[0];
  if (!ocu) return { typeImports, staticImports, wildcardPackages };
  for (const imp of (ocu.children.importDeclaration ?? [])) {
    try {
      const ids = imp.children.packageOrTypeName?.[0]?.children?.Identifier ?? [];
      if (ids.length === 0) continue;
      const names = ids.map(t => t.image);
      const isStatic   = !!imp.children.Static;
      const isWildcard = !!imp.children.Star;
      if (isStatic && isWildcard) continue;
      if (isStatic) {
        const member = names[names.length - 1];
        const owner = names.slice(0, -1).join('.');
        if (member && owner) staticImports[member] = owner;
      } else if (isWildcard) {
        wildcardPackages.push(names.join('.'));
      } else {
        const simple = names[names.length - 1];
        const pkg    = names.slice(0, -1).join('.');
        if (simple && pkg) typeImports[simple] = pkg;
      }
    } catch { /* skip malformed */ }
  }
  return { typeImports, staticImports, wildcardPackages };
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

function collectDefinitions(files) {
  const definitions = {};
  for (const filepath of files) {
    let source;
    try { source = fs.readFileSync(filepath, 'utf8'); } catch { continue; }
    let cst;
    try { cst = parse(source); } catch { continue; }
    try {
      const collector = new DefinitionCollector(filepath);
      collector.visit(cst);
      Object.assign(definitions, collector.definitions);
    } catch { /* skip files that crash the visitor */ }
  }
  return definitions;
}

// ── Calls pass ────────────────────────────────────────────────────────────────

class CallCollector extends BaseJavaCstVisitorWithDefaults {
  constructor(filepath, definitions, nameToIds, importMap) {
    super();
    this.validateVisitor();
    this.filepath = filepath;
    this.definitions = definitions;
    this.nameToIds = nameToIds;
    this.importMap = importMap;        // { typeImports, staticImports, wildcardPackages }
    this.callerStack = [];             // current caller ids
    this.edges = [];
    this.seenEdges = new Set();
    this.libraryNodes = new Map();
  }

  _pushCaller(name, line) {
    const id = `${this.filepath}::${name}::${line}`;
    if (this.definitions[id]) {
      this.callerStack.push(id);
      return true;
    }
    return false;
  }

  _popCaller() { this.callerStack.pop(); }

  _currentCaller() { return this.callerStack[this.callerStack.length - 1] ?? null; }

  _addEdge(target, isLibraryEdge = false) {
    const src = this._currentCaller();
    if (!src) return;
    const key = `${src}|${target}`;
    if (this.seenEdges.has(key)) return;
    if (src === target) return;
    this.seenEdges.add(key);
    const edge = { source: src, target };
    if (isLibraryEdge) edge.isLibraryEdge = true;
    this.edges.push(edge);
  }

  _addLibraryEdge(libName, funcName) {
    const libId = `library::${libName}::${funcName}`;
    if (!this.libraryNodes.has(libId)) {
      this.libraryNodes.set(libId, {
        id: libId, name: funcName, file: null, line: 0,
        isLibrary: true, libraryName: libName, language: 'java',
      });
    }
    this._addEdge(libId, true);
  }

  methodDeclaration(ctx) {
    let pushed = false;
    try {
      const header = ctx.methodHeader?.[0];
      const declarator = header?.children?.methodDeclarator?.[0];
      const id = declarator?.children?.Identifier?.[0];
      if (id) pushed = this._pushCaller(id.image, id.startLine);
    } catch { /* skip */ }
    try { if (ctx.methodBody) this.visit(ctx.methodBody); }
    finally { if (pushed) this._popCaller(); }
  }

  constructorDeclaration(ctx) {
    let pushed = false;
    try {
      const decl   = ctx.constructorDeclarator?.[0];
      const simple = decl?.children?.simpleTypeName?.[0];
      const id     = simple?.children?.Identifier?.[0];
      if (id) pushed = this._pushCaller('constructor', id.startLine);
    } catch { /* skip */ }
    try { if (ctx.constructorBody) this.visit(ctx.constructorBody); }
    finally { if (pushed) this._popCaller(); }
  }

  primary(ctx) {
    try {
      const info = extractCallInfo({ children: ctx });
      if (info && this._currentCaller()) {
        const { calleeName, receiverName } = info;

        // Internal call: bare name OR receiver === 'this'
        if (receiverName === null || receiverName === 'this') {
          const ids = this.nameToIds[calleeName];
          if (ids) {
            for (const calleeId of ids) this._addEdge(calleeId, false);
          }
        }

        // Library call: receiver matches an imported type
        if (receiverName && receiverName !== 'this') {
          const pkg = this.importMap.typeImports[receiverName];
          if (pkg && !this.nameToIds[receiverName]) {
            this._addLibraryEdge(pkg, calleeName);
          }
        }

        // Static-imported member: bare call to e.g. PI(), isNaN()
        if (receiverName === null) {
          const owner = this.importMap.staticImports[calleeName];
          if (owner && !this.nameToIds[calleeName]) {
            this._addLibraryEdge(owner, calleeName);
          }
        }
      }
    } catch { /* skip malformed call */ }
    if (ctx.primaryPrefix) this.visit(ctx.primaryPrefix);
    if (ctx.primarySuffix) this.visit(ctx.primarySuffix);
  }
}

function collectCalls(files, definitions) {
  const nameToIds = Object.create(null);
  for (const [qid, defn] of Object.entries(definitions)) {
    if (!nameToIds[defn.name]) nameToIds[defn.name] = [];
    nameToIds[defn.name].push(qid);
  }

  const allEdges = [];
  const allLibraryNodes = new Map();
  for (const filepath of files) {
    let source;
    try { source = fs.readFileSync(filepath, 'utf8'); } catch { continue; }
    let cst;
    try { cst = parse(source); } catch { continue; }
    const importMap = parseImports(cst);
    try {
      const collector = new CallCollector(filepath, definitions, nameToIds, importMap);
      collector.visit(cst);
      allEdges.push(...collector.edges);
      for (const [id, node] of collector.libraryNodes) {
        if (!allLibraryNodes.has(id)) allLibraryNodes.set(id, node);
      }
    } catch { /* skip files that crash the visitor */ }
  }
  return { edges: allEdges, libraryNodes: Array.from(allLibraryNodes.values()) };
}

// ── Entry ─────────────────────────────────────────────────────────────────────

function main() {
  if (process.argv.length < 3) {
    process.stderr.write('Usage: analyze_java.js <workspace_root>\n');
    process.exit(1);
  }
  const root = process.argv[2];
  const files = collectJavaFiles(root);
  const definitions = collectDefinitions(files);
  const { edges, libraryNodes } = collectCalls(files, definitions);
  const nodes = [...Object.values(definitions), ...libraryNodes];
  process.stdout.write(JSON.stringify({ nodes, edges, files }) + '\n');
}

// Only run main() when invoked as a script, not when require()'d by tests.
if (require.main === module) {
  main();
}

if (typeof module !== 'undefined') {
  module.exports = { collectJavaFiles, collectDefinitions, collectCalls };
}
