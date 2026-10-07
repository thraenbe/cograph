import * as fs from 'fs';
import * as path from 'path';

/** A tool argument the agent got wrong. The server reports it as an `isError` result, not a crash. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/** realpath when the target exists, the plain resolved path otherwise (a deleted file is still nameable). */
function realOrResolved(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
  const real = realOrResolved(resolved);
  if (!isInside(realOrResolved(root), real)) {
    throw new ToolError(`Path "${input}" resolves outside the workspace.`);
  }
  return resolved;
}

/** Workspace-relative POSIX path; absolute paths outside the root are returned unchanged (POSIX-ified). */
export function relPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  if (rel === '') { return '.'; }
  const posix = (rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel).split(path.sep).join('/');
  return posix;
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
