import * as assert from 'assert';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fc = require('../../../src/webview/frameCull.js');

/* eslint-disable @typescript-eslint/no-explicit-any */
const NS = 'http://www.w3.org/2000/svg';

function build(paths: string[]) {
  const doc = new JSDOM('<!DOCTYPE html><body><svg><g class="frames"></g></svg></body>').window.document;
  const parent = doc.querySelector('g.frames') as any;
  const mk = (tag: string, cls: string, into: any) => { const el = doc.createElementNS(NS, tag); el.setAttribute('class', cls); into.appendChild(el); return el; };
  const entries = paths.map((p) => {
    const frame = mk('g', 'frame', parent);
    frame.setAttribute('data-path', p);
    mk('rect', 'folder-bubble-shape', frame);
    const slots = mk('g', 'f-slots', frame);
    const slot = mk('g', 'file-slot', slots);
    mk('rect', 'file-slot-rect', slot); mk('text', 'file-slot-label', slot);
    mk('g', 'f-links', frame);
    const nodes = mk('g', 'f-nodes', frame);
    mk('circle', 'regular-node', nodes); mk('path', 'cloud-node', nodes); mk('circle', 'regular-node', nodes); mk('circle', 'regular-node', nodes);
    mk('g', 'f-labels', frame);
    return [p, frame] as [string, any];
  });
  const culler = fc.createDomCuller();
  culler.reset(parent, entries);
  const orderNow = () => [...parent.children].map((el: any) => el.getAttribute('data-path'));
  const shape = (frame: any) => [...frame.children].map((el: any) => el.getAttribute('class'));
  return { parent, entries, culler, orderNow, shape };
}

suite('frameCull (detach-based culling + LOD)', () => {
  test('hide detaches the frame; show re-inserts it at its paint-order position', () => {
    const t = build(['/a', '/a/b', '/c', '/d']);
    t.culler.hide('/a/b'); t.culler.hide('/c');
    assert.deepStrictEqual(t.orderNow(), ['/a', '/d']);
    assert.strictEqual(t.culler.isAttached('/c'), false);
    assert.strictEqual(t.culler.show('/c'), true);
    assert.deepStrictEqual(t.orderNow(), ['/a', '/c', '/d'], 'before the next ATTACHED sibling');
    t.culler.show('/a/b');
    assert.deepStrictEqual(t.orderNow(), ['/a', '/a/b', '/c', '/d'], 'parents still paint before children');
    assert.strictEqual(t.culler.show('/a/b'), false, 'already attached → no DOM work');
    t.culler.hide('/d'); t.culler.show('/d');
    assert.deepStrictEqual(t.orderNow(), ['/a', '/a/b', '/c', '/d'], 'last frame is appended');
    t.culler.hide('/ghost'); assert.strictEqual(t.culler.show('/ghost'), false);
  });

  test('LOD parks layers in place and restores the exact child order', () => {
    const t = build(['/a']);
    const frame = t.entries[0][1];
    const before = t.shape(frame);
    const nodesBefore = [...frame.querySelector('g.f-nodes').children];
    const moved = t.culler.applyLod('/a', { labels: false, links: false, nodes: false, slotLabels: false });
    assert.strictEqual(moved, 1 + 1 + 3 + 1);
    assert.deepStrictEqual(t.shape(frame), ['folder-bubble-shape', 'f-slots', 'f-nodes']);
    assert.deepStrictEqual([...frame.querySelector('g.f-nodes').children].map((el: any) => el.getAttribute('class')), ['cloud-node'],
      'folder/file glyphs stay; only function nodes go');
    assert.strictEqual(frame.querySelector('text.file-slot-label'), null);
    assert.ok(frame.querySelector('rect.file-slot-rect'), 'the coloured slots remain');
    assert.ok(t.culler.isParked('/a', 'nodes') && t.culler.isParked('/a', 'labels'));
    assert.strictEqual(t.culler.applyLod('/a', { labels: false, links: false, nodes: false, slotLabels: false }), 0, 'idempotent');

    t.culler.applyLod('/a', { labels: true, links: true, nodes: true, slotLabels: true });
    assert.deepStrictEqual(t.shape(frame), before);
    assert.deepStrictEqual([...frame.querySelector('g.f-nodes').children], nodesBefore, 'same elements, same order');
    assert.ok(frame.querySelector('text.file-slot-label'));
    assert.strictEqual(t.culler.isParked('/a', 'nodes'), false);
  });

  test('layers can be changed while the frame itself is detached (no layout work on show)', () => {
    const t = build(['/a', '/b']);
    t.culler.hide('/b');
    t.culler.applyLod('/b', { labels: false, links: true, nodes: true, slotLabels: true });
    t.culler.show('/b');
    assert.strictEqual(t.entries[1][1].querySelector('g.f-labels'), null);
    assert.ok(t.entries[1][1].querySelector('g.f-links'));
  });

  test('restoreAll puts every frame and layer back before a re-render', () => {
    const t = build(['/a', '/b', '/c']);
    const before = t.entries.map(e => t.shape(e[1]));
    t.culler.hide('/b');
    t.culler.applyLod('/a', { labels: false, links: false, nodes: false, slotLabels: false });
    t.culler.applyLod('/b', { labels: false, links: true, nodes: true, slotLabels: true });
    t.culler.restoreAll();
    assert.deepStrictEqual(t.orderNow(), ['/a', '/b', '/c']);
    assert.deepStrictEqual(t.entries.map(e => t.shape(e[1])), before);
  });

  test('detached elements stay writable (positions, classes) — selections keep working', () => {
    const t = build(['/a']);
    const circle = t.entries[0][1].querySelector('circle.regular-node');
    t.culler.applyLod('/a', { labels: true, links: true, nodes: false, slotLabels: true });
    circle.setAttribute('cx', '42');
    t.culler.applyLod('/a', { labels: true, links: true, nodes: true, slotLabels: true });
    assert.strictEqual(t.entries[0][1].querySelector('circle.regular-node').getAttribute('cx'), '42');
  });

  test('reset forgets the previous render', () => {
    const t = build(['/a']);
    t.culler.applyLod('/a', { labels: false });
    const t2 = build(['/x']);
    t.culler.reset(t2.parent, t2.entries);
    assert.deepStrictEqual(t.culler.paths(), ['/x']);
    assert.strictEqual(t.culler.isParked('/a', 'labels'), false);
  });

  test('only frames the culler detached come back — an element removed by someone else stays out', () => {
    const t = build(['/a', '/b', '/c']);
    t.culler.hide('/b');
    t.parent.removeChild(t.entries[2][1]);     // engine teardown / a d3 exit removed /c
    assert.strictEqual(t.culler.show('/c'), false);
    t.culler.restoreAll();
    assert.deepStrictEqual(t.orderNow(), ['/a', '/b'], '/c is not resurrected into the next render');
    t.culler.reset(null, []);
    assert.strictEqual(t.culler.show('/b'), false, 'after a reset nothing is known');
  });
});
