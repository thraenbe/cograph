import * as http from 'http';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import { MAIN_VIEW, type ClientSink } from './viewHub';
import { compilePattern, matchPattern, type CompiledPattern, type TourRoute, type TourRouteRequest } from './routes';
import {
  hostAllowed, postOriginAllowed, tokenMatches, sendStatus, sendBody, readJsonBody,
  resolveUnder, sendFile, sseFrame, BASE_HEADERS,
} from './serverIo';

/**
 * The loopback server behind "Open in browser" and the PR tour (docs/tour-protocol.md
 * section 4). Bound to 127.0.0.1 only, a fresh 32-byte token per start, and every
 * request passes the same gate before anything runs: loopback Host (403), the token
 * (blank 401), and for POST a same-origin Origin / Sec-Fetch-Site (403).
 *
 * No vscode and no GraphProvider import: pages come from `deps.renderPage`, views are
 * anything with the `MirroredView` members (GraphProvider has them).
 */

export { MAIN_VIEW };

/** Where the mirror page of `viewId` is served: the main view at `/`, any other at `/view/<id>`. */
export function viewPath(viewId: string): string {
  return viewId === MAIN_VIEW ? '/' : `/view/${encodeURIComponent(viewId)}`;
}
const KEEPALIVE_MS = 15_000;
/** The bridge's random tab id: it lands in log lines, so nothing but these characters. */
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface MirroredView {
  /** A tab's event stream opened; returns its detach. */
  attachView(clientId: string, sink: ClientSink): () => void;
  /** A tab posted a message (`ready` included). */
  receiveFromView(clientId: string, message: Record<string, unknown>): void;
  replayMessages(): object[];
  /** The directory the view's graph is rooted at (the tour's `stageRoot`). */
  viewRoot(): string;
  /** False once the view's panel is closed: its page and stream then say so instead of showing nothing. */
  isOpen?(): boolean;
}

export interface PageRequest {
  viewId: string;
  view: MirroredView;
  token: string;
  tour?: { tourId: string; assets: boolean };
}

export interface BrowserServerDeps {
  /** The extension's root: /ext/src/webview and /ext/dist/webview are served from it. */
  extensionRoot: string;
  renderPage(page: PageRequest): string;
  log(line: string): void;
  /** Tests: a fixed token. Production leaves it unset. */
  token?: string;
}

interface Mounted { method: 'GET' | 'POST'; compiled: CompiledPattern; route: TourRoute }

export class BrowserServer {
  private readonly views = new Map<string, MirroredView>();
  private readonly tours = new Map<string, { viewId: string; assets: boolean }>();
  private readonly statics: { prefix: string; dir: string }[];
  private readonly mounted: Mounted[] = [];
  private readonly streams = new Set<http.ServerResponse>();
  private disposed = false;

  private constructor(
    private readonly server: http.Server,
    private readonly deps: BrowserServerDeps,
    private readonly token: string,
    readonly port: number,
  ) {
    this.statics = ['src/webview', 'dist/webview'].map(r => ({ prefix: `/ext/${r}`, dir: path.join(deps.extensionRoot, r) }));
  }

