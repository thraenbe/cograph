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

function inside(root: string, p: string): boolean {
  const abs = path.resolve(root, p);
  const base = path.resolve(root);
  return abs === base || abs.startsWith(base + path.sep);
}

/** null when every path in `message` lies under `root`, else the first one that does not. */
export function pathOutsideRoot(message: Record<string, unknown>, root: string): string | null {
  if (!root) { return null; } // no root, nothing to confine to (and nothing on disk to reach)
  for (const field of PATH_FIELDS) {
    const v = message[field];
    if (typeof v === 'string' && v && !inside(root, v)) { return v; }
  }
  const files = message.files;
  if (Array.isArray(files)) {
    for (const f of files) { if (typeof f === 'string' && !inside(root, f)) { return f; } }
  }
  return null;
}

/** True for a message the user caused (a click, an edit), which makes its view the active one. */
export function isUserMessage(message: { type?: unknown }): boolean {
  return typeof message.type === 'string' && !PASSIVE.has(message.type);
}
