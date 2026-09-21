// Renders the REAL production webview HTML outside VS Code: the compiled
// out/webviewHtmlBuilder.js is loaded with a stubbed `vscode` module, so panel
// markup, CSP and script order can never drift from what the extension ships.
import * as path from 'path';
import * as fs from 'fs';

export interface BootConfig {
  engine?: 'shelf' | 'global';
  motion?: 'dynamic' | 'static';
  perf?: boolean;
  timeline?: boolean;
}

export const REPO_ROOT = path.resolve(__dirname, '..', '..');
/** The CoGraph checkout under test. Defaults to this repo; point UXTEST_EXT_ROOT at another
 *  worktree/branch checkout (needs `npm run compile` there) to run the same suite against it. */
export const EXT_ROOT = process.env.UXTEST_EXT_ROOT ? path.resolve(process.env.UXTEST_EXT_ROOT) : REPO_ROOT;
const BUILDER = path.join(EXT_ROOT, 'out', 'webviewHtmlBuilder.js');

let currentCfg: Record<string, unknown> = {};
let hookInstalled = false;

const vscodeStub = {
  Uri: {
    joinPath: (base: { path: string }, ...segs: string[]) => ({ path: path.posix.join(base.path, ...segs) }),
  },
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback: T): T => (key in currentCfg ? (currentCfg[key] as T) : fallback),
    }),
  },
};

function installHook(): void {
  if (hookInstalled) { return; }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'vscode') { return vscodeStub; }
    return origLoad.call(this, request, ...rest);
  };
  hookInstalled = true;
}

/** Webview resources resolve to /ext/<repo-relative path> on the lab server. */
export const EXT_PREFIX = '/ext';

export function renderWebviewHtml(origin: string, cfg: BootConfig = {}): string {
  if (!fs.existsSync(BUILDER)) {
    throw new Error(`${BUILDER} missing - run "npm run compile" first`);
  }
  installHook();
  currentCfg = {
    'layout.defaultEngine': cfg.engine ?? 'shelf',
    'layout.defaultMode': cfg.motion ?? 'static',
    'debug.perfLog': cfg.perf ?? true,
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const builder = require(BUILDER);
  const webview = {
    asWebviewUri: (u: { path: string }) => `${EXT_PREFIX}${u.path}`,
    cspSource: origin,
  };
  return builder.getWebviewHtml(webview, { path: '/' }, { timelineMode: cfg.timeline === true });
}

/** Script paths (repo-relative) in load order, as emitted by the real builder. */
export function scriptListFromHtml(html: string): string[] {
  const out: string[] = [];
  const re = /<script[^>]*\ssrc="([^"?]+)[^"]*"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1].startsWith(EXT_PREFIX + '/')) { out.push(m[1].slice(EXT_PREFIX.length + 1)); }
  }
  return out;
}
