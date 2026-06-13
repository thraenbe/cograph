import type { GraphData, GraphEdge } from './graphProvider';

const edgeKey = (e: GraphEdge): string => `${e.source}|${e.target}|${e.isLibraryEdge ? 1 : 0}`;

/**
 * Merge `incoming` into `base` by node id (last-writer-wins) and deduplicated
 * edges, unioning the scanned-file lists. Used by subset/background analysis and
 * the re-open cache so partial results accumulate without losing prior data.
 * `base` is not mutated.
 */
export function mergeGraph(base: GraphData | undefined, incoming: GraphData): GraphData {
  if (!base) {
    return { nodes: [...incoming.nodes], edges: [...incoming.edges], files: [...(incoming.files ?? [])] };
  }
  const byId = new Map(base.nodes.map(n => [n.id, n]));
  for (const n of incoming.nodes) { byId.set(n.id, n); }

  const seen = new Set(base.edges.map(edgeKey));
  const edges = [...base.edges];
  for (const e of incoming.edges) {
    const k = edgeKey(e);
    if (!seen.has(k)) { seen.add(k); edges.push(e); }
  }

  const files = [...new Set([...(base.files ?? []), ...(incoming.files ?? [])])];
  return { nodes: [...byId.values()], edges, files };
}
