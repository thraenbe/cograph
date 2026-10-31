import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { STAGE_SCRIPTS } from '../../stagePage';

// The static viewer runs the stage scripts as ONE file (scripts/build-stage.js), and one file is not
// the same program as many tags. A `const` or `class` of a later script sits in its dead zone from the
// first line, so `typeof` throws where separate files said undefined. A later function is hoisted, so
// a `typeof f === 'function'` guard flips. A repeated `const` is a syntax error that loses the page, and
// a directive at the head of the first file would make all of them strict. Nothing of this shows in
// the panel, which keeps separate tags, so these rules are checked here on the source.

const WEBVIEW = path.resolve(__dirname, '..', '..', '..', 'src', 'webview');

/** drilldown.js and scope.js: functions, not called at load, so scope.js's wins in either form of the page. */
const SAME_FUNCTION_TWICE = new Set(['pathUnder']);

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, fs.readFileSync(path.join(WEBVIEW, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function topLevelNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const st of source.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) { names.push(st.name.text); }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) { if (ts.isIdentifier(d.name)) { names.push(d.name.text); } }
    }
  }
  return names;
}

/** `typeof name` outside every function: the code that runs while the file loads. */
function loadTimeTypeofs(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) { return; }
    if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression)) { found.push(node.expression.text); }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

suite('stage scripts: safe to run as one file', () => {
  const files = [...STAGE_SCRIPTS, 'staticBridge.js'];
  const sources = files.map(parse);

  test('no file starts with a directive', () => {
    for (const source of sources) {
      const first = source.statements[0];
      assert.ok(!(first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression)), source.fileName);
    }
  });

  test('no top-level name twice, the bridge included: a repeated const would lose the whole page', () => {
    const seen = new Map<string, string>();
    for (const source of sources) {
      for (const name of topLevelNames(source)) {
        const other = seen.get(name);
        assert.ok(!other || SAME_FUNCTION_TWICE.has(name), `${name} in ${other} and ${source.fileName}`);
        seen.set(name, source.fileName);
      }
    }
  });

  test('nothing at load time asks typeof about a name a later script declares', () => {
    sources.forEach((source, i) => {
      const later = new Set(sources.slice(i + 1).flatMap(topLevelNames));
      for (const name of loadTimeTypeofs(source)) {
        assert.ok(!later.has(name), `${source.fileName}: typeof ${name}`);
      }
    });
  });
});
