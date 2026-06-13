/**
 * CoGraph C++ AST analyzer.
 *
 * Usage: node analyze_cpp.js <workspace_root>
 *
 * Outputs a JSON call graph to stdout:
 *   { "nodes": [{id, name, file, line, language, ...}], "edges": [...], "files": [...] }
 *
 * Scope: workspace .cpp/.cc/.cxx/.c++/.hpp/.hh/.hxx/.h++/.h files. Static
 * analysis via web-tree-sitter (WASM) + the bundled tree-sitter-cpp grammar
 * (scripts/tree-sitter-cpp.wasm). Handles classes/structs, inheritance, free
 * functions, in-class methods, out-of-line definitions (Foo::bar),
 * constructors, destructors, templates, and qualified calls. stdlib (std::*)
 * and other namespace-qualified calls become library nodes. A header
 * declaration is dropped when its definition is found elsewhere (see
 * pruneRedundantDeclarations) so each method yields exactly one node.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
// Bare specifier (not a path join): web-tree-sitter is an "exports"-only package
// with no "main" field, so it must be resolved by name. Node resolves it from
// node_modules relative to this file regardless of the process cwd.
const { Parser, Language } = require('web-tree-sitter');

const GRAMMAR_WASM = path.join(__dirname, 'tree-sitter-cpp.wasm');

let parser = null;

/**
 * Initialise the WASM runtime and load the C++ grammar. Idempotent — safe to
 * call repeatedly. Must be awaited before collectDefinitions / collectCalls.
 *
 * web-tree-sitter is pure WASM, so (unlike the native tree-sitter binding) it
 * has no libstdc++/ABI dependency and loads inside snap/flatpak-confined
 * Electron runtimes.
 */
async function init() {
  if (parser) { return parser; }
  await Parser.init();
  const Cpp = await Language.load(GRAMMAR_WASM);
  parser = new Parser();
  parser.setLanguage(Cpp);
  return parser;
}

// ── Parse cache (single-parse optimisation) ───────────────────────────────────
// collectDefinitions and collectCalls each need the parse tree of every file.
// Parsing dominates the analyzer's cost, so we parse each file once and reuse
// the tree across both passes instead of re-parsing it (which doubled analysis
// time — and this runs on every save). web-tree-sitter trees are WASM-heap
// objects that are NOT garbage-collected, so clearTreeCache() must free them
// when an analysis run completes.
//
// Trade-off: every tree is held in memory between the two passes (vs one at a
// time before). Acceptable for typical workspaces; the lower-memory variant (a
// single walk that extracts call-sites into plain objects and deletes each tree
// immediately) is recorded in .ai/memory/tech-dept.md as a future option, along
// with a note to apply this same cache to scripts/analyze_java.js.
const treeCache = new Map(); // filepath -> Tree | null

// Diagnostic/test counter: number of actual parser.parse() invocations. A run
// over N files should report N parses, not 2N.
const _stats = { parses: 0 };

function getTree(filepath) {
  if (treeCache.has(filepath)) return treeCache.get(filepath);
  let tree = null;
  try {
    const source = fs.readFileSync(filepath, 'utf8');
    tree = parser.parse(source);
    if (tree) _stats.parses++;
  } catch { tree = null; }
  treeCache.set(filepath, tree ?? null);
  return tree ?? null;
}

/** Free all cached WASM trees and empty the cache. Call once per analysis run. */
function clearTreeCache() {
  for (const tree of treeCache.values()) {
    if (tree) { try { tree.delete(); } catch { /* already freed */ } }
  }
  treeCache.clear();
}

const SKIP_DIR_NAMES = new Set(['node_modules', 'out', 'dist', 'target', 'build', 'CMakeFiles']);
const CPP_EXTS = new Set(['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.h']);

function collectCppFiles(root) {
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (entry.name.startsWith('cmake-build-')) continue;
        walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CPP_EXTS.has(ext)) results.push(full);
      }
    }
  }
  walk(root);
  return results;
}

// ── AST helpers ───────────────────────────────────────────────────────────────

