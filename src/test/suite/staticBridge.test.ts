import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import { docsUrl } from '../../docsUrl';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bridgeLib = require('../../../src/webview/staticBridge.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const hs = require('../../../src/webview/readyHandshake.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

const REPLAY = [
  { type: 'subgraph', include: [] },
  { type: 'pr-view', active: true, readOnly: true },
  { type: 'structure', tree: {} },
  { type: 'graph', data: { nodes: [], edges: [], files: [] } },
];

const SLICE = {
  source: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'),
  signature: 'def f(x)', doc: 'Does f.', body: Array.from({ length: 19 }, (_, i) => `line ${i + 2}`).join('\n'),
  endLine: 29, totalLines: 20, endReason: 'detected',
};

interface Harness {
  win: any;
  api: any;
  /** What reached window.postMessage, with its target. */
  sent: any[];
  targets: string[];
  logged: any[];
  tabs: any[][];
  open(extra?: Record<string, unknown>): void;
}

function makeHarness(opts: { light?: boolean; html?: string; storageThrows?: boolean } = {}): Harness {
  const html = opts.html ?? '<!DOCTYPE html><head><meta name="cograph-worker" content="simWorker.abc.js"></head><body class="cg-browser"></body>';
  const win: any = new JSDOM(html).window;
  const h: Harness = { win, api: null, sent: [], targets: [], logged: [], tabs: [], open: () => undefined };
  win.matchMedia = (q: string) => ({ matches: opts.light === true && q === '(prefers-color-scheme: light)' });
  win.open = (...args: unknown[]) => { h.tabs.push(args); return null; };
  win.postMessage = (m: unknown, target: string) => { h.sent.push(m); h.targets.push(target); };
  if (opts.storageThrows) {
    Object.defineProperty(win, 'sessionStorage', { get() { throw new Error('SecurityError'); } });
  }
  bridgeLib.installStaticBridge(win, win.document, { docsUrl });
  h.api = win.acquireVsCodeApi();
  h.open = (extra = {}) => win.__cographStaticBridge.open({
    replay: REPLAY, sources: { 'src/a.py:10': SLICE }, stageRoot: '/repo',
    fileLink: (file: string, line: number) => `https://github.com/o/r/blob/abc/${file.replace('/repo/', '')}#L${line}`,
    log: (entry: unknown) => h.logged.push(entry),
    ...extra,
  });
  return h;
}

/** Past the replay, so `sent` holds only what the test's own message caused. */
function opened(extra?: Record<string, unknown>): Harness {
  const h = makeHarness();
  h.open(extra);
  h.api.postMessage({ type: 'ready' });
  h.sent.length = 0;
  h.targets.length = 0;
  return h;
}

suite('staticBridge.js: boot', () => {
  test('defines acquireVsCodeApi, COGRAPH_CONFIG and the open() seam', () => {
    const h = makeHarness();
    assert.deepStrictEqual({ ...h.win.COGRAPH_CONFIG }, {
      defaultEngine: 'shelf', defaultMode: 'static', perf: false, workers: 'auto', workerUri: 'simWorker.abc.js', sameFileEdgesOnly: true,
    });
    assert.strictEqual(typeof h.win.__cographStaticBridge.open, 'function');
  });

  test('a page without the worker meta runs the simulations on the main thread', () => {
    const h = makeHarness({ html: '<!DOCTYPE html><body></body>' });
    assert.strictEqual(h.win.COGRAPH_CONFIG.workerUri, null);
  });

  test('the body class follows prefers-color-scheme, dark otherwise', () => {
    assert.ok(makeHarness({ light: true }).win.document.body.classList.contains('vscode-light'));
    const dark = makeHarness();
    assert.ok(dark.win.document.body.classList.contains('vscode-dark'));
    assert.ok(!dark.win.document.body.classList.contains('vscode-light'));
    assert.ok(dark.win.document.body.classList.contains('cg-browser'), 'the template class stays');
  });

  test('state lives in memory: it works where the browser storage throws, as under sandbox', () => {
    const h = makeHarness({ storageThrows: true });
    assert.strictEqual(h.api.getState(), undefined);
    assert.deepStrictEqual(h.api.setState({ zoom: 2 }), { zoom: 2 });
    assert.deepStrictEqual(h.api.getState(), { zoom: 2 });
  });

  test('the file names neither the storage nor the origin the sandbox takes away', () => {
    const text = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'src', 'webview', 'staticBridge.js'), 'utf8');
    assert.ok(!text.includes('sessionStorage'));
    assert.ok(!text.includes('location.origin'));
  });
});

