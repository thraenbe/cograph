// tsJsAnalyzer.js — the analyzer core shared by analyze_ts.js and analyze_js.js.
'use strict';

const { createNarrower, withStats, resolveThisCall } = require('./narrowCalls.js');
// Bare specifier so esbuild can inline it into the packaged bundle (dev runs
// resolve it from the repo's node_modules via normal module resolution).
const ts   = require('typescript');

const { collectSourceFiles, explicitFileList } = require('./sourceFiles.js');
const { isSfcPath, ownsSfc, readAnalyzerSource } = require('./sfcScript.js');

// ScriptKind of a .vue/.svelte script block, by its `lang` (sfcScript.js).
const SFC_SCRIPT_KINDS = { ts: ts.ScriptKind.TS, tsx: ts.ScriptKind.TSX, js: ts.ScriptKind.JS };

/**
 * A file this analyzer parses: one of its own extensions, or a .vue/.svelte
 * component it owns (`lang="ts"`/`"tsx"` → TypeScript, other JS → JavaScript).
 */
function isAnalyzedFile(file, options) {
  if (isSfcPath(file)) return ownsSfc(file, options.sfcAnalyzer);
  return options.isSourceFile(file);
}

function collectFiles(root, options) {
  return collectSourceFiles(root, (file) => isAnalyzedFile(file, options));
}

function getLine(sourceFile, node) {
  return ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;
}

/**
 * Parses `filepath`, or null when it is unreadable or a component this analyzer
 * does not own. A component is parsed as its virtual source (sfcScript.js): the
 * file's own line count with everything outside the script blocks blanked.
 */
function parse(filepath, options) {
  const read = readAnalyzerSource(filepath, options.sfcAnalyzer);
  if (!read) return null;
  const scriptKind = read.lang ? SFC_SCRIPT_KINDS[read.lang] : options.scriptKind;
  return ts.createSourceFile(filepath, read.source, ts.ScriptTarget.Latest, true, scriptKind);
}

function classInfo(classNode, sourceFile) {
  const info = { className: classNode.name?.text ?? '(anonymous)' };
  const classImplements = [];
  for (const clause of classNode.heritageClauses ?? []) {
    if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length) {
      info.classExtends = clause.types[0].expression.getText(sourceFile);
    } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
      for (const t of clause.types) {
        classImplements.push(t.expression.getText(sourceFile));
      }
    }
  }
  if (classImplements.length) info.classImplements = classImplements;
  return info;
}

function collectDefinitions(files, options) {
  const language = options.language;
  const definitions = {};
  for (const filepath of files) {
    let sourceFile;
    try {
      sourceFile = parse(filepath, options);
    } catch { continue; }
    if (!sourceFile) continue;

    function visit(node) {
      try {
        if (ts.isFunctionDeclaration(node) && node.name) {
          const name = node.name.text;
          const line = getLine(sourceFile, node);
          const id = `${filepath}::${name}::${line}`;
          definitions[id] = { id, name, file: filepath, line, language };
        } else if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.name) {
          const name = node.name.getText(sourceFile);
          const line = getLine(sourceFile, node);
          const id = `${filepath}::${name}::${line}`;
          definitions[id] = { id, name, file: filepath, line, language,
                              ...classInfo(node.parent, sourceFile) };
        } else if (ts.isConstructorDeclaration(node) && ts.isClassDeclaration(node.parent)) {
          const line = getLine(sourceFile, node);
          const id = `${filepath}::constructor::${line}`;
          definitions[id] = { id, name: 'constructor', file: filepath, line, language,
                              ...classInfo(node.parent, sourceFile) };
        } else if ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
                   && ts.isClassDeclaration(node.parent) && node.name) {
          const prefix = ts.isGetAccessorDeclaration(node) ? 'get ' : 'set ';
          const name = prefix + node.name.getText(sourceFile);
          const line = getLine(sourceFile, node);
          const id = `${filepath}::${name}::${line}`;
          definitions[id] = { id, name, file: filepath, line, language,
                              ...classInfo(node.parent, sourceFile) };
        } else if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.initializer &&
                (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
              const name = decl.name.text;
              const line = getLine(sourceFile, decl);
              const id = `${filepath}::${name}::${line}`;
              definitions[id] = { id, name, file: filepath, line, language };
            }
          }
        }
      } catch { /* skip malformed nodes */ }
      ts.forEachChild(node, visit);
    }
    try { visit(sourceFile); } catch { continue; }
  }
  return definitions;
}

