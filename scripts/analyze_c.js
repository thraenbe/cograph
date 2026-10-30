/**
 * CoGraph C AST analyzer.
 *
 * Usage: node analyze_c.js <workspace_root> [--files <listpath>]
 *
 * Outputs a JSON call graph to stdout:
 *   { "nodes": [{id, name, file, line, language: "c", ...}], "edges": [...], "files": [...] }
 *
 * Scope: workspace `.c` files plus the `.h` files that belong to C. A `.h`
 * belongs to C when its own directory holds at least one `.c` file and no C++
 * source (`.cpp`, `.cc`, `.cxx`, `.c++`); otherwise it is C++ and
 * analyze_cpp.js takes it (the rule lives in cFamily.js, shared by both).
 * Static analysis via web-tree-sitter (WASM) + the official tree-sitter-c
 * grammar (scripts/tree-sitter-c.wasm); the C++ grammar cannot be reused
 * because C-only identifiers (a variable called `new`) break its parse.
 *
 * Tracked: function definitions (static, inline, pointer-returning,
 * function-pointer-returning), prototypes in headers (kept as a node only when
 * nothing in the workspace defines them, see pruneRedundantDeclarations),
 * direct calls `f(x)`, and callbacks — a workspace function passed as an
 * argument, stored in a variable or struct initializer, assigned, or returned
 * becomes an edge from the enclosing function. Calls to C standard library
 * functions become library nodes attributed to the header stem ("stdio").
 *
 * Not tracked (static analysis cannot resolve them): calls through pointers
 * (`fp(x)`, `(*fp)(x)`, `ops->open(x)`), macros and the calls inside them,
 * function tables at file scope (no enclosing function to draw the edge from),
 * and calls to third-party libraries (no import says which library a name is).
 */

'use strict';

const path = require('path');
const { createNarrower, withStats } = require('./narrowCalls.js');
const { collectSourceFiles, explicitFileList } = require('./sourceFiles.js');
const {
  createTreeSitterSession, isCFamilyFile, splitCFamilyFiles,
  findFunctionDeclarator, declaratorName, pruneRedundantDeclarations,
} = require('./cFamily.js');
const { libraryOf } = require('./cStdlib.js');

const GRAMMAR_WASM = path.join(__dirname, 'tree-sitter-c.wasm');

// Parser + parse cache (each file is parsed once and the tree reused by both
// passes; see createTreeSitterSession). `init()` must be awaited before
// collectDefinitions / collectCalls; `clearTreeCache()` frees the WASM trees
// once an analysis run completes.
const session = createTreeSitterSession(GRAMMAR_WASM);
const { init, getTree, clearTreeCache } = session;
const _stats = session.stats;

/** The C files of a workspace: a standalone walk, keeping only what C owns. */
function collectCFiles(root) {
  return splitCFamilyFiles(collectSourceFiles(root, isCFamilyFile)).c;
}

// ── Definitions pass ──────────────────────────────────────────────────────────

/** The name node of the function a definition or prototype declares, or null. */
function functionNameOf(declarator) {
  const funcDecl = findFunctionDeclarator(declarator);
  return funcDecl ? declaratorName(funcDecl) : null;
}