suite('staticBridge.js: ready and open()', () => {
  test('ready first: nothing moves until open(), then the replay in order', () => {
    const h = makeHarness();
    h.api.postMessage({ type: 'ready' });
    assert.strictEqual(h.sent.length, 0);
    h.open();
    assert.deepStrictEqual(h.sent.map(m => m.type), ['subgraph', 'pr-view', 'structure', 'graph']);
  });

  test('open() first: nothing moves until ready, then the replay in order', () => {
    const h = makeHarness();
    h.open();
    assert.strictEqual(h.sent.length, 0);
    h.api.postMessage({ type: 'ready' });
    assert.deepStrictEqual(h.sent.map(m => m.type), ['subgraph', 'pr-view', 'structure', 'graph']);
  });

  test('every message goes to *: a page in an opaque origin cannot name its own', () => {
    const h = makeHarness();
    h.open();
    h.api.postMessage({ type: 'ready' });
    h.api.postMessage({ type: 'expand-folder', folderPath: '/repo/src' });
    assert.strictEqual(h.targets.length, 5);
    assert.ok(h.targets.every(t => t === '*'), h.targets.join());
  });

  test('one replay: a second ready repeats nothing', () => {
    const h = opened();
    h.api.postMessage({ type: 'ready' });
    assert.strictEqual(h.sent.length, 0);
  });

  test('open() twice is a programming error, and open() needs the replay', () => {
    const h = makeHarness();
    assert.throws(() => h.win.__cographStaticBridge.open({ sources: null }), /replay/);
    h.open();
    assert.throws(() => h.open(), /once per page/);
  });

  test('a request before open() waits, and is answered after the replay', () => {
    const h = makeHarness();
    h.api.postMessage({ type: 'get-func-source', file: '/repo/src/a.py', line: 10, reqId: 'r1' });
    h.api.postMessage({ type: 'ready' });
    assert.strictEqual(h.sent.length, 0);
    h.open();
    assert.deepStrictEqual(h.sent.map(m => m.type), ['subgraph', 'pr-view', 'structure', 'graph', 'func-source']);
  });

  test('a request between open() and ready waits too', () => {
    const h = makeHarness();
    h.open();
    h.api.postMessage({ type: 'expand-folder', folderPath: '/repo/src' });
    assert.strictEqual(h.sent.length, 0);
    h.api.postMessage({ type: 'ready' });
    assert.deepStrictEqual(h.sent.map(m => m.type), ['subgraph', 'pr-view', 'structure', 'graph', 'graph-patch']);
  });

  test('a log entry from before open() reaches the log given at open()', () => {
    const h = makeHarness();
    h.api.postMessage({ type: 'webview-log', entry: { msg: 'early' } });
    h.api.postMessage({ type: 'ready' });
    h.open();
    assert.deepStrictEqual(h.logged, [{ event: 'webview-log', entry: { msg: 'early' } }]);
  });

  test('sources, fileLink and log are optional', () => {
    const h = makeHarness();
    h.win.__cographStaticBridge.open({ replay: REPLAY, stageRoot: '/repo' });
    h.api.postMessage({ type: 'ready' });
    h.sent.length = 0;
    h.api.postMessage({ type: 'get-func-source', file: '/repo/src/a.py', line: 10, reqId: 'r1' });
    h.api.postMessage({ type: 'navigate', file: '/repo/src/a.py', line: 10 });
    h.api.postMessage({ type: 'no-such-message' });
    assert.strictEqual(h.sent[0].error, bridgeLib.STATIC_NOT_IN_TOUR);
    assert.deepStrictEqual(h.tabs, []);
  });
});

