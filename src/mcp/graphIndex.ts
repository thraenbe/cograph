import * as fs from 'fs';
import { cachePath, diffManifest, readCacheFile, type Manifest } from '../cacheStore';
import { annotationsPath, loadAnnotations } from '../graphIntelligence/annotationStore';
import type { AnnotationFile } from '../graphIntelligence/annotationTypes';
import { scanStructure } from '../structureScanner';
import { assignIds, splitLine, toSym, type Sym } from './ids';
import { ToolError } from './paths';

/** Everything the tools query, built once per cache file version. Pure data, no I/O after build. */
export interface GraphIndex {
  root: string;
  savedAt: string;
  symbols: Sym[];
  byRaw: Map<string, Sym>;
  byId: Map<string, Sym>;
  byBase: Map<string, Sym[]>;
  /** `<relPath>::<name>` without the class, so a guessed `file::method` still resolves. */
  byLoose: Map<string, Sym[]>;
  /** Workspace-relative file → its symbols sorted by line. */
  byFile: Map<string, Sym[]>;
  /** rawId → rawIds of direct callers / callees (deduplicated, no self loops). */
  callers: Map<string, Set<string>>;
  callees: Map<string, Set<string>>;
  annotations: AnnotationFile;
  manifest: Manifest;
}

function link(map: Map<string, Set<string>>, from: string, to: string): void {
  const set = map.get(from);
  if (set) { set.add(to); } else { map.set(from, new Set([to])); }
}

export function buildIndex(root: string, data: NonNullable<ReturnType<typeof readCacheFile>>,
  annotations: AnnotationFile): GraphIndex {
  const symbols = data.graph.nodes.map((n) => toSym(root, n));
  const byBase = assignIds(symbols);
  const byRaw = new Map(symbols.map((s) => [s.rawId, s]));
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const byFile = new Map<string, Sym[]>();
  for (const s of symbols) {
    if (!s.rel) { continue; }
    const list = byFile.get(s.rel);
    if (list) { list.push(s); } else { byFile.set(s.rel, [s]); }
  }
  for (const list of byFile.values()) { list.sort((a, b) => a.line - b.line); }
  const byLoose = new Map<string, Sym[]>();
  for (const s of symbols) {
    if (!s.rel || !s.className) { continue; }
    const k = `${s.rel}::${s.name}`;
    const list = byLoose.get(k);
    if (list) { list.push(s); } else { byLoose.set(k, [s]); }
  }
  const callers = new Map<string, Set<string>>();
  const callees = new Map<string, Set<string>>();
  for (const e of data.graph.edges) {
    if (e.source === e.target || !byRaw.has(e.source) || !byRaw.has(e.target)) { continue; }
    link(callees, e.source, e.target);
    link(callers, e.target, e.source);
  }
  return {
    root, savedAt: data.savedAt, symbols, byRaw, byId, byBase, byLoose, byFile, callers, callees,
    annotations, manifest: data.manifest,
  };
}

/**
 * Resolve an agent-supplied id. Accepts the agent id, the raw cache id, or `<base>:<line>`
 * where the line drifted since the id was handed out (nearest line wins). A bare base that
 * names several functions is an error that lists them, never a guess.
 */
export function resolveSymbol(index: GraphIndex, input: string): Sym {
  const key = input.trim();
  const exact = index.byId.get(key) ?? index.byRaw.get(key);
  if (exact) { return exact; }
  const { base, line } = splitLine(key);
  const candidates = index.byBase.get(base) ?? index.byLoose.get(base) ?? [];
  if (candidates.length === 1) { return candidates[0]; }
  if (candidates.length > 1 && line !== null) {
    return candidates.reduce((best, s) => (Math.abs(s.line - line) < Math.abs(best.line - line) ? s : best));
  }
  if (candidates.length > 1) {
    const list = candidates.slice(0, 10).map((s) => `  ${s.id}`).join('\n');
    throw new ToolError(`"${input}" names ${candidates.length} functions. Use one of:\n${list}`);
  }
  throw new ToolError(`No function with id "${input}". Use find_symbol to look it up by name.`);
}

/** True when this source file's mtime differs from the analysis manifest (lines may have shifted). */
export function fileChangedSinceAnalysis(index: GraphIndex, absFile: string): boolean {
  try { return fs.statSync(absFile).mtimeMs !== index.manifest[absFile]; } catch { return true; }
}

export interface Staleness {
  changed: number;
  removed: number;
}

const STALE_CHECK_MS = 5000;

/**
 * Holds the index for one workspace and keeps it current: the cache file's mtime is checked on
 * every call (the extension rewrites it after each analysis), staleness against the source files
 * at most every few seconds. Never throws; a missing or broken cache yields `null`.
 */
export class IndexHolder {
  private index: GraphIndex | null = null;
  private cacheMtime = -1;
  private annotationsMtime = -1;
  private stale: Staleness | null = null;
  private staleCheckedAt = 0;

  constructor(readonly root: string, private readonly now: () => number = Date.now) {}

  get(): GraphIndex | null {
    let mtime: number;
    try { mtime = fs.statSync(cachePath(this.root)).mtimeMs; } catch { this.reset(); return null; }
    if (mtime !== this.cacheMtime || !this.index) {
      const data = readCacheFile(this.root);
      this.index = data ? buildIndex(this.root, data, loadAnnotations(this.root)) : null;
      this.annotationsMtime = -1;
      this.cacheMtime = data ? mtime : -1;
      this.stale = null;
    }
    this.refreshAnnotations();
    return this.index;
  }

  /** Annotate Graph rewrites its file without touching the graph cache, so it is tracked on its own. */
  private refreshAnnotations(): void {
    if (!this.index) { return; }
    let mtime = 0;
    try { mtime = fs.statSync(annotationsPath(this.root)).mtimeMs; } catch { /* none yet */ }
    if (mtime !== this.annotationsMtime) {
      this.index.annotations = loadAnnotations(this.root);
      this.annotationsMtime = mtime;
    }
  }

  staleness(): Staleness | null {
    const index = this.index;
    if (!index) { return null; }
    if (this.stale && this.now() - this.staleCheckedAt < STALE_CHECK_MS) { return this.stale; }
    try {
      const { changed, removed } = diffManifest(index.manifest, scanStructure(this.root));
      this.stale = { changed: changed.length, removed: removed.length };
    } catch {
      this.stale = null;
    }
    this.staleCheckedAt = this.now();
    return this.stale;
  }

  private reset(): void {
    this.index = null;
    this.cacheMtime = -1;
    this.annotationsMtime = -1;
    this.stale = null;
  }
}
