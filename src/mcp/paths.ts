import * as fs from 'fs';
import * as path from 'path';

/** A tool argument the agent got wrong. The server reports it as an `isError` result, not a crash. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * Canonical form for comparisons: the realpath of the deepest EXISTING ancestor plus the missing
 * tail. Both sides of every comparison go through this, so a missing file is canonicalised the
 * same way as the root. Before, only existing paths were realpath'd, so a missing path under a
 * root reached through an alias compared as outside it. Aliases are a symlink on POSIX, or a
 * Windows 8.3 short name such as `RUNNER~1`, which realpath expands.
 */
export function canonical(p: string): string {
  const tail: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) { return path.resolve(p); }
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Segment-wise containment, not a string prefix: `..foo` is a child, `..` and `../x` are not.
 * Case-insensitive on Windows, where `c:\x` and `C:\x` are the same directory.
 */
export function isInside(root: string, candidate: string, p: path.PlatformPath = path): boolean {
  const fold = (s: string) => (p === path.win32 ? s.toLowerCase() : s);
  const rel = p.relative(fold(root), fold(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

/**
 * Resolve a user/agent-supplied path against the workspace root and refuse anything that
 * escapes it: `..`, an absolute path elsewhere, or a symlink pointing outside. Accepts
 * workspace-relative paths with either separator, and absolute paths inside the root.
 */
export function confine(root: string, input: string): string {
  const raw = input.trim();
  if (raw === '' || raw === '.' || raw === './') { return root; }
  const resolved = path.resolve(root, raw.split(/[\\/]+/).join(path.sep));
  if (!isInside(root, resolved)) { throw new ToolError(`Path "${input}" is outside the workspace.`); }
  if (!isInside(canonical(root), canonical(resolved))) {
    throw new ToolError(`Path "${input}" resolves outside the workspace.`);
  }
  return resolved;
}

/** Workspace-relative POSIX path; absolute paths outside the root are returned unchanged (POSIX-ified). */
export function relPath(root: string, abs: string): string {
  if (!isInside(root, abs)) { return abs.split(path.sep).join('/'); }
  const rel = path.relative(root, abs);
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

/**
 * The workspace the server answers for: `--workspace` if given, otherwise the nearest ancestor of
 * `cwd` that holds a CoGraph cache, otherwise `cwd` itself (the result will say "no analysis yet").
 */
export function findWorkspaceRoot(cwd: string, explicit?: string): string {
  if (explicit) { return path.resolve(cwd, explicit); }
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.cograph', 'graph-cache.json'))) { return dir; }
    const parent = path.dirname(dir);
    if (parent === dir) { return path.resolve(cwd); }
    dir = parent;
  }
}
