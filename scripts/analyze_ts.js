/**
 * CoGraph TypeScript AST analyzer.
 *
 * Usage: node analyze_ts.js <workspace_root>
 *
 * Outputs a JSON call graph to stdout:
 *   { "nodes": [{id, name, file, line, language}], "edges": [{source, target}] }
 *
 * Scope: workspace .ts/.tsx files (excludes .d.ts). Best-effort static analysis.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const ts   = require(path.join(__dirname, '..', 'node_modules', 'typescript'));

const SKIP_DIR_NAMES = new Set(['node_modules', 'out', 'dist']);

function collectTsFiles(root) {
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name)) walk(full);
      } else if (entry.isFile() && !entry.name.endsWith('.d.ts') &&
                 (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        results.push(full);
      }
    }
  }
  walk(root);
  return results;
}

function getLine(sourceFile, node) {
  return ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;
}

function collectDefinitions(files) {
  const definitions = {};
  for (const filepath of files) {
    let source;
    try { source = fs.readFileSync(filepath, 'utf8'); } catch { continue; }
    let sourceFile;
    try {
      sourceFile = ts.createSourceFile(filepath, source, ts.ScriptTarget.Latest, true);
    } catch { continue; }

    function visit(node) {
      try {
        if (ts.isFunctionDeclaration(node) && node.name) {
          const name = node.name.text;
          const line = getLine(sourceFile, node);
          const id = `${filepath}::${name}::${line}`;
          definitions[id] = { id, name, file: filepath, line, language: 'typescript' };
        } else if (ts.isMethodDeclaration(node) && ts.isClassDeclaration(node.parent) && node.name) {
          const name = node.name.getText(sourceFile);
          const line = getLine(sourceFile, node);
          const id = `${filepath}::${name}::${line}`;
          const classNode = node.parent;
          const className = classNode.name?.text ?? '(anonymous)';
          let classExtends;
          const classImplements = [];
          if (classNode.heritageClauses) {
            for (const clause of classNode.heritageClauses) {
              if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length) {
                classExtends = clause.types[0].expression.getText(sourceFile);
              } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
                for (const t of clause.types) {
                  classImplements.push(t.expression.getText(sourceFile));
                }
              }
            }
          }
          const def = { id, name, file: filepath, line, language: 'typescript', className };
          if (classExtends !== undefined) def.classExtends = classExtends;
          if (classImplements.length) def.classImplements = classImplements;
          definitions[id] = def;
        } else if (ts.isConstructorDeclaration(node) && ts.isClassDeclaration(node.parent)) {
          const line = getLine(sourceFile, node);
          const classNode = node.parent;
          const className = classNode.name?.text ?? '(anonymous)';
          const id = `${filepath}::constructor::${line}`;
          let classExtends;
          const classImplements = [];
          if (classNode.heritageClauses) {
            for (const clause of classNode.heritageClauses) {
              if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length) {
                classExtends = clause.types[0].expression.getText(sourceFile);
              } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
                for (const t of clause.types) {
                  classImplements.push(t.expression.getText(sourceFile));
                }
              }
            }
          }
          const def = { id, name: 'constructor', file: filepath, line, language: 'typescript', className };
          if (classExtends !== undefined) def.classExtends = classExtends;
          if (classImplements.length) def.classImplements = classImplements;
          definitions[id] = def;
        } else if ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))
                   && ts.isClassDeclaration(node.parent) && node.name) {
          const prefix = ts.isGetAccessorDeclaration(node) ? 'get ' : 'set ';
          const name = prefix + node.name.getText(sourceFile);
          const line = getLine(sourceFile, node);
          const id = `${filepath}::${name}::${line}`;
          const classNode = node.parent;
          const className = classNode.name?.text ?? '(anonymous)';
          let classExtends;
          const classImplements = [];
          if (classNode.heritageClauses) {
            for (const clause of classNode.heritageClauses) {
              if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length) {
                classExtends = clause.types[0].expression.getText(sourceFile);
              } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
                for (const t of clause.types) {
                  classImplements.push(t.expression.getText(sourceFile));
                }
              }
            }
          }
          const def = { id, name, file: filepath, line, language: 'typescript', className };
          if (classExtends !== undefined) def.classExtends = classExtends;
          if (classImplements.length) def.classImplements = classImplements;
          definitions[id] = def;
        } else if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.initializer &&
                (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
              const name = decl.name.text;
              const line = getLine(sourceFile, decl);
              const id = `${filepath}::${name}::${line}`;
              definitions[id] = { id, name, file: filepath, line, language: 'typescript' };
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

function collectImportMap(sourceFile) {
  const importMap = {};
  ts.forEachChild(sourceFile, node => {
    if (!ts.isImportDeclaration(node)) return;
    try {
      const spec = node.moduleSpecifier.text;
      if (spec.startsWith('.')) return; // skip relative imports
      const clause = node.importClause;
      if (!clause) return;
      // Default import: import React from 'react'
      if (clause.name) {
        importMap[clause.name.text] = spec;
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          // Namespace: import * as fs from 'fs'
          importMap[clause.namedBindings.name.text] = spec;
        } else if (ts.isNamedImports(clause.namedBindings)) {
          // Named: import { useState } from 'react'
          for (const element of clause.namedBindings.elements) {
            const local = element.name.text;
            importMap[local] = spec;
          }
        }
      }
    } catch { /* skip malformed */ }
  });
  return importMap;
}

