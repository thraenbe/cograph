import * as vscode from 'vscode';
import { BrowserServer } from './browserServer';
import { renderBrowserPage } from './browserHtml';

/**
 * One loopback server per extension host, started on first use (Open in browser or a
 * tour) and stopped on deactivate or when cograph.browserView.enabled goes off.
 */

interface LifetimeConfig { extensionRoot: string; log(line: string): void }

let config: LifetimeConfig | undefined;
let serverPromise: Promise<BrowserServer> | undefined;

/** extension.ts, on activate: where the stage files are and where the server logs. */
export function configureBrowserServer(cfg: LifetimeConfig): void {
  config = cfg;
}

export function browserViewEnabled(): boolean {
  return vscode.workspace.getConfiguration('cograph').get<boolean>('browserView.enabled', true) !== false;
}

/** The running server, started now if needed; null when the setting switches it off. Rejects when it cannot listen. */
export function getBrowserServer(): Promise<BrowserServer | null> {
  if (!browserViewEnabled()) { return Promise.resolve(null); }
  const cfg = config;
  if (!cfg) { return Promise.reject(new Error('the browser view is not configured (extension not activated)')); }
  if (!serverPromise) {
    serverPromise = BrowserServer.start({
      extensionRoot: cfg.extensionRoot,
      log: cfg.log,
      renderPage: (page) => renderBrowserPage(page, cfg.extensionRoot),
    });
    // A failed start is not cached: the next click tries again.
    serverPromise.catch(() => { serverPromise = undefined; });
  }
  return serverPromise;
}

/** True when a server is running or starting (no start as a side effect). */
export function browserServerStarted(): boolean { return !!serverPromise; }

export async function stopBrowserServer(): Promise<void> {
  const pending = serverPromise;
  serverPromise = undefined;
  if (!pending) { return; }
  try {
    (await pending).dispose();
  } catch (err) {
    config?.log(`[browser] stop: the server had not started (${(err as Error).message})`);
  }
}
