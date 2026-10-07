import * as crypto from 'crypto';
import * as path from 'path';
import type { FileStatus, GitStatusOverride, LineHunk } from '../gitService';
import { isAnalyzablePath } from '../structureScanner';
import type { StructureTree } from '../structureScanner';
import { normalize, toRel } from '../subgraphScope';
import type { ScopeSpec } from '../subgraphScope';
import type { PrFile, PrFileStatus, PullRequest } from './types';

/**
 * What a pull request looks like in the graph of the CURRENT checkout. Pure: the
 * caller supplies the files, the structure tree and a way to hash a working file.
 *
 * The rule: every folder on a path to a changed file is open, every other folder
 * is closed, and the PR's diff — not the working tree — decides the colours.
 */

/** Folders without changes: still drawn, closed ('collapse') or taken out of the view ('hide'). */
export type UnchangedFolders = 'collapse' | 'hide';

/** Where one of the PR's files ended up. */
export type PrFilePlace =
  | 'graph'        // drawn and coloured
  | 'missing'      // a source file that this checkout does not have
  | 'other';       // not something the graph shows (docs, config, styles, skipped folders)

export interface PrViewFile {
  /** Repository-relative POSIX path, as the PR names it. */
  path: string;
  status: PrFileStatus;
  place: PrFilePlace;
  /** Functions are coloured individually (the checkout's file is the PR head's file). */
  exact: boolean;
}

export interface PrViewCounts {
  total: number;
  inGraph: number;
  /** In the graph, coloured per function. */
  exact: number;
  /** In the graph, coloured as a whole file only. */
  fileLevel: number;
  missing: number;
  other: number;
}

export interface PrViewModel {
  pr: PullRequest;
  spec: ScopeSpec;
  /** Structure-tree folder paths to open: every ancestor of a changed file in the graph. */
  expand: string[];
  override: GitStatusOverride;
  files: PrViewFile[];
  counts: PrViewCounts;
}

export interface PrViewInput {
  pr: PullRequest;
  files: PrFile[];
  tree: StructureTree;
  /** Workspace folder (what scope paths are relative to). */
  workspaceRoot: string;
  /** Top level of the git repository (what the PR's paths are relative to). */
  repoRoot: string;
  unchangedFolders: UnchangedFolders;
  /** Git blob id of the working file at this absolute path; null when it cannot be read. */
  blobShaOf: (absPath: string) => string | null;
  /** The tree IS the pull request's head (a materialised copy): every file matches by construction. */
  treeIsHead?: boolean;
}

/** The id git gives a blob with this content. */
export function gitBlobSha(content: Buffer): string {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

function fwd(p: string): string {
  return p.replace(/\\/g, '/');
}

function absOf(repoRoot: string, relPosix: string): string {
  return path.join(repoRoot, ...relPosix.split('/'));
}

/** file path → the tree folder that directly holds it. */
function folderByFile(tree: StructureTree): Map<string, string> {
  const map = new Map<string, string>();
  for (const folder of Object.values(tree.folders)) {
    for (const file of folder.files) { map.set(file, folder.path); }
  }
  return map;
}

export function buildPrView(input: PrViewInput): PrViewModel {
  const { pr, tree, workspaceRoot, repoRoot } = input;
  const holder = folderByFile(tree);
  const statuses = new Map<string, FileStatus>();
  const hunks = new Map<string, LineHunk[]>();
  const open = new Set<string>();
  const changedFolders = new Set<string>();
  const files: PrViewFile[] = [];
  const counts: PrViewCounts = { total: input.files.length, inGraph: 0, exact: 0, fileLevel: 0, missing: 0, other: 0 };

  const draw = (abs: string, status: PrFileStatus, file: PrFile, sameContent: boolean): boolean => {
    // A whole-file status needs no line numbers; only a modified file does.
    const exact = status !== 'modified' || (sameContent && file.hunks !== null);
    statuses.set(fwd(abs), { unstaged: status, staged: null });
    if (status === 'modified' && exact && file.hunks) { hunks.set(fwd(abs), file.hunks); }
    const folder = holder.get(abs) as string;
    changedFolders.add(folder);
    for (let f: string | null = folder; f; f = tree.folders[f]?.parent ?? null) { open.add(f); }
    counts.inGraph++;
    if (exact) { counts.exact++; } else { counts.fileLevel++; }
    return exact;
  };

  for (const file of input.files) {
    const abs = absOf(repoRoot, file.path);
    if (holder.has(abs)) {
      const same = input.treeIsHead === true || (file.blobSha !== null && input.blobShaOf(abs) === file.blobSha);
      files.push({ path: file.path, status: file.status, place: 'graph', exact: draw(abs, file.status, file, same) });
      continue;
    }
    // Renamed in the PR, and this checkout still has it under the old name.
    const oldAbs = file.previousPath ? absOf(repoRoot, file.previousPath) : null;
    if (oldAbs && holder.has(oldAbs)) {
      files.push({ path: file.path, status: 'modified', place: 'graph', exact: draw(oldAbs, 'modified', file, false) });
      continue;
    }
    const inWorkspace = !toRel(workspaceRoot, abs).startsWith('..');
    const place: PrFilePlace = inWorkspace && isAnalyzablePath(toRel(workspaceRoot, abs)) ? 'missing' : 'other';
    if (place === 'missing') { counts.missing++; } else { counts.other++; }
    files.push({ path: file.path, status: file.status, place, exact: false });
  }

  if (tree.root && tree.folders[tree.root]) { open.add(tree.root); } // the root is always open, or nothing shows
  const include = input.unchangedFolders === 'hide' && changedFolders.size > 0
    ? [...changedFolders].map(f => toRel(workspaceRoot, f))
    : ['.'];
  return {
    pr,
    spec: normalize({ include, exclude: [] }),
    expand: [...open].sort(),
    override: { files: statuses, hunks },
    files,
    counts,
  };
}

/**
 * Panel title / Folder-panel name of a PR view. It names the TREE, not the PR's
 * title: whoever looks at the graph must know whether it is their checkout or
 * the pull request's own commit.
 */
export function prViewName(pr: Pick<PullRequest, 'number'>, tree: { kind: 'checkout' } | { kind: 'head'; sha: string }): string {
  return tree.kind === 'head' ? `PR #${pr.number} · head ${tree.sha.slice(0, 7)}` : `PR #${pr.number} · your checkout`;
}
