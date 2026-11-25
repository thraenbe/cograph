import * as path from 'path';

/**
 * What a browser tab may ask the host. The panel's webview runs inside VS Code's own
 * isolation; a tab is a page behind a token, so its file-carrying messages (read source,
 * save source, navigate, new file, rename, expand) are confined to the directory the
 * view's graph is rooted at. Defence in depth: the token and the request gate come first.
 */

const PATH_FIELDS = ['file', 'filePath', 'folderPath'] as const;

/** Messages that only report and never act: they do not make a view the active one. */
const PASSIVE = new Set(['ready', 'perf-report', 'webview-log', 'get-annotations']);

/**
 * Only an absolute string under `root`: the handlers pass the path to fs as it came, so a
 * relative one means the extension host's working directory, not the root, and fs also
 * opens a URL-shaped object. Every real message carries absolute paths.
 */
function inside(root: string, p: unknown): boolean {
  if (typeof p !== 'string' || !path.isAbsolute(p)) { return false; }
  const abs = path.resolve(p);
  const base = path.resolve(root);
  return abs === base || abs.startsWith(base + path.sep);
}

/** null when every path in `message` lies under `root`, else the first one that does not. */
export function pathOutsideRoot(message: Record<string, unknown>, root: string): string | null {
  if (!root) { return null; } // no root, nothing to confine to (and nothing on disk to reach)
  for (const field of PATH_FIELDS) {
    const v = message[field];
    if (v !== undefined && v !== null && v !== '' && !inside(root, v)) { return String(v); }
  }
  const files = message.files;
  if (Array.isArray(files)) {
    for (const f of files) { if (!inside(root, f)) { return String(f); } }
  }
  return null;
}

/** True for a message the user caused (a click, an edit), which makes its view the active one. */
export function isUserMessage(message: { type?: unknown }): boolean {
  return typeof message.type === 'string' && !PASSIVE.has(message.type);
}
