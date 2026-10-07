import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface SkipDirs { alwaysSkip: string[]; artefact: string[]; artefactPrefixes: string[] }
// Outside rootDir, so a plain require: esbuild inlines it, and from out/ it resolves to scripts/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const skipDirs = require('../scripts/skipDirs.json') as SkipDirs;

/**
 * What belongs to the project (F30): the single rule the structure scanner applies and
 * every analyzer inherits through `--files`.
 *
 * - `alwaysSkip` dirs and dot-dirs are never entered.
 * - `artefact` dirs (build output) are entered only when git tracks files inside them,
 *   and then only those tracked files count: hand-written `build/` scripts stay, a
 *   setuptools `build/lib/` copy of the package does not.
 * - Without git (not a repository, git missing) every artefact dir is skipped.
 *
 * git is asked lazily, at most once per walk, and only when an artefact dir is met.
 */

const ALWAYS_SKIP = new Set<string>(skipDirs.alwaysSkip);
const ARTEFACT = new Set<string>(skipDirs.artefact);
const ARTEFACT_PREFIXES: string[] = skipDirs.artefactPrefixes;

export function isAlwaysSkippedDir(name: string): boolean {
  return ALWAYS_SKIP.has(name) || name.startsWith('.');
}

export function isArtefactDir(name: string): boolean {
  return ARTEFACT.has(name) || ARTEFACT_PREFIXES.some(p => name.startsWith(p));
}

export interface GitTracked {
  /** Absolute paths of tracked files under the root. */
  files: Set<string>;
  /** Absolute paths of every directory that contains a tracked file (at any depth). */
  dirs: Set<string>;
}

export type GitLister = (root: string) => string[] | null;

/** `git ls-files` relative to `root`; null when root is not in a repository or git fails. */
export const gitLsFiles: GitLister = (root) => {
  try {
    const out = cp.execFileSync('git', ['ls-files', '-z'], {
      cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
};

export function readGitTracked(root: string, list: GitLister = gitLsFiles): GitTracked | null {
  const rel = list(root);
  if (!rel) { return null; }
  const files = new Set<string>();
  const dirs = new Set<string>();
  const top = path.resolve(root);
  for (const r of rel) {
    const abs = path.resolve(root, r);
    files.add(abs);
    for (let d = path.dirname(abs); d.length >= top.length && !dirs.has(d); d = path.dirname(d)) {
      dirs.add(d);
      if (d === top) { break; }
    }
  }
  return { files, dirs };
}

/**
 * Walk the project's files under `root` by the rule above. `visit` returns `false` to
 * stop the walk early. `list` is injectable for tests.
 */
export function walkProjectFiles(
  root: string,
  visit: (file: string, name: string) => boolean | void,
  list: GitLister = gitLsFiles,
): void {
  let git: GitTracked | null | undefined; // undefined = not asked yet
  const tracked = (): GitTracked | null => (git === undefined ? (git = readGitTracked(root, list)) : git);
  const stack: Array<{ dir: string; trackedOnly: boolean }> = [{ dir: root, trackedOnly: false }];
  while (stack.length) {
    const { dir, trackedOnly } = stack.pop() as { dir: string; trackedOnly: boolean };
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isAlwaysSkippedDir(entry.name)) { continue; }
        if (trackedOnly || isArtefactDir(entry.name)) {
          const g = tracked();
          if (!g || !g.dirs.has(path.resolve(full))) { continue; }
          stack.push({ dir: full, trackedOnly: true });
        } else {
          stack.push({ dir: full, trackedOnly: false });
        }
      } else if (entry.isFile()) {
        if (trackedOnly && !tracked()?.files.has(path.resolve(full))) { continue; }
        if (visit(full, entry.name) === false) { return; }
      }
    }
  }
}