suite('staticBridge.js: the handler table', () => {
  test('expand-folder answers an empty patch naming the folder, so stageApi.expand never waits', () => {
    const h = opened();
    h.api.postMessage({ type: 'expand-folder', folderPath: '/repo/src', files: ['/repo/src/a.py'] });
    assert.deepStrictEqual(h.sent, [{ type: 'graph-patch', parsedFolder: '/repo/src', patch: { nodes: [], edges: [], files: [] } }]);
  });

  test('parse-file answers the same for the file\'s folder', () => {
    const h = opened();
    h.api.postMessage({ type: 'parse-file', filePath: '/repo/src/a.py' });
    assert.strictEqual(h.sent[0].parsedFolder, '/repo/src');
  });

  test('the hover gets the slice cut as the host cuts it', () => {
    const h = opened();
    h.api.postMessage({ type: 'get-func-source', file: '/repo/src/a.py', line: 10, maxLines: 8, reqId: 'r1' });
    const m = h.sent[0];
    assert.strictEqual(m.reqId, 'r1');
    assert.strictEqual(m.source.split('\n').length, 8);
    assert.strictEqual(m.body.split('\n').length, 8);
    assert.strictEqual(m.signature, 'def f(x)');
    assert.strictEqual(m.doc, 'Does f.');
    assert.strictEqual(m.endLine, 17);
    assert.strictEqual(m.totalLines, 20);
    assert.strictEqual(m.endReason, 'maxLines');
  });

  test('a function shorter than the peek keeps its end and its reason', () => {
    const h = opened();
    h.api.postMessage({ type: 'get-func-source', file: '/repo/src/a.py', line: 10, maxLines: 40, reqId: 'r1' });
    assert.strictEqual(h.sent[0].source, SLICE.source);
    assert.strictEqual(h.sent[0].endLine, 29);
    assert.strictEqual(h.sent[0].endReason, 'detected');
  });

  test('a peek asking for more than the host allows is capped', () => {
    const long = { ...SLICE, source: Array.from({ length: 200 }, () => 'x').join('\n') };
    const h = opened({ sources: { 'src/a.py:10': long } });
    h.api.postMessage({ type: 'get-func-source', file: '/repo/src/a.py', line: 10, maxLines: 500, reqId: 'r1' });
    assert.strictEqual(h.sent[0].source.split('\n').length, 80);
  });

  test('the popup gets the whole slice', () => {
    const h = opened();
    h.api.postMessage({ type: 'get-func-source', file: '/repo/src/a.py', line: 10, reqId: 'r1' });
    assert.deepStrictEqual(h.sent, [{ type: 'func-source', reqId: 'r1', source: SLICE.source, endLine: 29 }]);
  });

  test('colorizedHtml never leaves a slice: popups.js assigns it to innerHTML', () => {
    const hostile = { ...SLICE, colorizedHtml: '<img src=x onerror=alert(1)>', error: 'forged', type: 'graph', reqId: 'forged' };
    for (const maxLines of [undefined, 8]) {
      const h = opened({ sources: { 'src/a.py:10': hostile } });
      h.api.postMessage({ type: 'get-func-source', file: '/repo/src/a.py', line: 10, maxLines, reqId: 'r1' });
      const m = h.sent[0];
      assert.strictEqual(m.type, 'func-source');
      assert.strictEqual(m.reqId, 'r1');
      assert.ok(!('colorizedHtml' in m));
      assert.ok(!('error' in m));
    }
  });

  test('a slice field that is not text arrives as empty text', () => {
    const h = opened({ sources: { 'src/a.py:10': { source: { toString: 1 }, signature: 7, doc: [], body: null } } });
    h.api.postMessage({ type: 'get-func-source', file: '/repo/src/a.py', line: 10, maxLines: 8, reqId: 'r1' });
    assert.deepStrictEqual([h.sent[0].source, h.sent[0].signature, h.sent[0].doc, h.sent[0].body], ['', '', '', '']);
  });

  test('an unchanged function: the hover gets the sentence, the popup also the link', () => {
    const h = opened();
    h.api.postMessage({ type: 'get-func-source', file: '/repo/src/b.py', line: 3, maxLines: 8, reqId: 'r1' });
    h.api.postMessage({ type: 'get-func-source', file: '/repo/src/b.py', line: 3, reqId: 'r2' });
    assert.deepStrictEqual(h.sent[0], { type: 'func-source', reqId: 'r1', source: '', error: 'This function is not part of the tour.' });
    assert.deepStrictEqual(h.sent[1], {
      type: 'func-source', reqId: 'r2', source: '',
      error: 'This function is not part of the tour.\nhttps://github.com/o/r/blob/abc/src/b.py#L3',
    });
  });

  test('no slices at all, and no link: the sentence alone', () => {
    const h = opened({ sources: null, fileLink: () => null });
    h.api.postMessage({ type: 'get-func-source', file: '/repo/src/a.py', line: 10, reqId: 'r1' });
    assert.strictEqual(h.sent[0].error, 'This function is not part of the tour.');
  });

  test('a path outside the root is looked up as it is, and misses', () => {
    const h = opened();
    h.api.postMessage({ type: 'get-func-source', file: '/repository/src/a.py', line: 10, reqId: 'r1' });
    assert.strictEqual(h.sent[0].source, '');
  });

  test('navigate opens the link in a new tab, with no opener and no referrer', () => {
    const h = opened();
    h.api.postMessage({ type: 'navigate', file: '/repo/src/a.py', line: 12 });
    assert.deepStrictEqual(h.tabs, [['https://github.com/o/r/blob/abc/src/a.py#L12', '_blank', 'noopener,noreferrer']]);
  });

  test('navigate with no link does nothing visible and says so in the log', () => {
    const h = opened({ fileLink: () => null });
    h.api.postMessage({ type: 'navigate', file: '/repo/src/a.py', line: 12 });
    assert.deepStrictEqual(h.tabs, []);
    assert.deepStrictEqual(h.logged, [{ event: 'no-link', file: '/repo/src/a.py' }]);
  });

  test('open-docs opens docsUrl, not fileLink', () => {
    const h = opened({ fileLink: () => { throw new Error('not a file'); } });
    h.api.postMessage({ type: 'open-docs', libraryName: 'os.path', language: 'python' });
    assert.deepStrictEqual(h.tabs, [['https://docs.python.org/3/library/os', '_blank', 'noopener,noreferrer']]);
  });

  test('a handler that throws is logged, and the next message still works', () => {
    const h = opened();
    h.api.postMessage({ type: 'open-docs', language: 'python' });
    assert.strictEqual(h.logged[0].event, 'handler-error');
    assert.strictEqual(h.logged[0].type, 'open-docs');
    h.api.postMessage({ type: 'expand-folder', folderPath: '/repo' });
    assert.strictEqual(h.sent.length, 1);
  });

  test('a library description is empty: main.js shows its own sentence', () => {
    const h = opened();
    h.api.postMessage({ type: 'get-lib-description', libraryName: 'os', reqId: 5 });
    assert.deepStrictEqual(h.sent, [{ type: 'lib-description', reqId: 5, description: '' }]);
  });

  test('a save is refused with its reqId, so the popup keeps the text', () => {
    const h = opened();
    h.api.postMessage({ type: 'save-func-source', reqId: 'r1', file: '/repo/a.py', line: 1, newSource: 'x' });
    assert.deepStrictEqual(h.sent, [{ type: 'func-source-saved', reqId: 'r1', ok: false, reason: 'This tour is read-only.' }]);
  });

  test('get-annotations, dirty-state and perf-report are in the table and silent', () => {
    const h = opened();
    for (const type of ['get-annotations', 'dirty-state', 'perf-report']) { h.api.postMessage({ type }); }
    assert.strictEqual(h.sent.length, 0);
    assert.deepStrictEqual(h.logged, []);
  });

  test('webview-log is forwarded', () => {
    const h = opened();
    h.api.postMessage({ type: 'webview-log', entry: { level: 'warn', msg: 'x' } });
    assert.deepStrictEqual(h.logged, [{ event: 'webview-log', entry: { level: 'warn', msg: 'x' } }]);
  });

  test('anything else is logged as unhandled and answered by nothing', () => {
    const h = opened();
    for (const type of ['save-graph', 'tour-start', 'toString']) { h.api.postMessage({ type }); }
    assert.deepStrictEqual(h.logged.map(l => l.type), ['save-graph', 'tour-start', 'toString']);
    assert.ok(h.logged.every(l => l.event === 'unhandled'));
    assert.strictEqual(h.sent.length, 0);
  });
});

