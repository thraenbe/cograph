import * as assert from 'assert';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BrowserServer, MAIN_VIEW, viewPath, type MirroredView, type PageRequest } from '../../browserView/browserServer';
import { ViewHub, type ClientSink } from '../../browserView/viewHub';
import { compilePattern, matchPattern } from '../../browserView/routes';
import { hostAllowed, postOriginAllowed, sendFile, MAX_BODY_BYTES } from '../../browserView/serverIo';
import { pathOutsideRoot, isUserMessage } from '../../browserView/messageGuard';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const rawFs = require('fs');

// Real sockets on 127.0.0.1; vscode-free, so this suite also runs under plain mocha (coverage).

const TOKEN = 'a'.repeat(64);

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) { req.write(opts.body); }
    req.end();
  });
}

/** Open an SSE stream and collect frames until `until` says enough. */
function stream(port: number, pathQ: string, until: (frames: string[]) => boolean): Promise<{ frames: string[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathQ }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`status ${res.statusCode}`)); return; }
      let buf = '';
      const frames: string[] = [];
      const timer = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(frames)}`)), 3000);
      res.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) { frames.push(buf.slice(0, i)); buf = buf.slice(i + 2); }
        if (until(frames)) { clearTimeout(timer); resolve({ frames, close: () => req.destroy() }); }
      });
    });
    req.on('error', reject);
  });
}

function dataOf(frames: string[]): unknown[] {
  return frames.filter(f => f.startsWith('data: ')).map(f => JSON.parse(f.slice(6)));
}

class FakeView implements MirroredView {
  open = true;
  readonly received: { clientId: string; message: Record<string, unknown> }[] = [];
  readonly hub: ViewHub;
  constructor(private readonly replay: object[] = [{ type: 'subgraph' }, { type: 'graph', data: { nodes: [] } }]) {
    this.hub = new ViewHub({ log: () => undefined, replay: () => this.replay, forward: (m, id) => this.received.push({ clientId: id, message: m }) });
  }
  attachView(clientId: string, sink: ClientSink) { return this.hub.attachClient(clientId, sink); }
  receiveFromView(clientId: string, message: Record<string, unknown>) { this.hub.receive(clientId, message); }
  replayMessages() { return this.replay; }
  viewRoot() { return '/repo'; }
  isOpen() { return this.open; }
}

suite('browserView: BrowserServer', () => {
  let server: BrowserServer;
  let extRoot: string;
  let logs: string[];
  let pages: PageRequest[];
  let view: FakeView;

  setup(async () => {
    extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-browser-'));
    fs.mkdirSync(path.join(extRoot, 'src', 'webview'), { recursive: true });
    fs.mkdirSync(path.join(extRoot, 'dist', 'webview'), { recursive: true });
    fs.writeFileSync(path.join(extRoot, 'src', 'webview', 'state.js'), 'const state = {};');
    fs.writeFileSync(path.join(extRoot, 'dist', 'webview', 'd3.min.js'), '/* d3 */');
    fs.writeFileSync(path.join(extRoot, 'secret.txt'), 'outside the allow-list');
    logs = [];
    pages = [];
    server = await BrowserServer.start({
      extensionRoot: extRoot, token: TOKEN, log: (l) => logs.push(l),
      renderPage: (p) => { pages.push(p); return `<html>${p.viewId}${p.tour ? ` tour=${p.tour.tourId} assets=${p.tour.assets}` : ''}</html>`; },
    });
    view = new FakeView();
    server.registerView(MAIN_VIEW, view);
  });

  teardown(() => {
    server.dispose();
    fs.rmSync(extRoot, { recursive: true, force: true });
  });

  const q = (p: string, extra = '') => `${p}?token=${TOKEN}${extra}`;

  test('binds the loopback only and url() carries the token', () => {
    assert.match(server.url('/'), new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/\\?token=${TOKEN}$`));
    assert.strictEqual(server.url('/tour/x', { a: '1 2' }), `http://127.0.0.1:${server.port}/tour/x?token=${TOKEN}&a=1+2`);
  });

  test('a missing or wrong token gets a blank 401, on every route', async () => {
    for (const p of ['/', '/events?view=main&client=c', '/ext/src/webview/state.js', '/nope']) {
      const r = await request(server.port, { path: p });
      assert.deepStrictEqual([r.status, r.body], [401, ''], p);
    }
    const wrong = await request(server.port, { path: `/?token=${'b'.repeat(64)}` });
    assert.deepStrictEqual([wrong.status, wrong.body], [401, '']);
    const short = await request(server.port, { path: '/?token=a' });
    assert.strictEqual(short.status, 401);
  });

  test('the right token serves the main page with the security headers', async () => {
    const r = await request(server.port, { path: q('/') });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, '<html>main</html>');
    assert.strictEqual(r.headers['referrer-policy'], 'no-referrer');
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.strictEqual(r.headers['x-frame-options'], 'DENY');
    assert.strictEqual(pages[0].token, TOKEN);
  });

  test('a foreign Host is refused with 403 even with the token (DNS rebinding)', async () => {
    const r = await request(server.port, { path: q('/'), headers: { host: 'evil.example:80' } });
    assert.strictEqual(r.status, 403);
    const ok = await request(server.port, { path: q('/'), headers: { host: `localhost:${server.port + 1}` } });
    assert.strictEqual(ok.status, 200, 'a forwarded local port is still the loopback');
  });

  test('a POST with a cross-site Origin or Sec-Fetch-Site gets 403 and never reaches the view', async () => {
    const body = JSON.stringify({ type: 'navigate', file: '/x', line: 1 });
    const evil = await request(server.port, { method: 'POST', path: q('/msg', '&view=main&client=c'), headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body });
    assert.strictEqual(evil.status, 403);
    const site = await request(server.port, { method: 'POST', path: q('/msg', '&view=main&client=c'), headers: { 'sec-fetch-site': 'cross-site' }, body });
    assert.strictEqual(site.status, 403);
    assert.strictEqual(view.received.length, 0);
    const same = await request(server.port, { method: 'POST', path: q('/msg', '&view=main&client=c'), headers: { origin: `http://127.0.0.1:${server.port}`, 'sec-fetch-site': 'same-origin' }, body });
    assert.strictEqual(same.status, 204);
    assert.deepStrictEqual(view.received, [{ clientId: 'c', message: { type: 'navigate', file: '/x', line: 1 } }]);
  });

  test('REGRESSION: a tab on a forwarded origin passes the gate, on that origin only, with either Host the proxy sends', async () => {
    const forwarded = 'https://abc-1234.app.github.dev';
    const post = (host: string, origin: string, token = TOKEN) => request(server.port, {
      method: 'POST', path: `/msg?token=${token}&view=main&client=c1`, headers: { host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'navigate', file: 'x' }),
    });
    const loopback = `localhost:${server.port}`;
    assert.strictEqual((await post(loopback, forwarded)).status, 403, 'unknown until asExternalUri named it');
    assert.strictEqual((await post('abc-1234.app.github.dev', forwarded)).status, 403);

    server.allowForwarded(`${forwarded}/?token=${TOKEN}`);

    assert.strictEqual((await post(loopback, forwarded)).status, 204, 'a proxy that rewrites the Host to the loopback');
    assert.strictEqual((await post('abc-1234.app.github.dev', forwarded)).status, 204, 'a proxy that passes the public Host on');
    assert.strictEqual((await request(server.port, { path: q('/'), headers: { host: 'abc-1234.app.github.dev' } })).status, 200, 'the page itself');
    assert.strictEqual((await post(loopback, 'https://evil-1234.app.github.dev')).status, 403, 'another origin stays out');
    assert.strictEqual((await post('evil-1234.app.github.dev', forwarded)).status, 403, 'another Host stays out');
    assert.strictEqual((await post(loopback, forwarded, 'b'.repeat(64))).status, 401, 'the token still decides');
    assert.strictEqual(view.received.length, 2);
  });

  test('allowForwarded ignores anything but http and https', async () => {
    server.allowForwarded('vscode-remote://ssh-remote+x/y');
    assert.strictEqual((await request(server.port, { path: q('/'), headers: { host: 'ssh-remote+x' } })).status, 403);
  });

  test('static allow-list: the two webview roots, files only, nothing else', async () => {
    const s = await request(server.port, { path: q('/ext/src/webview/state.js') });
    assert.deepStrictEqual([s.status, s.body, s.headers['content-type']], [200, 'const state = {};', 'text/javascript; charset=utf-8']);
    assert.strictEqual((await request(server.port, { path: q('/ext/dist/webview/d3.min.js') })).status, 200);
    assert.strictEqual((await request(server.port, { path: q('/ext/secret.txt') })).status, 404);
    assert.strictEqual((await request(server.port, { path: q('/ext/src/webview') })).status, 404, 'a directory is not a file');
    assert.strictEqual((await request(server.port, { path: q('/ext/src/webview/') })).status, 404);
  });

  test('traversal out of a root is refused, encoded or not, and through a symlink', async () => {
    for (const p of ['/ext/src/webview/../../secret.txt', '/ext/src/webview/%2e%2e/%2e%2e/secret.txt', '/ext/src/webview/..%2f..%2fsecret.txt', '/ext/src/webview/%00state.js']) {
      const r = await request(server.port, { path: q(p) });
      assert.notStrictEqual(r.status, 200, p);
      assert.ok(!r.body.includes('outside the allow-list'), p);
    }
    let linked = false;
    try { fs.symlinkSync(path.join(extRoot, 'secret.txt'), path.join(extRoot, 'src', 'webview', 'link.js')); linked = true; } catch { /* no symlinks here (Windows without rights) */ }
    if (linked) { assert.strictEqual((await request(server.port, { path: q('/ext/src/webview/link.js') })).status, 404); }
  });

  test('REGRESSION: a tab that goes away mid-file closes the file, and that is no error', async () => {
    fs.writeFileSync(path.join(extRoot, 'src', 'webview', 'big.js'), Buffer.alloc(32 * 1024 * 1024, 'x'));
    const opened: fs.ReadStream[] = [];
    const real = rawFs.createReadStream;
    rawFs.createReadStream = (...args: unknown[]) => { const s = real(...args); opened.push(s); return s; };
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port: server.port, path: q('/ext/src/webview/big.js') }, (res) => {
          res.once('data', () => { req.destroy(); resolve(); });
        });
        req.on('error', () => undefined); // our own destroy
        setTimeout(() => reject(new Error('no first chunk')), 3000).unref();
      });
      for (let i = 0; i < 100 && !opened[0]?.destroyed; i++) { await new Promise(r => setTimeout(r, 10)); }
      assert.strictEqual(opened.length, 1);
      assert.strictEqual(opened[0].destroyed, true, 'the file stream must not outlive the response');
      assert.ok(!logs.some(l => l.includes('read /ext')), logs.join('|'));
    } finally {
      rawFs.createReadStream = real;
    }
  });

  test('a read that fails after the headers ends the response and reaches the caller', async () => {
    const errors: string[] = [];
    const host = http.createServer((_req, res) => sendFile(res, path.join(extRoot, 'no-such-file'), (e) => errors.push((e as NodeJS.ErrnoException).code ?? '')));
    await new Promise<void>(r => host.listen(0, '127.0.0.1', () => r()));
    try {
      await assert.rejects(request((host.address() as { port: number }).port, { path: '/' }));
      assert.deepStrictEqual(errors, ['ENOENT']);
    } finally {
      host.close();
    }
  });

  test('serveStatic adds a root with the same rules', async () => {
    const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-assets-'));
    fs.writeFileSync(path.join(assets, 'tour.css'), 'body{}');
    server.serveStatic('/tour-assets', assets);
    const r = await request(server.port, { path: q('/tour-assets/tour.css') });
    assert.deepStrictEqual([r.status, r.headers['content-type']], [200, 'text/css; charset=utf-8']);
    assert.strictEqual((await request(server.port, { path: q('/tour-assets/../secret.txt') })).status, 404);
    fs.rmSync(assets, { recursive: true, force: true });
  });

  test('SSE: replay after ready, one data line per message, live messages behind it', async () => {
    const s = await stream(server.port, q('/events', '&view=main&client=tab1'), (f) => f.length >= 1);
    assert.strictEqual(s.frames[0], 'retry: 2000');
    const done = new Promise<string[]>((resolve) => {
      const check = setInterval(() => { if (dataOf(s.frames).length >= 3) { clearInterval(check); resolve(s.frames); } }, 5);
    });
    await request(server.port, { method: 'POST', path: q('/msg', '&view=main&client=tab1'), body: JSON.stringify({ type: 'ready' }) });
    view.hub.post({ type: 'git-update', text: 'line one\nline two' });
    const frames = await done;
    const msgs = dataOf(frames) as { type: string; __seq: number; text?: string }[];
    assert.deepStrictEqual(msgs.map(m => m.type), ['subgraph', 'graph', 'git-update']);
    assert.deepStrictEqual(msgs.map(m => m.__seq), [1, 2, 3]);
    assert.strictEqual(msgs[2].text, 'line one\nline two', 'a newline inside a message survives the framing');
    for (const f of frames.filter(x => x.startsWith('data: '))) { assert.ok(!f.includes('\n'), 'one line per frame'); }
    s.close();
  });

  test('SSE: closing the view sends a control frame and ends the stream; the client count drops', async () => {
    const s = await stream(server.port, q('/events', '&view=main&client=tab2'), (f) => f.length >= 1);
    assert.strictEqual(view.hub.clientCount(), 1);
    const ended = new Promise<void>((resolve) => {
      const check = setInterval(() => { if (s.frames.some(f => f.startsWith('event: control'))) { clearInterval(check); resolve(); } }, 5);
    });
    view.hub.closeClients();
    await ended;
    assert.ok(s.frames.includes('event: control\ndata: {"kind":"closed"}'));
    assert.strictEqual(view.hub.clientCount(), 0);
    s.close();
  });

  test('SSE: an unknown view or a malformed client id is 404', async () => {
    assert.strictEqual((await request(server.port, { path: q('/events', '&view=nope&client=a') })).status, 404);
    assert.strictEqual((await request(server.port, { path: q('/events', '&view=main&client=a/b') })).status, 404);
    assert.strictEqual((await request(server.port, { path: q('/events', '&view=main') })).status, 404);
  });

  test('a dropped tab connection detaches its client', async () => {
    const s = await stream(server.port, q('/events', '&view=main&client=gone'), (f) => f.length >= 1);
    assert.strictEqual(view.hub.clientCount(), 1);
    s.close();
    const deadline = Date.now() + 2000;
    while (view.hub.clientCount() !== 0 && Date.now() < deadline) { await new Promise(r => setTimeout(r, 10)); }
    assert.strictEqual(view.hub.clientCount(), 0);
  });

  test('POST /msg: body cap 1 MB (413), bad JSON (400), a message without a type (400), unknown view (404)', async () => {
    const big = Buffer.alloc(MAX_BODY_BYTES + 10, 0x20);
    const tooBig = await request(server.port, { method: 'POST', path: q('/msg', '&view=main&client=c'), body: big });
    assert.strictEqual(tooBig.status, 413);
    assert.strictEqual((await request(server.port, { method: 'POST', path: q('/msg', '&view=main&client=c'), body: '{nope' })).status, 400);
    assert.strictEqual((await request(server.port, { method: 'POST', path: q('/msg', '&view=main&client=c'), body: '[1]' })).status, 400);
    assert.strictEqual((await request(server.port, { method: 'POST', path: q('/msg', '&view=main&client=c'), body: '{"x":1}' })).status, 400);
    assert.strictEqual((await request(server.port, { method: 'POST', path: q('/msg', '&view=nope&client=c'), body: '{"type":"x"}' })).status, 404);
    const atCap = Buffer.concat([Buffer.from('{"type":"x","pad":"'), Buffer.alloc(MAX_BODY_BYTES - 40, 0x61), Buffer.from('"}')]);
    assert.strictEqual((await request(server.port, { method: 'POST', path: q('/msg', '&view=main&client=c'), body: atCap })).status, 204);
    assert.strictEqual(view.received.length, 1);
  });

  test('mounted routes run only after the gate, with params, query (no token) and the parsed body', async () => {
    const seen: unknown[] = [];
    server.mount([
      { method: 'GET', pattern: '/tour/:id/script', handler: async (req) => { seen.push(req); return { status: 200, body: '{"ok":true}' }; } },
      { method: 'POST', pattern: '/tour/:id/action', handler: async (req) => { seen.push(req); return { status: 200, headers: { 'Content-Type': 'text/plain', 'Referrer-Policy': 'unsafe-url' }, body: 'done' }; } },
      { method: 'GET', pattern: '/boom', handler: async () => { throw new Error(`secret ${TOKEN}`); } },
    ]);
    assert.strictEqual((await request(server.port, { path: '/tour/t1/script' })).status, 401, 'no token, no route');
    assert.strictEqual((await request(server.port, { path: '/tour/t1/script', headers: { host: 'evil.example' } })).status, 403);
    assert.strictEqual(seen.length, 0);
    const g = await request(server.port, { path: q('/tour/t%201/script', '&a=b') });
    assert.deepStrictEqual([g.status, g.body], [200, '{"ok":true}']);
    assert.deepStrictEqual(seen[0], { method: 'GET', path: '/tour/t%201/script', params: { id: 't 1' }, query: { a: 'b' }, body: undefined });
    const p = await request(server.port, { method: 'POST', path: q('/tour/t1/action'), body: '{"action":"rerun-ai"}' });
    assert.deepStrictEqual([p.status, p.body, p.headers['content-type'], p.headers['referrer-policy']], [200, 'done', 'text/plain', 'no-referrer']);
    assert.deepStrictEqual((seen[1] as { body: unknown }).body, { action: 'rerun-ai' });
    const evil = await request(server.port, { method: 'POST', path: q('/tour/t1/action'), headers: { origin: 'http://evil.example' }, body: '{}' });
    assert.strictEqual(evil.status, 403);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual((await request(server.port, { path: q('/boom') })).status, 500);
    assert.ok(logs.some(l => l.includes('route /boom failed: secret <token>')), logs.join('\n'));
    assert.strictEqual((await request(server.port, { path: q('/tour/t1/nothing') })).status, 404);
    assert.strictEqual((await request(server.port, { method: 'POST', path: q('/tour/t1/script'), body: '{}' })).status, 404, 'method matters');
  });

  test('serveTourPage: the page names the tour and its assets; /graph returns the replay in order', async () => {
    const pr = new FakeView([{ type: 'subgraph' }, { type: 'pr-view' }, { type: 'structure' }, { type: 'graph' }, { type: 'git-update' }]);
    server.registerView('pr-104', pr);
    server.serveTourPage('tour-a', 'pr-104', { assets: true });
    const page = await request(server.port, { path: q('/tour/tour-a') });
    assert.deepStrictEqual([page.status, page.body], [200, '<html>pr-104 tour=tour-a assets=true</html>']);
    assert.strictEqual(pages.at(-1)?.view, pr);
    const graph = await request(server.port, { path: q('/tour/tour-a/graph') });
    assert.strictEqual(graph.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepStrictEqual((JSON.parse(graph.body) as { messages: { type: string }[] }).messages.map(m => m.type),
      ['subgraph', 'pr-view', 'structure', 'graph', 'git-update']);
    assert.strictEqual((await request(server.port, { path: q('/tour/unknown') })).status, 404);
    assert.throws(() => server.serveTourPage('t2', 'not-registered', { assets: false }), /not registered/);
    server.unregisterView('pr-104');
    assert.strictEqual((await request(server.port, { path: q('/tour/tour-a') })).status, 404, 'the tour goes with its view');
  });

  test('a page whose view is gone says so; a failing renderer is a 500 with the token redacted', async () => {
    server.unregisterView(MAIN_VIEW);
    const r = await request(server.port, { path: q('/') });
    assert.deepStrictEqual([r.status, r.body], [404, 'This view is not open in VS Code.']);
    const broken = await BrowserServer.start({ extensionRoot: extRoot, token: TOKEN, log: (l) => logs.push(l), renderPage: () => { throw new Error(`bad ${TOKEN}`); } });
    broken.registerView(MAIN_VIEW, view);
    assert.strictEqual((await request(broken.port, { path: q('/') })).status, 500);
    broken.dispose();
    assert.ok(logs.some(l => l.includes('bad <token>')));
  });

  test('any other view is served at /view/<id>; viewPath names the URL', async () => {
    server.registerView('view-3', new FakeView());
    const r = await request(server.port, { path: q('/view/view-3') });
    assert.deepStrictEqual([r.status, r.body], [200, '<html>view-3</html>']);
    assert.strictEqual((await request(server.port, { path: q('/view/nope') })).status, 404);
    assert.strictEqual(viewPath(MAIN_VIEW), '/');
    assert.strictEqual(viewPath('pr 1'), '/view/pr%201');
  });

  test('a view whose panel closed: page, replay, stream and POST all answer 404', async () => {
    server.registerView('pr', view);
    server.serveTourPage('t', 'pr', { assets: false });
    view.open = false;
    for (const p of [q('/'), q('/view/pr'), q('/tour/t'), q('/tour/t/graph'), q('/events', '&view=pr&client=c')]) {
      const r = await request(server.port, { path: p });
      assert.strictEqual(r.status, 404, p);
    }
    assert.strictEqual((await request(server.port, { path: q('/') })).body, 'This view is not open in VS Code.');
    assert.strictEqual((await request(server.port, { method: 'POST', path: q('/msg', '&view=main&client=c'), body: '{"type":"navigate"}' })).status, 404);
    assert.strictEqual(view.received.length, 0);
    assert.strictEqual(server.hasView('pr'), false, 'a closed view other than main is dropped, its tours with it');
    assert.strictEqual(server.hasView(MAIN_VIEW), true, 'main stays: the same provider shows its panel again');
    view.open = true;
    assert.strictEqual((await request(server.port, { path: q('/') })).status, 200);
    assert.strictEqual((await request(server.port, { path: q('/tour/t') })).status, 404);
  });

  test('POST /msg refuses a malformed client id (it would land in log lines)', async () => {
    for (const client of ['', 'a%0Ab', 'x'.repeat(65), 'a/b']) {
      const r = await request(server.port, { method: 'POST', path: q('/msg', `&view=main&client=${client}`), body: '{"type":"navigate"}' });
      assert.strictEqual(r.status, 400, client);
    }
    assert.strictEqual(view.received.length, 0);
  });

  test('other methods are 405; the token never appears in any log line', async () => {
    assert.strictEqual((await request(server.port, { method: 'PUT', path: q('/') })).status, 405);
    assert.ok(logs.length > 0);
    for (const l of logs) { assert.ok(!l.includes(TOKEN), l); }
  });

  test('REGRESSION: after dispose a kept-alive socket gets no answer, also where Node has no closeAllConnections', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const viaAgent = () => new Promise<number>((resolve, reject) => {
      http.get({ agent, host: '127.0.0.1', port: server.port, path: q('/') }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); }).on('error', reject);
    });
    try {
      assert.strictEqual(await viaAgent(), 200);
      // Node 16 as VS Code 1.75 ships it: close() leaves an idle socket alone.
      const raw = (server as unknown as { server: { closeAllConnections?: unknown; closeIdleConnections?: unknown } }).server;
      raw.closeAllConnections = undefined;
      raw.closeIdleConnections = () => undefined;
      server.dispose();
      await assert.rejects(viaAgent());
    } finally {
      agent.destroy();
    }
  });

  test('dispose stops listening; a fresh start gets a fresh random token', async () => {
    const port = server.port;
    server.dispose();
    await assert.rejects(request(port, { path: q('/') }));
    const a = await BrowserServer.start({ extensionRoot: extRoot, log: () => undefined, renderPage: () => '' });
    const b = await BrowserServer.start({ extensionRoot: extRoot, log: () => undefined, renderPage: () => '' });
    const tokenOf = (s: BrowserServer) => new URL(s.url('/')).searchParams.get('token') ?? '';
    assert.match(tokenOf(a), /^[0-9a-f]{64}$/);
    assert.notStrictEqual(tokenOf(a), tokenOf(b));
    a.dispose(); b.dispose();
  });
});

