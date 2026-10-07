import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Files a pull-request panel opens are read-only documents of their own scheme,
 * so they are read-only by construction: VS Code marks a content provider's
 * documents read-only (lock on the tab, no edits accepted) and nothing — no
 * click, no command — makes them writable. The URI path carries a label, so the
 * tab reads `esbuild.js · PR #69 · head 23834be` on hover and in the description,
 * or `analyze.py · your checkout · main (not PR #73)` — never like the user's
 * own file, and never like the PR's version when it is not.
 *
 * Three sources: a file under the copies' storage (a head panel), a file under
 * the workspace (a checkout panel), or text handed in directly (the PR's version
 * of a file the checkout lacks, fetched from GitHub).
 */
export const PR_DOCUMENT_SCHEME = 'cograph-pr';

/** The URI for `absFile`, labelled; the file must lie under one of the registered roots. */
export function prDocumentUri(root: string, label: string, absFile: string): vscode.Uri {
  const rel = path.relative(root, absFile).split(path.sep).join('/');
  return vscode.Uri.from({
    scheme: PR_DOCUMENT_SCHEME,
    path: `/${label}/${rel}`,
    query: new URLSearchParams({ file: absFile }).toString(),
  });
}

/** The on-disk file a document URI stands for; null when it is not under one of `roots`. */
export function prDocumentFile(uri: vscode.Uri, roots: string[]): string | null {
  const file = new URLSearchParams(uri.query).get('file');
  if (!file) { return null; }
  const abs = path.resolve(file);
  return roots.some(r => { const root = path.resolve(r); return abs === root || abs.startsWith(root + path.sep); }) ? abs : null;
}

/** Text handed in directly (fetched from GitHub), keyed by URI; shown until the extension unloads. */
const inline = new Map<string, string>();

/** Open `text` as `<label>/<relPath>`, read-only. */
export async function showPrText(label: string, relPath: string, text: string): Promise<void> {
  const uri = vscode.Uri.from({ scheme: PR_DOCUMENT_SCHEME, path: `/${label}/${relPath}`, query: 'inline=1' });
  inline.set(uri.toString(), text);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

/** Register the scheme; files are served only from under `roots`. */
export function registerPrDocuments(roots: string[]): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(PR_DOCUMENT_SCHEME, {
    provideTextDocumentContent(uri) {
      const text = inline.get(uri.toString());
      if (text !== undefined) { return text; }
      const file = prDocumentFile(uri, roots);
      if (!file) { return `// Not a pull-request document: ${uri.path}`; }
      try { return fs.readFileSync(file, 'utf8'); } catch (err) { return `// ${(err as Error).message}`; }
    },
  });
}