/** Recursively flatten a qualified_identifier into ["std","ranges","sort"]. */
function flattenQualified(node) {
  if (!node) return [];
  if (node.type === 'qualified_identifier') {
    const scope = node.childForFieldName('scope');
    const name  = node.childForFieldName('name');
    const left  = scope ? flattenQualified(scope) : [];
    const right = name  ? flattenQualified(name)  : [];
    return [...left, ...right];
  }
  if (node.type === 'template_function') {
    const name = node.childForFieldName('name');
    return name ? [name.text] : [];
  }
  // identifier, namespace_identifier, field_identifier, type_identifier, etc.
  return [node.text];
}

/**
 * Walk a function_declarator chain (skipping pointer/reference wrappers) and
 * return the innermost name-bearing declarator node.
 */
function unwrapDeclarator(node) {
  let cur = node;
  while (cur && cur.type !== 'identifier'
              && cur.type !== 'field_identifier'
              && cur.type !== 'qualified_identifier'
              && cur.type !== 'destructor_name'
              && cur.type !== 'operator_name'
              && cur.type !== 'template_function') {
    const inner = cur.childForFieldName?.('declarator');
    if (!inner || inner === cur) return cur;
    cur = inner;
  }
  return cur;
}

/**
 * Extract { name, line, className? } from a function_declarator.
 * className is set when the declarator is a qualified_identifier (out-of-line
 * definition like void Foo::bar() {}) or a destructor (~Foo → className "Foo").
 */
function describeFunctionDeclarator(funcDecl, enclosingClass) {
  const decl = funcDecl.childForFieldName('declarator');
  if (!decl) return null;
  const inner = unwrapDeclarator(decl);
  if (!inner) return null;

  const line = inner.startPosition.row + 1;

  if (inner.type === 'identifier' || inner.type === 'field_identifier') {
    const name = inner.text;
    if (enclosingClass && name === enclosingClass) {
      return { name: 'constructor', line, className: enclosingClass };
    }
    const out = { name, line };
    if (enclosingClass) out.className = enclosingClass;
    return out;
  }

  if (inner.type === 'qualified_identifier') {
    const parts = flattenQualified(inner);
    if (parts.length === 0) return null;
    let name = parts[parts.length - 1];
    const className = parts.length > 1 ? parts[parts.length - 2] : enclosingClass;
    if (name.startsWith('~')) name = 'destructor';
    else if (className && name === className) name = 'constructor';
    const out = { name, line };
    if (className) out.className = className;
    return out;
  }

  if (inner.type === 'destructor_name') {
    return { name: 'destructor', line, className: enclosingClass ?? null };
  }

  if (inner.type === 'operator_name') {
    return { name: inner.text, line, className: enclosingClass ?? undefined };
  }

  if (inner.type === 'template_function') {
    const nameNode = inner.childForFieldName('name');
    if (!nameNode) return null;
    const out = { name: nameNode.text, line };
    if (enclosingClass) out.className = enclosingClass;
    return out;
  }

  return null;
}

/**
 * Parse base classes from a class_specifier's base_class_clause.
 * Returns { classExtends?, classImplements? } — first base goes to classExtends,
 * remaining bases (C++ multi-inheritance) go to classImplements.
 */
function parseBases(classSpec) {
  const result = {};
  for (const child of classSpec.namedChildren) {
    if (child.type !== 'base_class_clause') continue;
    const bases = [];
    for (const c of child.namedChildren) {
      if (c.type === 'type_identifier') bases.push(c.text);
      else if (c.type === 'qualified_identifier') {
        const parts = flattenQualified(c);
        if (parts.length) bases.push(parts[parts.length - 1]);
      }
    }
    if (bases.length > 0) result.classExtends = bases[0];
    if (bases.length > 1) result.classImplements = bases.slice(1);
    break;
  }
  return result;
}

/** Parse using-declarations from the whole tree, per file. */
function parseImports(rootNode) {
  const usingSymbols = {};    // "cout" → "std"
  const usingNamespaces = []; // ["std", ...]
  function walk(node) {
    if (node.type === 'using_declaration') {
      const named = node.namedChildren;
      if (named.length === 1) {
        const sole = named[0];
        if (sole.type === 'qualified_identifier') {
          const parts = flattenQualified(sole);
          if (parts.length >= 2) {
            const symbol = parts[parts.length - 1];
            const ns = parts.slice(0, -1).join('::');
            usingSymbols[symbol] = ns;
          }
        } else if (sole.type === 'identifier') {
          // `using namespace std;` — anonymous keywords stripped, child is bare identifier
          usingNamespaces.push(sole.text);
        }
      }
      return; // don't descend
    }
    for (const c of node.namedChildren) walk(c);
  }
  walk(rootNode);
  return { usingSymbols, usingNamespaces };
}

