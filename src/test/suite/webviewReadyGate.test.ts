import * as assert from 'assert';
import * as sinon from 'sinon';
import { WebviewReadyGate } from '../../webviewReadyGate';

/* eslint-disable @typescript-eslint/no-explicit-any */

suite('WebviewReadyGate (F11 ready handshake)', () => {
  let clock: sinon.SinonFakeTimers;
  let sent: any[];
  let gate: WebviewReadyGate;

  setup(() => {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    sent = [];
    gate = new WebviewReadyGate((m) => sent.push(m), 150);
  });
  teardown(() => { gate.dispose(); clock.restore(); });

  const types = () => sent.map(m => m.type);

  test('never armed (panel we did not load) → pass-through, in order, stamped', () => {
    gate.post({ type: 'a' }); gate.post({ type: 'b' });
    assert.deepStrictEqual(types(), ['a', 'b']);
    assert.deepStrictEqual(sent.map(m => m.__seq), [1, 2]);
  });

  test('a message posted before ready is delivered after it — once, in order', () => {
    gate.arm();
    gate.post({ type: 'structure' });
    gate.post({ type: 'graph' });
    assert.deepStrictEqual(sent, [], 'held while the document loads');
    clock.tick(100);
    gate.markReady();
    assert.deepStrictEqual(types(), ['structure', 'graph']);
    clock.tick(1000);
    assert.deepStrictEqual(types(), ['structure', 'graph'], 'the fallback does not fire after ready');
    gate.post({ type: 'graph-patch' });
    assert.deepStrictEqual(types(), ['structure', 'graph', 'graph-patch'], 'ready → immediate');
    gate.markReady(); // a repeated ready has nothing to re-send
    assert.strictEqual(sent.length, 3);
  });

  test('no ready (stale cached webview / test double): fallback delivers at the old 150 ms', () => {
    gate.arm();
    gate.post({ type: 'graph' });
    clock.tick(149);
    assert.deepStrictEqual(sent, []);
    clock.tick(1);
    assert.deepStrictEqual(types(), ['graph']);
    assert.strictEqual(gate.isReady(), false);
    gate.post({ type: 'later' });
    clock.tick(150);
    assert.deepStrictEqual(types(), ['graph', 'later']);
  });

  test('ready AFTER the fallback: the page was not listening → same messages again, same __seq', () => {
    gate.arm();
    gate.post({ type: 'structure' });
    clock.tick(150);                       // cold open: scripts still loading, this delivery is lost
    gate.post({ type: 'graph' });          // queued again (still not ready)
    gate.markReady();
    assert.deepStrictEqual(types(), ['structure', 'structure', 'graph']);
    assert.strictEqual(sent[0].__seq, sent[1].__seq, 'the webview de-duplicates by __seq if the first one did arrive');
    assert.strictEqual(gate.pendingCount(), 0);
  });

  test('arm() for a new document drops what was meant for the old one', () => {
    gate.arm();
    gate.post({ type: 'old-structure' });
    gate.arm();
    gate.post({ type: 'new-structure' });
    gate.markReady();
    assert.deepStrictEqual(types(), ['new-structure']);
  });

  test('dispose clears the queue and the timer; nothing is sent afterwards', () => {
    gate.arm();
    gate.post({ type: 'graph' });
    gate.dispose();
    clock.tick(1000);
    gate.markReady();
    gate.post({ type: 'x' });
    assert.deepStrictEqual(sent, []);
    assert.strictEqual(gate.pendingCount(), 0);
  });
});
