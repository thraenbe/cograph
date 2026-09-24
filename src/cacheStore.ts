import * as fs from 'fs';
import * as path from 'path';
import type { GraphData } from './graphProvider';
import type { StructureTree } from './structureScanner';

/**
 * On-disk analysis cache so re-opening a large repo is near-instant. Keyed by a
 * manifest of {file: mtimeMs} for every scanned source file; a stat sweep (no
 * reads, no parsing) decides validity. Lives in the already-gitignored .cograph/.
 * All operations are best-effort — a cache problem must never break the graph.
 */

const SCHEMA_VERSION = 1;
const CACHE_DIR = '.cograph';
const CACHE_FILE = 'graph-cache.json';

type Manifest = Record<string, number>; // absPath → mtimeMs

interface CacheFile {
  schemaVersion: number;
  savedAt: string;
  manifest: Manifest;
  graph: GraphData;
}

export interface CacheLoadResult {
  graph: GraphData;
  /** True when every scanned file matches the manifest (instant-load path). */
  valid: boolean;
  /** Files that are new or whose mtime changed since the cache was written. */
  changed: string[];
  /** Files in the manifest that no longer exist. */
  removed: string[];
}

function cachePath(root: string): string {
  return path.join(root, CACHE_DIR, CACHE_FILE);
}

function buildManifest(structure: StructureTree): Manifest {
  const manifest: Manifest = {};
  for (const f of structure.files) {
    try { manifest[f.path] = fs.statSync(f.path).mtimeMs; } catch { /* vanished — omit */ }
  }
  return manifest;
}

/**
 * Load the cache and diff it against the current on-disk structure. Returns null
 * on miss / corruption / schema mismatch. When `valid` is false, the cached
 * graph is still returned (for an instant paint) alongside the changed/removed
 * file lists so the caller can reconcile incrementally.
 */
export function loadCache(root: string, structure: StructureTree): CacheLoadResult | null {
  let parsed: CacheFile;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath(root), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !parsed.graph || !parsed.manifest) {
    return null;
  }

  const current = buildManifest(structure);
  const old = parsed.manifest;

  const changed: string[] = [];
  for (const p of Object.keys(current)) {
    if (old[p] === undefined || old[p] !== current[p]) { changed.push(p); }
  }
  const removed: string[] = [];
  for (const p of Object.keys(old)) {
    if (current[p] === undefined) { removed.push(p); }
  }

  return { graph: parsed.graph, valid: changed.length === 0 && removed.length === 0, changed, removed };
}

/** Persist the merged graph + a fresh mtime manifest. Atomic (temp + rename); never throws. */
export function writeCache(root: string, graph: GraphData, structure: StructureTree): void {
  if (!graph || graph.nodes.length === 0) { return; } // don't cache empty/failed results
  try {
    if (!fs.existsSync(root)) { return; } // never create a non-existent workspace root
    const dir = path.join(root, CACHE_DIR);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    const data: CacheFile = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      manifest: buildManifest(structure),
      graph,
    };
    const target = cachePath(root);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, target);
  } catch {
    /* cache write failure is non-fatal */
  }
}

// ── Asynchronous, coalesced writes (hot path) ────────────────────────────────
// writeCache() above blocks the extension host for a stat() per source file, a
// JSON.stringify of the whole graph and the file write — and it used to run
// BEFORE the graph was posted to the webview, after every analysis, folder
// expansion and single-file re-parse. scheduleCacheWrite() defers all of it,
// keeps only the newest request per workspace, and does the I/O with fs.promises.

const STAT_BATCH = 64;
const pendingWrites = new Map<string, { graph: GraphData; structure: StructureTree; timer: ReturnType<typeof setTimeout> }>();
const inFlight = new Set<Promise<void>>();

async function buildManifestAsync(structure: StructureTree): Promise<Manifest> {
  const manifest: Manifest = {};
  for (let i = 0; i < structure.files.length; i += STAT_BATCH) {
    await Promise.all(structure.files.slice(i, i + STAT_BATCH).map(async (f) => {
      try { manifest[f.path] = (await fs.promises.stat(f.path)).mtimeMs; } catch { /* vanished — omit */ }
    }));
  }
  return manifest;
}

/** Same result as writeCache(), without blocking. Never rejects. */
export async function writeCacheAsync(root: string, graph: GraphData, structure: StructureTree): Promise<void> {
  if (!graph || graph.nodes.length === 0) { return; }
  try {
    await fs.promises.access(root);              // never create a non-existent workspace root
    await fs.promises.mkdir(path.join(root, CACHE_DIR), { recursive: true });
    const data: CacheFile = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      manifest: await buildManifestAsync(structure),
      graph,
    };
    const target = cachePath(root);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fs.promises.rename(tmp, target);
  } catch {
    /* cache write failure is non-fatal */
  }
}

/** Debounced write: the newest graph per workspace root wins. */
export function scheduleCacheWrite(root: string, graph: GraphData, structure: StructureTree, delayMs = 250): void {
  const prev = pendingWrites.get(root);
  if (prev) { clearTimeout(prev.timer); }
  const timer = setTimeout(() => {
    pendingWrites.delete(root);
    const job = writeCacheAsync(root, graph, structure);
    inFlight.add(job);
    job.finally(() => inFlight.delete(job));
  }, delayMs);
  pendingWrites.set(root, { graph, structure, timer });
}

/** Run every pending write now and wait for all in-flight ones (deactivate / tests). */
export async function flushCacheWrites(): Promise<void> {
  for (const [root, p] of [...pendingWrites]) {
    clearTimeout(p.timer);
    pendingWrites.delete(root);
    const job = writeCacheAsync(root, p.graph, p.structure);
    inFlight.add(job);
    job.finally(() => inFlight.delete(job));
  }
  await Promise.all([...inFlight]);
}