// ── Definitions pass ──────────────────────────────────────────────────────────

function collectDefinitionsFromTree(rootNode, filepath, definitions) {
  const classStack = [];

  function pushClass(classSpec) {
    const nameNode = classSpec.childForFieldName('name');
    const className = nameNode ? nameNode.text : '(anonymous)';
    const bases = parseBases(classSpec);
    classStack.push({ className, ...bases });
  }
  function popClass() { classStack.pop(); }
  function topClass() { return classStack[classStack.length - 1] ?? null; }

  function addDef({ name, line, className: forcedClassName }, isDeclaration) {
    const id = `${filepath}::${name}::${line}`;
    const ctx = topClass();
    const def = { id, name, file: filepath, line, language: 'cpp' };
    const className = forcedClassName ?? ctx?.className;
    if (className) def.className = className;
    if (ctx && def.className === ctx.className) {
      if (ctx.classExtends !== undefined)     def.classExtends    = ctx.classExtends;
      if (ctx.classImplements)                def.classImplements = ctx.classImplements;
    }
    // Marker (stripped before output by pruneRedundantDeclarations): a method
    // declared without a body, e.g. `void bar();` in a header.
    if (isDeclaration) def.isDeclaration = true;
    definitions[id] = def;
  }

  function visit(node) {
    const t = node.type;

    if (t === 'class_specifier' || t === 'struct_specifier') {
      if (!node.childForFieldName('body')) return; // forward declaration
      pushClass(node);
      try {
        const body = node.childForFieldName('body');
        for (const c of body.namedChildren) visit(c);
      } finally { popClass(); }
      return;
    }

    if (t === 'function_definition') {
      const funcDecl = node.childForFieldName('declarator');
      if (funcDecl && funcDecl.type === 'function_declarator') {
        const info = describeFunctionDeclarator(funcDecl, topClass()?.className);
        if (info) addDef(info);
      }
      const body = node.childForFieldName('body');
      if (body) for (const c of body.namedChildren) visit(c);
      return;
    }

    if (t === 'field_declaration') {
      // In-class method declaration without body: `void bar();`
      const decl = node.childForFieldName('declarator');
      if (decl && decl.type === 'function_declarator') {
        const info = describeFunctionDeclarator(decl, topClass()?.className);
        if (info) addDef(info, /* isDeclaration */ true);
      }
      return;
    }

    if (t === 'template_declaration') {
      for (const c of node.namedChildren) visit(c);
      return;
    }

    if (t === 'namespace_definition' || t === 'linkage_specification' || t === 'declaration_list') {
      for (const c of node.namedChildren) visit(c);
      return;
    }

    // Generic recursion for any container nodes we didn't model explicitly
    for (const c of node.namedChildren) visit(c);
  }

  visit(rootNode);
}

/**
 * Drop declaration-only nodes (a bodyless `void bar();` in a header) when a
 * real definition for the same class+name exists elsewhere in the workspace.
 *
 * Without this, every `.h`/`.cpp` pair yields two nodes for one method and
 * every call edge is duplicated — pure visual noise that also inflates the
 * layout. A declaration with no matching definition (e.g. the body lives in a
 * library or an un-indexed file) is kept so calls still resolve to a node;
 * its internal `isDeclaration` marker is stripped either way.
 */
function pruneRedundantDeclarations(definitions) {
  const definedKeys = new Set();
  for (const def of Object.values(definitions)) {
    if (!def.isDeclaration) {
      definedKeys.add(`${def.className || ''}::${def.name}`);
    }
  }
  for (const [id, def] of Object.entries(definitions)) {
    if (!def.isDeclaration) { continue; }
    if (definedKeys.has(`${def.className || ''}::${def.name}`)) {
      delete definitions[id];
    } else {
      delete def.isDeclaration; // surviving declaration — drop the internal marker
    }
  }
}