function collectCalls(files, definitions) {
  const nameToIds = {};
  for (const [qid, defn] of Object.entries(definitions)) {
    if (!nameToIds[defn.name]) nameToIds[defn.name] = [];
    nameToIds[defn.name].push(qid);
  }

  const edges = [];
  const seenEdges = new Set();
  const libraryNodes = new Map();

  for (const filepath of files) {
    let source;
    try { source = fs.readFileSync(filepath, 'utf8'); } catch { continue; }
    let sourceFile;
    try {
      sourceFile = ts.createSourceFile(filepath, source, ts.ScriptTarget.Latest, true);
    } catch { continue; }

    const importMap = collectImportMap(sourceFile);

    function visitFunc(funcNode, callerId) {
      ts.forEachChild(funcNode, function walkCalls(node) {
        try {
          if (ts.isCallExpression(node)) {
            const callee = node.expression;
            let calleeName = null;
            if (ts.isIdentifier(callee)) {
              calleeName = callee.text;
            } else if (ts.isPropertyAccessExpression(callee) &&
                       ts.isIdentifier(callee.expression) &&
                       callee.expression.text === 'this') {
              calleeName = callee.name.text;
            }
            if (calleeName && nameToIds[calleeName]) {
              for (const calleeId of nameToIds[calleeName]) {
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
                  libraryNodes.set(libId, { id: libId, name, file: null, line: 0, isLibrary: true, libraryName: libName, language: 'typescript' });
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
                  libraryNodes.set(libId, { id: libId, name: funcName, file: null, line: 0, isLibrary: true, libraryName: libName, language: 'typescript' });
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
  return { edges, libraryNodes: Array.from(libraryNodes.values()) };
}

function main() {
  if (process.argv.length < 3) {
    process.stderr.write('Usage: analyze_ts.js <workspace_root>\n');
    process.exit(1);
  }
  const root = process.argv[2];
  const files = collectTsFiles(root);
  const definitions = collectDefinitions(files);
  const { edges, libraryNodes } = collectCalls(files, definitions);
  const nodes = [...Object.values(definitions), ...libraryNodes];
  process.stdout.write(JSON.stringify({ nodes, edges }) + '\n');
}

main();

if (typeof module !== 'undefined') {
  module.exports = { collectTsFiles, collectDefinitions, collectCalls };
}
