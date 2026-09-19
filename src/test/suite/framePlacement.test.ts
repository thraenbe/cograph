import * as assert from 'assert';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Real grid packer; the frame geometry helpers are stubbed so the tests can
// move a slot's interior at will.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const frames = require('../../../src/webview/frames.js');

const savedGlobals: Record<string, any> = {};
function installGlobals() {
  for (const k of ['state', 'innerOrigin', 'slotInteriorFor', 'gridPositions']) {
    savedGlobals[k] = (global as any)[k];
  }
  (global as any).innerOrigin = () => ({ x: 0, y: 0 });
  (global as any).slotInteriorFor = (f: any) => f.__interior;
  (global as any).gridPositions = frames.gridPositions;
}
installGlobals();

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fr = require('../../../src/webview/frameRender.js');

const R = 10;
const INTERIOR = { x: 100, y: 100, w: 400, h: 300 };

function makeWorld(n: number, opts: { layoutMode?: string } = {}) {
  const frame: any = {
    path: '/p', kind: 'folder',
    __interior: { ...INTERIOR },
    slotOf: new Map(),
  };
  const mems: any[] = [];
  for (let i = 0; i < n; i++) {
    const id = `fn${i}`;
    frame.slotOf.set(id, 'file:a.ts');
    // The F1 seed shape: a tight jittered cloud INSIDE the slot interior.
    const node = { id, x: 150 + (i % 5) * 2, y: 150 + Math.floor(i / 5) * 2, fx: null, fy: null };
    mems.push({ id, r: R, file: 'a.ts', _ref: node });
  }
  (global as any).state = {
    frames: { byPath: new Map([['/p', frame]]) },
    layoutMode: opts.layoutMode ?? 'static',
    slotPlacedIds: new Set(),
  };
  return { frame, mems, members: new Map([['/p', mems]]) };
}

function overlapPairs(mems: any[]) {
  let pairs = 0;
  for (let i = 0; i < mems.length; i++) {
    for (let j = i + 1; j < mems.length; j++) {
      const a = mems[i]._ref, b = mems[j]._ref;
      if (Math.hypot(a.x - b.x, a.y - b.y) < 2 * R) { pairs++; }
    }
  }
  return pairs;
}

function inside(node: any, rect: any) {
  return node.x >= rect.x && node.x <= rect.x + rect.w
    && node.y >= rect.y && node.y <= rect.y + rect.h;
}

suite('placeMembersInSlots — placement stamps (F1)', () => {
  suiteTeardown(() => {
    for (const [k, v] of Object.entries(savedGlobals)) { (global as any)[k] = v; }
  });

  test('a seed cloud inside a big slot grids on first pack: 0 overlapping pairs', () => {
    const w = makeWorld(20);
    assert.ok(overlapPairs(w.mems) > 0, 'sanity: the seed cloud overlaps');
    fr.placeMembersInSlots(w.members);
    assert.strictEqual(overlapPairs(w.mems), 0, 'grid must separate every pair');
    for (const m of w.mems) {
      assert.ok(inside(m._ref, INTERIOR), `${m.id} inside the interior`);
      assert.ok((global as any).state.slotPlacedIds.has(m.id), `${m.id} stamped`);
    }
  });

  test('the stamp survives node-object replacement (graph patches)', () => {
    const w = makeWorld(12);
    fr.placeMembersInSlots(w.members);
    // A patch re-render replaces every node OBJECT but keeps ids + positions;
    // one node also carries a position the user chose inside the interior.
    for (const m of w.mems) {
      m._ref = { id: m.id, x: m._ref.x, y: m._ref.y, fx: null, fy: null };
    }
    w.mems[3]._ref.x = 333; w.mems[3]._ref.y = 222;
    const before = w.mems.map(m => ({ x: m._ref.x, y: m._ref.y }));
    fr.placeMembersInSlots(w.members);
    w.mems.forEach((m, i) => {
      assert.strictEqual(m._ref.x, before[i].x, `${m.id} x untouched`);
      assert.strictEqual(m._ref.y, before[i].y, `${m.id} y untouched`);
    });
  });

  test('an unstamped newcomer inside the interior still grids', () => {
    const w = makeWorld(6);
    fr.placeMembersInSlots(w.members);
    const extra = { id: 'fnNew', r: R, file: 'a.ts', _ref: { id: 'fnNew', x: 150, y: 150, fx: null, fy: null } };
    w.frame.slotOf.set('fnNew', 'file:a.ts');
    w.mems.push(extra);
    fr.placeMembersInSlots(w.members);
    assert.ok((global as any).state.slotPlacedIds.has('fnNew'));
    assert.strictEqual(overlapPairs(w.mems), 0, 'newcomer got its own cell');
  });

  test('static: a moved slot rect re-grids stamped members into the new rect', () => {
    const w = makeWorld(8);
    fr.placeMembersInSlots(w.members);
    const moved = { x: 900, y: 700, w: 300, h: 200 };
    w.frame.__interior = { ...moved };
    fr.placeMembersInSlots(w.members);
    for (const m of w.mems) {
      assert.ok(inside(m._ref, moved), `${m.id} moved into the new rect`);
    }
    assert.strictEqual(overlapPairs(w.mems), 0);
  });

  test('static: a grown slot re-grids even when members still fit the new rect', () => {
    const w = makeWorld(8);
    fr.placeMembersInSlots(w.members);
    // Custom position that stays inside the grown rect — static re-pack must
    // still re-grid (the layout changed under the nodes).
    w.mems[0]._ref.x = 480; w.mems[0]._ref.y = 380;
    w.frame.__interior = { x: 100, y: 100, w: 500, h: 400 };
    fr.placeMembersInSlots(w.members);
    assert.notStrictEqual(w.mems[0]._ref.x, 480, 'stamped member re-gridded on rect change');
  });

  test('dynamic: an unchanged-fit rect change leaves placed members to the sim', () => {
    const w = makeWorld(8, { layoutMode: 'dynamic' });
    fr.placeMembersInSlots(w.members);
    const posBefore = w.mems.map(m => ({ x: m._ref.x, y: m._ref.y }));
    // Grow the rect so every current position stays inside it.
    w.frame.__interior = { x: 100, y: 100, w: 500, h: 400 };
    fr.placeMembersInSlots(w.members);
    w.mems.forEach((m, i) => {
      assert.strictEqual(m._ref.x, posBefore[i].x, `${m.id} left to the sim`);
    });
  });

  test('a static pin follows the grid (fx updated with x)', () => {
    const w = makeWorld(4);
    const n = w.mems[0]._ref;
    n.x = -50; n.y = -50; n.fx = -50; n.fy = -50; // pinned outside
    fr.placeMembersInSlots(w.members);
    assert.strictEqual(n.fx, n.x, 'pin snapped to the gridded position');
    assert.ok(inside(n, INTERIOR));
  });
});
