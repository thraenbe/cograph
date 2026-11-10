import * as path from 'path';
import { formatImpact, formatOverview, formatSource, formatSymbol, formatWalk, NO_CAPS, symbolLine } from '../mcp/format';
import type { GraphIndex } from '../mcp/graphIndex';
import type { Sym } from '../mcp/ids';
import { overviewOf } from '../mcp/overview';
import { byLocation, impactOf, isLocal, walk, type Reached } from '../mcp/queries';
import { readSlice } from '../mcp/sourceSlice';
import { ordinal } from '../mcp/compare';
import type { SourceFile } from './analyze';
import type { Resolved } from './entries';
import type { JavaFacts } from './javaFacts';
import { Pages, relPathFile, symbolPath } from './output';
import { callSitesTsv, classCard, literalsTsv, methodLines, nodesTsv, signaturesTsv, siteLines, tsv, unresolvedTsv } from './renderJava';

export interface RenderOptions {
  depth: number;
  source: boolean;
  /** null = a symbol file for every function. */
  symbols: Sym[] | null;
  features: Array<{ name: string; entries: Resolved[] }>;
}

const ALL = Number.MAX_SAFE_INTEGER;
/** First lines of every page. */
const header = (title: string) => `# ${title}\n\nCoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).`;
/** A `##` section with its body. */
const section = (title: string, body: string) => `\n## ${title}\n\n${body}`;

/**
 * Class cards of a file (only those in `only` when given): from the Java facts, or from what
 * the graph knows about each class for the other languages.
 */
function classCards(root: string, index: GraphIndex, facts: JavaFacts, rel: string, only?: Set<string>): string[] {
  const cards = (facts.classesByRel.get(rel) ?? []).filter((c) => !only || only.has(`${rel}::${c.name}`));
  if (cards.length) {
    return cards.map((c) => classCard(c, rel, (index.byFile.get(rel) ?? []).filter((s) => isLocal(s) && s.className === c.name).length));
  }
  // Languages without Java facts: what the graph knows about each class.
  const names = [...new Set((index.byFile.get(rel) ?? []).filter((s) => isLocal(s) && s.className).map((s) => s.className as string))].sort(ordinal);
  return names.filter((n) => !only || only.has(`${rel}::${n}`)).map((n) => {
    const syms = (index.byFile.get(rel) ?? []).filter((s) => isLocal(s) && s.className === n);
    const ext = syms.find((s) => s.classExtends)?.classExtends;
    return `### ${rel}::${n}\nDeclaration: class ${n}${ext ? ` extends ${ext}` : ''}\nMethods: ${syms.length}\nFields and literals: not extracted for this language.`;
  });
}

/** Callers or callees of s within depth, formatted as the MCP server does (callees include libraries). */
function walkText(index: GraphIndex, s: Sym, dir: 'callers' | 'callees', depth: number): string {
  return formatWalk(index, s, dir, depth, walk(index, s, dir, depth, ALL, dir === 'callees'));
}

/** Source slice of s up to the next function in its file, or '' for a symbol without a file. */
function sourceText(root: string, index: GraphIndex, s: Sym): string {
  if (!s.rel || !s.file) { return ''; }
  const next = index.byFile.get(s.rel)?.find((o) => o.line > s.line);
  return formatSource(readSlice(path.join(root, ...s.rel.split('/')), s.line, { maxLines: 400, nextStartLine: next?.line ?? null }), s);
}

/** symbols/<path>/<Class.method>.md: card, Java signature, callers and callees within depth, impact and call sites. */
function symbolPage(root: string, index: GraphIndex, facts: JavaFacts, s: Sym, o: RenderOptions): string {
  const parts = [header(s.id), formatSymbol(index, s, o.source ? sourceText(root, index, s) : '', ALL)];
  const m = methodLines(facts, s);
  if (m.length) { parts.push(`\n${m.join('\n')}`); }
  parts.push(section(`Callers within depth ${o.depth}`, walkText(index, s, 'callers', o.depth)));
  parts.push(section(`Callees within depth ${o.depth} (with libraries)`, walkText(index, s, 'callees', o.depth)));
  parts.push(section('Impact', formatImpact(index, s.id, impactOf(index, [s]), ALL, NO_CAPS)));
  if (facts.sites.length) {
    const sl = siteLines(index, facts, s);
    parts.push(section(`Call sites (${sl.length})`, sl.join('\n') || 'none'));
  }
  return parts.join('\n');
}

/** files/<path>.md: class cards, the function overview and each function's direct callers and callees. */
function filePage(root: string, index: GraphIndex, facts: JavaFacts, rel: string): string {
  const parts = [header(rel)];
  const cards = classCards(root, index, facts, rel);
  if (cards.length) { parts.push(section('Classes', cards.join('\n\n'))); }
  const fns = (index.byFile.get(rel) ?? []).filter(isLocal);
  parts.push(section('Functions', fns.length ? formatOverview(index, overviewOf(index, rel, 1), NO_CAPS) : 'none'));
  for (const s of fns) {
    const callers = walk(index, s, 'callers', 1, ALL, false).items;
    const callees = walk(index, s, 'callees', 1, ALL, true).items;
    /** One symbol line per item, or 'none'. */
    const list = (items: Reached[]) => (items.length ? items.map((r) => symbolLine(index, r.sym)).join('\n') : 'none');
    parts.push(`\n### ${s.id}\n\nCalled by (${callers.length}):\n${list(callers)}\n\nCalls (${callees.length}):\n${list(callees)}`);
  }
  return parts.join('\n');
}

