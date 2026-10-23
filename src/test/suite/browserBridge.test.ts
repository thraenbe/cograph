import * as assert from 'assert';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bridgeLib = require('../../../src/webview/browserBridge.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hs = require('../../../src/webview/readyHandshake.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A controllable EventSource: the test opens, feeds and fails it. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closedByBridge = false;
  private readonly listeners: Record<string, ((e: { data: string }) => void)[]> = {};
  constructor(readonly url: string) { FakeEventSource.last = this; }
  addEventListener(name: string, fn: (e: { data: string }) => void) { (this.listeners[name] ??= []).push(fn); }
  close() { this.readyState = 2; this.closedByBridge = true; }
  open() { this.readyState = 1; this.onopen?.(); }
  data(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  raw(data: string) { this.onmessage?.({ data }); }
  control(kind: string) { for (const fn of this.listeners.control ?? []) { fn({ data: JSON.stringify({ kind }) }); } }
  fail(closed = false) { this.readyState = closed ? 2 : 0; this.onerror?.(); }
}

interface Harness {
  win: any;
  doc: Document;
  posts: { url: string; body: any }[];
  reloads: number;
  status: any;
  respond: (status: number) => void;
}

function makeHarness(opts: { loading?: boolean; config?: unknown } = {}): Harness {
  const dom = new JSDOM('<!DOCTYPE html><body></body>', { url: 'http://127.0.0.1:4321/?token=t' });
  const real = dom.window as any;
  // jsdom's location cannot be replaced: the bridge gets a window facade over the real one.
  const win: any = {
    document: real.document, crypto: real.crypto, sessionStorage: real.sessionStorage,
    addEventListener: real.addEventListener.bind(real),
    postMessage: (m: unknown, target: string) => real.postMessage(m, target),
  };
  const h: Harness = { win, doc: win.document, posts: [], reloads: 0, status: null, respond: () => undefined };
  let status = 204;
  h.respond = (s) => { status = s; };
  win.COGRAPH_BROWSER = opts.config ?? { view: 'main', eventsUrl: '/events?token=t&view=main', msgUrl: '/msg?token=t&view=main' };
  win.EventSource = FakeEventSource;
  win.fetch = (url: string, init: { body: string }) => {
    h.posts.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve({ ok: status < 300, status });
  };
  win.location = { origin: 'http://127.0.0.1:4321', reload: () => { h.reloads += 1; } };
  // jsdom's own document is still 'loading' right after construction; the facade says which case is tested.
  const doc: any = {
    readyState: opts.loading ? 'loading' : 'complete',
    addEventListener: (n: string, cb: () => void) => { doc[`on${n}`] = cb; },
    getElementById: (id: string) => real.document.getElementById(id),
    createElement: (t: string) => real.document.createElement(t),
    body: real.document.body,
  };
  h.doc = doc as Document;
  FakeEventSource.last = null;
  h.status = bridgeLib.installBrowserBridge(win, doc);
  return h;
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const received = (win: any) => {
  const got: any[] = [];
  win.addEventListener('message', (e: any) => got.push(e.data));
  return got;
};

suite('browserView: browserBridge.js', () => {
  test('installs acquireVsCodeApi and opens the stream with its client id', () => {
    const h = makeHarness();
    assert.strictEqual(typeof h.win.acquireVsCodeApi, 'function');
    assert.match(FakeEventSource.last?.url ?? '', /^\/events\?token=t&view=main&client=[0-9a-f]{16}$/);
    assert.strictEqual(h.win.__cographBridge.clientId, h.status.clientId);
  });

  test('no config, no bridge: the panel page never gets the shim', () => {
    const dom = new JSDOM('<!DOCTYPE html><body></body>');
    assert.strictEqual(bridgeLib.installBrowserBridge(dom.window, dom.window.document), null);
    assert.strictEqual((dom.window as any).acquireVsCodeApi, undefined);
  });

  test('the stream waits for DOMContentLoaded while the document is loading', () => {
    const h = makeHarness({ loading: true });
    assert.strictEqual(FakeEventSource.last, null, 'listeners of later scripts are not attached yet');
    (h.doc as any).onDOMContentLoaded();
    assert.ok(FakeEventSource.last);
  });

  test('posts wait for the stream; on open `ready` goes first, then the rest in order, one ready only', async () => {
    const h = makeHarness();
    const api = h.win.acquireVsCodeApi();
    api.postMessage({ type: 'ready' });          // readyHandshake's own
    api.postMessage({ type: 'perf-report', n: 1 });
    assert.strictEqual(h.posts.length, 0);
    FakeEventSource.last!.open();
    api.postMessage({ type: 'expand-folder', folderPath: '/r/a' });
    await flush(); await flush(); await flush();
    assert.deepStrictEqual(h.posts.map(p => p.body.type), ['ready', 'perf-report', 'expand-folder']);
    assert.match(h.posts[0].url, /^\/msg\?token=t&view=main&client=[0-9a-f]{16}$/);
    assert.strictEqual(h.posts[0].url.split('client=')[1], FakeEventSource.last!.url.split('client=')[1]);
  });

  test('POSTs are sequential: the next starts only after the previous answered', async () => {
    const h = makeHarness();
    let release: (() => void) | undefined;
    const order: string[] = [];
    h.win.fetch = (_url: string, init: { body: string }) => {
      const type = JSON.parse(init.body).type;
      order.push(`start ${type}`);
      return new Promise((resolve) => { const done = () => { order.push(`end ${type}`); resolve({ ok: true, status: 204 }); }; if (type === 'ready') { release = done; } else { done(); } });
    };
    FakeEventSource.last!.open();
    h.win.acquireVsCodeApi().postMessage({ type: 'navigate' });
    await flush();
    assert.deepStrictEqual(order, ['start ready']);
    release!();
    await flush(); await flush();
    assert.deepStrictEqual(order, ['start ready', 'end ready', 'start navigate', 'end navigate']);
  });

  test('an SSE event becomes a window message for the page, with the same-origin target', async () => {
    const h = makeHarness();
    const got = received(h.win);
    const targets: string[] = [];
    const inner = h.win.postMessage;
    h.win.postMessage = (m: unknown, target: string) => { targets.push(target); inner(m, target); };
    FakeEventSource.last!.open();
    FakeEventSource.last!.data({ type: 'graph', __seq: 1, data: { nodes: [] } });
    await flush();
    assert.deepStrictEqual(got, [{ type: 'graph', __seq: 1, data: { nodes: [] } }]);
    assert.deepStrictEqual(targets, ['http://127.0.0.1:4321']);
  });

  test('a re-sent __seq is still dropped by readyHandshake, as in the panel', async () => {
    const h = makeHarness();
    hs.installSeqDedupe(h.win);
    const got = received(h.win);
    FakeEventSource.last!.open();
    FakeEventSource.last!.data({ type: 'structure', __seq: 1 });
    FakeEventSource.last!.data({ type: 'structure', __seq: 1 });
    await flush();
    assert.strictEqual(got.length, 1);
  });

  test('a malformed event is recorded, not dispatched', async () => {
    const h = makeHarness();
    const got = received(h.win);
    FakeEventSource.last!.open();
    FakeEventSource.last!.raw('{not json');
    await flush();
    assert.strictEqual(got.length, 0);
    assert.ok(h.status.errors.some((e: string) => e.startsWith('bad event')));
  });

  test('control reload reloads; control closed ends the stream and shows the closed banner', () => {
    const h = makeHarness();
    FakeEventSource.last!.open();
    FakeEventSource.last!.control('reload');
    assert.strictEqual(h.reloads, 1);
    FakeEventSource.last!.control('closed');
    assert.ok(FakeEventSource.last!.closedByBridge);
    const banner = h.win.document.getElementById('browser-banner');
    assert.strictEqual(banner?.dataset.kind, 'closed');
    assert.strictEqual(banner?.textContent, bridgeLib.BRIDGE_TEXT.closed);
    assert.strictEqual(banner?.getAttribute('role'), 'alert');
  });

  test('a reconnect reloads the tab instead of patching a page that missed messages', () => {
    const h = makeHarness();
    const es = FakeEventSource.last!;
    es.open();
    es.fail();
    assert.strictEqual(h.reloads, 0);
    es.open();
    assert.strictEqual(h.reloads, 1);
  });

  test('the banner appears after three failed reconnects, not before', () => {
    const h = makeHarness();
    const es = FakeEventSource.last!;
    es.fail(); es.fail();
    assert.strictEqual(h.win.document.getElementById('browser-banner'), null);
    es.fail();
    assert.strictEqual(h.win.document.getElementById('browser-banner')?.dataset.kind, 'lost');
    assert.ok(es.closedByBridge);
  });

  test('a stream the browser gave up on (401 after a VS Code restart) shows the banner at once', () => {
    const h = makeHarness();
    FakeEventSource.last!.fail(true);
    assert.strictEqual(h.win.document.getElementById('browser-banner')?.dataset.kind, 'lost');
  });

  test('a refused POST shows the banner and is recorded', async () => {
    const h = makeHarness();
    h.respond(401);
    FakeEventSource.last!.open();
    await flush(); await flush();
    assert.strictEqual(h.win.document.getElementById('browser-banner')?.dataset.kind, 'lost');
    assert.ok(h.status.errors.some((e: string) => e.includes('POST ready refused (401)')));
  });

  test('a network failure of a POST shows the banner; later posts still go out', async () => {
    const h = makeHarness();
    let n = 0;
    h.win.fetch = () => (++n === 1 ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true, status: 204 }));
    FakeEventSource.last!.open();
    h.win.acquireVsCodeApi().postMessage({ type: 'navigate' });
    await flush(); await flush(); await flush();
    assert.strictEqual(n, 2);
    assert.ok(h.status.errors.some((e: string) => e.includes('POST ready failed (offline)')));
  });

  test('getState/setState persist per view in sessionStorage; a storage error is soft', () => {
    const h = makeHarness();
    const api = h.win.acquireVsCodeApi();
    assert.strictEqual(api.getState(), undefined);
    assert.deepStrictEqual(api.setState({ zoom: 2 }), { zoom: 2 });
    assert.deepStrictEqual(api.getState(), { zoom: 2 });
    assert.strictEqual(h.win.sessionStorage.getItem('cograph-state:main'), '{"zoom":2}');
    h.win.sessionStorage.setItem('cograph-state:main', '{broken');
    assert.strictEqual(api.getState(), undefined);
    assert.strictEqual(h.win.document.getElementById('browser-banner'), null, 'storage trouble is not a lost connection');
  });

  test('the banner element is reused, not stacked', () => {
    const h = makeHarness();
    bridgeLib.bridgeShowBanner(h.win.document, 'lost');
    bridgeLib.bridgeShowBanner(h.win.document, 'closed');
    assert.strictEqual(h.win.document.querySelectorAll('#browser-banner').length, 1);
    assert.strictEqual(h.win.document.getElementById('browser-banner')?.textContent, bridgeLib.BRIDGE_TEXT.closed);
  });
});
