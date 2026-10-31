import * as path from 'path';
import { GitService } from '../gitService';
import { buildSubgraphMessage } from '../subgraphScope';
import type { StructureTree } from '../structureScanner';
import type { TourPrepared, TourScript, TourTarget } from '../tour/tourApi';
import { tourGraphView } from '../vcs/tourView';
import type { CiTrees } from './trees';

/**
 * What a bundle's `stage/` holds and the script it plays: the messages the stage gets in VS Code,
 * from the head copy, with every path moved under a virtual root. No runner path may enter a
 * bundle, and the viewer knows no other root. No vscode import.
 *
 * Paths are rewritten field by field, not with a replace over the JSON: a replace would also
 * touch source text that happens to quote the path, and misses a path in its Windows spelling.
 */

export const STAGE_ROOT = '/repo';

export interface StageData {
  /** The script with `trees.repoRoot` virtual. */
  script: TourScript;
  /** `prepared.statuses` under the virtual root. */
  statuses: TourPrepared['statuses'];
  /** `stage/view.json`: the two stage messages, verbatim. */
  view: { subgraph: object; prView: object };
  /** `stage/structure.json`. */
  structure: object;
  /** `stage/graph.json`, with function statuses applied. */
  graph: object;
}

/** Native path under `headDir` → the same file under the virtual root. Anything else stays as it is. */
function underStage(headDir: string): (p: string) => string {
  const fwd = (p: string) => p.split(path.sep).join('/');
  const root = fwd(headDir);
  return (p) => {
    const file = fwd(p);
    if (file === root) { return STAGE_ROOT; }
    return file.startsWith(`${root}/`) ? `${STAGE_ROOT}${file.slice(root.length)}` : p;
  };
}

function stageStructure(tree: StructureTree, stage: (p: string) => string): StructureTree {
  const folders: StructureTree['folders'] = {};
  for (const folder of Object.values(tree.folders)) {
    folders[stage(folder.path)] = {
      ...folder, path: stage(folder.path), parent: folder.parent === null ? null : stage(folder.parent),
      childFolders: folder.childFolders.map(stage), files: folder.files.map(stage),
    };
  }
  return { ...tree, root: stage(tree.root), folders, files: tree.files.map(f => ({ ...f, path: stage(f.path) })) };
}

/** The head graph with colours applied through the same code the panel uses, every path and id moved. */
function stageGraph(trees: CiTrees, prepared: TourPrepared, stage: (p: string) => string) {
  const git = new GitService();
  git.setOverride({ files: new Map(prepared.statuses.files), hunks: new Map(prepared.statuses.hunks) });
  const nodes = trees.head.graph.nodes.map(n => ({ ...n }));
  git.applyGitStatuses(nodes, prepared.headDir);
  const ids = new Map<string, string>();
  const moved = nodes.map((n) => {
    if (!n.file) { return n; }
    const id = n.id.startsWith(`${n.file}::`) ? `${stage(n.file)}${n.id.slice(n.file.length)}` : n.id;
    ids.set(n.id, id);
    return { ...n, id, file: stage(n.file) };
  });
  const edges = trees.head.graph.edges.map(e => ({ ...e, source: ids.get(e.source) ?? e.source, target: ids.get(e.target) ?? e.target }));
  return { nodes: moved, edges, files: (trees.head.graph.files ?? []).map(stage) };
}

function stageStatuses(statuses: TourPrepared['statuses'], stage: (p: string) => string): TourPrepared['statuses'] {
  return { files: statuses.files.map(([p, s]) => [stage(p), s]), hunks: statuses.hunks.map(([p, h]) => [stage(p), h]) };
}

export function stageData(prepared: TourPrepared, trees: CiTrees, target: TourTarget): StageData {
  const stage = underStage(prepared.headDir);
  const view = tourGraphView(prepared, target);
  const statuses = stageStatuses(prepared.statuses, stage);
  const fileGitStatus = Object.fromEntries(statuses.files.map(([p, s]) => [p, { unstaged: s.unstaged, staged: null }]));
  return {
    script: { ...prepared.script, trees: { ...(prepared.script.trees as object), repoRoot: STAGE_ROOT } },
    statuses,
    view: {
      subgraph: buildSubgraphMessage({ spec: view.spec, source: 'pr', name: view.name }, STAGE_ROOT),
      prView: { ...view.message, readOnly: true, expand: view.message.expand.map(stage), fileGitStatus },
    },
    structure: { type: 'structure', tree: stageStructure(trees.structure, stage), autoEngage: true },
    graph: { type: 'graph', data: stageGraph(trees, prepared, stage), gitAvailable: true, fileGitStatus, isReanalysis: false },
  };
}
