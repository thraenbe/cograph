import { ordinal } from '../mcp/compare';
import type { GraphIndex } from '../mcp/graphIndex';
import type { Sym } from '../mcp/ids';
import { relOf } from './analyze';
import { classDeclaration, siteText, type JavaClass, type JavaFacts, type JavaSite } from './javaFacts';

/** Why a call site has no edge, in words. */
export const REASONS: Record<string, string> = {
  'unknown-type': 'the receiver\'s type could not be worked out (lambda parameter, raw generic, library return value)',
  'no-definition': 'no method of that name and arity in the receiver\'s type or its project ancestors',
  'implicit-constructor': 'the class declares no constructor (the default one is not a node)',
  'ambiguous-dropped': 'more than eight candidates after narrowing',
  'anonymous-class': 'an anonymous class of a library type (`new Thread(r) { .. }`); the resolver records no constructor call for it',
  'not-recorded': 'the parser sees the call but the resolver records none (should not happen; please report it)',
};

const fieldLine = (f: JavaClass['fields'][number]) => `- L${f.line} ${f.modifiers ? `${f.modifiers} ` : ''}${f.type} ${f.name}${f.init ? ` = ${f.init}` : ''}`;

/** The class card of the paper's S context: declaration, fields, literals, methods count. */
export function classCard(c: JavaClass, rel: string, methodCount: number): string {
  const out = [`### ${rel}::${c.name}  (${c.kind}, lines ${c.line}-${c.endLine})`];
  out.push(`Declaration: ${classDeclaration(c)}${c.outer ? `  (nested in ${c.outer})` : ''}`);
  if (c.javadoc) { out.push(`Javadoc: ${c.javadoc}`); }
  out.push(`Methods: ${methodCount}`);
  out.push(c.fields.length ? `Fields (${c.fields.length}):\n${c.fields.map(fieldLine).join('\n')}` : 'Fields: none');
  if (c.literals.length) {
    out.push(`String literals naming a URL, an asset or a file (${c.literals.length}):\n`
      + c.literals.map((l) => `- L${l.line} ${l.why} ${l.text}`).join('\n'));
  }
  return out.join('\n');
}

const targetIds = (index: GraphIndex, s: JavaSite) => s.targets.map((t) => index.byRaw.get(t)?.id ?? t);

/** One line per call site of a method, linked or not. */
export function siteLines(index: GraphIndex, facts: JavaFacts, sym: Sym): string[] {
  return (facts.sitesByCaller.get(sym.rawId) ?? []).map((s) => {
    const status = s.targets.length ? `-> ${targetIds(index, s).join(', ')}` : `not linked: ${s.reason ?? 'no-definition'}`;
    return `- L${s.line}  ${siteText(s)}  [${status}]`;
  });
}

/** Signature, body range and Javadoc of a Java method, or nothing for other languages. */
export function methodLines(facts: JavaFacts, sym: Sym): string[] {
  const m = facts.methodById.get(sym.rawId);
  if (!m) { return []; }
  const lines = [
    `Signature: ${m.annotations.length ? `${m.annotations.join(' ')} ` : ''}${m.signature}${m.abstract ? '  [abstract]' : ''}`,
    `Body: lines ${sym.line}-${m.endLine}`,
    `Javadoc: ${m.javadoc || 'none'}`,
  ];
  const reads = staticReads(facts, m.reads);
  if (reads.length) { lines.push(`Static fields read (${reads.length}):\n${reads.join('\n')}`); }
  return lines;
}

/**
 * `Class.CONSTANT` reads of project classes, each with its declared initialiser when the name
 * is unique; reads of library classes (`Color.RED`) are left out.
 */
function staticReads(facts: JavaFacts, reads: string[]): string[] {
  const out: string[] = [];
  for (const r of [...reads].sort(ordinal)) {
    const [cls, field] = r.split('.');
    const owners = facts.classesByName.get(cls) ?? [];
    if (!owners.length) { continue; }
    const decl = owners.length === 1 ? owners[0].fields.find((f) => f.name === field) : undefined;
    out.push(`- ${r}${decl ? `  (${decl.type}${decl.init ? ` = ${decl.init}` : ''})` : ''}`);
  }
  return out;
}

const tsvCell = (v: string | number) => String(v).replace(/[\t\r\n]+/g, ' ');
const tsv = (rows: Array<Array<string | number>>) => rows.map((r) => r.map(tsvCell).join('\t')).join('\n');

/**
 * The interim export's columns come first (rel, line, col, caller, kind = call / new / ctor,
 * receiver, method, args), so its readers keep working; CoGraph's resolver adds form and reason.
 */
const SITE_HEAD = ['rel', 'line', 'col', 'caller', 'kind', 'receiver', 'method', 'args'];

