import * as fs from 'fs';
import * as path from 'path';

/**
 * Cheap, parse-free directory scan that powers the instant file-cluster skeleton.
 *
 * The folder/file *structure* of a repo is cheap to compute (one `fs` walk, no
 * parsing); extracting call graphs is what costs minutes on large repos. This
 * module produces the structure synchronously in the extension host so the graph
 * view can paint a collapsed folder tree immediately, before any analyzer runs.
 *
 * Pure TypeScript + `fs` only — no subprocess, no native modules (see the
 * packaging note about snap/GLIBCXX). Kept in sync with the analyzers' walk
 * rules in scripts/analyze_*.js.
 */

export type StructureLanguage = 'python' | 'typescript' | 'javascript' | 'java' | 'cpp';

export interface StructureFile {
  path: string;
  language: StructureLanguage;
}

export interface StructureFolder {
  path: string;
  /** Depth below the common root (root = 0). */
  depth: number;
  parent: string | null;
  childFolders: string[];
  /** Source files directly inside this folder (not descendants). */
  files: string[];
  /** Recursive count of source files under this folder (for sizing/labels). */
  fileCount: number;
}

export interface StructureTree {
  /** The single common-root folder — the level-0 node of the skeleton. */
  root: string;
  folders: Record<string, StructureFolder>;
  files: StructureFile[];
  totalFiles: number;
}

/** Directories skipped by every analyzer's file walk (union of scripts/analyze_*.js). */
const SKIP_DIR_NAMES = new Set(['node_modules', 'out', 'dist', 'target', 'build', 'CMakeFiles']);

const EXT_LANGUAGE: Record<string, StructureLanguage> = {
  '.py': 'python',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.java': 'java',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.c++': 'cpp',
  '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.h++': 'cpp', '.h': 'cpp',
};

function splitSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/** Like path.dirname but stable across separators; returns '' at the filesystem root. */
function dirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.substring(0, idx) : '';
}

function languageOf(name: string): StructureLanguage | null {
  if (name.endsWith('.d.ts')) { return null; } // declaration files aren't analyzed
  const dot = name.lastIndexOf('.');
  if (dot < 0) { return null; }
  return EXT_LANGUAGE[name.slice(dot)] ?? null;
}

function isSkippedDir(name: string): boolean {
  return SKIP_DIR_NAMES.has(name) || name.startsWith('.') || name.startsWith('cmake-build-');
}

/** Collect every supported source file under `root` (parse-free). */
function collectFiles(root: string): StructureFile[] {
  const files: StructureFile[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) { stack.push(path.join(dir, entry.name)); }
      } else if (entry.isFile()) {
        const language = languageOf(entry.name);
        if (language) { files.push({ path: path.join(dir, entry.name), language }); }
      }
    }
  }
  return files;
}

/** Deepest directory that is an ancestor of every file dir (the single skeleton root). */
function commonRoot(fileDirs: string[]): string {
  let common = splitSegments(fileDirs[0]);
  for (const d of fileDirs) {
    const segs = splitSegments(d);
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) { i++; }
    common.length = i;
  }
  // Walk dirs[0] up to `common.length` segments so the original separators/leading
  // slash/drive are preserved (rather than re-joining the split segments).
  let root = fileDirs[0];
  while (splitSegments(root).length > common.length) { root = dirOf(root); }
  return root;
}

/**
 * Scan a workspace into a folder hierarchy with a single common root. Empty tree
 * (root '', no folders/files) when nothing supported is found.
 */
export function scanStructure(workspaceRoot: string): StructureTree {
  const files = collectFiles(workspaceRoot);
  if (files.length === 0) {
    return { root: '', folders: {}, files: [], totalFiles: 0 };
  }

  const fileDirs = [...new Set(files.map(f => dirOf(f.path)))];
  const root = commonRoot(fileDirs);
  const rootDepth = splitSegments(root).length;

  const folders: Record<string, StructureFolder> = {};
  const ensureFolder = (p: string): StructureFolder => {
    let folder = folders[p];
    if (!folder) {
      folder = { path: p, depth: splitSegments(p).length - rootDepth, parent: null, childFolders: [], files: [], fileCount: 0 };
      folders[p] = folder;
    }
    return folder;
  };
  ensureFolder(root);

  for (const file of files) {
    const dir = dirOf(file.path);
    ensureFolder(dir).files.push(file.path);
    // Walk dir → root, creating ancestors, linking children, counting files.
    let current = dir;
    while (true) {
      ensureFolder(current).fileCount++;
      if (current === root) { break; }
      const parent = dirOf(current);
      if (!parent || parent === current) { break; } // safety: never escape above root
      const parentFolder = ensureFolder(parent);
      if (!parentFolder.childFolders.includes(current)) { parentFolder.childFolders.push(current); }
      folders[current].parent = parent;
      current = parent;
    }
  }

  return { root, folders, files, totalFiles: files.length };
}
