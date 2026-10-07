import * as fs from 'fs';
import * as path from 'path';
import type { GraphData, GraphNode } from '../../graphProvider';
import { relPath } from './treeAnalysis';

/**
 * Structural diff of two analysed trees: which functions a change adds, removes
 * or alters, which call edges appear or vanish, and who calls what changed.
 *
 * Keys are repository-relative POSIX path + (class.)name, never node ids (ids
 * embed the absolute path and the line, which differ between any two trees), so
 * a diff is meaningful without either tree on disk and serialises as it is.
 * "Changed" is decided by the function's source text, not by line numbers: the
 * text from its definition line to the next definition in the file, trailing
 * blank lines dropped. Two definitions of one name in one file are matched in
 * line order. No vscode import.
 */

export interface DiffTree {
  root: string;
  sha?: string;
  graph: GraphData;
}

export type FunctionChangeKind = 'added' | 'removed' | 'changed' | 'moved';

export interface FunctionChange {
  key: string;
  file: string;
  name: string;
  className?: string;
  kind: FunctionChangeKind;
  baseLine?: number;
  headLine?: number;
}

export interface EdgeChange {
  source: string;
  target: string;
  kind: 'added' | 'removed';
}

/** Who calls a function that the change touched: in the head for added / changed, in the base for removed. */
export interface Impact {
  key: string;
  kind: Exclude<FunctionChangeKind, 'moved'>;
  callers: string[];
}

export interface StructuralDiff {
  base: { sha?: string; functions: number; files: number };
  head: { sha?: string; functions: number; files: number };
  files: { added: string[]; removed: string[] };
  functions: FunctionChange[];
  edges: EdgeChange[];
  impact: Impact[];
  summary: {
    added: number; removed: number; changed: number; moved: number;
    edgesAdded: number; edgesRemoved: number; callersAffected: number;
  };
}

export interface DiffOptions {
  /** Read a source file; null when unreadable. Default: the file system. */
  readFile?: (absPath: string) => string | null;
}

interface Keyed {
  key: string;
  file: string;
  name: string;
  className?: string;
  line: number;
  node: GraphNode;
}

interface Indexed {
  byKey: Map<string, Keyed>;
  keyById: Map<string, string>;
  /** rel file → its functions in line order */
  byFile: Map<string, Keyed[]>;
  files: Set<string>;
}

function readFromDisk(absPath: string): string | null {
  try { return fs.readFileSync(absPath, 'utf8'); } catch { return null; }
}

function libraryKey(n: GraphNode): string {
  return `lib:${n.libraryName ?? ''}:${n.name}`;
}

/** Key every function node; library nodes key by library + name. */
function index(tree: DiffTree): Indexed {
  const byKey = new Map<string, Keyed>();
  const keyById = new Map<string, string>();
  const byFile = new Map<string, Keyed[]>();
  const files = new Set<string>();
  for (const f of tree.graph.files ?? []) {
    const rel = relPath(tree.root, f);
    if (rel) { files.add(rel); }
  }
  const pending: Array<{ n: GraphNode; file: string; base: string }> = [];
  for (const n of tree.graph.nodes) {
    if (n.isLibrary) { keyById.set(n.id, libraryKey(n)); continue; }
    if (!n.file) { continue; }
    const file = relPath(tree.root, n.file);
    if (!file) { continue; }
    files.add(file);
    pending.push({ n, file, base: `${file}::${n.className ? n.className + '.' : ''}${n.name}` });
  }
  // Line order decides the ordinal of a name defined more than once in a file.
  pending.sort((a, b) => a.file.localeCompare(b.file) || a.n.line - b.n.line);
  const seen = new Map<string, number>();
  for (const { n, file, base } of pending) {
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    const key = ordinal === 0 ? base : `${base}#${ordinal + 1}`;
    const k: Keyed = { key, file, name: n.name, className: n.className, line: n.line, node: n };
    byKey.set(key, k);
    keyById.set(n.id, key);
    let list = byFile.get(file);
    if (!list) { list = []; byFile.set(file, list); }
    list.push(k);
  }
  return { byKey, keyById, byFile, files };
}

/** A function's source: from its definition line to the line before the next definition, trailing blanks dropped. */
function functionText(tree: DiffTree, fnsInFile: Keyed[], i: number, cache: Map<string, string[] | null>, read: (p: string) => string | null): string | null {
  const k = fnsInFile[i];
  let lines = cache.get(k.file);
  if (lines === undefined) {
    const text = read(path.join(tree.root, ...k.file.split('/')));
    lines = text === null ? null : text.split(/\r?\n/);
    cache.set(k.file, lines);
  }
  if (!lines) { return null; }
  // fnsInFile is in line order: the next definition on a later line ends this one.
  let next: Keyed | undefined;
  for (let j = i + 1; j < fnsInFile.length; j++) { if (fnsInFile[j].line > k.line) { next = fnsInFile[j]; break; } }
  const end = next ? next.line - 1 : lines.length;
  const slice = lines.slice(Math.max(0, k.line - 1), end).map(l => l.replace(/\s+$/, ''));
  while (slice.length && slice[slice.length - 1] === '') { slice.pop(); }
  return slice.join('\n');
}

