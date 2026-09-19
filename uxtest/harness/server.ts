// Lab server: serves the real webview HTML at / and the webview resources
// under /ext/{src/webview,dist/webview,media}/. Bound to 127.0.0.1 on a random port.
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { renderWebviewHtml, EXT_ROOT, EXT_PREFIX, type BootConfig } from './vscodeStub';
import { log } from '../lib/log';

// Everything a webview may legitimately load: the plain sources today, the
// bundled/vendored output (dist/webview, e.g. a local d3) once perf lands it.
const STATIC_ROOTS = ['src/webview', 'dist/webview', 'media'].map(r => path.join(EXT_ROOT, r));
const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

export interface LabServer {
  origin: string;
  /** URL of the lab page for a boot config (engine / motion / perf / timeline). */
  pageUrl(cfg?: BootConfig): string;
  close(): Promise<void>;
}

function cfgFromQuery(url: URL): BootConfig {
  const engine = url.searchParams.get('engine');
  const motion = url.searchParams.get('motion');
  return {
    engine: engine === 'global' ? 'global' : 'shelf',
    motion: motion === 'dynamic' ? 'dynamic' : 'static',
    perf: url.searchParams.get('perf') !== '0',
    timeline: url.searchParams.get('timeline') === '1',
  };
}

/** Resolve /ext/<repo-relative file> to disk; null when outside the served roots. */
export function resolveStatic(pathname: string): string | null {
  if (!pathname.startsWith(EXT_PREFIX + '/')) { return null; }
  const rel = decodeURIComponent(pathname.slice(EXT_PREFIX.length + 1));
  const abs = path.resolve(EXT_ROOT, rel);
  return STATIC_ROOTS.some(root => abs.startsWith(root + path.sep)) ? abs : null;
}

function handle(origin: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', origin);
  if (url.pathname === '/') {
    const html = renderWebviewHtml(origin, cfgFromQuery(url));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
    return;
  }
  const file = resolveStatic(url.pathname);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).on('error', (err) => {
    log.error('static-read-failed', { file, error: String(err) });
    res.destroy();
  }).pipe(res);
}

export async function startServer(): Promise<LabServer> {
  let origin = '';
  const server = http.createServer((req, res) => {
    try { handle(origin, req, res); }
    catch (err) {
      log.error('lab-server-error', { url: req.url, error: String(err) });
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    pageUrl: (cfg: BootConfig = {}) => {
      const q = new URLSearchParams({
        engine: cfg.engine ?? 'shelf', motion: cfg.motion ?? 'static',
        perf: cfg.perf === false ? '0' : '1', timeline: cfg.timeline ? '1' : '0',
      });
      return `${origin}/?${q.toString()}`;
    },
    close: () => new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))),
  };
}