suite('staticBridge.js: messages from another window', () => {
  const windows = () => {
    const h = makeHarness();
    const other = new JSDOM('<!DOCTYPE html>').window;
    const seen: unknown[] = [];
    return { h, other, seen, deliver: (data: unknown, source: unknown) => h.win.dispatchEvent(new h.win.MessageEvent('message', { data, source })) };
  };

  test('the page\'s own message reaches a listener', () => {
    const { h, seen, deliver } = windows();
    h.win.addEventListener('message', (e: any) => seen.push(e.data));
    deliver({ type: 'graph' }, h.win);
    assert.deepStrictEqual(seen, [{ type: 'graph' }]);
  });

  test('a message from another window reaches no listener', () => {
    const { h, other, seen, deliver } = windows();
    h.win.addEventListener('message', (e: any) => seen.push(e.data));
    deliver({ type: 'graph', data: { nodes: [{ id: 'forged' }] } }, other);
    assert.deepStrictEqual(seen, []);
  });

  test('a message with no source reaches no listener', () => {
    const { h, seen, deliver } = windows();
    h.win.addEventListener('message', (e: any) => seen.push(e.data));
    deliver({ type: 'graph' }, null);
    assert.deepStrictEqual(seen, []);
  });

  test('a foreign message cannot burn a __seq the real replay needs: the filter runs first', () => {
    const { h, other, seen, deliver } = windows();
    hs.installSeqDedupe(h.win);
    h.win.addEventListener('message', (e: any) => seen.push(e.data));
    deliver({ type: 'graph', __seq: 1, forged: true }, other);
    deliver({ type: 'graph', __seq: 1 }, h.win);
    assert.deepStrictEqual(seen, [{ type: 'graph', __seq: 1 }]);
  });
});
