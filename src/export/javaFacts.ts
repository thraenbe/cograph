import { ordinal } from '../mcp/compare';
import { relOf } from './analyze';

/** What `analyze_java.js --export-info` adds to its graph (see scripts/javaExportInfo.js). */
export interface JavaField { line: number; modifiers: string; type: string; name: string; init: string; }
export interface JavaLiteral { line: number; why: 'url' | 'asset' | 'file-arg'; text: string; }
export interface JavaClass {
  file: string; pkg: string; name: string; kind: string; line: number; endLine: number; outer: string;
  modifiers: string[]; typeParams: string; javadoc: string; extends: string; implements: string[];
  fields: JavaField[]; literals: JavaLiteral[];
}
export interface JavaMethod {
  id: string; endLine: number; javadoc: string; signature: string; modifiers: string[]; annotations: string[]; abstract: boolean;
  /** `Class.CONSTANT` reads as written; the export keeps those whose class is in the project. */
  reads: string[];
}
export interface JavaSite {
  file: string; line: number; col: number; caller: string; form: string; name: string;
  receiver: string; args: string; targets: string[]; reason: string | null;
}
/** A literal naming a URL, an asset or a file, with the method (raw id) or class it sits in. */
export interface JavaLiteralAt extends JavaLiteral { file: string; method: string | null; cls: string | null; }
export interface JavaExportInfo { classes: JavaClass[]; methods: JavaMethod[]; literals: JavaLiteralAt[]; sites: JavaSite[]; }

/** The Java facts keyed for rendering: classes by file, methods and call sites by caller raw id. */
export interface JavaFacts {
  classesByRel: Map<string, JavaClass[]>;
  /** Simple class name -> its classes (several when the name repeats across packages). */
  classesByName: Map<string, JavaClass[]>;
  methodById: Map<string, JavaMethod>;
  sitesByCaller: Map<string, JavaSite[]>;
  sites: JavaSite[];
  literals: JavaLiteralAt[];
  classes: JavaClass[];
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) { l.push(v); } else { m.set(k, [v]); }
}

export function indexJavaFacts(root: string, info: JavaExportInfo | null): JavaFacts {
  const facts: JavaFacts = { classesByRel: new Map(), classesByName: new Map(), methodById: new Map(), sitesByCaller: new Map(), sites: [], literals: [], classes: [] };
  if (!info) { return facts; }
  const bySource = (a: { file: string; line: number }, b: { file: string; line: number }) =>
    ordinal(relOf(root, a.file), relOf(root, b.file)) || a.line - b.line;
  for (const c of [...info.classes].sort((a, b) => bySource(a, b) || ordinal(a.name, b.name))) {
    push(facts.classesByRel, relOf(root, c.file), c);
    push(facts.classesByName, c.name, c);
  }
  for (const m of info.methods) { facts.methodById.set(m.id, m); }
  facts.classes = [...facts.classesByRel.values()].flat();
  facts.literals = [...info.literals].sort((a, b) => bySource(a, b) || ordinal(a.text, b.text));
  facts.sites = [...info.sites].sort((a, b) => bySource(a, b) || a.col - b.col || ordinal(a.name, b.name));
  for (const s of facts.sites) { push(facts.sitesByCaller, s.caller, s); }
  return facts;
}

export function classDeclaration(c: JavaClass): string {
  const kw = c.kind === 'interface' ? 'extends' : 'implements';
  return `${c.pkg ? `package ${c.pkg}; ` : ''}${[...c.modifiers, c.kind, c.name + c.typeParams].join(' ')}`
    + `${c.extends ? ` extends ${c.extends}` : ''}${c.implements.length ? ` ${kw} ${c.implements.join(', ')}` : ''}`;
}

/** How a call site reads in the source, e.g. `this.score.save(points)` or `new File("hs.txt")`. */
export function siteText(s: JavaSite): string {
  if (s.form.startsWith('ctor-')) { return `${s.name}(..)`; } // explicit or implicit constructor call: no text kept
  return `${s.receiver ? `${s.receiver}.` : ''}${s.name}(${s.args})`;
}