function edgeKeys(tree: DiffTree, idx: Indexed): Map<string, { source: string; target: string }> {
  const out = new Map<string, { source: string; target: string }>();
  for (const e of tree.graph.edges) {
    const source = idx.keyById.get(e.source);
    const target = idx.keyById.get(e.target);
    if (source && target) { out.set(`${source} -> ${target}`, { source, target }); }
  }
  return out;
}

/** A change record without `undefined` fields, so the diff is the same before and after JSON. */
function change(k: Keyed, kind: FunctionChangeKind, lines: { baseLine?: number; headLine?: number }): FunctionChange {
  const out: FunctionChange = { key: k.key, file: k.file, name: k.name, kind };
  if (k.className) { out.className = k.className; }
  if (lines.baseLine !== undefined) { out.baseLine = lines.baseLine; }
  if (lines.headLine !== undefined) { out.headLine = lines.headLine; }
  return out;
}

export function diffGraphs(base: DiffTree, head: DiffTree, opts: DiffOptions = {}): StructuralDiff {
  const read = opts.readFile ?? readFromDisk;
  const b = index(base);
  const h = index(head);
  const baseCache = new Map<string, string[] | null>();
  const headCache = new Map<string, string[] | null>();

  const functions: FunctionChange[] = [];
  for (const [key, hk] of h.byKey) {
    const bk = b.byKey.get(key);
    if (!bk) {
      functions.push(change(hk, 'added', { headLine: hk.line }));
      continue;
    }
    const bl = b.byFile.get(bk.file) ?? [];
    const hl = h.byFile.get(hk.file) ?? [];
    const before = functionText(base, bl, bl.indexOf(bk), baseCache, read);
    const after = functionText(head, hl, hl.indexOf(hk), headCache, read);
    // Unreadable on either side: say nothing rather than guess.
    if (before === null || after === null) { continue; }
    if (before !== after) {
      functions.push(change(hk, 'changed', { baseLine: bk.line, headLine: hk.line }));
    } else if (bk.line !== hk.line) {
      functions.push(change(hk, 'moved', { baseLine: bk.line, headLine: hk.line }));
    }
  }
  for (const [key, bk] of b.byKey) {
    if (!h.byKey.has(key)) {
      functions.push(change(bk, 'removed', { baseLine: bk.line }));
    }
  }
  functions.sort((x, y) => x.file.localeCompare(y.file) || (x.headLine ?? x.baseLine ?? 0) - (y.headLine ?? y.baseLine ?? 0) || x.key.localeCompare(y.key));

  const baseEdges = edgeKeys(base, b);
  const headEdges = edgeKeys(head, h);
  const edges: EdgeChange[] = [];
  for (const [k, e] of headEdges) { if (!baseEdges.has(k)) { edges.push({ ...e, kind: 'added' }); } }
  for (const [k, e] of baseEdges) { if (!headEdges.has(k)) { edges.push({ ...e, kind: 'removed' }); } }
  edges.sort((x, y) => x.source.localeCompare(y.source) || x.target.localeCompare(y.target) || x.kind.localeCompare(y.kind));

  const callersIn = (map: Map<string, { source: string; target: string }>): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const e of map.values()) {
      if (e.source === e.target) { continue; }
      let s = out.get(e.target);
      if (!s) { s = new Set(); out.set(e.target, s); }
      s.add(e.source);
    }
    return out;
  };
  const headCallers = callersIn(headEdges);
  const baseCallers = callersIn(baseEdges);
  const impact: Impact[] = [];
  const affected = new Set<string>();
  for (const f of functions) {
    if (f.kind === 'moved') { continue; }
    const callers = [...((f.kind === 'removed' ? baseCallers : headCallers).get(f.key) ?? [])].sort();
    for (const c of callers) { affected.add(c); }
    impact.push({ key: f.key, kind: f.kind, callers });
  }

  const filesAdded = [...h.files].filter(f => !b.files.has(f)).sort();
  const filesRemoved = [...b.files].filter(f => !h.files.has(f)).sort();
  const count = (kind: FunctionChangeKind) => functions.filter(f => f.kind === kind).length;
  const side = (sha: string | undefined, idx: Indexed) => ({ ...(sha ? { sha } : {}), functions: idx.byKey.size, files: idx.files.size });
  return {
    base: side(base.sha, b),
    head: side(head.sha, h),
    files: { added: filesAdded, removed: filesRemoved },
    functions,
    edges,
    impact,
    summary: {
      added: count('added'), removed: count('removed'), changed: count('changed'), moved: count('moved'),
      edgesAdded: edges.filter(e => e.kind === 'added').length,
      edgesRemoved: edges.filter(e => e.kind === 'removed').length,
      callersAffected: affected.size,
    },
  };
}