suite('browserView: request guards', () => {
  test('hostAllowed: loopback names with any port, nothing else', () => {
    for (const h of ['127.0.0.1', '127.0.0.1:1234', 'localhost:9', 'LOCALHOST', '[::1]:80']) { assert.ok(hostAllowed(h), h); }
    for (const h of [undefined, '', 'evil.example', '127.0.0.1.evil.example', 'localhost.evil:80', '10.0.0.1:80', '[::2]']) { assert.ok(!hostAllowed(h), String(h)); }
  });

  test('postOriginAllowed: same origin or none; cross-site metadata refused', () => {
    assert.ok(postOriginAllowed({ host: '127.0.0.1:5' }));
    assert.ok(postOriginAllowed({ host: '127.0.0.1:5', origin: 'http://127.0.0.1:5', 'sec-fetch-site': 'same-origin' }));
    assert.ok(!postOriginAllowed({ host: '127.0.0.1:5', origin: 'http://127.0.0.1:6' }));
    assert.ok(!postOriginAllowed({ host: '127.0.0.1:5', origin: 'null' }));
    assert.ok(!postOriginAllowed({ host: '127.0.0.1:5', 'sec-fetch-site': 'same-site' }));
  });

  test('the forwarded host and origin are exact, case-insensitive for the host only', () => {
    assert.strictEqual(hostAllowed('abc.app.github.dev', new Set(['abc.app.github.dev'])), true);
    assert.strictEqual(hostAllowed('ABC.app.github.dev', new Set(['abc.app.github.dev'])), true);
    assert.strictEqual(hostAllowed('x.abc.app.github.dev', new Set(['abc.app.github.dev'])), false);
    assert.strictEqual(postOriginAllowed({ host: 'localhost:9', origin: 'https://a.dev' }, new Set(['https://a.dev'])), true);
    assert.strictEqual(postOriginAllowed({ host: 'localhost:9', origin: 'http://a.dev' }, new Set(['https://a.dev'])), false);
    assert.strictEqual(postOriginAllowed({ host: 'localhost:9', origin: 'https://a.dev', 'sec-fetch-site': 'cross-site' }, new Set(['https://a.dev'])), false, 'fetch metadata still refuses');
  });

  test('route patterns: params never span a slash, specials are literal, bad escapes do not match', () => {
    const c = compilePattern('/tour/:id/script');
    assert.deepStrictEqual(matchPattern(c, '/tour/abc/script'), { id: 'abc' });
    assert.strictEqual(matchPattern(c, '/tour/a/b/script'), null);
    assert.strictEqual(matchPattern(c, '/tour/%E0%A4%A/script'), null);
    assert.strictEqual(matchPattern(compilePattern('/a.b'), '/aXb'), null);
  });
});

