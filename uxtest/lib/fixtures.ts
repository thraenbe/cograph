// Deterministic host-side fixtures derived from an analyzed repo: workflow
// metadata, timeline history, and a legacy (v1) saved layout.
import type { AnalyzedRepo } from './analyze';
import type { GraphLite, GraphNodeLite } from '../harness/fakeHost';

const fns = (repo: AnalyzedRepo): GraphNodeLite[] => repo.graph.nodes.filter(n => !n.isLibrary && n.file);

/** A workflow graph (AI pipeline view) over the first `max` functions: 6 stages, 3 tiers. */
export function workflowGraph(repo: AnalyzedRepo, max = 120): GraphLite {
  const STAGES = 6;
  const picked = fns(repo).slice(0, max);
  const ids = new Set(picked.map(n => n.id));
  const tierOf = (stage: number): string => (stage < 3 ? 'backend' : stage < 5 ? 'shared' : 'frontend');
  const nodes = picked.map((n, i) => {
    const stage = i % STAGES;
    return { ...n, workflow: { rank: i, stage, tier: tierOf(stage), cluster: `c${stage}`, clusterName: `Stage ${stage + 1}`,
      isEntry: i === 0, isOutput: i === picked.length - 1 } };
  });
  return {
    nodes,
    edges: repo.graph.edges.filter(e => ids.has(e.source) && ids.has(e.target)),
    files: repo.graph.files,
    workflow: { stageCount: STAGES, dividerStage: 3, generatedAt: '2026-01-01T00:00:00.000Z',
      clusters: Array.from({ length: STAGES }, (_, s) => ({ id: `c${s}`, name: `Stage ${s + 1}`, tier: tierOf(s), stage: s })) },
  };
}

/** `timeline-data` entries: one function introduced per simulated day, in graph order. */
export function timelineEntries(repo: AnalyzedRepo, max = 400): Array<{ id: string; ts: number }> {
  const t0 = Date.UTC(2024, 0, 1) / 1000;
  return fns(repo).slice(0, max).map((n, i) => ({ id: n.id, ts: t0 + i * 86400 }));
}

/** A v1 saved layout (positions + settings only; no frames / expandedFolders / detailDepth). */
export function v1Payload(positions: Array<{ id: string; x: number; y: number }>): Record<string, unknown> {
  const nodePositions: Record<string, { x: number; y: number }> = {};
  for (const p of positions) { nodePositions[p.id] = { x: p.x, y: p.y }; }
  return {
    settings: { complexityLevel: 1, clusterGroupBy: 'file', layoutMode: 'static', gitMode: true, languageMode: true, folderMode: true, classMode: true },
    nodePositions,
  };
}

/** A few files marked modified/added so the git colours have something to show. */
export function gitFixture(repo: AnalyzedRepo): { gitAvailable: boolean; fileGitStatus: Record<string, unknown> } {
  const files = [...new Set(fns(repo).map(n => n.file as string))].slice(0, 4);
  const fileGitStatus: Record<string, unknown> = {};
  files.forEach((f, i) => { fileGitStatus[f] = { unstaged: i % 2 === 0 ? 'modified' : 'added', staged: null }; });
  return { gitAvailable: true, fileGitStatus };
}
