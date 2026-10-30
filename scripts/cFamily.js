/**
 * cFamily.js — what the C analyzer (analyze_c.js) and the C++ analyzer
 * (analyze_cpp.js) share: the web-tree-sitter session with its parse cache,
 * the C-family file predicate (the walk itself is sourceFiles.js), the rule
 * that decides whether a `.h` belongs to C or to C++, the declarator helper
 * that finds the function behind pointer/reference wrappers, and the
 * declaration/definition pruning.
 *
 * Header rule: a `.h` file is C when its own directory holds at least one `.c`
 * file and no C++ source (`.cpp`, `.cc`, `.cxx`, `.c++`); otherwise it is C++.
 * The rule reads the directory on disk (not the file list handed to the
 * analyzer), so a full run and a single-file subset run classify a header the
 * same way, and both analyzers see exactly one owner per header.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
// Bare specifier (not a path join): web-tree-sitter is an "exports"-only package
// with no "main" field, so it must be resolved by name. Node resolves it from
// node_modules relative to this file regardless of the process cwd.
const { Parser, Language } = require('web-tree-sitter');

const C_SOURCE_EXTS   = new Set(['.c']);
const CPP_SOURCE_EXTS = new Set(['.cpp', '.cc', '.cxx', '.c++']);
const CPP_HEADER_EXTS = new Set(['.hpp', '.hh', '.hxx', '.h++']);
const SHARED_HEADER_EXT = '.h';
const C_FAMILY_EXTS = new Set([...C_SOURCE_EXTS, ...CPP_SOURCE_EXTS, ...CPP_HEADER_EXTS, SHARED_HEADER_EXT]);

function extOf(file) { return path.extname(file).toLowerCase(); }

// ── Parse session (single-parse optimisation) ────────────────────────────────
// The definitions pass and the calls pass each need the parse tree of every
// file. Parsing dominates the analyzer's cost, so each file is parsed once and
// the tree reused across both passes (re-parsing doubled analysis time — and
// this runs on every save). web-tree-sitter trees are WASM-heap objects that
// are NOT garbage-collected, so clearTreeCache() must free them when a run ends.
//
// Trade-off: every tree is held in memory between the two passes. Acceptable
// for typical workspaces; the lower-memory variant (one walk that extracts
// call-sites into plain objects and deletes each tree immediately) is recorded
// in .ai/memory/tech-dept.md as a future option.

/**
 * One parser + parse cache for one grammar. `init()` is idempotent and must be
 * awaited before `getTree()`. web-tree-sitter is pure WASM, so (unlike the
 * native tree-sitter binding) it has no libstdc++/ABI dependency and loads
 * inside snap/flatpak-confined Electron runtimes.
 */