suite('browserView: message guard', () => {
  const root = path.resolve('/work/repo');
  const at = (...p: string[]) => path.join(root, ...p);

  test('paths under the root pass, in every field', () => {
    assert.strictEqual(pathOutsideRoot({ type: 'save-func-source', file: at('src', 'a.ts') }, root), null);
    assert.strictEqual(pathOutsideRoot({ type: 'request-new-file', folderPath: root }, root), null);
    assert.strictEqual(pathOutsideRoot({ type: 'expand-folder', folderPath: at('src'), files: [at('src', 'a.ts'), at('src', 'b.ts')] }, root), null);
    assert.strictEqual(pathOutsideRoot({ type: 'navigate', file: null, line: 1 }, root), null, 'library nodes carry no file');
    assert.strictEqual(pathOutsideRoot({ type: 'open-docs', libraryName: 'x' }, root), null);
  });

  test('a path outside the root, or escaping it, is named', () => {
    const outside = path.resolve('/etc/passwd');
    assert.strictEqual(pathOutsideRoot({ type: 'get-func-source', file: outside }, root), outside);
    assert.strictEqual(pathOutsideRoot({ type: 'save-func-source', file: at('..', 'other', 'x.ts') }, root), at('..', 'other', 'x.ts'));
    assert.strictEqual(pathOutsideRoot({ type: 'parse-file', filePath: path.resolve('/work/repo-evil/x.ts') }, root), path.resolve('/work/repo-evil/x.ts'), 'a sibling with the same prefix is outside');
    assert.strictEqual(pathOutsideRoot({ type: 'expand-folder', folderPath: at('src'), files: [at('src', 'a.ts'), outside] }, root), outside);
    assert.strictEqual(pathOutsideRoot({ type: 'request-rename-folder', folderPath: path.resolve('/work') }, root), path.resolve('/work'));
  });

  test('a relative path is refused in every field: fs would resolve it against the host, not the root', () => {
    assert.strictEqual(pathOutsideRoot({ type: 'get-func-source', file: 'src/a.ts' }, root), 'src/a.ts');
    assert.strictEqual(pathOutsideRoot({ type: 'save-func-source', file: '.ssh/id_rsa' }, root), '.ssh/id_rsa');
    assert.strictEqual(pathOutsideRoot({ type: 'parse-file', filePath: 'a.ts' }, root), 'a.ts');
    assert.strictEqual(pathOutsideRoot({ type: 'request-new-file', folderPath: 'src' }, root), 'src');
    assert.strictEqual(pathOutsideRoot({ type: 'expand-folder', folderPath: at('src'), files: [at('src', 'a.ts'), 'b.ts'] }, root), 'b.ts');
  });

  test('a path field that is not a string is refused: fs opens a URL-shaped object', () => {
    const url = { href: 'x', protocol: 'file:', pathname: '/etc/passwd', hostname: '' };
    assert.notStrictEqual(pathOutsideRoot({ type: 'get-func-source', file: url }, root), null);
    assert.notStrictEqual(pathOutsideRoot({ type: 'expand-folder', folderPath: at('src'), files: [url] }, root), null);
  });

  test('no root: nothing to confine to', () => {
    assert.strictEqual(pathOutsideRoot({ type: 'navigate', file: '/anything' }, ''), null);
  });

  test('diagnostics are passive, everything else is the user', () => {
    for (const t of ['ready', 'perf-report', 'webview-log', 'get-annotations']) { assert.strictEqual(isUserMessage({ type: t }), false, t); }
    for (const t of ['navigate', 'save-graph', 'dirty-state', 'expand-folder', 'subgraph-include']) { assert.strictEqual(isUserMessage({ type: t }), true, t); }
    assert.strictEqual(isUserMessage({}), false);
  });
});
