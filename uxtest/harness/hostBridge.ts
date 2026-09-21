// Bridges the webview's `acquireVsCodeApi()` to the node-side FakeHost.
// The in-page half is installed with addInitScript (CDP-injected, so the
// production CSP does not apply to it); the node half is an exposed binding.
import type { Page } from '@playwright/test';
import type { FakeHost, HostMessage } from './fakeHost';
import { log } from '../lib/log';

const BINDING = '__uxHostSend';

/** Runs in the page before any webview script. Must be self-contained. */
function installVsCodeApiStub(bindingName: string): void {
  const w = window as unknown as Record<string, unknown>;
  const posted: unknown[] = [];
  let persisted: unknown;
  const api = {
    postMessage(msg: unknown) {
      posted.push(msg);
      const send = w[bindingName] as ((m: string) => Promise<void>) | undefined;
      // JSON round-trip: d3 node objects carry cyclic refs the binding cannot clone.
      if (send) { send(JSON.stringify(msg)).catch(() => { /* page closing */ }); }
    },
    getState: () => persisted,
    setState: (s: unknown) => { persisted = s; return s; },
  };
  w.__uxPosted = posted;
  w.acquireVsCodeApi = () => api;
}

export async function attachHost(page: Page, host: FakeHost): Promise<void> {
  await page.exposeBinding(BINDING, async (_source, raw: string) => {
    let msg: HostMessage;
    try { msg = JSON.parse(raw) as HostMessage; }
    catch (err) { log.warn('host-bad-message', { error: String(err) }); return; }
    try {
      const replies = await host.onMessage(msg);
      for (const r of replies) { await postToWebview(page, r.message, r.delayMs); }
    } catch (err) {
      log.error('host-handler-failed', { type: msg.type, error: String(err) });
    }
  });
  await page.addInitScript(installVsCodeApiStub, BINDING);
}

/** Deliver a host→webview message exactly like VS Code does (a window message event). */
export async function postToWebview(page: Page, message: unknown, delayMs = 0): Promise<void> {
  if (page.isClosed()) { return; }
  if (delayMs > 0) { await new Promise(r => setTimeout(r, delayMs)); }
  if (page.isClosed()) { return; }
  await page.evaluate((m) => { window.postMessage(m, '*'); }, message);
}
