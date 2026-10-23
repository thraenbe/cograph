import * as vscode from 'vscode';
import type { GraphProvider } from '../graphProvider';
import { MAIN_VIEW, type BrowserServer } from './browserServer';
import { getBrowserServer } from './browserLifetime';

/** Said under the panel's button (and in a toast from the command) when the setting is off. */
export const BROWSER_DISABLED_NOTE = 'Open in browser is switched off (setting cograph.browserView.enabled).';

/**
 * Open `server.url(urlPath)` in the default browser. Under Remote-SSH or Codespaces the URL
 * goes through asExternalUri first, so VS Code forwards the port. Returns the URL that was
 * opened (it carries the token: put it on the clipboard, never in a log or a toast) and
 * whether the browser accepted it.
 */
export async function openExternalUrl(server: BrowserServer, urlPath: string, query?: Record<string, string>): Promise<{ url: string; opened: boolean }> {
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(server.url(urlPath, query)));
  const opened = await vscode.env.openExternal(external);
  return { url: external.toString(true), opened };
}

/** "Graph opened in your browser" with Copy URL; the URL itself is never shown. */
export async function showOpenedToast(message: string, url: string, opened: boolean): Promise<void> {
  const text = opened ? message : 'CoGraph: The browser did not open. Copy the URL and paste it into your browser.';
  const choice = await vscode.window.showInformationMessage(text, 'Copy URL');
  if (choice === 'Copy URL') { await vscode.env.clipboard.writeText(url); }
}

/**
 * The panel's Open in browser button and the cograph.openInBrowser command: show the panel
 * when it is closed (it owns the analysis), mirror it on the server as `viewId`, open the tab.
 */
export async function openInBrowser(provider: GraphProvider, viewId: string = MAIN_VIEW): Promise<void> {
  let server: BrowserServer | null;
  try {
    server = await getBrowserServer();
  } catch (err) {
    void vscode.window.showErrorMessage(`CoGraph: Could not start the browser view — ${(err as Error).message}`);
    return;
  }
  if (!server) {
    provider.postBrowserNote(BROWSER_DISABLED_NOTE);
    void vscode.window.showInformationMessage(`CoGraph: ${BROWSER_DISABLED_NOTE}`);
    return;
  }
  if (!provider.isOpen()) { provider.show(); }
  if (!provider.isOpen()) { return; } // no workspace: show() already said so
  server.registerView(viewId, provider);
  try {
    const { url, opened } = await openExternalUrl(server, '/');
    await showOpenedToast('CoGraph: Graph opened in your browser.', url, opened);
  } catch (err) {
    void vscode.window.showErrorMessage(`CoGraph: Could not open the browser — ${(err as Error).message}`);
  }
}