  static async start(deps: BrowserServerDeps): Promise<BrowserServer> {
    const token = deps.token ?? crypto.randomBytes(32).toString('hex');
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const instance = new BrowserServer(server, deps, token, (server.address() as AddressInfo).port);
    server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      instance.handle(req, res).catch((err: unknown) => {
        instance.log(`[browser] ${req.method} failed: ${(err as Error).message}`);
        sendStatus(res, 500);
      });
    });
    server.on('error', (err) => instance.log(`[browser] server error: ${err.message}`));
    instance.log(`[browser] listening on 127.0.0.1:${instance.port}`);
    return instance;
  }

  /** Absolute URL with the token: `url('/tour/x', { a: '1' })`. Not yet through asExternalUri. */
  url(urlPath: string, query: Record<string, string> = {}): string {
    const q = new URLSearchParams({ token: this.token, ...query });
    return `http://127.0.0.1:${this.port}${urlPath}?${q.toString()}`;
  }

  registerView(id: string, view: MirroredView): void { this.views.set(id, view); }

  unregisterView(id: string): void {
    this.views.delete(id);
    for (const [tourId, t] of [...this.tours]) { if (t.viewId === id) { this.tours.delete(tourId); } }
  }

  hasView(id: string): boolean { return this.views.has(id); }

  /** Private routes; they run only after the gate. A public route of the same path wins. */
  mount(routes: TourRoute[]): void {
    for (const route of routes) { this.mounted.push({ method: route.method, compiled: compilePattern(route.pattern), route }); }
  }

  /** Serve the files of `dir` under `prefix` (e.g. '/tour-assets'): files only, no traversal. */
  serveStatic(prefix: string, dir: string): void {
    const clean = '/' + prefix.replace(/^\/+|\/+$/g, '');
    this.statics.push({ prefix: clean, dir });
  }

  /** GET /tour/<tourId> (the stage of `viewId` with the tour layer) and GET /tour/<tourId>/graph (its replay). */
  serveTourPage(tourId: string, viewId: string, opts: { assets: boolean }): void {
    if (!this.views.has(viewId)) { throw new Error(`serveTourPage: view "${viewId}" is not registered`); }
    this.tours.set(tourId, { viewId, assets: opts.assets });
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const res of this.streams) { res.end(); }
    this.streams.clear();
    this.server.close();
    // Keep-alive sockets would hold close() open until they time out.
    (this.server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    this.log('[browser] stopped');
  }

  private log(line: string): void { this.deps.log(line.split(this.token).join('<token>')); }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!hostAllowed(req.headers.host)) { sendStatus(res, 403); return; }
    if (!tokenMatches(url.searchParams.get('token'), this.token)) { sendStatus(res, 401); return; }
    const method = req.method === 'POST' ? 'POST' : req.method === 'GET' ? 'GET' : null;
    if (!method) { sendStatus(res, 405); return; }
    if (method === 'POST' && !postOriginAllowed(req.headers)) { sendStatus(res, 403); return; }
    const query = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'token'));
    if (method === 'GET' && await this.handleGet(url.pathname, query, res, req)) { return; }
    if (method === 'POST' && url.pathname === '/msg') { await this.handleMsg(req, res, query); return; }
    await this.handleMounted(method, url.pathname, query, req, res);
  }

  /** The public GET routes; false when none matched. */
  private async handleGet(pathname: string, query: Record<string, string>, res: http.ServerResponse, req: http.IncomingMessage): Promise<boolean> {
    if (pathname === '/') { this.sendPage(res, MAIN_VIEW); return true; }
    const mirror = /^\/view\/([^/]+)$/.exec(pathname);
    if (mirror) { this.sendPage(res, safeDecode(mirror[1]) ?? ''); return true; }
    if (pathname === '/events') { this.openStream(req, res, query); return true; }
    const tour = /^\/tour\/([^/]+)(\/graph)?$/.exec(pathname);
    const known = tour ? this.tours.get(safeDecode(tour[1]) ?? '') : undefined;
    if (tour && known) {
      const tourId = safeDecode(tour[1]) as string;
      if (tour[2]) { this.sendReplay(res, known.viewId); } else { this.sendPage(res, known.viewId, { tourId, assets: known.assets }); }
      return true;
    }
    for (const s of this.statics) {
      if (!pathname.startsWith(s.prefix + '/')) { continue; }
      const file = resolveUnder(s.dir, pathname.slice(s.prefix.length + 1));
      if (!file) { sendStatus(res, 404); return true; }
      sendFile(res, file, (err) => this.log(`[browser] read ${pathname} failed: ${err.message}`));
      return true;
    }
    return false;
  }

  /**
   * A registered view whose panel is still open. A closed one other than the main view is
   * dropped with its tours: a pull-request provider is never shown again (a new one is made),
   * and keeping it would keep its graph alive until VS Code quits.
   */
  private openView(viewId: string): MirroredView | undefined {
    const view = this.views.get(viewId);
    if (!view) { return undefined; }
    if (view.isOpen?.() ?? true) { return view; }
    if (viewId !== MAIN_VIEW) { this.unregisterView(viewId); }
    return undefined;
  }

  private sendPage(res: http.ServerResponse, viewId: string, tour?: { tourId: string; assets: boolean }): void {
    const view = this.openView(viewId);
    if (!view) { sendStatus(res, 404, 'This view is not open in VS Code.'); return; }
    let html: string;
    try {
      html = this.deps.renderPage({ viewId, view, token: this.token, tour });
    } catch (err) {
      this.log(`[browser] page for ${viewId} failed: ${(err as Error).message}`);
      sendStatus(res, 500);
      return;
    }
    sendBody(res, 200, 'text/html; charset=utf-8', html);
  }

  private sendReplay(res: http.ServerResponse, viewId: string): void {
    const view = this.openView(viewId);
    if (!view) { sendStatus(res, 404); return; }
    let json: string;
    try { json = JSON.stringify({ messages: view.replayMessages() }); }
    catch (err) {
      this.log(`[browser] replay of ${viewId} failed: ${(err as Error).message}`);
      sendStatus(res, 500);
      return;
    }
    sendBody(res, 200, 'application/json; charset=utf-8', json);
  }

  /** GET /events?view=&client=: the tab's stream of host → view messages, the replay first. */
  private openStream(req: http.IncomingMessage, res: http.ServerResponse, query: Record<string, string>): void {
    const view = this.openView(query.view ?? '');
    const clientId = query.client ?? '';
    if (!view || !CLIENT_ID.test(clientId)) { sendStatus(res, 404); return; }
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    this.streams.add(res);
    const sink: ClientSink = {
      write: (json) => { res.write(sseFrame(json)); },
      control: (kind) => {
        res.write(sseFrame(JSON.stringify({ kind }), 'control'));
        if (kind === 'closed') { res.end(); }
      },
    };
    const detach = view.attachView(clientId, sink);
    const keepalive = setInterval(() => res.write(': ping\n\n'), KEEPALIVE_MS);
    res.on('close', () => {
      clearInterval(keepalive);
      this.streams.delete(res);
      detach();
    });
  }

  /** POST /msg?view=&client=: one view → host message. */
  private async handleMsg(req: http.IncomingMessage, res: http.ServerResponse, query: Record<string, string>): Promise<void> {
    const body = await readJsonBody(req);
    if (!body.ok) { sendStatus(res, body.status); return; }
    const view = this.openView(query.view ?? '');
    if (!view) { sendStatus(res, 404); return; }
    if (!CLIENT_ID.test(query.client ?? '')) { sendStatus(res, 400); return; }
    const msg = body.value as Record<string, unknown> | null;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') { sendStatus(res, 400); return; }
    try {
      view.receiveFromView(query.client ?? '', msg);
    } catch (err) {
      this.log(`[browser] ${msg.type} from ${query.view} failed: ${(err as Error).message}`);
      sendStatus(res, 500);
      return;
    }
    sendStatus(res, 204);
  }

  private async handleMounted(method: 'GET' | 'POST', pathname: string, query: Record<string, string>, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    for (const m of this.mounted) {
      if (m.method !== method) { continue; }
      const params = matchPattern(m.compiled, pathname);
      if (!params) { continue; }
      let body: unknown;
      if (method === 'POST') {
        const read = await readJsonBody(req);
        if (!read.ok) { sendStatus(res, read.status); return; }
        body = read.value;
      }
      const request: TourRouteRequest = { method, path: pathname, params, query, body };
      try {
        const out = await m.route.handler(request);
        const type = Object.entries(out.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
        sendBody(res, out.status, type ?? 'application/json; charset=utf-8', out.body, out.headers);
      } catch (err) {
        this.log(`[browser] route ${m.route.pattern} failed: ${(err as Error).message}`);
        sendStatus(res, 500);
      }
      return;
    }
    sendStatus(res, 404);
  }
}

function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}