/** Union of the seeds' callers or callees within depth, nearest distance first, seeds left out. */
function neighbourhood(index: GraphIndex, seeds: Sym[], dir: 'callers' | 'callees', depth: number): Reached[] {
  const seedIds = new Set(seeds.map((s) => s.rawId));
  const near = new Map<string, Reached>();
  for (const s of seeds) {
    for (const it of walk(index, s, dir, depth, ALL, dir === 'callees').items) {
      if (seedIds.has(it.sym.rawId)) { continue; }
      const prev = near.get(it.sym.rawId);
      if (!prev || it.depth < prev.depth) { near.set(it.sym.rawId, { sym: it.sym, depth: it.depth, via: s }); }
    }
  }
  return [...near.values()].sort((a, b) => a.depth - b.depth || byLocation(a.sym, b.sym));
}

/**
 * features/<name>.md: the entries, their class cards, the entry functions with call sites, the
 * callers and callees around them (entries left out) and the combined impact.
 */
function featurePage(root: string, index: GraphIndex, facts: JavaFacts, name: string, entries: Resolved[], o: RenderOptions): string {
  const seedMap = new Map<string, Sym>();
  const classes = new Set<string>();
  for (const r of entries) { r.seeds.forEach((s) => seedMap.set(s.rawId, s)); r.classes.forEach((c) => classes.add(c)); }
  const seeds = [...seedMap.values()].sort(byLocation);
  const parts = [header(`Feature ${name}`)];
  parts.push(section(`Entries (${entries.length})`, entries.map((r) => `- ${r.entry}  (${r.kind}, ${r.seeds.length} fn)`).join('\n')));
  const rels = [...new Set([...classes].map((k) => k.slice(0, k.lastIndexOf('::'))))].sort(ordinal);
  const cards = rels.flatMap((rel) => classCards(root, index, facts, rel, classes));
  if (cards.length) { parts.push(section(`Classes (${cards.length})`, cards.join('\n\n'))); }
  const seedBlocks = seeds.map((s) => {
    const lines = [`### ${s.id}`, '', formatSymbol(index, s, o.source ? sourceText(root, index, s) : '', ALL)];
    const m = methodLines(facts, s);
    if (m.length) { lines.push('', ...m); }
    if (facts.sites.length) { const sl = siteLines(index, facts, s); lines.push('', `Call sites (${sl.length}):`, sl.join('\n') || 'none'); }
    return lines.join('\n');
  });
  parts.push(section(`Functions (${seeds.length})`, seedBlocks.join('\n\n') || 'none'));
  for (const dir of ['callers', 'callees'] as const) {
    const near = neighbourhood(index, seeds, dir, o.depth);
    const title = dir === 'callers' ? `Callers within depth ${o.depth}, outside the entries` : `Callees within depth ${o.depth}, outside the entries (with libraries)`;
    parts.push(section(`${title} (${near.length})`, near.map((r) => symbolLine(index, r.sym, `  ${r.depth} hop(s) from ${r.via?.id}`)).join('\n') || 'none'));
  }
  if (seeds.length) { parts.push(section('Impact', formatImpact(index, `feature ${name}`, impactOf(index, seeds), ALL, NO_CAPS))); }
  return parts.join('\n');
}

