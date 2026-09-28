import * as vscode from 'vscode';
import type { StructureTree } from './structureScanner';
import { toRel } from './subgraphScope';

/**
 * "CoGraph: Only visualize folder…": a QuickPick over the structure tree's folders.
 * The command picks exactly one folder, so a flat, filterable list is the right
 * control here (the multi-folder subgraph picker lives in the sidebar instead).
 */

export interface FolderPickItem extends vscode.QuickPickItem {
  /** Workspace-relative POSIX path, '.' for the root. */
  rel: string;
}

/** Pure: one item per folder, shallow first, then by path; the root is listed as "." */
export function buildFolderItems(tree: StructureTree, workspaceRoot: string): FolderPickItem[] {
  const folders = Object.values(tree.folders)
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  return folders.map(f => {
    const rel = toRel(workspaceRoot, f.path);
    const files = f.fileCount === 1 ? '1 file' : `${f.fileCount} files`;
    return {
      label: rel === '.' ? '$(root-folder) .' : `$(folder) ${rel}`,
      description: files,
      detail: rel === '.' ? 'Project root (whole project)' : undefined,
      rel,
    };
  });
}

/** Show the picker; resolves to the chosen folder's relative path, or null when dismissed. */
export async function pickFolder(tree: StructureTree, workspaceRoot: string): Promise<string | null> {
  const items = buildFolderItems(tree, workspaceRoot);
  if (items.length === 0) {
    vscode.window.showInformationMessage('CoGraph: No source folders found in this workspace.');
    return null;
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: 'CoGraph: Only visualize folder',
    placeHolder: 'Pick the folder to visualize (its subfolders are included)',
    matchOnDescription: true,
  });
  return picked ? picked.rel : null;
}
