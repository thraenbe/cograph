import * as path from 'path';
import type { GraphData } from './graphProvider';
import type { StructureTree } from './structureScanner';

/**
 * Scope model for subgraphs and "Only visualize folder". Pure: no vscode import,
 * no I/O. The host keeps the FULL graph and filters what it posts through here.
 *
 * Paths in a spec are workspace-relative POSIX ('.' = the workspace root), the
 * same convention as annotations. The verdict for a folder comes from its nearest
 * listed ancestor (or itself): listed in `include` → in, in `exclude` → out;
 * nothing listed → in only when `include` is empty (no scope at all).
 * v1 is include-only: `exclude` is carried and honoured so the format is stable,
 * but nothing in the UI writes it yet.
 */

export interface ScopeSpec {
  /** Folders (with their descendants) in the view; [] = whole project. */
  include: string[];
  /** Carve-outs inside an included folder. Always present, [] in v1. */
  exclude: string[];
}

export type ScopeSource = 'none' | 'folder' | 'subgraph';

export interface Scope {
  spec: ScopeSpec;
  source: ScopeSource;
  /** Saved-graph name; null for an unsaved "Only visualize folder" view. */
  name: string | null;
}

/** Wire shape of the host → webview `subgraph` message (agreed with session-111). */
export interface SubgraphMessage {
  type: 'subgraph';
  name: string | null;
  root: string;
  include: string[];
  exclude: string[];
}

export const NO_SCOPE: Scope = { spec: { include: [], exclude: [] }, source: 'none', name: null };

export function hasScope(scope: Scope): boolean {
  return scope.spec.include.length > 0;
}

/** Workspace-relative POSIX key for an absolute path; the root itself is ".". */
export function toRel(root: string, abs: string): string {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  return rel === '' || rel === '.' ? '.' : rel;
}

export function toAbs(root: string, rel: string): string {
  return rel === '.' ? root : path.join(root, ...rel.split('/'));
}

/** Clean a user- or file-supplied relative folder path into the canonical key. */
export function cleanRel(p: string): string {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '').replace(/^\/+/, '');
  return s === '' || s === '.' ? '.' : s;
}

function isSelfOrDescendant(rel: string, ancestor: string): boolean {
  return ancestor === '.' || rel === ancestor || rel.startsWith(ancestor + '/');
}

/** The listed entry (from include or exclude) closest to `rel`, or null. */
function nearestListed(spec: ScopeSpec, rel: string): { entry: string; included: boolean } | null {
  let best: { entry: string; included: boolean } | null = null;
  const consider = (entry: string, included: boolean) => {
    if (!isSelfOrDescendant(rel, entry)) { return; }
    if (!best || entry.length > best.entry.length) { best = { entry, included }; }
  };
  for (const e of spec.include) { consider(e, true); }
  for (const e of spec.exclude) { consider(e, false); }
  return best;
}

/** Is the folder `rel` (workspace-relative POSIX) part of the view? */
export function isIncluded(spec: ScopeSpec, rel: string): boolean {
  if (spec.include.length === 0) { return true; }
  const hit = nearestListed(spec, cleanRel(rel));
  return hit ? hit.included : false;
}

/** Is the file `relFile` part of the view? Its folder decides. */
export function fileInScope(spec: ScopeSpec, relFile: string): boolean {
  if (spec.include.length === 0) { return true; }
  const r = cleanRel(relFile);
  const slash = r.lastIndexOf('/');
  return isIncluded(spec, slash < 0 ? '.' : r.slice(0, slash));
}

/**
 * Canonical form: cleaned, deduped, sorted, and without entries whose verdict is
 * already implied by their nearest listed ancestor. Idempotent. Saved specs and
 * everything posted to the webview are normalized.
 */
export function normalize(spec: Partial<ScopeSpec> | null | undefined): ScopeSpec {
  const inc = uniqSorted((spec?.include ?? []).map(cleanRel));
  const exc = uniqSorted((spec?.exclude ?? []).map(cleanRel));
  if (inc.length === 0) { return { include: [], exclude: [] }; } // no scope: carve-outs are meaningless
  const draft: ScopeSpec = { include: inc, exclude: exc };
  const keep = (entry: string, included: boolean) => {
    const parent = entry === '.' ? null : (entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '.');
    if (parent === null) { return included; } // the root itself: an include is meaningful, an exclude never is
    const hit = nearestListed(draft, parent);
    const parentVerdict = hit ? hit.included : false;
    return parentVerdict !== included; // redundant when the parent already says the same
  };
  return {
    include: inc.filter(e => keep(e, true)),
    exclude: exc.filter(e => keep(e, false)),
  };
}

function uniqSorted(items: string[]): string[] {
  return [...new Set(items)].sort();
}

/** A spec that shows exactly one folder. */
export function specForFolder(rel: string): ScopeSpec {
  return normalize({ include: [cleanRel(rel)], exclude: [] });
}

export function withFolderIncluded(spec: ScopeSpec, rel: string): ScopeSpec {
  const r = cleanRel(rel);
  return normalize({ include: [...spec.include, r], exclude: spec.exclude.filter(e => !isSelfOrDescendant(e, r)) });
}

