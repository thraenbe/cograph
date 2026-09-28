import * as assert from 'assert';
import * as sinon from 'sinon';
import { JSDOM } from 'jsdom';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const hc = require('../../../src/webview/hoverCard.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

// F18: the R2b drag handle (rect.file-slot-handle) covers the slot's label
// band and is the topmost element there, so it must resolve to the file card
// exactly like the label underneath it used to.

const ROOT = '/ws';
const SVG = 'http://www.w3.org/2000/svg';

const STATE = {
  structureTree: { files: [{ path: '/ws/src/util/b.ts', language: 'typescript' }] },
  graphData: { nodes: [{ id: '1', file: '/ws/src/util/b.ts' }] },
};

function buildSlot(doc: Document): Record<string, any> {
  const root = doc.getElementById('graph')!;
  const svg = doc.createElementNS(SVG, 'svg');
  root.appendChild(svg);
  const el = (parent: Element, tag: string, cls: string, datum?: unknown) => {
    const n = doc.createElementNS(SVG, tag) as any;
    n.setAttribute('class', cls);
    if (datum !== undefined) { n.__data__ = datum; }
    parent.appendChild(n);
    return n;
  };
  const frame = el(svg, 'g', 'frame', { path: '/ws/src/util' });
  const slot = el(el(frame, 'g', 'f-slots'), 'g', 'file-slot', { key: 'k', file: '/ws/src/util/b.ts' });
  return {
    root,
    slotShape: el(slot, 'rect', 'file-slot-shape'),
    slotLabel: el(slot, 'text', 'file-slot-label'),
    slotHandle: el(slot, 'rect', 'file-slot-handle'),
  };
}

suite('slot drag handle hover (F18)', () => {
  test('hcResolveTarget resolves the handle like the label: fast file target', () => {
    const dom = new JSDOM('<div id="graph"></div>');
    const g = buildSlot(dom.window.document);
    assert.deepStrictEqual(hc.hcResolveTarget(g.slotHandle),
      { kind: 'file', path: '/ws/src/util/b.ts', background: false });
    assert.deepStrictEqual(hc.hcResolveTarget(g.slotHandle), hc.hcResolveTarget(g.slotLabel),
      'handle and label open the same card at the same delay');
  });

  test('hovering the handle opens the file card after the label delay', () => {
    const dom = new JSDOM('<div id="graph"></div>', { pretendToBeVisual: true });
    const g = buildSlot(dom.window.document);
    const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const win = dom.window as any;
    win.setTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms);
    win.clearTimeout = (id: any) => clearTimeout(id);
    const card = hc.createHoverCard({
      doc: win.document, win, root: g.root, getState: () => STATE, post: () => {},
    });
    win.dispatchEvent(new win.MessageEvent('message', {
      data: { type: 'annotations', root: ROOT, aiEnabled: true,
        files: { 'src/util/b.ts': { summary: 'Helper functions.', role: 'helpers' } },
        folders: {}, stale: [] },
    }));
    try {
      g.slotHandle.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
      g.slotHandle.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
      clock.tick(hc.HOVER_DELAY_MS - 1);
      assert.strictEqual(card.isVisible(), false, 'not before the label delay');
      clock.tick(1);
      assert.strictEqual(card.isVisible(), true, 'the file card opens on the handle');
      assert.strictEqual(card.element.querySelector('.hc-name').textContent, 'b.ts');
      assert.strictEqual(card.element.querySelector('.hc-summary').textContent, 'Helper functions.');
    } finally {
      card.destroy();
      clock.restore();
    }
  });
});
