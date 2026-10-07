import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Files of a materialised pull-request copy open as read-only documents of
 * their own scheme, so they are read-only by construction: VS Code marks a
 * content provider's documents read-only (lock on the tab, no edits accepted)
 * and nothing — no click, no command — makes them writable. The URI path
 * carries the panel's title, so the tab reads `esbuild.js · PR #69 · head 23834be`
 * on hover and in the description, never like the user's own esbuild.js.
 */
export const PR_DOCUMENT_SCHEME = 'cograph-pr';

/** The URI for `absFile`, which must lie under `treeDir`; `title` names the panel it came from. */
export function prDocumentUri(treeDir: string, title: string, absFile: string): vscode.Uri {
  const rel = path.relative(treeDir, absFile).split(path.sep).join('/');
  return vscode.Uri.from({
    scheme: PR_DOCUMENT_SCHEME,
    path: `/${title}/${rel}`,
    query: new URLSearchParams({ file: absFile }).toString(),
  });
}

/** The on-disk file a document URI stands for; null when it is not under `storageDir`. */
export function prDocumentFile(uri: vscode.Uri, storageDir: string): string | null {
  const file = new URLSearchParams(uri.query).get('file');
  if (!file) { return null; }
  const abs = path.resolve(file);
  const root = path.resolve(storageDir);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

/** Register the scheme; documents are served only from under `storageDir`. */
export function registerPrDocuments(storageDir: string): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(PR_DOCUMENT_SCHEME, {
    provideTextDocumentContent(uri) {
      const file = prDocumentFile(uri, storageDir);
      if (!file) { return `// Not a pull-request copy: ${uri.path}`; }
      try { return fs.readFileSync(file, 'utf8'); } catch (err) { return `// ${(err as Error).message}`; }
    },
  });
}
