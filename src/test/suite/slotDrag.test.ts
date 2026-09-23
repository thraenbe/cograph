import * as assert from 'assert';

/* eslint-disable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sd = require('../../../src/webview/slotDrag.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const frames = require('../../../src/webview/frames.js');

suite('slotDrag — clamp (R2b)', () => {
  const bounds = { x0: 40, y0: 86, x1: 640, y1: 486 };

  test('inside positions pass through', () => {
    assert.deepStrictEqual(sd.clampSlotPos(bounds, 100, 80, 200, 200), { x: 200, y: 200 });
  });

  test('clamps on all four sides of the frame inner area', () => {
    assert.deepStrictEqual(sd.clampSlotPos(bounds, 100, 80, -50, -50), { x: 40, y: 86 });
    assert.deepStrictEqual(sd.clampSlotPos(bounds, 100, 80, 9999, 9999), { x: 540, y: 406 });
  });

  test('a slot larger than the area sticks to the origin corner', () => {
    assert.deepStrictEqual(sd.clampSlotPos(bounds, 900, 700, 100, 100), { x: 40, y: 86 });
  });
});

suite('packContentSlots — pinned slots (R2b)', () => {
  function members(files: string[], perFile = 3) {
    const out: any[] = [];
    for (const f of files) {
      for (let i = 0; i < perFile; i++) {
        out.push({ id: `${f}::fn${i}`, r: 10, file: f, isFn: true });
      }
    }
    return out;
  }
  const overlap = (a: any, b: any) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  test('a pinned slot keeps its position; free slots pack around it without overlap', () => {
    const mems = members(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    const pins = new Map([['file:b.ts', { x: 40, y: 30 }]]);
    const packed = frames.packContentSlots(mems, pins);
    const pinned = packed.slots.get('file:b.ts');
    assert.deepStrictEqual({ x: pinned.x, y: pinned.y }, { x: 40, y: 30 }, 'pin respected');
    for (const [k, s] of packed.slots) {
      if (k === 'file:b.ts') { continue; }
      assert.ok(!overlap(s, pinned), `${k} must not overlap the pinned slot`);
    }
    assert.ok(packed.w >= pinned.x + pinned.w && packed.h >= pinned.y + pinned.h,
      'content block contains the pin');
  });

  test('pins clamp to non-negative content coordinates', () => {
    const mems = members(['a.ts', 'b.ts']);
    const packed = frames.packContentSlots(mems, new Map([['file:a.ts', { x: -60, y: -10 }]]));
    const s = packed.slots.get('file:a.ts');
    assert.deepStrictEqual({ x: s.x, y: s.y }, { x: 0, y: 0 });
  });

  test('deterministic with and without pins', () => {
    const mems = members(['a.ts', 'b.ts', 'c.ts']);
    const pins = new Map([['file:c.ts', { x: 200, y: 0 }]]);
    assert.deepStrictEqual(frames.packContentSlots(mems, pins).slots,
      frames.packContentSlots(mems, pins).slots);
  });

  const mkRoot = (children: string[]) => ({
    path: '/r', kind: 'root', parent: null, children,
    local: { x: 0, y: 0, w: 1000, h: 1000 }, abs: { x: 0, y: 0, w: 1000, h: 1000 },
    inner: { w: 1000, h: 1000 }, contentPos: { x: 0, y: 0 },
  });

  test('slot pins serialize round-trip on the frame entry (sp, additive)', () => {
    const f: any = {
      path: '/p/a', kind: 'folder', parent: '/r', children: [], abs: { x: 0, y: 0, w: 400, h: 300 }, local: { x: 5, y: 6, w: 400, h: 300 },
      contentPos: { x: 0, y: 0 }, pinned: false,
      slotPins: new Map([['file:x.ts', { x: 12.4, y: 7.6 }]]),
    };
    const fs2: any = { root: '/r', byPath: new Map([['/r', mkRoot(['/p/a'])], ['/p/a', f]]) };
    const saved = frames.serializeFrames(fs2);
    assert.deepStrictEqual(saved['/p/a'].sp, { 'file:x.ts': [12, 8] });
    const g2: any = {
      path: '/p/a', kind: 'folder', parent: '/r', children: [], abs: { x: 0, y: 0, w: 100, h: 100 }, local: { x: 0, y: 0, w: 100, h: 100 },
      contentPos: { x: 0, y: 0 }, inner: { w: 1, h: 1 }, slotPins: new Map(),
    };
    const fs3: any = { root: '/r', byPath: new Map([['/r', mkRoot(['/p/a'])], ['/p/a', g2]]) };
    frames.deserializeFrames(saved, fs3);
    assert.deepStrictEqual(g2.slotPins.get('file:x.ts'), { x: 12, y: 8 });
    // old saves without sp: pins untouched
    const h2: any = { ...g2, slotPins: new Map([['keep', { x: 1, y: 1 }]]) };
    frames.deserializeFrames({ '/p/a': { x: 0, y: 0, w: 50, h: 50, pinned: false } },
      { root: '/r', byPath: new Map([['/r', mkRoot(['/p/a'])], ['/p/a', h2]]) } as any);
    assert.ok(h2.slotPins.has('keep'), 'old saves leave pins alone');
  });
});

suite('slot drag wiring (R2b, source contracts)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs2 = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path2 = require('path');
  const src = fs2.readFileSync(
    path2.resolve(__dirname, '../../../src/webview/frameRender.js'), 'utf8');

  test('the handle is the label band only and the drag uses the stable container', () => {
    assert.ok(src.includes("attr('class', 'file-slot-handle')"));
    assert.ok(/file-slot-handle'\)\n\s+\.attr\('x', d\.x\)\.attr\('y', d\.y\)\.attr\('width', d\.w\)\.attr\('height', SLOT\.LABEL_H\)/.test(src),
      'handle covers exactly the label band — node drags below keep working');
    const deps = src.slice(src.indexOf('function slotDragDeps'), src.indexOf('function frameDragDeps'));
    assert.ok(deps.includes('container: function () { return g.node(); }'),
      'slot drags measure against the stable zoomed layer (the R1 lesson)');
    assert.ok(deps.includes('fr.slotPins.set(d.key'), 'drop writes the content-local pin');
  });
});
