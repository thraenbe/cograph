import { displayName, type Sym } from './ids';
import type { GraphIndex } from './graphIndex';
import { confine, relPath, ToolError } from './paths';

/** Functions the agent can address: real code, not libraries or the module-level pseudo node. */
export function isLocal(s: Sym): boolean {
  return !s.isLibrary && !s.isModule && s.rel !== null;
}

export function callerCount(index: GraphIndex, s: Sym): number {
  return index.callers.get(s.rawId)?.size ?? 0;
}

export function calleeCount(index: GraphIndex, s: Sym): number {
  return index.callees.get(s.rawId)?.size ?? 0;
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*$|[._-](test|spec)\.[^/]+$|_test\.[^/]+$/i;

export function isTestPath(rel: string | null): boolean {
  return rel !== null && TEST_PATH.test(rel);
}

/** Workspace-relative POSIX scope for a `path` argument ('' = whole workspace). */
export function scopeOf(index: GraphIndex, input: string | undefined): string {
  if (!input) { return ''; }
  const rel = relPath(index.root, confine(index.root, input));
  return rel === '.' ? '' : rel;
}

export function inScope(rel: string | null, scope: string): boolean {
  if (rel === null) { return false; }
  return scope === '' || rel === scope || rel.startsWith(scope + '/');
}

function byLocation(a: Sym, b: Sym): number {
  return (a.rel ?? '').localeCompare(b.rel ?? '') || a.line - b.line;
}

// ── find_symbol ─────────────────────────────────────────────────────────────

export interface FindArgs { query: string; path?: string; limit: number; includeLibraries: boolean; }
export interface FindResult { total: number; items: Sym[]; }

function rank(s: Sym, q: string, ql: string): number {
  const full = displayName(s);
  if (full === q || s.name === q) { return 0; }
  const fl = full.toLowerCase();
  const nl = s.name.toLowerCase();
  if (fl === ql || nl === ql) { return 1; }
  if (fl.startsWith(ql) || nl.startsWith(ql)) { return 2; }
  if (fl.includes(ql)) { return 3; }
  return -1;
}

export function findSymbols(index: GraphIndex, args: FindArgs): FindResult {
  const q = args.query.trim();
  if (!q) { throw new ToolError('query must not be empty.'); }
  const exact = index.byId.get(q) ?? index.byRaw.get(q);
  if (exact && !exact.isModule) { return { total: 1, items: [exact] }; }
  const scope = scopeOf(index, args.path);
  const ql = q.toLowerCase();
  const hits: Array<{ s: Sym; r: number }> = [];
  for (const s of index.symbols) {
    if (s.isModule || (s.isLibrary && !args.includeLibraries)) { continue; }
    if (!s.isLibrary && !inScope(s.rel, scope)) { continue; }
    const r = rank(s, q, ql);
    if (r >= 0) { hits.push({ s, r }); }
  }
  hits.sort((a, b) => a.r - b.r || callerCount(index, b.s) - callerCount(index, a.s) || byLocation(a.s, b.s));
  return { total: hits.length, items: hits.slice(0, args.limit).map((h) => h.s) };
}

// ── callers / callees ───────────────────────────────────────────────────────

export interface Reached { sym: Sym; depth: number; via: Sym | null; }
export interface WalkResult { total: number; items: Reached[]; maxDepthHit: boolean; }
export type Direction = 'callers' | 'callees';

/** Breadth-first walk; cycles are visited once; `total` counts everything within `depth`. */
export function walk(index: GraphIndex, start: Sym, dir: Direction, depth: number,
  limit: number, includeLibraries: boolean): WalkResult {
  const edges = dir === 'callers' ? index.callers : index.callees;
  const seen = new Set<string>([start.rawId]);
  const out: Reached[] = [];
  let frontier: Sym[] = [start];
  let maxDepthHit = false;
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: Sym[] = [];
    const level: Reached[] = [];
    for (const from of frontier) {
      for (const raw of edges.get(from.rawId) ?? []) {
        const s = index.byRaw.get(raw);
        if (!s || seen.has(raw) || (s.isLibrary && !includeLibraries)) { continue; }
        seen.add(raw);
        level.push({ sym: s, depth: d, via: d === 1 ? null : from });
        next.push(s);
      }
    }
    level.sort((a, b) => byLocation(a.sym, b.sym));
    out.push(...level);
    frontier = next;
    if (d === depth && next.some((s) => (edges.get(s.rawId)?.size ?? 0) > 0)) { maxDepthHit = true; }
  }
  return { total: out.length, items: out.slice(0, limit), maxDepthHit };
}

// ── impact ──────────────────────────────────────────────────────────────────

export interface FileImpact { rel: string; count: number; nearest: number; }
export interface ImpactResult {
  seeds: Sym[];
  /** Transitive callers outside the seed set, nearest first. */
  affected: Reached[];
  files: FileImpact[];
  entryPoints: Sym[];
  tests: Sym[];
  maxDepth: number;
}

const IMPACT_DEPTH_CAP = 50;

export function seedsForPath(index: GraphIndex, input: string): Sym[] {
  const scope = scopeOf(index, input);
  const seeds = index.symbols.filter((s) => isLocal(s) && inScope(s.rel, scope));
  if (seeds.length === 0) { throw new ToolError(`No analysed functions under "${input}".`); }
  return seeds;
}

export function impactOf(index: GraphIndex, seeds: Sym[]): ImpactResult {
  const seen = new Set(seeds.map((s) => s.rawId));
  const affected: Reached[] = [];
  let frontier = seeds;
  let d = 0;
  while (frontier.length > 0 && d < IMPACT_DEPTH_CAP) {
    d++;
    const next: Sym[] = [];
    for (const from of frontier) {
      for (const raw of index.callers.get(from.rawId) ?? []) {
        const s = index.byRaw.get(raw);
        if (!s || seen.has(raw)) { continue; }
        seen.add(raw);
        affected.push({ sym: s, depth: d, via: from });
        next.push(s);
      }
    }
    frontier = next;
  }
  const files = new Map<string, FileImpact>();
  for (const r of affected) {
    const rel = r.sym.rel ?? '(module-level code)';
    const f = files.get(rel);
    if (f) { f.count++; f.nearest = Math.min(f.nearest, r.depth); } else { files.set(rel, { rel, count: 1, nearest: r.depth }); }
  }
  const tops = [...seeds, ...affected.map((r) => r.sym)].filter((s) => callerCount(index, s) === 0);
  return {
    seeds,
    affected,
    files: [...files.values()].sort((a, b) => a.nearest - b.nearest || b.count - a.count || a.rel.localeCompare(b.rel)),
    entryPoints: tops.filter((s) => !isTestPath(s.rel)).sort(byLocation),
    tests: affected.map((r) => r.sym).filter((s) => isTestPath(s.rel)).sort(byLocation),
    maxDepth: affected.reduce((m, r) => Math.max(m, r.depth), 0),
  };
}
