import type { Sym } from './ids';
import type { GraphIndex, Staleness } from './graphIndex';
import type { FolderNode, OverviewData } from './overview';
import { callerCount, calleeCount, type ImpactResult, type Reached, type WalkResult } from './queries';
import type { SliceResult } from './sourceSlice';

/** Hard cap per tool result (~5k tokens); Claude Code warns at 10k and cuts at 25k by default. */
export const MAX_RESULT_CHARS = 20_000;

export function location(s: Sym): string {
  if (s.isLibrary) { return `library ${s.libraryName ?? '?'}`; }
  if (s.isModule || !s.rel) { return 'module-level code'; }
  return `${s.rel}:${s.line}`;
}

/** One symbol per line: id, then where it is and its fan-in / fan-out. */
export function symbolLine(index: GraphIndex, s: Sym, extra = ''): string {
  const where = s.isLibrary || s.isModule ? `  (${location(s)})` : `  L${s.line}`;
  return `- ${s.id}${where}  ←${callerCount(index, s)} →${calleeCount(index, s)}${extra}`;
}

export function moreNote(shown: number, total: number, hint: string): string {
  return total > shown ? `\n… ${total - shown} more (${hint}).` : '';
}

export function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) { return 'at an unknown time'; }
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 1) { return 'just now'; }
  if (min < 90) { return `${min} min ago`; }
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

export function footer(index: GraphIndex, stale: Staleness | null, now: number): string {
  const base = `CoGraph graph analysed ${ago(index.savedAt, now)}`;
  if (!stale) { return `\n\n— ${base}.`; }
  const n = stale.changed + stale.removed;
  return n === 0
    ? `\n\n— ${base}; source files unchanged since.`
    : `\n\n— ${base}; STALE: ${n} source file(s) changed since. Open the project in VS Code with CoGraph to re-analyse.`;
}

/** Cut at a line boundary under the cap and say so. */
export function capText(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) { return text; }
  const cut = text.lastIndexOf('\n', max - 120);
  return `${text.slice(0, cut > 0 ? cut : max - 120)}\n… output truncated at ${max} characters; narrow the query or lower depth/limit.`;
}

export function formatFind(index: GraphIndex, query: string, items: Sym[], total: number): string {
  if (total === 0) { return `No function matches "${query}".`; }
  const lines = items.map((s) => symbolLine(index, s));
  return `${total} match(es) for "${query}" (id, line, ←callers →callees):\n${lines.join('\n')}${moreNote(items.length, total, 'raise limit or pass path')}`;
}

const ENDED = {
  detected: 'end detected', maxLines: 'TRUNCATED at maxLines', fallback: 'end not detected, cut before the next function', eof: 'reached end of file',
};

export function formatSource(slice: SliceResult | null, s: Sym, fileChanged = false): string {
  if (!slice) { return ''; }
  if (!slice.ok) { return `\n\nSource: unavailable (${slice.error}).`; }
  const drift = fileChanged ? '\nWARNING: this file changed since the analysis, so the line numbers may have shifted and this slice may not be the function.' : '';
  return `\n\nSource ${s.rel}:${slice.startLine}-${slice.endLine} (best-effort slice, ${ENDED[slice.endReason]}; read the file at this range before editing):${drift}\n\`\`\`\n${slice.source}\n\`\`\``;
}

function neighbourList(index: GraphIndex, title: string, raws: Set<string> | undefined, cap: number): string {
  const syms = [...(raws ?? [])].map((r) => index.byRaw.get(r)).filter((x): x is Sym => !!x);
  if (syms.length === 0) { return `\n\n${title}: none in the graph.`; }
  const shown = syms.slice(0, cap).map((s) => symbolLine(index, s));
  return `\n\n${title} (${syms.length}):\n${shown.join('\n')}${moreNote(shown.length, syms.length, 'use callers/callees with a limit')}`;
}

export function formatSymbol(index: GraphIndex, s: Sym, source: string, neighbourCap: number): string {
  const head = [`${s.id}`, `  where: ${location(s)}`];
  if (s.language) { head.push(`  language: ${s.language}`); }
  if (s.className) {
    const ext = s.classExtends ? ` extends ${s.classExtends}` : '';
    const impl = s.classImplements?.length ? ` implements ${s.classImplements.join(', ')}` : '';
    head.push(`  class: ${s.className}${ext}${impl}`);
  }
  const fileNote = s.rel ? index.annotations.files[s.rel]?.summary : undefined;
  if (fileNote) { head.push(`  file summary: ${fileNote}`); }
  return head.join('\n') + source
    + neighbourList(index, 'Called by', index.callers.get(s.rawId), neighbourCap)
    + neighbourList(index, 'Calls', index.callees.get(s.rawId), neighbourCap);
}

