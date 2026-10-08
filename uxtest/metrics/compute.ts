// PURE layout metrics: Snapshot in, numbers out. No DOM, no Playwright, no I/O —
// unit-tested with hand-built snapshots (uxtest/unit/compute.test.ts).
import type { LayoutMetrics, Rect, SnapNode, Snapshot } from './types';

const TOL = 0.5;        // px of slack before two shapes count as overlapping
const WALL_EPS = 1;     // px: a node this close to the clamp wall is "pinned" (B2)

export interface ComputeOpts { maxCrossingEdges?: number; maxOverlapNodes?: number; seed?: number }

/** Small deterministic PRNG so edge sampling is reproducible across runs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rectsIntersect(a: Rect, b: Rect, tol = TOL): boolean {
  return a.x + a.w - tol > b.x && b.x + b.w - tol > a.x && a.y + a.h - tol > b.y && b.y + b.h - tol > a.y;
}

export function pointInRect(x: number, y: number, r: Rect, tol = TOL): boolean {
  return x >= r.x - tol && x <= r.x + r.w + tol && y >= r.y - tol && y <= r.y + r.h + tol;
}

/** Bucket items by grid cell so pair tests stay near-linear. */
function gridPairs<T>(items: T[], box: (t: T) => Rect, cell: number, test: (a: T, b: T) => boolean): Array<[number, number]> {
  const grid = new Map<string, number[]>();
  const pairs: Array<[number, number]> = [];
  const seen = new Set<number>();
  items.forEach((it, i) => {
    const b = box(it);
    const x0 = Math.floor(b.x / cell), x1 = Math.floor((b.x + b.w) / cell);
    const y0 = Math.floor(b.y / cell), y1 = Math.floor((b.y + b.h) / cell);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = gx + ':' + gy;
        const bucket = grid.get(key);
        if (!bucket) { grid.set(key, [i]); continue; }
        for (const j of bucket) {
          const id = j * items.length + i;
          if (!seen.has(id) && test(items[j], it)) { seen.add(id); pairs.push([j, i]); }
        }
        bucket.push(i);
      }
    }
  });
  return pairs;
}

export function nodeOverlapPairs(nodes: SnapNode[]): Array<[number, number]> {
  if (nodes.length < 2) { return []; }
  const maxR = nodes.reduce((m, n) => Math.max(m, n.r), 1);
  return gridPairs(nodes, n => ({ x: n.x - n.r, y: n.y - n.r, w: 2 * n.r, h: 2 * n.r }), Math.max(8, maxR * 4),
    (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - TOL);
}

export function rectOverlapPairs(rects: Rect[]): Array<[number, number]> {
  if (rects.length < 2) { return []; }
  const cell = Math.max(32, rects.reduce((m, r) => Math.max(m, r.w, r.h), 0) / 2);
  return gridPairs(rects, r => r, cell, (a, b) => rectsIntersect(a, b));
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) { const k = key(it); const g = m.get(k); if (g) { g.push(it); } else { m.set(k, [it]); } }
  return m;
}

export interface ContainmentCounts { outsideSlot: number; pokingOut: number; outsideFrame: number; pinned: number }

export function containment(snap: Snapshot): ContainmentCounts {
  const slotByKey = new Map(snap.slots.map(s => [s.frame + '\0' + s.key, s]));
  const frameByPath = new Map(snap.frames.map(f => [f.path, f]));
  const c: ContainmentCounts = { outsideSlot: 0, pokingOut: 0, outsideFrame: 0, pinned: 0 };
  for (const n of snap.nodes) {
    const f = n.frame ? frameByPath.get(n.frame) : undefined;
    if (f && !pointInRect(n.x, n.y, f.rect)) { c.outsideFrame++; }
    const s = n.frame && n.slot ? slotByKey.get(n.frame + '\0' + n.slot) : undefined;
    if (!s) { continue; }
    if (!pointInRect(n.x, n.y, s.rect)) { c.outsideSlot++; continue; }
    const r = s.rect;
    if (n.x - n.r < r.x - TOL || n.x + n.r > r.x + r.w + TOL || n.y - n.r < r.y - TOL || n.y + n.r > r.y + r.h + TOL) { c.pokingOut++; }
    if (isPinned(n, s.interior)) { c.pinned++; }
  }
  return c;
}

/** Resting against the clamp wall: the circle touches an interior edge (± WALL_EPS). */
export function isPinned(n: SnapNode, interior: Rect): boolean {
  if (interior.w <= 2 * n.r + 2 * WALL_EPS || interior.h <= 2 * n.r + 2 * WALL_EPS) { return false; } // slot too tight to tell
  const gaps = [n.x - n.r - interior.x, interior.x + interior.w - (n.x + n.r), n.y - n.r - interior.y, interior.y + interior.h - (n.y + n.r)];
  return gaps.some(g => Math.abs(g) <= WALL_EPS);
}

