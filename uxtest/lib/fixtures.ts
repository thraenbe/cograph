// Deterministic host-side fixtures derived from an analyzed repo: workflow
// metadata, timeline history, and a legacy (v1) saved layout.
import type { AnalyzedRepo } from './analyze';
import type { AnnotationsFixture, GraphLite, GraphNodeLite } from '../harness/fakeHost';

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

const posix = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
const relTo = (root: string, abs: string): string => (posix(abs) === posix(root) ? '.' : posix(abs).startsWith(posix(root) + '/') ? posix(abs).slice(posix(root).length + 1) : posix(abs));

/** What the real host answers to `get-annotations`: summaries for the biggest folder and two
 *  of its files, one of them stale. AI stays OFF — these are canned strings, nothing is generated. */
export function annotationsFixture(repo: AnalyzedRepo): AnnotationsFixture & { folderRel: string; fileRel: string; staleRel: string } {
  const byDir = new Map<string, string[]>();
  for (const n of fns(repo)) {
    const file = posix(n.file as string), dir = file.slice(0, file.lastIndexOf('/'));
    const list = byDir.get(dir) ?? [];
    if (!list.includes(file)) { list.push(file); }
    byDir.set(dir, list);
  }
  // The root frame has no grabbable header, so annotate the biggest folder below it.
  const [dir, files] = [...byDir.entries()].filter(([d]) => d !== posix(repo.root))
    .sort((a, b) => b[1].length - a[1].length || b[0].split('/').length - a[0].split('/').length)[0] ?? ['', []]; // ties → deepest (leaf headers are never covered)
  const folderRel = relTo(repo.root, dir), fileRel = relTo(repo.root, files[0] ?? ''), staleRel = relTo(repo.root, files[1] ?? files[0] ?? '');
  return {
    root: repo.root, aiEnabled: false, folderRel, fileRel, staleRel,
    folders: { [folderRel]: { summary: 'uxtest: canned folder summary.', role: 'core' } },
    files: { [fileRel]: { summary: 'uxtest: canned file summary.', role: 'module' }, [staleRel]: { summary: 'uxtest: canned but outdated summary.' } },
    stale: [staleRel],
  };
}
