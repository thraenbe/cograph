import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';
import { GraphProvider } from '../../graphProvider';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const hs = require('../../../src/webview/readyHandshake.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

suite('ready handshake — webview side (F11)', () => {
  test('a re-sent __seq is dropped before any other listener; unstamped messages pass', () => {
    const win = new JSDOM('<!DOCTYPE html><body></body>').window as any;
    hs.installSeqDedupe(win);
    const handled: string[] = [];
    win.addEventListener('message', (e: any) => handled.push(`main:${e.data.type}`));
    win.addEventListener('message', (e: any) => handled.push(`controls:${e.data.type}`));
    const post = (data: any) => win.dispatchEvent(new win.MessageEvent('message', { data }));
    post({ type: 'structure', __seq: 1 });
    post({ type: 'structure', __seq: 1 });   // host re-send after a late `ready`
    post({ type: 'graph', __seq: 2 });
    post({ type: 'func-source' });            // not gated → never de-duplicated
    post({ type: 'func-source' });
    assert.deepStrictEqual(handled, [
      'main:structure', 'controls:structure', 'main:graph', 'controls:graph',
      'main:func-source', 'controls:func-source', 'main:func-source', 'controls:func-source',
    ]);
  });

  test('announceReady waits for DOMContentLoaded while loading, else defers one task', () => {
    const posted: any[] = [];
    const listeners: Record<string, () => void> = {};
    const loadingDoc = { readyState: 'loading', addEventListener: (n: string, cb: () => void) => { listeners[n] = cb; } };
    hs.announceReady(loadingDoc, (m: any) => { posted.push(m); });
    assert.strictEqual(posted.length, 0, 'not before the other scripts attached their listeners');
    listeners.DOMContentLoaded();
    assert.deepStrictEqual(posted, [{ type: 'ready' }]);
    let deferred: (() => void) | undefined;
    hs.announceReady({ readyState: 'interactive' }, (m: any) => { posted.push(m); }, (fn: () => void) => { deferred = fn; });
    assert.strictEqual(posted.length, 1);
    (deferred as () => void)();
    assert.strictEqual(posted.length, 2);
  });
});

suite('ready handshake — GraphProvider (F11)', () => {
  let clock: sinon.SinonFakeTimers;
  setup(() => { clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  teardown(() => clock.restore());

  function make() {
    const provider = new GraphProvider({ extensionPath: '/fake/ext', extensionUri: vscode.Uri.file('/fake/ext') } as any);
    const posted: any[] = [];
    const webview: any = { html: '', cspSource: 'x', asWebviewUri: (u: vscode.Uri) => u, postMessage: (m: any) => { posted.push(m); return Promise.resolve(true); } };
    (provider as any).panel = { webview };
    return { provider: provider as any, posted, webview };
  }

  test('structure/graph posted before `ready` are delivered after it — in order, once', () => {
    const t = make();
    t.provider.loadGraphHtml([{ type: 'structure' }, { type: 'graph' }]);
    assert.ok(t.webview.html.includes('<div id="graph">'), 'graph HTML assigned');
    assert.deepStrictEqual(t.posted, [], 'nothing goes into the loading document');
    clock.tick(80);
    t.provider.readyGate.markReady();
    assert.deepStrictEqual(t.posted.map((m: any) => m.type), ['structure', 'graph']);
    clock.tick(1000);
    assert.strictEqual(t.posted.length, 2, 'the fallback must not deliver them a second time');
    assert.ok(t.posted.every((m: any) => typeof m.__seq === 'number'));
  });

  test('a webview that never says ready still gets its data after 150 ms (old behaviour)', () => {
    const t = make();
    t.provider.loadGraphHtml([{ type: 'graph' }]);
    clock.tick(149);
    assert.strictEqual(t.posted.length, 0);
    clock.tick(1);
    assert.deepStrictEqual(t.posted.map((m: any) => m.type), ['graph']);
  });

  test('a second load re-arms: messages for the replaced document are dropped', () => {
    const t = make();
    t.provider.loadGraphHtml([{ type: 'structure', v: 1 }]);
    t.provider.loadGraphHtml([{ type: 'structure', v: 2 }]);
    t.provider.readyGate.markReady();
    assert.deepStrictEqual(t.posted.map((m: any) => m.v), [2]);
  });

  test('no panel → no throw, nothing queued', () => {
    const t = make();
    t.provider.panel = undefined;
    t.provider.loadGraphHtml([{ type: 'graph' }]);
    assert.strictEqual(t.provider.readyGate, undefined);
  });
});