/**
 * Collects ESM import bindings and, when options.cjsRequire is set, CommonJS
 * require() bindings. Returns a map of local name -> package/module specifier.
 */
function collectImportMap(sourceFile, options) {
  const importMap = Object.create(null);

  ts.forEachChild(sourceFile, node => {
    // ESM: import React from 'react' / import * as fs from 'fs' / import { x } from 'pkg'
    if (ts.isImportDeclaration(node)) {
      try {
        const spec = node.moduleSpecifier.text;
        if (spec.startsWith('.')) return;
        const clause = node.importClause;
        if (!clause) return;
        if (clause.name) {
          importMap[clause.name.text] = spec;
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            importMap[clause.namedBindings.name.text] = spec;
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              importMap[element.name.text] = spec;
            }
          }
        }
      } catch { /* skip malformed */ }
      return;
    }

    // CJS: const x = require('pkg')  /  const { a, b } = require('pkg')
    if (options.cjsRequire && ts.isVariableStatement(node)) {
      try {
        for (const decl of node.declarationList.declarations) {
          if (!decl.initializer) continue;
          // Unwrap: require('pkg') or require('pkg').something
          let call = decl.initializer;
          if (ts.isPropertyAccessExpression(call)) call = call.expression;
          if (!ts.isCallExpression(call)) continue;
          const expr = call.expression;
          if (!ts.isIdentifier(expr) || expr.text !== 'require') continue;
          if (call.arguments.length < 1) continue;
          const arg = call.arguments[0];
          if (!ts.isStringLiteral(arg)) continue;
          const spec = arg.text;
          if (spec.startsWith('.')) continue;

          if (ts.isIdentifier(decl.name)) {
            // const x = require('pkg')
            importMap[decl.name.text] = spec;
          } else if (ts.isObjectBindingPattern(decl.name)) {
            // const { a, b } = require('pkg')
            for (const element of decl.name.elements) {
              if (ts.isIdentifier(element.name)) {
                importMap[element.name.text] = spec;
              }
            }
          }
        }
      } catch { /* skip malformed */ }
    }
  });

  return importMap;
}

