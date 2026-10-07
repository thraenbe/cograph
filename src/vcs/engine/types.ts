/**
 * The engine's own view of a graph and of git-style statuses. Structurally the
 * same shapes GraphProvider and GitService use, declared here so that nothing
 * under src/vcs/engine needs graphProvider.ts (which imports vscode) even to
 * type-check: a CLI or the MCP server can compile these files on their own.
 */

export interface EngineNode {
  id: string;
  name: string;
  file: string | null;
  line: number;
  className?: string;
  isLibrary?: boolean;
  libraryName?: string;
}

export interface EngineEdge {
  source: string;
  target: string;
  isLibraryEdge?: boolean;
}

export interface EngineGraph {
  nodes: EngineNode[];
  edges: EngineEdge[];
  files?: string[];
}

export type EngineStatus = 'added' | 'modified' | 'deleted';
export type EngineFileStatus = { unstaged: EngineStatus | null; staged: EngineStatus | null };
export type EngineHunk = { start: number; end: number; isNew: boolean };

/** What GitService colours from (its GitStatusOverride), keyed by forward-slash absolute path. */
export interface EngineStatusOverride {
  files: Map<string, EngineFileStatus>;
  hunks: Map<string, EngineHunk[]>;
}