function createTreeSitterSession(grammarWasm) {
  let parser = null;
  const treeCache = new Map(); // filepath -> Tree | null
  // Diagnostic/test counter: a run over N files should report N parses, not 2N.
  const stats = { parses: 0 };

  async function init() {
    if (parser) { return parser; }
    await Parser.init();
    const language = await Language.load(grammarWasm);
    parser = new Parser();
    parser.setLanguage(language);
    return parser;
  }

  function getTree(filepath) {
    if (treeCache.has(filepath)) { return treeCache.get(filepath); }
    let tree = null;
    try {
      tree = parser.parse(fs.readFileSync(filepath, 'utf8'));
      if (tree) { stats.parses++; }
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

  return { init, getTree, clearTreeCache, stats };
}

// ── Files ────────────────────────────────────────────────────────────────────
// The walk and `--files` parsing live in sourceFiles.js; this predicate selects
// the C-family files for it, and splitCFamilyFiles hands each to its analyzer.

/** Is this a C or C++ source or header (by extension, case-insensitive)? */
function isCFamilyFile(file) { return C_FAMILY_EXTS.has(extOf(file)); }

const headerDirCache = new Map(); // directory -> true when its .h files are C

/** The header rule (see the file comment): does this `.h` belong to C? */
function isCHeader(file) {
  const dir = path.dirname(file);
  if (headerDirCache.has(dir)) { return headerDirCache.get(dir); }
  let hasC = false;
  let hasCpp = false;
  try {
    for (const name of fs.readdirSync(dir)) {
      const ext = extOf(name);
      if (C_SOURCE_EXTS.has(ext)) { hasC = true; }
      else if (CPP_SOURCE_EXTS.has(ext)) { hasCpp = true; }
    }
  } catch { /* unreadable directory: treat as C++ (today's behaviour) */ }
  const isC = hasC && !hasCpp;
  headerDirCache.set(dir, isC);
  return isC;
}

/** Split a C-family file list into the files each analyzer owns. */
function splitCFamilyFiles(files) {
  const c = [];
  const cpp = [];
  for (const file of files) {
    const ext = extOf(file);
    if (C_SOURCE_EXTS.has(ext)) { c.push(file); }
    else if (ext === SHARED_HEADER_EXT) { (isCHeader(file) ? c : cpp).push(file); }
    else if (CPP_SOURCE_EXTS.has(ext) || CPP_HEADER_EXTS.has(ext)) { cpp.push(file); }
  }
  return { c, cpp };
}

// ── Declarators ──────────────────────────────────────────────────────────────

const DECLARATOR_WRAPPERS = new Set(['pointer_declarator', 'reference_declarator', 'parenthesized_declarator']);

/**
 * The declarator one level down. `pointer_declarator` names it through the
 * `declarator` field; `reference_declarator` and `parenthesized_declarator`
 * carry it as their only named child (no field name in the grammars).
 */
function innerDeclarator(node) {
  const byField = node.childForFieldName('declarator');
  if (byField) { return byField; }
  return node.namedChildren.find(c => c.type.endsWith('declarator') || c.type.endsWith('identifier')
    || c.type === 'destructor_name' || c.type === 'operator_name' || c.type === 'template_function') ?? null;
}

/**
 * The function_declarator that carries a function's name, or null when the
 * declarator does not describe a function at all.
 *
 * `int* make_ptr()` and `const Widget& get_ref(...)` wrap the function
 * declarator in a pointer/reference declarator (the pointer/reference-return
 * bug: looking only at the top-level declarator type dropped every such
 * function and every call into it). `int (*pick(int))(int)` nests one
 * function declarator in another: the innermost one names the function. In
 * `int (*cb)(int);` a pointer sits between the function declarator and the
 * name, which makes `cb` a function-pointer variable — not a function.
 */
function findFunctionDeclarator(decl) {
  let cur = decl;
  let found = null;
  while (cur) {
    if (cur.type === 'function_declarator') { found = cur; }
    else if (!DECLARATOR_WRAPPERS.has(cur.type)) { break; } // reached the name
    cur = innerDeclarator(cur);
  }
  return found && declaratorName(found) ? found : null;
}

/**
 * The name node of a function_declarator (identifier, field_identifier,
 * qualified_identifier, destructor_name, …), looked up through parentheses.
 * Null when a pointer sits between the declarator and the name (`(*cb)(int)`).
 */
function declaratorName(funcDecl) {
  let name = innerDeclarator(funcDecl);
  while (name && name.type === 'parenthesized_declarator') { name = innerDeclarator(name); }
  return name && !name.type.endsWith('declarator') ? name : null;
}

// ── Declarations vs definitions ──────────────────────────────────────────────

/**
 * Drop declaration-only nodes (a bodyless `void bar();` or `int f(void);` in a
 * header) when a real definition for the same class+name exists elsewhere in
 * the workspace.
 *
 * Without this, every `.h`/source pair yields two nodes for one function and
 * every call edge is duplicated — pure visual noise that also inflates the
 * layout. A declaration with no matching definition (the body lives in a
 * library or an un-indexed file) is kept so calls still resolve to a node — one
 * node, even when several files declare it (a C header and a forward
 * declaration in a `.c`); its internal `isDeclaration` marker is stripped.
 */
function pruneRedundantDeclarations(definitions) {
  const keyOf = (def) => `${def.className || ''}::${def.name}`;
  const definedKeys = new Set();
  for (const def of Object.values(definitions)) {
    if (!def.isDeclaration) { definedKeys.add(keyOf(def)); }
  }
  const keptDeclarations = new Set();
  for (const [id, def] of Object.entries(definitions)) {
    if (!def.isDeclaration) { continue; }
    const key = keyOf(def);
    if (definedKeys.has(key) || keptDeclarations.has(key)) { delete definitions[id]; continue; }
    keptDeclarations.add(key);
    delete def.isDeclaration; // surviving declaration — drop the internal marker
  }
}

module.exports = {
  C_FAMILY_EXTS, createTreeSitterSession, isCFamilyFile,
  isCHeader, splitCFamilyFiles, findFunctionDeclarator, declaratorName, pruneRedundantDeclarations,
};