function collectCalls(files, definitions, root, options) {
  const language = options.language;
  // D6: a name with more than 8 definitions is narrowed (file → directory →
  // top-level package) or dropped instead of linked to all of them (narrowCalls.js).
  const narrower = createNarrower((id) => definitions[id] && definitions[id].file, root);
  const nameToIds = Object.create(null);
  for (const [qid, defn] of Object.entries(definitions)) {
    if (!nameToIds[defn.name]) nameToIds[defn.name] = [];
    nameToIds[defn.name].push(qid);
  }

  const edges = [];
  const seenEdges = new Set();
  const libraryNodes = new Map();

  for (const filepath of files) {
    let sourceFile;
    try {
      sourceFile = parse(filepath, options);
    } catch { continue; }
    if (!sourceFile) continue;

    const importMap = collectImportMap(sourceFile, options);

    function visitFunc(funcNode, callerId) {
      ts.forEachChild(funcNode, function walkCalls(node) {
        try {
          if (ts.isCallExpression(node)) {
            const callee = node.expression;
            let calleeName = null;
            let viaThis = false;
            if (ts.isIdentifier(callee)) {
              calleeName = callee.text;
            } else if (ts.isPropertyAccessExpression(callee) &&
                       callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
              // `this` is a ThisKeyword token, never an Identifier.
              calleeName = callee.name.text;
              viaThis = true;
            }
            if (calleeName && nameToIds[calleeName]) {
              const targets = viaThis
                ? resolveThisCall(nameToIds[calleeName], definitions[callerId], definitions, narrower.narrow, filepath)
                : narrower.narrow(nameToIds[calleeName], filepath);
              for (const calleeId of targets) {
                const key = `${callerId}|${calleeId}`;
                if (!seenEdges.has(key) && callerId !== calleeId) {
                  seenEdges.add(key);
                  edges.push({ source: callerId, target: calleeId });
                }
              }
            }
            // Library call detection
            if (ts.isIdentifier(callee)) {
              const name = callee.text;
              if (importMap[name] && !nameToIds[name]) {
                const libName = importMap[name];
                const libId = `library::${libName}::${name}`;
                if (!libraryNodes.has(libId)) {
                  libraryNodes.set(libId, { id: libId, name, file: null, line: 0, isLibrary: true, libraryName: libName, language });
                }
                const key = `${callerId}|${libId}`;
                if (!seenEdges.has(key)) {
                  seenEdges.add(key);
                  edges.push({ source: callerId, target: libId, isLibraryEdge: true });
                }
              }
            } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
              const objName = callee.expression.text;
              if (importMap[objName] && !nameToIds[objName]) {
                const libName = importMap[objName];
                const funcName = callee.name.text;
                const libId = `library::${libName}::${funcName}`;
                if (!libraryNodes.has(libId)) {
                  libraryNodes.set(libId, { id: libId, name: funcName, file: null, line: 0, isLibrary: true, libraryName: libName, language });
                }
                const key = `${callerId}|${libId}`;
                if (!seenEdges.has(key)) {
                  seenEdges.add(key);
                  edges.push({ source: callerId, target: libId, isLibraryEdge: true });
                }
              }
            }
          }
        } catch { /* skip */ }
        ts.forEachChild(node, walkCalls);
      });
    }

    function visit(node) {
      try {
        let callerId = null;
        if (ts.isFunctionDeclaration(node) && node.name) {
          const line = getLine(sourceFile, node);
          callerId = `${filepath}::${node.name.text}::${line}`;
        } else if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.name) {
          const line = getLine(sourceFile, node);
          callerId = `${filepath}::${node.name.getText(sourceFile)}::${line}`;
        } else if ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
                   && ts.isClassDeclaration(node.parent) && node.name) {
          const prefix = ts.isGetAccessorDeclaration(node) ? 'get ' : 'set ';
          const line = getLine(sourceFile, node);
          callerId = `${filepath}::${prefix}${node.name.getText(sourceFile)}::${line}`;
        } else if (ts.isConstructorDeclaration(node) && ts.isClassDeclaration(node.parent)) {
          const line = getLine(sourceFile, node);
          callerId = `${filepath}::constructor::${line}`;
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
                   (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
          const line = getLine(sourceFile, node);
          callerId = `${filepath}::${node.name.text}::${line}`;
        }
        if (callerId && definitions[callerId]) {
          visitFunc(node, callerId);
        }
      } catch { /* skip */ }
      ts.forEachChild(node, visit);
    }
    try { visit(sourceFile); } catch { continue; }
  }
  return { edges, libraryNodes: Array.from(libraryNodes.values()), stats: narrower.stats };
}

function main(options) {
  if (process.argv.length < 3) {
    process.stderr.write(`Usage: ${options.scriptName} <workspace_root> [--files <listpath>]\n`);
    process.exit(1);
  }
  const root = process.argv[2];
  const files = explicitFileList((file) => isAnalyzedFile(file, options)) ?? collectFiles(root, options);
  const definitions = collectDefinitions(files, options);
  const { edges, libraryNodes, stats } = collectCalls(files, definitions, root, options);
  const nodes = [...Object.values(definitions), ...libraryNodes];
  require('./graphOutput.js').writeGraph(withStats({ nodes, edges, files }, stats));
}

module.exports = { isAnalyzedFile, collectFiles, collectDefinitions, collectCalls, main };
