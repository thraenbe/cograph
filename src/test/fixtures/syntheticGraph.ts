import type { StructureTree, StructureFolder, StructureLanguage } from '../../structureScanner';
import type { GraphData, GraphNode, GraphEdge } from '../../graphProvider';

/**
 * Deterministic synthetic-repo generator for performance work (#50/#52).
 *
 * Emits the same shapes the real pipeline produces — a StructureTree matching
 * scanStructure()'s invariants and a GraphData payload — so a fixture can drive
 * both webview paths: post `structure` then `graph` (skeleton/drill-down), or
 * `graph` alone (flat renderGraph). Used by the unit tests and by the
 * `cograph.dev.loadSynthetic` command (gated on cograph.debug.perfLog).
 */

export interface SyntheticOpts {
  /** Total folders including the root (default 10). */
  folders?: number;
  /** Children per folder, filled breadth-first (default 3). */
  branching?: number;
  filesPerFolder?: number;
  fnsPerFile?: number;
  /** Total call edges (default: nodes × 1.5). */
  edges?: number;
  /** Fraction of edges with both endpoints in the same folder (default 0.95). */
  intraRatio?: number;
  seed?: number;
  root?: string;
  /** Cycled per file (default: ['typescript']). */
  languages?: StructureLanguage[];
}

/** Small deterministic PRNG (32-bit); same seed → same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EXT: Record<StructureLanguage, string> = {
  typescript: 'ts', javascript: 'js', python: 'py', java: 'java', cpp: 'cpp',
};

function dirOf(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.substring(0, idx) : '';
}

export function makeSyntheticRepo(o: SyntheticOpts = {}): {
  structure: StructureTree; graph: GraphData; fnCountByFile: Map<string, number>;
} {
  const folders = o.folders ?? 10;
  const branching = o.branching ?? 3;
  const filesPerFolder = o.filesPerFolder ?? 4;
  const fnsPerFile = o.fnsPerFile ?? 6;
  const intraRatio = o.intraRatio ?? 0.95;
  const root = o.root ?? '/r';
  const languages = o.languages ?? ['typescript'];
  const rng = mulberry32(o.seed ?? 1);

  // Folder tree, breadth-first fill: /r, /r/d0, /r/d1, …, /r/d0/dN, …
  const folderPaths: string[] = [root];
  const queue: string[] = [root];
  let di = 0;
  while (folderPaths.length < folders && queue.length) {
    const parent = queue.shift() as string;
    for (let k = 0; k < branching && folderPaths.length < folders; k++) {
      const child = `${parent}/d${di++}`;
      folderPaths.push(child);
      queue.push(child);
    }
  }
  const rootSegs = root.split('/').filter(Boolean).length;
  const folderMap: Record<string, StructureFolder> = {};
  for (const p of folderPaths) {
    folderMap[p] = {
      path: p,
      depth: p.split('/').filter(Boolean).length - rootSegs,
      parent: p === root ? null : dirOf(p),
      childFolders: [],
      files: [],
      fileCount: 0,
    };
  }
  for (const p of folderPaths) {
    if (p !== root) { folderMap[dirOf(p)].childFolders.push(p); }
  }

  // Files + function nodes.
  const files: StructureTree['files'] = [];
  const nodes: GraphNode[] = [];
  const nodesByFolder = new Map<string, GraphNode[]>();
  let fileIdx = 0;
  for (const p of folderPaths) {
    nodesByFolder.set(p, []);
    for (let f = 0; f < filesPerFolder; f++) {
      const language = languages[fileIdx % languages.length];
      const filePath = `${p}/f${f}.${EXT[language]}`;
      fileIdx++;
      folderMap[p].files.push(filePath);
      files.push({ path: filePath, language });
      for (let n = 0; n < fnsPerFile; n++) {
        const node: GraphNode = {
          id: `${filePath}::fn${n}`,
          name: `fn${n}`,
          file: filePath,
          line: n * 10 + 1,
          language,
        };
        nodes.push(node);
        (nodesByFolder.get(p) as GraphNode[]).push(node);
      }
      // Recursive fileCount, walking file dir → root (mirrors scanStructure).
      let cur = p;
      for (;;) {
        folderMap[cur].fileCount++;
        if (cur === root) { break; }
        cur = dirOf(cur);
      }
    }
  }

  // Edges: intraRatio of them stay inside the source's folder.
  const edgeTarget = o.edges ?? Math.round(nodes.length * 1.5);
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  let attempts = 0;
  while (edges.length < edgeTarget && attempts < edgeTarget * 10) {
    attempts++;
    const src = nodes[Math.floor(rng() * nodes.length)];
    const srcFolder = dirOf(src.file as string);
    let tgt: GraphNode;
    if (rng() < intraRatio) {
      const local = nodesByFolder.get(srcFolder) as GraphNode[];
      tgt = local[Math.floor(rng() * local.length)];
    } else {
      tgt = nodes[Math.floor(rng() * nodes.length)];
    }
    if (tgt.id === src.id) { continue; }
    const key = `${src.id}|${tgt.id}`;
    if (seen.has(key)) { continue; }
    seen.add(key);
    edges.push({ source: src.id, target: tgt.id, isLibraryEdge: false });
  }

  const fnCountByFile = new Map<string, number>();
  for (const n of nodes) { fnCountByFile.set(n.file as string, (fnCountByFile.get(n.file as string) ?? 0) + 1); }

  const structure: StructureTree = { root, folders: folderMap, files, totalFiles: files.length };
  const graph: GraphData = { nodes, edges, files: files.map(f => f.path) };
  return { structure, graph, fnCountByFile };
}