export function edgeLengthStats(snap: Snapshot): { mean: number; cv: number } {
  if (!snap.edges.length) { return { mean: 0, cv: 0 }; }
  const lens = snap.edges.map(([a, b]) => Math.hypot(snap.nodes[a].x - snap.nodes[b].x, snap.nodes[a].y - snap.nodes[b].y));
  const mean = lens.reduce((s, v) => s + v, 0) / lens.length;
  const variance = lens.reduce((s, v) => s + (v - mean) ** 2, 0) / lens.length;
  return { mean, cv: mean > 0 ? Math.sqrt(variance) / mean : 0 };
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
}

/** Proper crossing of two segments (shared endpoints and touching do not count). */
export function segmentsCross(p1: SnapNode, p2: SnapNode, p3: SnapNode, p4: SnapNode): boolean {
  const d1 = orient(p3.x, p3.y, p4.x, p4.y, p1.x, p1.y), d2 = orient(p3.x, p3.y, p4.x, p4.y, p2.x, p2.y);
  const d3 = orient(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y), d4 = orient(p1.x, p1.y, p2.x, p2.y, p4.x, p4.y);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function sampleEdges(edges: Array<[number, number]>, max: number, seed: number): Array<[number, number]> {
  if (edges.length <= max) { return edges; }
  const rng = mulberry32(seed);
  const idx = edges.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, max).map(i => edges[i]);
}

export function edgeCrossings(snap: Snapshot, max: number, seed: number): { crossings: number; sampled: number } {
  const es = sampleEdges(snap.edges, max, seed);
  let crossings = 0;
  for (let i = 0; i < es.length; i++) {
    for (let j = i + 1; j < es.length; j++) {
      const [a, b] = es[i], [c, d] = es[j];
      if (a === c || a === d || b === c || b === d) { continue; }
      if (segmentsCross(snap.nodes[a], snap.nodes[b], snap.nodes[c], snap.nodes[d])) { crossings++; }
    }
  }
  return { crossings, sampled: es.length };
}

export function labelOverlapRatio(labels: Rect[]): number {
  if (labels.length < 2) { return 0; }
  const hit = new Set<number>();
  for (const [a, b] of rectOverlapPairs(labels)) { hit.add(a); hit.add(b); }
  return hit.size / labels.length;
}

