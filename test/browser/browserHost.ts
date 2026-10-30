// The production loopback server (out/browserView/browserServer.js) serving the production
// browser page (out/browserView/browserHtml.js) for a view backed by the uxtest FakeHost.
// The stage then runs in a real browser tab exactly as Open in browser serves it; only the
// extension host behind the view is scripted. uxtest is used read-only.
import * as path from 'path';
import type { FakeHost, HostMessage } from '../../uxtest/harness/fakeHost';

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO_ROOT, 'out', 'browserView');

interface StubUri { path: string; fsPath: string; toString(): string }
const stubUri = (urlPath: string, fsPath: string): StubUri => ({ path: urlPath, fsPath, toString: () => urlPath });

/** Enough of `vscode` for browserHtml.ts and webviewHtmlBuilder.ts outside VS Code. */
function installVscodeStub(settings: Record<string, unknown>): void {
  const stub = {
    Uri: {
      joinPath: (base: StubUri, ...segs: string[]) => stubUri(path.posix.join(base.path, ...segs), path.join(base.fsPath, ...segs)),
      file: (fsPath: string) => stubUri(fsPath, fsPath),
    },
    workspace: { getConfiguration: () => ({ get: <T>(k: string, d: T): T => (k in settings ? settings[k] as T : d) }) },
    window: { activeColorTheme: { kind: 2 } },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const orig = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? stub : orig.call(this, request, ...rest);
  };
}

interface ClientSink { write(json: string): void; control(kind: 'reload' | 'closed'): void }
interface Hub {
  post(m: object): void;
  attachClient(id: string, sink: ClientSink): () => void;
  receive(id: string, m: Record<string, unknown>): void;
}

export interface BrowserLab {
  url: string;
  hub: Hub;
  close(): void;
}

/**
 * Start the real server with one view ('main') whose host is `host`. Every message a tab
 * posts reaches `host.onMessage` (ready included, as in the panel lab); its replies are
 * posted back through the view's hub, with the host's delays.
 */
export async function startBrowserLab(host: FakeHost, settings: Record<string, unknown> = {}): Promise<BrowserLab> {
  installVscodeStub({ 'layout.defaultEngine': 'shelf', 'layout.defaultMode': 'static', 'debug.perfLog': true, ...settings });
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { BrowserServer, MAIN_VIEW } = require(path.join(OUT, 'browserServer.js'));
  const { ViewHub } = require(path.join(OUT, 'viewHub.js'));
  const { renderBrowserPage } = require(path.join(OUT, 'browserHtml.js'));
  /* eslint-enable @typescript-eslint/no-var-requires */
  const logs: string[] = [];
  const hub: Hub = new ViewHub({
    log: (l: string) => logs.push(l),
    replay: () => host.openingMessages().map(r => r.message),
    forward: () => undefined, // every message is handed to the host below, ready included
  });
  const deliver = async (msg: HostMessage): Promise<void> => {
    for (const r of await host.onMessage(msg)) {
      if (r.delayMs) { await new Promise(res => setTimeout(res, r.delayMs)); }
      hub.post(r.message);
    }
  };
  const view = {
    attachView: (id: string, sink: ClientSink) => hub.attachClient(id, sink),
    receiveFromView: (id: string, msg: Record<string, unknown>) => {
      hub.receive(id, msg);
      deliver(msg as HostMessage).catch((err: unknown) => logs.push(`host failed: ${String(err)}`));
    },
    replayMessages: () => host.openingMessages().map(r => r.message),
    viewRoot: () => REPO_ROOT,
  };
  const server = await BrowserServer.start({
    extensionRoot: REPO_ROOT,
    log: (l: string) => logs.push(l),
    renderPage: (page: unknown) => renderBrowserPage(page, REPO_ROOT, 'dark'),
  });
  server.registerView(MAIN_VIEW, view);
  return { url: server.url('/'), hub, close: () => server.dispose() };
}