function collectDefinitions(files) {
  const definitions = {};
  for (const filepath of files) {
    const tree = getTree(filepath); // parsed once, reused by collectCalls
    if (!tree) { continue; }
    try {
      collectDefinitionsFromTree(tree.rootNode, filepath, definitions);
    } catch { /* skip files that crash the walker */ }
  }
  pruneRedundantDeclarations(definitions);
  return definitions;
}

// ── Calls pass ────────────────────────────────────────────────────────────────

function collectCallsFromTree(rootNode, filepath, definitions, nameToIds, importMap,
                              edges, seenEdges, libraryNodes) {
  const classStack = [];
  const callerStack = [];

  function pushClass(classSpec) {
    const nameNode = classSpec.childForFieldName('name');
    classStack.push(nameNode ? nameNode.text : '(anonymous)');
  }
  function popClass() { classStack.pop(); }
  function topClass() { return classStack[classStack.length - 1] ?? null; }

  function currentCaller() { return callerStack[callerStack.length - 1] ?? null; }

  function pushCallerForFn(funcDecl) {
    const info = describeFunctionDeclarator(funcDecl, topClass());
    if (!info) return false;
    const id = `${filepath}::${info.name}::${info.line}`;
    if (definitions[id]) {
      callerStack.push(id);
      return true;
    }
    return false;
  }

  function addEdge(target, isLibraryEdge) {
    const src = currentCaller();
    if (!src) return;
    if (src === target) return;
    const key = `${src}|${target}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    const edge = { source: src, target };
    if (isLibraryEdge) edge.isLibraryEdge = true;
    edges.push(edge);
  }

  function addLibraryEdge(libName, funcName) {
    const libId = `library::${libName}::${funcName}`;
    if (!libraryNodes.has(libId)) {
      libraryNodes.set(libId, {
        id: libId, name: funcName, file: null, line: 0,
        isLibrary: true, libraryName: libName, language: 'cpp',
      });
    }
    addEdge(libId, true);
  }

  function handleCall(callExpr) {
    const fn = callExpr.childForFieldName('function');
    if (!fn) return;

    if (fn.type === 'identifier') {
      const name = fn.text;
      const ids = nameToIds[name];
      if (ids) {
        for (const id of ids) addEdge(id, false);
        return;
      }
      const ns = importMap.usingSymbols[name];
      if (ns) { addLibraryEdge(ns, name); return; }
      // Fallback: an unqualified call matching no workspace symbol, in a file
      // with exactly one `using namespace N`, is most likely N::name. Restricted
      // to a single open namespace so attribution is unambiguous — with several
      // open namespaces we can't tell which owns the symbol, so we drop it.
      // Caveat: this can mis-bucket genuinely-global C functions (e.g. printf →
      // std::printf); accepted, consistent with the liberal library-node
      // behaviour of the other analyzers.
      if (importMap.usingNamespaces.length === 1) {
        addLibraryEdge(importMap.usingNamespaces[0], name);
      }
      return;
    }

    if (fn.type === 'field_expression') {
      const field = fn.childForFieldName('field');
      if (!field) return;
      const name = field.text;
      const ids = nameToIds[name];
      if (!ids) return;
      // `recv.name()` / `recv->name()`: name must be a member, so exclude free
      // functions that merely share the name (receiver-blind matching otherwise
      // over-connects to every same-named definition in the workspace).
      const members = ids.filter(id => definitions[id] && definitions[id].className);
      if (members.length === 0) return;
      // When the receiver is `this`, the member belongs to the enclosing class —
      // resolve precisely to it instead of to every class that declares `name`.
      const recv = fn.childForFieldName('argument');
      if (recv && recv.type === 'this') {
        const cls = topClass();
        const own = members.filter(id => definitions[id].className === cls);
        if (own.length) { for (const id of own) addEdge(id, false); return; }
      }
      for (const id of members) addEdge(id, false);
      return;
    }

    if (fn.type === 'qualified_identifier' || fn.type === 'template_function') {
      const parts = flattenQualified(fn);
      if (parts.length === 0) return;
      const calleeName = parts[parts.length - 1];

      if (parts.length === 1) {
        const ids = nameToIds[calleeName];
        if (ids) for (const id of ids) addEdge(id, false);
        return;
      }

      const scope = parts.slice(0, -1);
      const leading = scope[0];

      // Class-scoped internal call? (e.g. Foo::staticMethod when Foo is in workspace)
      // Heuristic: if scope is a single identifier matching a known className,
      // treat as internal; otherwise library.
      const ids = nameToIds[calleeName];
      const isKnownClass = ids && ids.some(id => {
        const d = definitions[id];
        return d && d.className === leading;
      });
      if (isKnownClass) {
        for (const id of ids) {
          const d = definitions[id];
          if (d && d.className === leading) addEdge(id, false);
        }
        return;
      }
      addLibraryEdge(scope.join('::'), calleeName);
      return;
    }
  }

  function visit(node) {
    const t = node.type;

    if (t === 'class_specifier' || t === 'struct_specifier') {
      if (!node.childForFieldName('body')) return;
      pushClass(node);
      try {
        const body = node.childForFieldName('body');
        for (const c of body.namedChildren) visit(c);
      } finally { popClass(); }
      return;
    }

    if (t === 'function_definition') {
      const funcDecl = node.childForFieldName('declarator');
      let pushed = false;
      if (funcDecl && funcDecl.type === 'function_declarator') {
        pushed = pushCallerForFn(funcDecl);
      }
      try {
        const body = node.childForFieldName('body');
        if (body) for (const c of body.namedChildren) visit(c);
      } finally { if (pushed) callerStack.pop(); }
      return;
    }

    if (t === 'call_expression') {
      try { handleCall(node); } catch { /* skip malformed call */ }
      // Still descend so nested calls (in arguments) are also visited.
      for (const c of node.namedChildren) visit(c);
      return;
    }

    for (const c of node.namedChildren) visit(c);
  }

  visit(rootNode);
}

function collectCalls(files, definitions) {
  const nameToIds = Object.create(null);
  for (const [qid, defn] of Object.entries(definitions)) {
    if (!nameToIds[defn.name]) nameToIds[defn.name] = [];
    nameToIds[defn.name].push(qid);
  }

  const edges = [];
  const seenEdges = new Set();
  const libraryNodes = new Map();
  for (const filepath of files) {
    const tree = getTree(filepath); // cache hit when collectDefinitions ran first
    if (!tree) { continue; }
    try {
      const importMap = parseImports(tree.rootNode);
      collectCallsFromTree(tree.rootNode, filepath, definitions, nameToIds, importMap,
                           edges, seenEdges, libraryNodes);
    } catch { /* skip files that crash the walker */ }
  }
  return { edges, libraryNodes: Array.from(libraryNodes.values()) };
}

// ── Entry ─────────────────────────────────────────────────────────────────────

// Subset mode: `--files <listpath>` analyzes only the listed C++ files.
// Returns null when absent → full walk.
function explicitFileList() {
  const i = process.argv.indexOf('--files');
  if (i === -1 || !process.argv[i + 1]) { return null; }
  let raw;
  try { raw = fs.readFileSync(process.argv[i + 1], 'utf8'); } catch { return []; }
  return raw.split('\n').map(s => s.trim()).filter(Boolean)
    .filter(f => CPP_EXTS.has(path.extname(f)));
}

async function main() {
  if (process.argv.length < 3) {
    process.stderr.write('Usage: analyze_cpp.js <workspace_root> [--files <listpath>]\n');
    process.exit(1);
  }
  await init();
  const root = process.argv[2];
  const files = explicitFileList() ?? collectCppFiles(root);
  try {
    const definitions = collectDefinitions(files);
    const { edges, libraryNodes } = collectCalls(files, definitions);
    const nodes = [...Object.values(definitions), ...libraryNodes];
    process.stdout.write(JSON.stringify({ nodes, edges, files }) + '\n');
  } finally {
    clearTreeCache(); // free all cached WASM trees
  }
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write('analyze_cpp failed: ' + ((err && err.stack) || err) + '\n');
    process.exit(1);
  });
}

if (typeof module !== 'undefined') {
  module.exports = { init, collectCppFiles, collectDefinitions, collectCalls, clearTreeCache, _stats };
}
