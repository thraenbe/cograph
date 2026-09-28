import * as assert from 'assert';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vis = require('../../../src/webview/visibility.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

function baseInputs(over: any = {}) {
  return {
    query: '', showLibraries: true, existingFilesOnly: false, showOrphans: true,
    nodes: over.nodes ?? [{ id: 'a' }, { id: 'b' }], connected: over.connected ?? new Set(['a']),
    onlyShowFolder: null, hiddenFolders: new Set<string>(), ...over,
  };
}

suite('visibility: visible-set memo', () => {
  test('returns the same Set while no input changed', () => {
    const memo = vis.createVisibleMemo();
    let computes = 0;
    const compute = () => { computes++; return new Set(['a']); };
    const inp = baseInputs();
    const s1 = memo.get(inp, compute);
    const s2 = memo.get({ ...inp }, compute);
    assert.strictEqual(s1, s2);
    assert.strictEqual(computes, 1);
  });

  test('recomputes when query, toggles, folder filters or list identity change', () => {
    const memo = vis.createVisibleMemo();
    let computes = 0;
    const compute = () => { computes++; return new Set(); };
    const inp = baseInputs();
    memo.get(inp, compute);
    memo.get({ ...inp, query: 'x' }, compute);
    memo.get({ ...inp, query: 'x', showOrphans: false }, compute);
    memo.get({ ...inp, query: 'x', showOrphans: false, onlyShowFolder: '/r/a' }, compute);
    const hidden = new Set(['/r/b']);
    memo.get({ ...inp, hiddenFolders: hidden }, compute);
    hidden.add('/r/c'); // mutated in place, like state.hiddenFolders
    memo.get({ ...inp, hiddenFolders: hidden }, compute);
    memo.get({ ...inp, hiddenFolders: hidden, nodes: [...inp.nodes] }, compute); // re-render → new array
    memo.get({ ...inp, hiddenFolders: hidden, nodes: inp.nodes, connected: new Set(['a']) }, compute);
    assert.strictEqual(computes, 8);
  });

  test('volatile inputs (timeline predicate) always recompute and drop the memo', () => {
    const memo = vis.createVisibleMemo();
    let computes = 0;
    const compute = () => { computes++; return new Set(); };
    const inp = baseInputs();
    memo.get(inp, compute);
    memo.get({ ...inp, volatile: true }, compute);
    memo.get({ ...inp, volatile: true }, compute);
    memo.get(inp, compute); // memo was dropped by the volatile call
    assert.strictEqual(computes, 4);
    memo.invalidate();
    memo.get(inp, compute);
    assert.strictEqual(computes, 5);
  });

  test('visibleKey separates folder names that would collide when joined', () => {
    const a = vis.visibleKey(baseInputs({ hiddenFolders: new Set(['/a', '/b']) }));
    const b = vis.visibleKey(baseInputs({ hiddenFolders: new Set(['/a,/b']) }));
    assert.notStrictEqual(a, b);
  });
});

function makeEls(ids: string[], links: [string, string][]) {
  const doc = new JSDOM('<!DOCTYPE html><body></body>').window.document;
  const writes = { n: 0 };
  const mk = (datum: any) => {
    const el: any = doc.createElement('span');
    el.__data__ = datum;
    const sp = el.style.setProperty.bind(el.style);
    const rp = el.style.removeProperty.bind(el.style);
    el.style.setProperty = (...a: any[]) => { writes.n++; return sp(...a); };
    el.style.removeProperty = (...a: any[]) => { writes.n++; return rp(...a); };
    return el;
  };
  const nodeEls = ids.map(id => mk({ id }));
  const labelEls = ids.map(id => mk({ id }));
  const linkEls = links.map(([s, t], i) => mk(i % 2 ? { source: { id: s }, target: { id: t } } : { source: s, target: t }));
  const sel = (els: any[]) => ({ nodes: () => els });
  return { nodeEls, labelEls, linkEls, writes, sels: { nodes: [sel(nodeEls), null, sel(labelEls)], links: sel(linkEls) } };
}

const hidden = (el: any) => el.style.getPropertyValue('display') === 'none';

suite('visibility: filter applier', () => {
  const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const LINKS: [string, string][] = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['g', 'h']];

  test('first apply is a full pass; nodes, labels and links follow the set', () => {
    const f = makeEls(IDS, LINKS);
    const ap = vis.createFilterApplier();
    const written = ap.apply(f.sels, new Set(['a', 'b', 'c']));
    assert.strictEqual(written, IDS.length * 2 + LINKS.length);
    assert.deepStrictEqual(f.nodeEls.map(hidden), [false, false, false, true, true, true, true, true]);
    assert.deepStrictEqual(f.labelEls.map(hidden), f.nodeEls.map(hidden));
    assert.deepStrictEqual(f.linkEls.map(hidden), [false, false, true, true]);
  });

  test('small change → only flipped elements and their links are written', () => {
    const f = makeEls(IDS, LINKS);
    const ap = vis.createFilterApplier();
    ap.apply(f.sels, new Set(IDS));
    f.writes.n = 0;
    const next = new Set(IDS); next.delete('b');
    const written = ap.apply(f.sels, next);
    assert.strictEqual(written, 2 + 2, 'node + label of b, links a-b and b-c');
    assert.strictEqual(f.writes.n, 4);
    assert.ok(hidden(f.nodeEls[1]) && hidden(f.labelEls[1]));
    assert.deepStrictEqual(f.linkEls.map(hidden), [true, true, false, false]);
    // and back again
    ap.apply(f.sels, new Set(IDS));
    assert.ok(f.nodeEls.every((e: any) => !hidden(e)) && f.linkEls.every((e: any) => !hidden(e)));
  });

  test('unchanged set writes nothing', () => {
    const f = makeEls(IDS, LINKS);
    const ap = vis.createFilterApplier();
    const set = new Set(IDS);
    ap.apply(f.sels, set);
    f.writes.n = 0;
    assert.strictEqual(ap.apply(f.sels, set), 0);
    assert.strictEqual(ap.apply(f.sels, new Set(IDS)), 0);
    assert.strictEqual(f.writes.n, 0);
  });

  test('big flips fall back to the full pass', () => {
    const f = makeEls(IDS, LINKS);
    const ap = vis.createFilterApplier({ maxDiffRatio: 0.25 });
    ap.apply(f.sels, new Set(IDS));
    const written = ap.apply(f.sels, new Set(['a'])); // 7 of 8 flip
    assert.strictEqual(written, IDS.length * 2 + LINKS.length);
    assert.deepStrictEqual(f.nodeEls.map(hidden), [false, true, true, true, true, true, true, true]);
  });

  test('a re-render (new selection objects) forces re-index + full pass', () => {
    const f1 = makeEls(IDS, LINKS);
    const f2 = makeEls(['a', 'z'], [['a', 'z']]);
    const ap = vis.createFilterApplier();
    ap.apply(f1.sels, new Set(IDS));
    const written = ap.apply(f2.sels, new Set(['a']));
    assert.strictEqual(written, 2 * 2 + 1);
    assert.ok(hidden(f2.nodeEls[1]) && hidden(f2.linkEls[0]));
    ap.reset();
    assert.strictEqual(ap.apply(f2.sels, new Set(['a'])), 5, 'reset → full pass again');
  });

  test('symmetricDiff lists ids present in exactly one set', () => {
    assert.deepStrictEqual(vis.symmetricDiff(new Set([1, 2, 3]), new Set([2, 3, 4])).sort(), [1, 4]);
  });
});

