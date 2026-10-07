import * as path from 'path';
import type { GraphData } from '../../graphProvider';
import { scanStructure } from '../../structureScanner';
import type { StructureTree } from '../../structureScanner';

/**
 * A directory turned into what the graph works from: its structure tree and its
 * call graph. The analyzer is injected — in VS Code it is the AnalyzerRunner, a
 * CLI or the MCP server can spawn the scripts under `scripts/` themselves. No
 * vscode import.
 */

export type TreeAnalyzer = (dir: string, signal?: AbortSignal) => Promise<GraphData>;

export interface AnalyzedTree {
  /** Absolute directory the paths in `tree` and `graph` point into. */
  root: string;
  /** Commit the directory was materialised from; undefined for a working tree. */
  sha?: string;
  tree: StructureTree;
  graph: GraphData;
}

export async function analyzeTree(root: string, analyzer: TreeAnalyzer, sha?: string, signal?: AbortSignal): Promise<AnalyzedTree> {
  const tree = scanStructure(root);
  const graph = await analyzer(root, signal);
  return { root, sha, tree, graph };
}

/** Repository-relative POSIX path of an absolute path under `root`; null outside it. */
export function relPath(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { return rel === '' ? '' : null; }
  return rel.split(path.sep).join('/');
}