export function bboxOf(nodes: SnapNode[]): Rect {
  if (!nodes.length) { return { x: 0, y: 0, w: 0, h: 0 }; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
    x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function viewportCoverage(snap: Snapshot, bbox: Rect): number {
  const { k, x, y } = snap.zoom;
  const l = Math.max(0, bbox.x * k + x), t = Math.max(0, bbox.y * k + y);
  const r = Math.min(snap.viewport.w, (bbox.x + bbox.w) * k + x), b = Math.min(snap.viewport.h, (bbox.y + bbox.h) * k + y);
  const area = snap.viewport.w * snap.viewport.h;
  return area > 0 && r > l && b > t ? ((r - l) * (b - t)) / area : 0;
}

const round = (v: number, d = 3): number => +v.toFixed(d);

export function median(xs: number[]): number {
  if (!xs.length) { return 0; }
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

export const SMALL_BOX_PX = 40;

export function legibility(snap: Snapshot): { nodePxMedian: number; labelPxMedian: number; smallBoxShare: number } {
  const boxes = (snap.boxes ?? []).filter(b => b.w < snap.viewport.w * 0.98 || b.h < snap.viewport.h * 0.98); // not the root box
  return {
    nodePxMedian: median(snap.nodes.map(n => n.r)) * snap.zoom.k,
    labelPxMedian: median(snap.labels.map(l => l.h)),
    smallBoxShare: boxes.length ? boxes.filter(b => b.w < SMALL_BOX_PX || b.h < SMALL_BOX_PX).length / boxes.length : 0,
  };
}

/** Territory conflicts between folders: intersection area of box pairs that are not nested by path, over the
 *  total box area. Boxes without a path (old snapshots) are ignored; nested folders legitimately overlap. */
export function folderOverlapRatio(boxes: Array<Rect & { path?: string }>): number {
  const bs = boxes.filter(b => !!b.path && b.w > 0 && b.h > 0);
  const total = bs.reduce((s, b) => s + b.w * b.h, 0);
  if (bs.length < 2 || total <= 0) { return 0; }
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const nested = (a: string, b: string): boolean => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  let overlap = 0;
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      if (nested(norm(bs[i].path as string), norm(bs[j].path as string))) { continue; }
      const w = Math.min(bs[i].x + bs[i].w, bs[j].x + bs[j].w) - Math.max(bs[i].x, bs[j].x);
      const h = Math.min(bs[i].y + bs[i].h, bs[j].y + bs[j].h) - Math.max(bs[i].y, bs[j].y);
      if (w > 0 && h > 0) { overlap += w * h; }
    }
  }
  return Math.min(1, overlap / total);
}

export function offscreenRatio(snap: Snapshot): number {
  if (!snap.nodes.length) { return 0; }
  const { k, x, y } = snap.zoom;
  const off = snap.nodes.filter(n => !pointInRect(n.x * k + x, n.y * k + y, { x: 0, y: 0, w: snap.viewport.w, h: snap.viewport.h }, 0)).length;
  return off / snap.nodes.length;
}

/** Frames/slots only describe the picture while the shelf engine is drawing it;
 *  under the global engine state.frames is stale and must not be scored. */
export function forEngine(snap: Snapshot): Snapshot {
  if (snap.engine === 'shelf' && snap.viewMode !== 'workflow') { return snap; } // the workflow view is not drawn by the frames engine
  return { ...snap, frames: [], slots: [], nodes: snap.nodes.map(n => ({ ...n, frame: null, slot: null })) };
}

export function computeMetrics(raw: Snapshot, opts: ComputeOpts = {}): LayoutMetrics {
  const snap = forEngine(raw);
  const capped = snap.nodes.length > (opts.maxOverlapNodes ?? 6000) ? snap.nodes.slice(0, opts.maxOverlapNodes ?? 6000) : snap.nodes;
  const pairs = nodeOverlapPairs(capped);
  const involved = new Set<number>();
  for (const [a, b] of pairs) { involved.add(a); involved.add(b); }
  const c = containment(snap);
  let frameOverlapPairs = 0;
  for (const sibs of groupBy(snap.frames.filter(f => f.kind !== 'root'), f => f.parent ?? '').values()) {
    frameOverlapPairs += rectOverlapPairs(sibs.map(f => f.rect)).length;
  }
  let slotOverlapPairs = 0;
  for (const ss of groupBy(snap.slots, s => s.frame).values()) { slotOverlapPairs += rectOverlapPairs(ss.map(s => s.rect)).length; }
  const len = edgeLengthStats(snap);
  const cross = edgeCrossings(snap, opts.maxCrossingEdges ?? 2000, opts.seed ?? 1);
  const bbox = bboxOf(snap.nodes);
  const leg = legibility(raw); // boxes are DOM-measured, valid under either engine
  const ink = snap.nodes.reduce((s, n) => s + Math.PI * n.r * n.r, 0);
  return {
    nodes: snap.nodes.length, edges: snap.edges.length, frames: snap.frames.length, slots: snap.slots.length,
    nodeOverlapPairs: pairs.length,
    nodeOverlapRatio: capped.length ? round(involved.size / capped.length) : 0,
    nodesOutsideSlot: c.outsideSlot, nodesPokingOutOfSlot: c.pokingOut,
    nodesOutsideFrame: c.outsideFrame, nodesPinnedToWall: c.pinned,
    frameOverlapPairs, slotOverlapPairs,
    edgeLenMean: round(len.mean, 1), edgeLenCv: round(len.cv),
    edgeCrossingsPerEdge: cross.sampled ? round(cross.crossings / cross.sampled) : 0, edgesSampled: cross.sampled,
    labels: snap.labels.length, labelOverlapRatio: round(labelOverlapRatio(snap.labels)),
    bboxAspect: bbox.h > 0 ? round(bbox.w / bbox.h, 2) : 0,
    inkRatio: bbox.w * bbox.h > 0 ? round(ink / (bbox.w * bbox.h), 4) : 0,
    viewportCoverage: round(viewportCoverage(snap, bbox)),
    offscreenNodeRatio: round(offscreenRatio(snap)),
    nodePxMedian: round(leg.nodePxMedian, 2), labelPxMedian: round(leg.labelPxMedian, 2), smallBoxShare: round(leg.smallBoxShare),
    folderOverlapRatio: round(folderOverlapRatio(raw.boxes ?? [])),
    domNodes: snap.domNodes, heapMB: snap.heapMB,
    maxMarkerPx: raw.maxMarkerPx, maxMarkerId: raw.maxMarkerId, markerLines: raw.markerLines, slotsOverName: raw.slotsOverName,
  };
}

/** Largest displacement between two snapshots for nodes accepted by `filter` (H4 / R5). */
export function maxDisplacement(before: Snapshot, after: Snapshot, filter: (n: SnapNode) => boolean = () => true): { max: number; moved: number } {
  const prev = new Map(before.nodes.map(n => [n.id, n]));
  let max = 0, moved = 0;
  for (const n of after.nodes) {
    const p = prev.get(n.id);
    if (!p || !filter(n)) { continue; }
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d > TOL) { moved++; }
    if (d > max) { max = d; }
  }
  return { max: round(max, 2), moved };
}