export function formatWalk(index: GraphIndex, s: Sym, dir: 'callers' | 'callees', depth: number, r: WalkResult): string {
  const verb = dir === 'callers' ? 'call' : 'are called by';
  if (r.total === 0) {
    return dir === 'callers'
      ? `Nothing in the graph calls ${s.id}. Static analysis misses dynamic dispatch, callbacks and reflection, so this is not proof it is unused.`
      : `${s.id} calls nothing that the analysis resolved.`;
  }
  const byDepth = new Map<number, Reached[]>();
  for (const it of r.items) { (byDepth.get(it.depth) ?? byDepth.set(it.depth, []).get(it.depth)!).push(it); }
  const parts = [`${r.total} function(s) within depth ${depth} ${verb} ${s.id}:`];
  for (const [d, items] of byDepth) {
    parts.push(`\ndepth ${d}:`);
    for (const it of items) { parts.push(symbolLine(index, it.sym, it.via ? `  via ${it.via.id}` : '')); }
  }
  let tail = moreNote(r.items.length, r.total, 'raise limit');
  if (r.maxDepthHit) { tail += `\nThe walk stopped at depth ${depth}; more lie beyond (max depth 5).`; }
  return parts.join('\n') + tail;
}

export function formatImpact(index: GraphIndex, label: string, r: ImpactResult, limit: number): string {
  if (r.affected.length === 0) {
    return `Nothing in the graph calls into ${label} (${r.seeds.length} function(s)). Static analysis misses dynamic dispatch, callbacks and reflection; check those before assuming it is safe.`;
  }
  const out = [`Changing ${label} (${r.seeds.length} function(s)) can affect ${r.affected.length} caller(s) in ${r.files.length} file(s), up to ${r.maxDepth} call(s) away.`];
  out.push('\nBy file (nearest first: file, functions affected, nearest distance):');
  const files = r.files.slice(0, 50).map((f) => `- ${f.rel}  ${f.count} fn, ${f.nearest} hop(s)`);
  out.push(files.join('\n') + moreNote(files.length, r.files.length, 'narrow the path'));
  if (r.tests.length) {
    out.push(`\nTests that reach it (${r.tests.length}):`);
    out.push(r.tests.slice(0, 25).map((s) => symbolLine(index, s)).join('\n') + moreNote(Math.min(25, r.tests.length), r.tests.length, 'see By file'));
  }
  if (r.entryPoints.length) {
    out.push(`\nEntry points on these call chains (nothing calls them) (${r.entryPoints.length}):`);
    out.push(r.entryPoints.slice(0, 15).map((s) => symbolLine(index, s)).join('\n') + moreNote(Math.min(15, r.entryPoints.length), r.entryPoints.length, 'narrow the path'));
  }
  out.push(`\nNearest callers (${Math.min(limit, r.affected.length)} of ${r.affected.length}):`);
  out.push(r.affected.slice(0, limit).map((a) => symbolLine(index, a.sym, `  ${a.depth} hop(s)`)).join('\n'));
  return out.join('\n');
}

function treeLines(n: FolderNode, indent: string, out: string[], maxChildren: number): void {
  const note = n.summary ? ` — ${n.summary}` : '';
  out.push(`${indent}${n.name}/  ${n.functions} fn in ${n.files} file(s)${note}`);
  for (const c of n.children.slice(0, maxChildren)) { treeLines(c, indent + '  ', out, maxChildren); }
  if (n.children.length > maxChildren) { out.push(`${indent}  … ${n.children.length - maxChildren} more folder(s)`); }
}

export function formatOverview(index: GraphIndex, o: OverviewData): string {
  const where = o.scope === '' ? 'workspace' : o.scope;
  if (o.functions === 0) { return `No analysed functions under ${where}.`; }
  const out = [`${where}: ${o.functions} function(s) in ${o.files} file(s).`];
  out.push(`Languages: ${o.languages.map((l) => `${l.language} ${l.functions}`).join(', ')}.`);
  if (o.isFile) {
    if (o.fileSummary) { out.push(`Summary: ${o.fileSummary}`); }
    out.push('\nFunctions (id, line, ←callers →callees):');
    out.push(o.fileFunctions.slice(0, 60).map((s) => symbolLine(index, s)).join('\n') + moreNote(Math.min(60, o.fileFunctions.length), o.fileFunctions.length, 'use find_symbol with path'));
  } else if (o.tree) {
    out.push('\nFolders (functions, files, AI summary if annotated):');
    const lines: string[] = [];
    treeLines(o.tree, '', lines, 15);
    out.push(lines.join('\n'));
  }
  if (!o.isFile && o.entryPoints.length) { out.push('\nEntry points (nothing calls them; tests excluded):'); out.push(o.entryPoints.map((s) => symbolLine(index, s)).join('\n')); }
  if (!o.isFile && o.hotSpots.length) { out.push('\nHot spots (most callers):'); out.push(o.hotSpots.map((s) => symbolLine(index, s)).join('\n')); }
  return out.join('\n');
}