export function withFolderExcluded(spec: ScopeSpec, rel: string): ScopeSpec {
  const r = cleanRel(rel);
  // Drop includes inside the folder; if the folder itself was directly included, that is enough.
  const include = spec.include.filter(e => !isSelfOrDescendant(e, r));
  const stillIn = isIncluded({ include, exclude: spec.exclude }, r);
  return normalize({ include, exclude: stillIn ? [...spec.exclude, r] : spec.exclude });
}

/** Maximal excluded subtrees (the shortest excluded paths), for a Filters list. */
export function excludedTops(spec: ScopeSpec, tree: StructureTree, root: string): Array<{ path: string; fileCount: number }> {
  if (spec.include.length === 0) { return []; }
  const out: Array<{ path: string; fileCount: number }> = [];
  const visit = (abs: string) => {
    const folder = tree.folders[abs];
    if (!folder) { return; }
    if (!isIncluded(spec, toRel(root, abs))) { out.push({ path: abs, fileCount: folder.fileCount }); return; }
    for (const child of folder.childFolders) { visit(child); }
  };
  if (tree.root) { visit(tree.root); }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Files of the tree that the scope keeps (absolute paths). */
export function filesInScope(spec: ScopeSpec, tree: StructureTree, root: string): string[] {
  if (spec.include.length === 0) { return tree.files.map(f => f.path); }
  return tree.files.map(f => f.path).filter(abs => fileInScope(spec, toRel(root, abs)));
}

/**
 * The part of a graph the scope keeps: nodes whose file is in scope, library nodes
 * only while an in-scope node still points at them, edges with both ends kept.
 */
export function filterGraph(graph: GraphData, spec: ScopeSpec, root: string): GraphData {
  if (spec.include.length === 0) { return graph; }
  const keep = new Set<string>();
  const libs = new Map<string, boolean>();
  for (const n of graph.nodes) {
    if (n.isLibrary) { libs.set(n.id, false); continue; }
    if (!n.file || fileInScope(spec, toRel(root, n.file))) { keep.add(n.id); }
  }
  for (const e of graph.edges) {
    if (keep.has(e.source) && libs.has(e.target)) { libs.set(e.target, true); }
  }
  for (const [id, used] of libs) { if (used) { keep.add(id); } }
  return {
    ...graph,
    nodes: graph.nodes.filter(n => keep.has(n.id)),
    edges: graph.edges.filter(e => keep.has(e.source) && keep.has(e.target)),
    ...(graph.files ? { files: graph.files.filter(f => fileInScope(spec, toRel(root, f))) } : {}),
  };
}

/**
 * The slice of a graph that belongs to `files` (absolute paths): their nodes, the
 * library nodes they reference, and the edges among all of those. Used to bring a
 * folder into a scoped view from the cache without re-parsing it.
 */
export function graphForFiles(graph: GraphData, files: Iterable<string>): GraphData {
  const want = new Set(files);
  const keep = new Set<string>();
  const libs = new Set<string>();
  for (const n of graph.nodes) {
    if (n.isLibrary) { libs.add(n.id); } else if (n.file && want.has(n.file)) { keep.add(n.id); }
  }
  for (const e of graph.edges) { if (keep.has(e.source) && libs.has(e.target)) { keep.add(e.target); } }
  return {
    nodes: graph.nodes.filter(n => keep.has(n.id)),
    edges: graph.edges.filter(e => keep.has(e.source) && keep.has(e.target)),
  };
}

/** Git statuses are keyed by absolute POSIX file path; keep only in-scope files. */
export function filterFileStatuses<T>(statuses: Record<string, T>, spec: ScopeSpec, root: string): Record<string, T> {
  if (spec.include.length === 0) { return statuses; }
  const out: Record<string, T> = {};
  for (const [file, status] of Object.entries(statuses)) {
    if (fileInScope(spec, toRel(root, file))) { out[file] = status; }
  }
  return out;
}

/** Absolute file paths reduced to the ones the scope keeps (for expand-folder / re-parse). */
export function filterFiles(files: string[], spec: ScopeSpec, root: string): string[] {
  if (spec.include.length === 0) { return files; }
  return files.filter(f => fileInScope(spec, toRel(root, f)));
}

export function buildSubgraphMessage(scope: Scope, root: string): SubgraphMessage {
  const spec = normalize(scope.spec);
  return { type: 'subgraph', name: scope.name, root, include: spec.include, exclude: spec.exclude };
}

/** Read a `subgraph` field from a saved-graph file; null when absent or unusable. */
export function readSubgraphField(data: unknown): ScopeSpec | null {
  const raw = (data as { subgraph?: unknown })?.subgraph;
  if (!raw || typeof raw !== 'object') { return null; }
  const inc = (raw as { include?: unknown }).include;
  if (!Array.isArray(inc) || !inc.every(x => typeof x === 'string')) { return null; }
  const exc = (raw as { exclude?: unknown }).exclude;
  const spec = normalize({ include: inc, exclude: Array.isArray(exc) ? exc.filter((x): x is string => typeof x === 'string') : [] });
  return spec.include.length ? spec : null;
}