suite('visibility: burst gate', () => {
  function fakeRaf() {
    const q: (() => void)[] = [];
    return { raf: (cb: () => void) => { q.push(cb); }, flush: () => { const cb = q.shift(); if (cb) { cb(); } }, q };
  }

  test('first call runs synchronously; same-frame repeats collapse to one trailing run', () => {
    const r = fakeRaf();
    const gate = vis.createBurstGate(r.raf);
    const ran: string[] = [];
    gate.run(() => ran.push('1'));
    gate.run(() => ran.push('2'));
    gate.run(() => ran.push('3'));
    assert.deepStrictEqual(ran, ['1']);
    r.flush();
    assert.deepStrictEqual(ran, ['1', '3'], 'last call wins');
    gate.run(() => ran.push('4')); // same frame as the trailing run → deferred
    assert.deepStrictEqual(ran, ['1', '3']);
    r.flush();
    assert.deepStrictEqual(ran, ['1', '3', '4']);
    r.flush(); // quiet frame re-opens the gate
    gate.run(() => ran.push('5'));
    assert.deepStrictEqual(ran, ['1', '3', '4', '5']);
  });

  test('without requestAnimationFrame every call runs immediately', () => {
    const gate = vis.createBurstGate(null);
    let n = 0;
    gate.run(() => n++); gate.run(() => n++);
    assert.strictEqual(n, 2);
  });
});