function collectDefinitionsFromTree(rootNode, filepath, definitions) {
  function addDef(nameNode, isDeclaration) {
    const line = nameNode.startPosition.row + 1;
    const name = nameNode.text;
    const def = { id: `${filepath}::${name}::${line}`, name, file: filepath, line, language: 'c' };
    // Marker (stripped before output by pruneRedundantDeclarations): a
    // prototype without a body, e.g. `int f(void);` in a header.
    if (isDeclaration) { def.isDeclaration = true; }
    definitions[def.id] = def;
  }

  function visit(node) {
    const t = node.type;
    if (t === 'function_definition') {
      const name = functionNameOf(node.childForFieldName('declarator'));
      if (name) { addDef(name, false); }
      return; // C has no nested functions
    }
    if (t === 'declaration') {
      // Prototype(s): `int f(void);`, `char *dup(const char *s), *g(int);`. The
      // type node and variable declarators yield no function declarator.
      for (const child of node.namedChildren) {
        if (child.type === 'init_declarator') { continue; } // a variable with an initializer
        const name = functionNameOf(child);
        if (name) { addDef(name, true); }
      }
      return;
    }
    if (t === 'struct_specifier' || t === 'union_specifier' || t === 'enum_specifier') { return; }
    // translation_unit, preproc_if/ifdef branches, extern "C" blocks, …
    for (const c of node.namedChildren) { visit(c); }
  }

  visit(rootNode);
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

// Where a bare function name counts as "this function is handed on" (a
// callback): an argument, an initializer (`cb_t f = handler;`, `{ .open =
// my_open }`), the right side of an assignment, a return value.
const REFERENCE_FIELDS = {
  argument_list: null, initializer_list: null, return_statement: null,
  init_declarator: 'value', initializer_pair: 'value', assignment_expression: 'right',
};

function isFunctionReference(identifier) {
  const parent = identifier.parent;
  if (!parent || !(parent.type in REFERENCE_FIELDS)) { return false; }
  const field = REFERENCE_FIELDS[parent.type];
  return field === null || parent.childForFieldName(field)?.equals(identifier) === true;
}

function collectCallsFromTree(rootNode, filepath, definitions, nameToIds,
                              edges, seenEdges, libraryNodes, narrowIds) {
  // D6: fan-outs over same-named definitions go through narrowCalls.js.
  const narrow = (ids) => (narrowIds ? narrowIds(ids, filepath) : ids);
  let caller = null;

  function addEdge(target, isLibraryEdge) {
    if (!caller || caller === target) { return; }
    const key = `${caller}|${target}`;
    if (seenEdges.has(key)) { return; }
    seenEdges.add(key);
    const edge = { source: caller, target };
    if (isLibraryEdge) { edge.isLibraryEdge = true; }
    edges.push(edge);
  }

  function addLibraryEdge(libName, funcName) {
    const libId = `library::${libName}::${funcName}`;
    if (!libraryNodes.has(libId)) {
      libraryNodes.set(libId, {
        id: libId, name: funcName, file: null, line: 0,
        isLibrary: true, libraryName: libName, language: 'c',
      });
    }
    addEdge(libId, true);
  }

  /** Link a bare name to the workspace functions called that; false when none. */
  function linkWorkspaceName(name) {
    const ids = nameToIds[name];
    if (!ids) { return false; }
    for (const id of narrow(ids)) { addEdge(id, false); }
    return true;
  }

  function handleCall(callExpr) {
    const fn = callExpr.childForFieldName('function');
    // fp(x), (*fp)(x), ops->open(x): the target is a runtime value — not tracked.
    if (!fn || fn.type !== 'identifier') { return; }
    if (linkWorkspaceName(fn.text)) { return; }
    const lib = libraryOf(fn.text);
    if (lib) { addLibraryEdge(lib, fn.text); }
  }

  function visit(node) {
    const t = node.type;
    if (t === 'function_definition') {
      const name = functionNameOf(node.childForFieldName('declarator'));
      const id = name ? `${filepath}::${name.text}::${name.startPosition.row + 1}` : null;
      caller = id && definitions[id] ? id : null;
      try {
        const body = node.childForFieldName('body');
        if (body) { for (const c of body.namedChildren) { visit(c); } }
      } finally { caller = null; }
      return;
    }
    if (t === 'call_expression') {
      try { handleCall(node); } catch { /* skip malformed call */ }
      // Still descend so nested calls (in arguments) are also visited.
      for (const c of node.namedChildren) { visit(c); }
      return;
    }
    if (t === 'identifier') {
      if (isFunctionReference(node)) { linkWorkspaceName(node.text); }
      return;
    }
    for (const c of node.namedChildren) { visit(c); }
  }

  visit(rootNode);
}

function collectCalls(files, definitions, root) {
  const narrower = createNarrower((id) => definitions[id] && definitions[id].file, root);
  const nameToIds = Object.create(null);
  for (const [id, defn] of Object.entries(definitions)) {
    (nameToIds[defn.name] ??= []).push(id);
  }

  const edges = [];
  const seenEdges = new Set();
  const libraryNodes = new Map();
  for (const filepath of files) {
    const tree = getTree(filepath); // cache hit when collectDefinitions ran first
    if (!tree) { continue; }
    try {
      collectCallsFromTree(tree.rootNode, filepath, definitions, nameToIds,
                           edges, seenEdges, libraryNodes, narrower.narrow);
    } catch { /* skip files that crash the walker */ }
  }
  return { edges, libraryNodes: Array.from(libraryNodes.values()), stats: narrower.stats };
}

// ── Entry ─────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.length < 3) {
    process.stderr.write('Usage: analyze_c.js <workspace_root> [--files <listpath>]\n');
    process.exit(1);
  }
  await init();
  const root = process.argv[2];
  // `--files <listpath>` (subset mode) or a full walk; either way only the C
  // share of the C-family files (C++ sources and headers go to analyze_cpp.js).
  const listed = explicitFileList(isCFamilyFile);
  const files = listed ? splitCFamilyFiles(listed).c : collectCFiles(root);
  try {
    const definitions = collectDefinitions(files);
    const { edges, libraryNodes, stats } = collectCalls(files, definitions, root);
    const nodes = [...Object.values(definitions), ...libraryNodes];
    require('./graphOutput.js').writeGraph(withStats({ nodes, edges, files }, stats));
  } finally {
    clearTreeCache(); // free all cached WASM trees
  }
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write('analyze_c failed: ' + ((err && err.stack) || err) + '\n');
    process.exit(1);
  });
}

if (typeof module !== 'undefined') {
  module.exports = { init, collectCFiles, collectDefinitions, collectCalls, clearTreeCache, _stats };
}
