import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** Request plumbing of the loopback server: the gate checks, bodies, static files. No vscode. */

export const MAX_BODY_BYTES = 1024 * 1024;

/** Sent with every response: nothing cached, nothing sniffed, no Referer carrying the token, never framed. */
export const BASE_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** DNS rebinding: the Host must name the loopback. Any port, so a Remote-SSH forward to another local port works. */
export function hostAllowed(host: string | undefined): boolean {
  if (!host) { return false; }
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host.trim().toLowerCase());
  return !!m && LOOPBACK_HOSTS.has(m[1]);
}

/** A POST must come from this page: same Origin as the Host it was sent to, and no cross-site fetch metadata. */
export function postOriginAllowed(headers: http.IncomingHttpHeaders): boolean {
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') { return false; }
  const origin = headers.origin;
  if (origin === undefined) { return true; } // non-browser clients (tests, curl) still need the token
  return origin === `http://${headers.host ?? ''}`;
}

export function tokenMatches(given: string | null, token: string): boolean {
  if (!given) { return false; }
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function sendStatus(res: http.ServerResponse, status: number, body = ''): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/** `headers` (a private route's) may add or set the type; they cannot lift the BASE_HEADERS. */
export function sendBody(res: http.ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void {
  const extra = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  res.writeHead(status, { ...extra, 'content-type': type, ...BASE_HEADERS });
  res.end(body);
}

export type BodyResult = { ok: true; value: unknown } | { ok: false; status: 400 | 413 };

/** Read a JSON body up to MAX_BODY_BYTES. Past the cap the rest is drained and discarded, then 413. */
export function readJsonBody(req: http.IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; chunks.length = 0; return; }
      if (!tooLarge) { chunks.push(chunk); }
    });
    req.on('error', () => resolve({ ok: false, status: 400 }));
    req.on('end', () => {
      if (tooLarge) { resolve({ ok: false, status: 413 }); return; }
      try { resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
      catch { resolve({ ok: false, status: 400 }); }
    });
  });
}

/**
 * The file `rel` under `root`, or null: no '..' escapes, no symlink out of the root, files only.
 * `rel` is the URL path after the prefix, still percent-encoded.
 */
export function resolveUnder(root: string, rel: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(rel); } catch { return null; }
  if (decoded.includes('\0')) { return null; }
  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(path.resolve(realRoot, '.' + path.sep + decoded));
  } catch { return null; }
  if (!real.startsWith(realRoot + path.sep)) { return null; }
  try { return fs.statSync(real).isFile() ? real : null; } catch { return null; }
}

/** Stream a resolved file. A read error after the headers ends the response; it is logged by the caller. */
export function sendFile(res: http.ServerResponse, file: string, onError: (err: Error) => void): void {
  res.writeHead(200, { ...BASE_HEADERS, 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  fs.createReadStream(file).on('error', (err) => { onError(err); res.destroy(); }).pipe(res);
}

/** One SSE frame. JSON.stringify never emits a raw newline, so a single data line carries any message. */
export function sseFrame(json: string, event?: string): string {
  return `${event ? `event: ${event}\n` : ''}data: ${json}\n\n`;
}
