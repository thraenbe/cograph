// Stands in for the hosted viewer: dist/stage files under delivery's exact CSP header, sandbox included,
// and `feed.js` at the marker where the private viewer's tags go, handing the replay to open().
// Serves one path more on a second port, for the page in another origin that tries to reach the viewer.
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';

export const VIEWER_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; "
  + "worker-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; "
  + 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

export interface StageManifest {
  files: { bridge: string; stage: string; css: string; worker: string };
  afterStage: string;
}

export interface StageServer {
  url: string;
  otherOrigin: string;
  close(): void;
}

function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const portOf = (server: http.Server): number => (server.address() as AddressInfo).port;

export async function startStageServer(dir: string, manifest: StageManifest, feedJs: string): Promise<StageServer> {
  const page = fs.readFileSync(path.join(dir, 'index.html'), 'utf8').replace(manifest.afterStage, '<script src="feed.js"></script>');
  const viewer = await listen((req, res) => {
    const name = new URL(req.url ?? '/', 'http://x').pathname.slice(1) || 'index.html';
    const body = name === 'index.html' ? page : name === 'feed.js' ? feedJs
      : Object.values(manifest.files).includes(name) ? fs.readFileSync(path.join(dir, name)) : null;
    if (body === null) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(name)] ?? 'application/octet-stream',
      'content-security-policy': VIEWER_CSP,
      // An opaque origin fetches the worker across origins, so hosting must allow it.
      ...(name === manifest.files.worker ? { 'access-control-allow-origin': '*' } : {}),
    });
    res.end(body);
  });
  const other = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!DOCTYPE html><title>other origin</title>'); });
  return {
    url: `http://127.0.0.1:${portOf(viewer)}/`,
    otherOrigin: `http://127.0.0.1:${portOf(other)}/`,
    close() { viewer.close(); other.close(); viewer.closeAllConnections(); other.closeAllConnections(); },
  };
}
