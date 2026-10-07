import type { Sym } from './ids';
import type { GraphIndex } from './graphIndex';
import { callerCount, calleeCount, inScope, isLocal, isTestPath, scopeOf } from './queries';

export interface FolderNode {
  rel: string;
  name: string;
  functions: number;
  files: number;
  summary?: string;
  children: FolderNode[];
}

export interface OverviewData {
  scope: string;
  isFile: boolean;
  functions: number;
  files: number;
  languages: Array<{ language: string; functions: number }>;
  tree: FolderNode | null;
  fileSummary?: string;
  fileFunctions: Sym[];
  entryPoints: Sym[];
  hotSpots: Sym[];
}

const TOP_N = 10;

function folderOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/** Folder tree of the scope, `depth` levels deep, with recursive function and file counts. */
function buildTree(index: GraphIndex, scope: string, syms: Sym[], depth: number): FolderNode {
  const nodes = new Map<string, FolderNode>();
  const get = (rel: string): FolderNode => {
    let n = nodes.get(rel);
    if (!n) {
      const summary = index.annotations.folders[rel === '' ? '.' : rel]?.summary;
      n = { rel, name: rel === '' ? '.' : rel.slice(rel.lastIndexOf('/') + 1), functions: 0, files: 0, summary, children: [] };
      nodes.set(rel, n);
    }
    return n;
  };
  const levels = (rel: string) => (rel === '' ? 0 : rel.split('/').length);
  const scopeDepth = levels(scope);
  const filesSeen = new Set<string>();
  for (const s of syms) {
    const rel = s.rel as string;
    const firstFile = !filesSeen.has(rel);
    filesSeen.add(rel);
    // Count into the file's folder and every ancestor up to the scope root, within `depth`.
    for (let f = folderOf(rel); ; f = folderOf(f)) {
      if (levels(f) - scopeDepth <= depth) {
        const n = get(f);
        n.functions++;
        if (firstFile) { n.files++; }
      }
      if (f === scope || f === '') { break; }
    }
  }
  for (const [rel, n] of nodes) {
    if (rel === scope) { continue; }
    nodes.get(folderOf(rel))?.children.push(n);
  }
  for (const n of nodes.values()) { n.children.sort((a, b) => b.functions - a.functions || a.name.localeCompare(b.name)); }
  return get(scope);
}

export function overviewOf(index: GraphIndex, path: string | undefined, depth: number): OverviewData {
  const scope = scopeOf(index, path);
  const isFile = index.byFile.has(scope);
  const syms = index.symbols.filter((s) => isLocal(s) && inScope(s.rel, scope));
  const langs = new Map<string, number>();
  for (const s of syms) { const l = s.language ?? 'unknown'; langs.set(l, (langs.get(l) ?? 0) + 1); }
  const rank = (a: Sym, b: Sym, f: (s: Sym) => number) => f(b) - f(a) || (a.rel ?? '').localeCompare(b.rel ?? '') || a.line - b.line;
  return {
    scope,
    isFile,
    functions: syms.length,
    files: new Set(syms.map((s) => s.rel)).size,
    languages: [...langs].map(([language, functions]) => ({ language, functions })).sort((a, b) => b.functions - a.functions),
    tree: isFile || syms.length === 0 ? null : buildTree(index, scope, syms, depth),
    fileSummary: isFile ? index.annotations.files[scope]?.summary : undefined,
    fileFunctions: isFile ? (index.byFile.get(scope) ?? []).filter(isLocal) : [],
    entryPoints: syms
      .filter((s) => callerCount(index, s) === 0 && calleeCount(index, s) > 0 && !isTestPath(s.rel))
      .sort((a, b) => rank(a, b, (s) => calleeCount(index, s))).slice(0, TOP_N),
    hotSpots: syms.filter((s) => callerCount(index, s) > 0)
      .sort((a, b) => rank(a, b, (s) => callerCount(index, s))).slice(0, TOP_N),
  };
}
