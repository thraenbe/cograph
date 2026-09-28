import * as assert from 'assert';

/* eslint-disable @typescript-eslint/no-explicit-any */

if ((global as any).state === undefined) { (global as any).state = {}; }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fr = require('../../../src/webview/frameRender.js');

suite('stampLinkRefs — link endpoints become node objects (F3)', () => {
  const a = { id: 'a', x: 10, y: 20 };
  const b = { id: 'b', x: 30, y: 40 };
  const byId = new Map<string, any>([['a', a], ['b', b]]);

  test('string endpoints resolve to node objects with live coordinates', () => {
    const links: any[] = [{ source: 'a', target: 'b' }];
    fr.stampLinkRefs(links, byId);
    assert.strictEqual(links[0].source, a);
    assert.strictEqual(links[0].target, b);
    assert.strictEqual(links[0]._s, a);
    assert.strictEqual(links[0]._t, b);
    // The F3 regression: a leftover coalesced global tick reads
    // d.source.x/d.target.x — with objects this is finite, never NaN.
    assert.ok(Number.isFinite(links[0].source.x + links[0].target.y));
  });

  test('already-resolved object endpoints re-resolve to the CURRENT node objects', () => {
    const staleA = { id: 'a', x: NaN, y: NaN }; // replaced by a graph patch
    const links: any[] = [{ source: staleA, target: 'b' }];
    fr.stampLinkRefs(links, byId);
    assert.strictEqual(links[0].source, a, 'stale object swapped for the live one');
  });

  test('unknown endpoints are left untouched and stamped null', () => {
    const links: any[] = [{ source: 'a', target: 'ghost' }];
    fr.stampLinkRefs(links, byId);
    assert.strictEqual(links[0]._t, null);
    assert.strictEqual(links[0].target, 'ghost', 'unresolvable endpoint unchanged');
  });
});
