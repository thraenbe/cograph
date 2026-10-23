import * as assert from 'assert';
import { ViewHub, PANEL_VIEW, type ClientSink, type ClientControl } from '../../browserView/viewHub';

// The hub is vscode-free: these tests also run under plain mocha (coverage).

interface FakeSink extends ClientSink { lines: object[]; controls: ClientControl[] }
function sink(): FakeSink {
  const s: FakeSink = {
    lines: [], controls: [],
    write: (json) => { s.lines.push(JSON.parse(json)); },
    control: (kind) => { s.controls.push(kind); },
  };
  return s;
}

/** Hubs of the running test: disposed in teardown, so no gate fallback timer outlives the suite. */
const liveHubs: ViewHub[] = [];

function makeHub(replay: object[] = []) {
  const logs: string[] = [];
  const forwarded: { message: object; viewId: string }[] = [];
  const hub = new ViewHub({
    log: (l) => logs.push(l),
    replay: () => replay,
    forward: (message, viewId) => forwarded.push({ message, viewId }),
    fallbackMs: 60_000,
  });
  liveHubs.push(hub);
  return { hub, logs, forwarded };
}

const types = (msgs: object[]) => msgs.map(m => (m as { type: string }).type);

suite('browserView: ViewHub', () => {
  teardown(() => { for (const hub of liveHubs.splice(0)) { hub.dispose(); } });

  test('post reaches the panel and every ready tab', () => {
    const { hub } = makeHub();
    const panel: object[] = [];
    hub.setPanel((m) => panel.push(m));
    const a = sink(); const b = sink();
    hub.attachClient('a', a); hub.attachClient('b', b);
    hub.receive('a', { type: 'ready' }); hub.receive('b', { type: 'ready' });
    hub.post({ type: 'git-update', nodes: [] });
    assert.deepStrictEqual(types(panel), ['git-update']);
    assert.deepStrictEqual(types(a.lines), ['git-update']);
    assert.deepStrictEqual(types(b.lines), ['git-update']);
  });

  test('a new tab gets the replay first, held until it says ready, then live messages behind it', () => {
    const { hub } = makeHub([{ type: 'subgraph' }, { type: 'structure' }, { type: 'graph' }]);
    const a = sink();
    hub.attachClient('a', a);
    hub.post({ type: 'git-update' });
    assert.strictEqual(a.lines.length, 0, 'nothing before ready');
    hub.receive('a', { type: 'ready' });
    assert.deepStrictEqual(types(a.lines), ['subgraph', 'structure', 'graph', 'git-update']);
  });

  test('each tab has its own __seq space starting at 1', () => {
    const { hub } = makeHub([{ type: 'structure' }]);
    const a = sink(); const b = sink();
    hub.attachClient('a', a);
    hub.receive('a', { type: 'ready' });
    hub.post({ type: 'x' });
    hub.attachClient('b', b);
    hub.receive('b', { type: 'ready' });
    assert.deepStrictEqual(a.lines.map(m => (m as { __seq: number }).__seq), [1, 2]);
    assert.deepStrictEqual(b.lines.map(m => (m as { __seq: number }).__seq), [1]);
  });

  test('the panel never sees __seq stamps from the hub', () => {
    const { hub } = makeHub();
    const panel: object[] = [];
    hub.setPanel((m) => panel.push(m));
    hub.attachClient('a', sink());
    hub.post({ type: 'x' });
    assert.deepStrictEqual(panel, [{ type: 'x' }]);
  });

  test('a second ready is harmless (no duplicate replay)', () => {
    const { hub } = makeHub([{ type: 'graph' }]);
    const a = sink();
    hub.attachClient('a', a);
    hub.receive('a', { type: 'ready' });
    hub.receive('a', { type: 'ready' });
    assert.deepStrictEqual(types(a.lines), ['graph']);
  });

  test('messages from a tab go to the provider with its id and make it active; ready is not forwarded', () => {
    const { hub, forwarded } = makeHub();
    hub.attachClient('a', sink());
    hub.receive('a', { type: 'ready' });
    hub.receive('a', { type: 'expand-folder', folderPath: '/r/src' });
    assert.deepStrictEqual(forwarded, [{ message: { type: 'expand-folder', folderPath: '/r/src' }, viewId: 'a' }]);
    assert.strictEqual(hub.activeView(), 'a');
  });

  test('postToActive goes to the last view that spoke, in both directions', () => {
    const { hub } = makeHub();
    const panel: object[] = [];
    hub.setPanel((m) => panel.push(m));
    const a = sink();
    hub.attachClient('a', a);
    hub.receive('a', { type: 'ready' });
    hub.receive('a', { type: 'dirty-state', dirty: true });
    hub.postToActive({ type: 'save-request', mode: 'save' });
    assert.deepStrictEqual(types(a.lines), ['save-request']);
    assert.strictEqual(panel.length, 0, 'tab active: the panel is not asked');
    hub.markPanelActive();
    hub.postToActive({ type: 'save-request', mode: 'save' });
    assert.deepStrictEqual(types(panel), ['save-request']);
    assert.strictEqual(a.lines.length, 1, 'panel active: the tab is not asked');
  });

  test('a detached active tab hands the active role back to the panel', () => {
    const { hub } = makeHub();
    const panel: object[] = [];
    hub.setPanel((m) => panel.push(m));
    const detach = hub.attachClient('a', sink());
    hub.receive('a', { type: 'navigate' });
    detach();
    hub.postToActive({ type: 'save-request' });
    assert.deepStrictEqual(types(panel), ['save-request']);
    assert.strictEqual(hub.clientCount(), 0);
  });

  test('a message JSON cannot carry is dropped for tabs and logged; the panel still gets it', () => {
    const { hub, logs } = makeHub();
    const panel: object[] = [];
    hub.setPanel((m) => panel.push(m));
    const a = sink();
    hub.attachClient('a', a);
    hub.receive('a', { type: 'ready' });
    const cyclic: Record<string, unknown> = { type: 'graph' };
    cyclic.self = cyclic;
    hub.post(cyclic);
    hub.post({ type: 'after' });
    assert.strictEqual(panel.length, 2);
    assert.deepStrictEqual(types(a.lines), ['after']);
    assert.ok(logs.some(l => l.includes('dropped graph for a')), logs.join('\n'));
  });

  test('a reconnect under the same id replaces the old stream; the old detach is then a no-op', () => {
    const { hub } = makeHub([{ type: 'graph' }]);
    const old = sink(); const fresh = sink();
    const detachOld = hub.attachClient('a', old);
    hub.receive('a', { type: 'ready' });
    hub.attachClient('a', fresh);
    detachOld();
    assert.strictEqual(hub.clientCount(), 1);
    hub.receive('a', { type: 'ready' });
    hub.post({ type: 'x' });
    assert.deepStrictEqual(types(fresh.lines), ['graph', 'x']);
    assert.deepStrictEqual(types(old.lines), ['graph']);
  });

  test('reloadClients and closeClients reach every tab; close empties the hub', () => {
    const { hub } = makeHub();
    const a = sink(); const b = sink();
    hub.attachClient('a', a); hub.attachClient('b', b);
    hub.reloadClients();
    assert.deepStrictEqual([a.controls, b.controls], [['reload'], ['reload']]);
    hub.closeClients();
    assert.deepStrictEqual([a.controls, b.controls], [['reload', 'closed'], ['reload', 'closed']]);
    assert.strictEqual(hub.clientCount(), 0);
  });

  test('client-count listeners hear attach, detach and close', () => {
    const { hub } = makeHub();
    const counts: number[] = [];
    const sub = hub.onClientCount((n) => counts.push(n));
    const detach = hub.attachClient('a', sink());
    hub.attachClient('b', sink());
    detach();
    hub.closeClients();
    sub.dispose();
    hub.attachClient('c', sink());
    assert.deepStrictEqual(counts, [1, 2, 1, 0]);
  });

  test('ready from a tab without a stream is logged and ignored', () => {
    const { hub, logs, forwarded } = makeHub();
    hub.receive('ghost', { type: 'ready' });
    assert.strictEqual(forwarded.length, 0);
    assert.ok(logs.some(l => l.includes('ghost')));
  });

  test('a failing replay leaves the tab working and says why', () => {
    const logs: string[] = [];
    const hub = new ViewHub({ log: (l) => logs.push(l), replay: () => { throw new Error('boom'); }, forward: () => undefined });
    liveHubs.push(hub);
    const a = sink();
    hub.attachClient('a', a);
    hub.receive('a', { type: 'ready' });
    hub.post({ type: 'x' });
    assert.deepStrictEqual(types(a.lines), ['x']);
    assert.ok(logs.some(l => l.includes('replay failed: boom')));
  });

  test('a throwing sink is logged, not thrown into the provider', () => {
    const { hub, logs } = makeHub();
    hub.attachClient('a', { write: () => { throw new Error('socket gone'); }, control: () => undefined });
    hub.receive('a', { type: 'ready' });
    assert.doesNotThrow(() => hub.post({ type: 'x' }));
    assert.ok(logs.some(l => l.includes('socket gone')));
  });

  test('after setPanel(undefined) posts reach only tabs; dispose closes them', () => {
    const { hub } = makeHub();
    const panel: object[] = [];
    hub.setPanel((m) => panel.push(m));
    hub.setPanel(undefined);
    const a = sink();
    hub.attachClient('a', a);
    hub.receive('a', { type: 'ready' });
    hub.post({ type: 'x' });
    assert.strictEqual(panel.length, 0);
    hub.dispose();
    assert.deepStrictEqual(a.controls, ['closed']);
    assert.strictEqual(hub.activeView(), PANEL_VIEW);
  });
});