function siteRow(root: string, index: GraphIndex, s: JavaSite): Array<string | number> {
  const kind = s.form === 'new' ? 'new' : s.form.startsWith('ctor-') ? 'ctor' : 'call';
  const method = kind === 'new' ? s.name.replace(/^new /, '') : s.name;
  return [relOf(root, s.file), s.line, s.col, index.byRaw.get(s.caller)?.id ?? s.caller, kind, s.receiver, method, s.args];
}

/** callsites.tsv: every Java call site; linked 1 or 0, with its targets or the reason it has none. */
export function callSitesTsv(root: string, index: GraphIndex, facts: JavaFacts): string {
  const rows = facts.sites.map((s) => [...siteRow(root, index, s), s.targets.length ? 1 : 0, s.form, s.reason ?? '', targetIds(index, s).join(' ')]);
  return tsv([[...SITE_HEAD, 'linked', 'form', 'reason', 'targets'], ...rows]);
}

/** unresolved.tsv: the call sites the analyser saw but did not link. */
export function unresolvedTsv(root: string, index: GraphIndex, facts: JavaFacts): string {
  const rows = facts.sites.filter((s) => s.targets.length === 0).map((s) => [...siteRow(root, index, s), s.form, s.reason ?? 'no-definition']);
  return tsv([[...SITE_HEAD, 'form', 'reason'], ...rows]);
}

const classOf = (facts: JavaFacts, rel: string, name: string | undefined) =>
  name ? (facts.classesByRel.get(rel) ?? []).find((c) => c.name === name) : undefined;

/** nodes.tsv: classes (also those without methods), methods with their end lines, library nodes. */
export function nodesTsv(root: string, index: GraphIndex, facts: JavaFacts): string {
  const rows: Array<Array<string | number>> = [];
  for (const c of facts.classes) {
    const rel = relOf(root, c.file);
    rows.push([`${rel}::${c.name}`, c.kind, rel, c.name, c.name, c.line, c.endLine, c.extends, c.implements.join(',')]);
  }
  for (const s of index.symbols) {
    if (s.isLibrary) { rows.push([s.id, 'library', '', '', s.name, '', '', '', '']); continue; }
    if (!s.rel || s.language !== 'java') { continue; }
    const c = classOf(facts, s.rel, s.className);
    rows.push([s.id, s.name === 'constructor' ? 'constructor' : 'method', s.rel, s.className ?? '', s.name, s.line,
      facts.methodById.get(s.rawId)?.endLine ?? s.line, c?.extends ?? '', c ? c.implements.join(',') : '']);
  }
  rows.sort((a, b) => ordinal(String(a[2]), String(b[2])) || Number(a[5]) - Number(b[5]) || ordinal(String(a[0]), String(b[0])));
  return tsv([['id', 'kind', 'rel', 'class', 'name', 'line', 'end_line', 'extends', 'implements'], ...rows]);
}

/** literals.tsv: URL, asset and file-argument literals with the method, class or file that holds them. */
export function literalsTsv(root: string, index: GraphIndex, facts: JavaFacts): string {
  const rows = facts.literals.map((l) => {
    const rel = relOf(root, l.file);
    const owner = l.method ? index.byRaw.get(l.method)?.id ?? `${rel}::${l.cls ?? ''}` : l.cls ? `${rel}::${l.cls}` : rel;
    return [rel, l.line, owner, l.why, l.text];
  });
  return tsv([['rel', 'line', 'owner', 'why', 'literal'], ...rows]);
}

/**
 * signatures.tsv: declarations of classes and signatures of methods, with Javadoc. The interim
 * export's paper role tags (its `annotations_or_roles` for classes) are experiment design and not
 * computed here; the column holds a method's annotations and stays empty for classes.
 */
export function signaturesTsv(root: string, index: GraphIndex, facts: JavaFacts): string {
  const rows: Array<Array<string | number>> = [];
  for (const c of facts.classes) {
    const rel = relOf(root, c.file);
    rows.push([`${rel}::${c.name}`, c.kind, c.modifiers.includes('abstract') ? 1 : 0, c.modifiers.join(' '), '', classDeclaration(c), c.javadoc]);
  }
  for (const s of index.symbols) {
    const m = s.rel ? facts.methodById.get(s.rawId) : undefined;
    if (!m) { continue; }
    rows.push([s.id, s.name === 'constructor' ? 'constructor' : 'method', m.abstract ? 1 : 0, m.modifiers.join(' '), m.annotations.join(' '), m.signature, m.javadoc]);
  }
  rows.sort((a, b) => ordinal(String(a[0]), String(b[0])));
  return tsv([['id', 'kind', 'abstract', 'modifiers', 'annotations_or_roles', 'signature_or_declaration', 'javadoc'], ...rows]);
}

export { tsv };
