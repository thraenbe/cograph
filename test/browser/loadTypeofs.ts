// The stage scripts as one file, with a recorder on every `typeof` of a name a later script declares. It
// tells which of them run while the file loads. There, one file and many tags disagree: a hoisted function
// makes the guard pass where a tag had not defined it yet. Whether that throws depends on what the function
// touches, so only running it shows them all (stageConcat.test.ts can only see the ones outside a function).
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { STAGE_SCRIPTS } from '../../src/stagePage';

const ROOT = path.resolve(__dirname, '..', '..');

function declaredAt(sources: ts.SourceFile[]): Map<string, number> {
  const at = new Map<string, number>();
  sources.forEach((source, i) => {
    for (const st of source.statements) {
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) { at.set(st.name.text, i); }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) { if (ts.isIdentifier(d.name)) { at.set(d.name.text, i); } }
      }
    }
  });
  return at;
}

function instrument(source: ts.SourceFile, index: number, declared: Map<string, number>): string {
  const hits: ts.TypeOfExpression[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression) && (declared.get(node.expression.text) ?? -1) > index) { hits.push(node); }
    ts.forEachChild(node, walk);
  };
  walk(source);
  let text = source.text;
  for (const node of hits.sort((a, b) => b.getStart(source) - a.getStart(source))) {
    const name = (node.expression as ts.Identifier).text;
    text = `${text.slice(0, node.getStart(source))}(__loadTypeof('${name}'), ${node.getText(source)})${text.slice(node.getEnd())}`;
  }
  return text;
}

/** The stage file to serve instead of the built one; `__loadTypeofs` then lists the names asked about during load. */
export function instrumentedStage(): string {
  const sources = STAGE_SCRIPTS.map((file) => {
    const text = fs.readFileSync(path.join(ROOT, 'src', 'webview', file), 'utf8');
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  });
  const declared = declaredAt(sources);
  const d3 = fs.readFileSync(path.join(ROOT, 'node_modules', 'd3', 'dist', 'd3.min.js'), 'utf8');
  const stage = sources.map((source, i) => instrument(source, i, declared)).join('\n;\n');
  return `var __loadTypeofs = [], __loaded = false;
function __loadTypeof(name) { if (!__loaded) { __loadTypeofs.push(name); } }
${d3}
;
${stage}
;
__loaded = true;
`;
}