/** Edge and call-site counts per language and per file (the analyser's coverage at a glance). */
function edgesReport(index: GraphIndex, files: SourceFile[], facts: JavaFacts, runs: Array<{ language: string; stats?: Record<string, number> }>): string {
  const rows: Array<Array<string | number>> = [];
  const totals = new Map<string, number[]>();
  for (const f of files) {
    const fns = (index.byFile.get(f.rel) ?? []).filter(isLocal);
    let out = 0; let inn = 0; let lib = 0; let noCaller = 0; let sites = 0; let unlinked = 0;
    for (const s of fns) {
      for (const t of index.callees.get(s.rawId) ?? []) { if (index.byRaw.get(t)?.isLibrary) { lib++; } else { out++; } }
      const c = index.callers.get(s.rawId)?.size ?? 0;
      inn += c;
      if (c === 0) { noCaller++; }
      for (const st of facts.sitesByCaller.get(s.rawId) ?? []) { sites++; if (!st.targets.length) { unlinked++; } }
    }
    const java = f.language === 'java';
    rows.push([f.rel, fns.length, out, inn, lib, noCaller, java ? sites : '-', java ? unlinked : '-']);
    const t = totals.get(f.language) ?? [0, 0, 0, 0, 0, 0, 0, 0];
    [1, fns.length, out, inn, lib, noCaller, sites, unlinked].forEach((v, i) => { t[i] += v; });
    totals.set(f.language, t);
  }
  /** One Markdown table row. */
  const md = (r: Array<string | number>) => `| ${r.join(' | ')} |`;
  const head = '| Language | Files | Functions | Internal edges | Library edges | Functions without callers | Call sites | Not linked |\n|---|---|---|---|---|---|---|---|';
  const langRows = [...totals].map(([l, t]) => md([l, t[0], t[1], t[2], t[4], t[5], l === 'java' ? t[6] : '-', l === 'java' ? t[7] : '-']));
  const reasons = new Map<string, number>();
  for (const s of facts.sites) { if (!s.targets.length) { const r = s.reason ?? 'no-definition'; reasons.set(r, (reasons.get(r) ?? 0) + 1); } }
  const parts = [header('Edges and call sites'), section('Per language', `${head}\n${langRows.join('\n')}`)];
  if (reasons.size) {
    parts.push(section('Java call sites without an edge, by reason', [...reasons].sort((a, b) => b[1] - a[1] || ordinal(a[0], b[0])).map(([r, n]) => `- ${r}: ${n}`).join('\n')));
  }
  const stats = runs.filter((r) => r.stats).map((r) => `- ${r.language}: ${Object.entries(r.stats ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (stats.length) { parts.push(section('Analyser counters', stats.join('\n'))); }
  parts.push(section('Per file', '| File | Functions | Edges out | Edges in | Library edges out | Without callers | Call sites | Not linked |\n|---|---|---|---|---|---|---|---|\n'
    + rows.map(md).join('\n')));
  return parts.join('\n');
}

/** edges.tsv: every resolved edge once, by caller and callee id. */
function edgesTsv(index: GraphIndex): string {
  const rows: string[][] = [];
  for (const [from, tos] of index.callees) {
    const s = index.byRaw.get(from);
    if (!s) { continue; }
    for (const t of tos) { const c = index.byRaw.get(t); if (c) { rows.push([s.id, c.id, c.isLibrary ? 'library' : 'internal']); } }
  }
  rows.sort((a, b) => ordinal(a[0], b[0]) || ordinal(a[1], b[1]));
  return tsv([['caller', 'callee', 'kind'], ...rows]);
}

/**
 * Paths that differ only in case (`K.Beta.md`, `K.beta.md`; legal names on Linux) would overwrite
 * each other on macOS and Windows. The first in ordinal order keeps its name, the others get
 * `-C2`, `-C3`, ... before the extension, so the mapping is deterministic and one to one.
 */
export function caseSafe(paths: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const p of paths) { const k = p.toLowerCase(); groups.set(k, [...(groups.get(k) ?? []), p]); }
  const rename = new Map<string, string>();
  for (const list of groups.values()) {
    const distinct = [...new Set(list)].sort(ordinal);
    distinct.forEach((p, i) => { if (i > 0) { rename.set(p, p.replace(/(\.[^./]+)$/, `-C${i + 1}$1`)); } });
  }
  return paths.map((p) => rename.get(p) ?? p);
}

/** Every page except README.md and manifest.json. */
export function renderPages(root: string, index: GraphIndex, files: SourceFile[], facts: JavaFacts,
  runs: Array<{ language: string; stats?: Record<string, number> }>, o: RenderOptions): Pages {
  const pages = new Pages();
  const javaClasses = [...facts.classesByRel].flatMap(([rel, cs]) => cs.map((c) => `- ${rel}::${c.name}${c.extends ? ` extends ${c.extends}` : ''}${c.implements.length ? ` implements ${c.implements.join(', ')}` : ''}`));
  pages.put('overview.md', [header('Overview'), formatOverview(index, overviewOf(index, undefined, 3), NO_CAPS),
    javaClasses.length ? `\nJava classes (${javaClasses.length}):\n${javaClasses.join('\n')}` : ''].join('\n'));
  pages.put('edges.md', edgesReport(index, files, facts, runs));
  pages.put('edges.tsv', edgesTsv(index));
  if (facts.sites.length) {
    pages.put('callsites.tsv', callSitesTsv(root, index, facts));
    pages.put('unresolved.tsv', unresolvedTsv(root, index, facts));
  }
  if (facts.classes.length) {
    pages.put('nodes.tsv', nodesTsv(root, index, facts));
    pages.put('literals.tsv', literalsTsv(root, index, facts));
    pages.put('signatures.tsv', signaturesTsv(root, index, facts));
  }
  const filePaths = caseSafe(files.map((f) => relPathFile('files', f.rel)));
  files.forEach((f, i) => pages.put(filePaths[i], filePage(root, index, facts, f.rel)));
  const syms = (o.symbols ?? index.symbols.filter(isLocal)).slice().sort(byLocation);
  const symPaths = caseSafe(syms.map(symbolPath));
  syms.forEach((s, i) => pages.put(symPaths[i], symbolPage(root, index, facts, s, o)));
  for (const f of o.features) { pages.put(relPathFile('features', f.name), featurePage(root, index, facts, f.name, f.entries, o)); }
  return pages;
}
