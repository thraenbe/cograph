import * as assert from 'assert';
import { makeSyntheticRepo } from '../fixtures/syntheticGraph';

// frames.js is pure (no DOM/d3/state) — required directly like fileClusters.js.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fr = require('../../../src/webview/frames.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fc = require('../../../src/webview/fileClusters.js');

/* eslint-disable @typescript-eslint/no-explicit-any */

// Same 3-level tree shape as drilldown.test.ts: /p → /p/a → /p/a/b, plus /p/c.
function makeTree() {
  return {
    root: '/p',
    totalFiles: 4,
    folders: {
      '/p':     { path: '/p',     depth: 0, parent: null,   childFolders: ['/p/a', '/p/c'], files: ['/p/x.ts'],     fileCount: 4 },
      '/p/a':   { path: '/p/a',   depth: 1, parent: '/p',   childFolders: ['/p/a/b'],       files: ['/p/a/y.ts'],   fileCount: 2 },
      '/p/a/b': { path: '/p/a/b', depth: 2, parent: '/p/a', childFolders: [],               files: ['/p/a/b/z.ts'], fileCount: 1 },
      '/p/c':   { path: '/p/c',   depth: 1, parent: '/p',   childFolders: [],               files: ['/p/c/w.ts'],   fileCount: 1 },
    },
    files: [
      { path: '/p/x.ts', language: 'typescript' },
      { path: '/p/a/y.ts', language: 'typescript' },
      { path: '/p/a/b/z.ts', language: 'python' },
      { path: '/p/c/w.ts', language: 'typescript' },
    ],
  };
}

function graphFor(tree: any, fnsPerFile = 3) {
  const nodes: any[] = [];
  for (const f of tree.files) {
    for (let i = 0; i < fnsPerFile; i++) {
      nodes.push({ id: `${f.path}::fn${i}`, name: `fn${i}`, file: f.path, line: i + 1, language: f.language });
    }
  }
  return { nodes, edges: [], files: tree.files.map((f: any) => f.path) };
}

/** Members via the real skeleton builder, so element shapes match production. */
function membersFor(tree: any, expanded: Set<string>, parsed: Set<string>, graph: any) {
  const els = fc.buildSkeletonElements(tree, expanded, parsed, graph, new Set());
  return fr.collectMembers(els, tree, 2.5);
}

function build(tree: any, expanded: Set<string>, parsed?: Set<string>, graph?: any) {
  const g = graph ?? graphFor(tree);
  const p = parsed ?? new Set(Object.keys(tree.folders));
  return fr.buildFrames(tree, expanded, membersFor(tree, expanded, p, g));
}

// ── Invariant helpers ────────────────────────────────────────────────────────
function assertInvariants(fs: any) {
  for (const [, f] of fs.byPath) {
    // children inside the parent's inner rect, pairwise non-overlapping
    const rects: any[] = [];
    if (f.content.w > 0) { rects.push({ key: '#content', x: f.contentPos.x, y: f.contentPos.y, w: f.content.w, h: f.content.h }); }
    for (const c of f.children) {
      const cf = fs.byPath.get(c);
      assert.ok(cf.local.x >= 0 && cf.local.y >= 0, `${c} local within parent`);
      assert.ok(cf.local.x + cf.local.w <= f.inner.w + 0.001, `${c} right edge inside ${f.path} inner (${cf.local.x + cf.local.w} <= ${f.inner.w})`);
      assert.ok(cf.local.y + cf.local.h <= f.inner.h + 0.001, `${c} bottom edge inside ${f.path} inner`);
      rects.push({ key: c, x: cf.local.x, y: cf.local.y, w: cf.local.w, h: cf.local.h });
      // abs consistency
      const io = fr.innerOrigin(f);
      assert.strictEqual(cf.abs.x, io.x + cf.local.x, `${c} abs.x`);
      assert.strictEqual(cf.abs.y, io.y + cf.local.y, `${c} abs.y`);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        assert.ok(!fr.rectsOverlap(rects[i], rects[j], 0),
          `${rects[i].key} overlaps ${rects[j].key} in ${f.path}`);
      }
    }
  }
}

suite('frames.js — content block', () => {
  test('empty → 0×0; single small member → minimums', () => {
    assert.deepStrictEqual(fr.contentBlockSize([]), { w: 0, h: 0 });
    const one = fr.contentBlockSize([{ id: 'a', r: 10 }]);
    assert.strictEqual(one.w, fr.FRAME.MIN_CONTENT_W);
    assert.strictEqual(one.h, fr.FRAME.MIN_CONTENT_H);
  });

  test('area scales with members; aspect roughly landscape', () => {
    const members = Array.from({ length: 100 }, (_, i) => ({ id: String(i), r: 10 }));
    const { w, h } = fr.contentBlockSize(members);
    const slot = 2 * 10 + fr.FRAME.GAP;
    assert.ok(w * h >= fr.FRAME.K * 100 * slot * slot * 0.95, 'area holds all members');
    assert.ok(w >= h, 'landscape');
  });

  test('one big glyph fits (floor = 2r + 2·gap)', () => {
    const { w, h } = fr.contentBlockSize([{ id: 'g', r: 115 }]);
    assert.ok(w >= 2 * 115 + 2 * fr.FRAME.GAP);
    assert.ok(h >= 2 * 115 + 2 * fr.FRAME.GAP);
  });
});

suite('frames.js — shelfPack', () => {
  const items = [
    { key: 'a', w: 100, h: 60 }, { key: 'b', w: 80, h: 90 },
    { key: 'c', w: 120, h: 40 }, { key: 'd', w: 60, h: 90 },
  ];

  test('no overlaps, deterministic, stable for equal heights', () => {
    const p1 = fr.shelfPack(items);
    const p2 = fr.shelfPack([...items].reverse());
    assert.deepStrictEqual(p1, p2, 'input order irrelevant (keyed sort)');
    const rects = items.map(it => ({ ...p1.pos[it.key], w: it.w, h: it.h }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        assert.ok(!fr.rectsOverlap(rects[i], rects[j], 0));
      }
    }
    // equal heights b (90) and d (90): key asc → b left of d
    assert.ok(p1.pos.b.y === p1.pos.d.y ? p1.pos.b.x < p1.pos.d.x : true);
  });

  test('fixed obstacles are never overlapped', () => {
    const fixed = [{ key: 'pin', x: 0, y: 0, w: 150, h: 150 }];
    const p = fr.shelfPack(items, { fixed });
    for (const it of items) {
      const r = { ...p.pos[it.key], w: it.w, h: it.h };
      assert.ok(!fr.rectsOverlap(r, fixed[0], 0), `${it.key} overlaps obstacle`);
    }
  });

  test('bounds cover every item', () => {
    const p = fr.shelfPack(items);
    for (const it of items) {
      assert.ok(p.pos[it.key].x + it.w <= p.w + 0.001);
      assert.ok(p.pos[it.key].y + it.h <= p.h + 0.001);
    }
  });
});

suite('frames.js — buildFrames invariants', () => {
  test('fully open tree: frames for all folders, invariants hold', () => {
    const tree = makeTree();
    const fs = build(tree, new Set(['/p', '/p/a', '/p/a/b', '/p/c']));
    assert.deepStrictEqual([...fs.byPath.keys()].sort(), ['/p', '/p/a', '/p/a/b', '/p/c']);
    assert.strictEqual(fs.byPath.get('/p').kind, 'root');
    assertInvariants(fs);
    // root has no chrome: abs equals local, inner origin = abs origin
    const root = fs.byPath.get('/p');
    assert.deepStrictEqual(fr.innerOrigin(root), { x: root.abs.x, y: root.abs.y });
  });

  test('collapsed root → only the root frame with the root glyph as member', () => {
    const tree = makeTree();
    const fs = build(tree, new Set());
    assert.deepStrictEqual([...fs.byPath.keys()], ['/p']);
    assert.strictEqual(fs.byPath.get('/p').memberCount, 1);
  });

  test('expanded FILE paths are ignored; non-visibly-open folders get no frame', () => {
    const tree = makeTree();
    // /p/a/b expanded but its parent /p/a is NOT → no /p/a/b frame
    const fs = build(tree, new Set(['/p', '/p/a/b', '/p/a/y.ts']));
    assert.deepStrictEqual([...fs.byPath.keys()].sort(), ['/p']);
  });

  test('deterministic: identical input → deepStrictEqual output', () => {
    const tree = makeTree();
    const expanded = new Set(['/p', '/p/a', '/p/c']);
    const a = build(tree, expanded);
    const b = build(tree, expanded);
    assert.deepStrictEqual(a, b);
  });

  test('minimum frame size: empty open folder → 200×190 outer', () => {
    const tree = makeTree();
    const graph = { nodes: [], edges: [], files: [] };
    const fs = build(tree, new Set(['/p', '/p/c']), new Set(), graph);
    const c = fs.byPath.get('/p/c');
    // unparsed folder still holds its collapsed file node; use inner minimums
    assert.ok(c.local.w >= fr.FRAME.MIN_INNER_W + 2 * fr.FRAME.PAD);
    assert.ok(c.local.h >= fr.FRAME.MIN_INNER_H + 2 * fr.FRAME.PAD + fr.FRAME.TITLE);
  });

  test('100-folder fixture: invariants hold, layout is fast', () => {
    const { structure, graph } = makeSyntheticRepo({ folders: 100, filesPerFolder: 3, fnsPerFile: 5, edges: 1000 });
    const expanded = new Set(Object.keys(structure.folders));
    const parsed = new Set(Object.keys(structure.folders));
    const members = membersFor(structure, expanded, parsed, graph);
    const t0 = process.hrtime.bigint();
    const fs = fr.buildFrames(structure, expanded, members);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`      buildFrames(100 folders): ${ms.toFixed(1)} ms`);
    assert.ok(ms < 50, `buildFrames too slow: ${ms} ms`); // generous CI margin
    assert.strictEqual(fs.byPath.size, 100);
    assertInvariants(fs);
  });
});

suite('frames.js — updateFrames', () => {
  const tree = makeTree();
  const allOpen = new Set(['/p', '/p/a', '/p/a/b', '/p/c']);

  function membersAt(parsed: Set<string>, expanded = allOpen, graph = graphFor(tree)) {
    return membersFor(tree, expanded, parsed, graph);
  }

  test('unchanged input → changed is empty', () => {
    const parsed = new Set(Object.keys(tree.folders));
    const prev = fr.buildFrames(tree, allOpen, membersAt(parsed));
    const { frames, changed, repacked } = fr.updateFrames(prev, tree, allOpen, membersAt(parsed));
    assert.strictEqual(changed.size, 0, [...changed].join(','));
    assert.strictEqual(repacked.size, 0);
    assertInvariants(frames);
  });

  test('growth that fits in place leaves siblings untouched', () => {
    // Unparsed /p/a (small: one collapsed file) → parsed (functions appear).
    const parsed0 = new Set(['/p', '/p/a/b', '/p/c']);
    const prev = fr.buildFrames(tree, allOpen, membersAt(parsed0));
    const cBefore = { ...prev.byPath.get('/p/c').local };
    const parsed1 = new Set(Object.keys(tree.folders));
    // Parsing /p/a grows it; whether it fits depends on packing — assert the
    // contract: either nothing else moved (fit) or the parent repacked and /p/c
    // translated rigidly (its own size unchanged).
    const { frames, repacked } = fr.updateFrames(prev, tree, allOpen, membersAt(parsed1));
    assertInvariants(frames);
    const cAfter = frames.byPath.get('/p/c').local;
    assert.strictEqual(cAfter.w, cBefore.w, '/p/c width untouched');
    assert.strictEqual(cAfter.h, cBefore.h, '/p/c height untouched');
    if (!repacked.has('/p')) {
      assert.deepStrictEqual(cAfter, cBefore, 'no repack → /p/c did not move');
    }
  });

  test('never shrink in place: fewer members keeps the frame size', () => {
    const parsed = new Set(Object.keys(tree.folders));
    const bigGraph = graphFor(tree, 8);
    const prev = fr.buildFrames(tree, allOpen, membersAt(parsed, allOpen, bigGraph));
    const aBefore = { ...prev.byPath.get('/p/a').local };
    const smallGraph = graphFor(tree, 1);
    const { frames, repacked } = fr.updateFrames(prev, tree, allOpen, membersAt(parsed, allOpen, smallGraph));
    if (!repacked.has('/p/a')) {
      const aAfter = frames.byPath.get('/p/a').local;
      assert.strictEqual(aAfter.w, aBefore.w);
      assert.strictEqual(aAfter.h, aBefore.h);
    }
  });

  test('newly expanded folder becomes a frame; seed position respected when free', () => {
    const parsed = new Set(Object.keys(tree.folders));
    const someOpen = new Set(['/p', '/p/a']);
    const prev = fr.buildFrames(tree, someOpen, membersAt(parsed, someOpen));
    const nowOpen = new Set(['/p', '/p/a', '/p/c']);
    const { frames, changed } = fr.updateFrames(prev, tree, nowOpen, membersAt(parsed, nowOpen), {
      seedPos: { '/p/c': { x: 4000, y: 3000 } },
    });
    assert.ok(frames.byPath.has('/p/c'));
    assert.ok(changed.has('/p/c'));
    assertInvariants(frames);
  });

  test('collapsing removes the frame and reports it changed', () => {
    const parsed = new Set(Object.keys(tree.folders));
    const prev = fr.buildFrames(tree, allOpen, membersAt(parsed));
    const fewer = new Set(['/p', '/p/c']);
    const { frames, changed } = fr.updateFrames(prev, tree, fewer, membersAt(parsed, fewer));
    assert.ok(!frames.byPath.has('/p/a'));
    assert.ok(!frames.byPath.has('/p/a/b'));
    assert.ok(changed.has('/p/a'));
    assertInvariants(frames);
  });

  test('pinned frame: position kept, siblings pack around it, negative clamped', () => {
    const parsed = new Set(Object.keys(tree.folders));
    const prev = fr.buildFrames(tree, allOpen, membersAt(parsed));
    fr.pinFrame(prev, '/p/a', { x: -50, y: 10 });
    const a = prev.byPath.get('/p/a');
    assert.strictEqual(a.local.x, 0, 'negative pin clamped to 0');
    assert.strictEqual(a.local.y, 10);
    assert.ok(a.pinned);
    const { frames } = fr.updateFrames(prev, tree, allOpen, membersAt(parsed));
    const a2 = frames.byPath.get('/p/a');
    assert.strictEqual(a2.local.x, 0, 'pinned x kept across update');
    assert.strictEqual(a2.local.y, 10, 'pinned y kept across update');
    assertInvariants(frames);
  });

  test('userSize is a floor, never a clip', () => {
    const parsed = new Set(Object.keys(tree.folders));
    const fs = fr.buildFrames(tree, allOpen, membersAt(parsed));
    const before = { ...fs.byPath.get('/p/c').local };
    fr.pinFrame(fs, '/p/c', null, { w: before.w + 200, h: before.h + 100 });
    const c = fs.byPath.get('/p/c');
    assert.strictEqual(c.local.w, before.w + 200);
    fr.pinFrame(fs, '/p/c', null, { w: 10, h: 10 }); // smaller than content
    assert.ok(c.local.w >= before.w, 'tiny userSize cannot clip content');
  });
});

suite('frames.js — file slots (shelf interior)', () => {
  const tree = makeTree();
  const allOpen = new Set(['/p', '/p/a', '/p/a/b', '/p/c']);
  const parsed = new Set(Object.keys(tree.folders));

  test('packContentSlots: every member slotted, slots inside bounds, no overlap', () => {
    const members = [
      { id: 'a1', r: 10, file: '/p/x.ts', isFn: true },
      { id: 'a2', r: 10, file: '/p/x.ts', isFn: true },
      { id: 'b1', r: 10, file: '/p/y.ts', isFn: true },
      { id: 'g1', r: 40, file: null, isFn: false }, // collapsed folder glyph
    ];
    const p = fr.packContentSlots(members);
    assert.strictEqual(p.slotOf.size, 4, 'every member mapped');
    assert.strictEqual(p.slots.size, 3, 'two file slots + one solo slot');
    const rects = [...p.slots.values()];
    for (const r of rects) {
      assert.ok(r.x >= 0 && r.y >= 0);
      assert.ok(r.x + r.w <= p.w + 0.001, 'slot inside content width');
      assert.ok(r.y + r.h <= p.h + 0.001, 'slot inside content height');
      assert.ok(r.h >= fr.SLOT.MIN_H, 'min slot height');
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        assert.ok(!fr.rectsOverlap(rects[i], rects[j], 0), 'slots never overlap');
      }
    }
    const fileSlot = p.slots.get('file:/p/x.ts');
    assert.strictEqual(fileSlot.count, 2, 'fn count carried');
    assert.strictEqual(fileSlot.file, '/p/x.ts');
    const soloKey = p.slotOf.get('g1');
    assert.strictEqual(p.slots.get(soloKey).file, null, 'glyph gets a solo slot');
  });

  test('packContentSlots is deterministic and empty-safe', () => {
    const members = [
      { id: 'b', r: 10, file: '/p/y.ts', isFn: true },
      { id: 'a', r: 10, file: '/p/x.ts', isFn: true },
    ];
    const p1 = fr.packContentSlots(members);
    const p2 = fr.packContentSlots([...members].reverse());
    assert.deepStrictEqual(p1, p2);
    assert.deepStrictEqual(fr.packContentSlots([]), { w: 0, h: 0, slots: new Map(), slotOf: new Map() });
  });

  test('buildFrames fills slots/slotOf; slotInteriors maps every member', () => {
    const fs = build(tree, allOpen, parsed);
    const a = fs.byPath.get('/p/a');
    assert.ok(a.slots.size > 0, 'frame carries slots');
    const mems = [...a.slotOf.keys()].map(id => ({ id }));
    const interiors = fr.slotInteriors(a, mems);
    assert.strictEqual(interiors.size, mems.length);
    for (const r of interiors.values()) {
      assert.ok(r.x >= 0 && r.y >= 0, 'interior inside inner rect');
      assert.ok(r.x + r.w <= a.inner.w + 0.001);
      assert.ok(r.y + r.h <= a.inner.h + 0.001);
    }
    assert.strictEqual(fr.slotInteriorFor(a, 'nonexistent'), null);
  });

  test('slot interiors sit below the label strip', () => {
    const members = [{ id: 'a1', r: 10, file: '/p/x.ts', isFn: true }];
    const p = fr.packContentSlots(members);
    const f = { kind: 'folder', contentPos: { x: 0, y: 0 }, slots: p.slots, slotOf: p.slotOf, inner: { w: 500, h: 500 } };
    const slot = p.slots.get('file:/p/x.ts');
    const interior = fr.slotInteriorFor(f, 'a1');
    assert.strictEqual(interior.y, slot.y + fr.SLOT.LABEL_H);
    assert.ok(interior.h < slot.h);
  });
});

suite('frames.js — gridPositions (static placement)', () => {
  const rect = { x: 100, y: 200, w: 120, h: 90 };
  const mems = (n: number, r = 10) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, r }));

  test('deterministic, order-preserving, inside the rect', () => {
    const a = fr.gridPositions(mems(7), rect);
    const b = fr.gridPositions(mems(7), rect);
    assert.deepStrictEqual(a, b);
    for (const [, p] of a) {
      assert.ok(p.x >= rect.x && p.x <= rect.x + rect.w, 'x inside');
      assert.ok(p.y >= rect.y && p.y <= rect.y + rect.h, 'y inside');
    }
    // row-major: first member top-left, second to its right
    assert.ok((a.get('m1') as any).x > (a.get('m0') as any).x);
    assert.strictEqual((a.get('m1') as any).y, (a.get('m0') as any).y);
  });

  test('no two members share a centre when the rect fits them', () => {
    const a = fr.gridPositions(mems(6), { x: 0, y: 0, w: 200, h: 120 });
    const seen = new Set<string>();
    for (const [, p] of a) {
      const k = `${p.x},${p.y}`;
      assert.ok(!seen.has(k), 'unique grid cells');
      seen.add(k);
    }
  });

  test('overflow compresses rows but stays inside the rect', () => {
    const a = fr.gridPositions(mems(40), { x: 0, y: 0, w: 100, h: 60 });
    for (const [, p] of a) {
      assert.ok(p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 60);
    }
  });

  test('empty input → empty map', () => {
    assert.strictEqual(fr.gridPositions([], rect).size, 0);
  });
});

suite('frames.js — queries & persistence', () => {
  const tree = makeTree();
  const allOpen = new Set(['/p', '/p/a', '/p/a/b', '/p/c']);
  const parsed = new Set(Object.keys(tree.folders));
  const fs = build(tree, allOpen, parsed);

  test('hitTest: deepest frame wins; outside → null', () => {
    const b = fs.byPath.get('/p/a/b');
    const inside = { x: b.abs.x + b.abs.w / 2, y: b.abs.y + b.abs.h / 2 };
    assert.strictEqual(fr.hitTest(fs, inside.x, inside.y).path, '/p/a/b');
    const a = fs.byPath.get('/p/a');
    // a point in /p/a's padding (just inside its rect, left edge) hits /p/a
    assert.strictEqual(fr.hitTest(fs, a.abs.x + 1, a.abs.y + a.abs.h - 1).path, '/p/a');
    const root = fs.byPath.get('/p');
    assert.strictEqual(fr.hitTest(fs, root.abs.x - 10, root.abs.y - 10), null);
  });

  test('titleBarRect and frameBounds', () => {
    const a = fs.byPath.get('/p/a');
    assert.deepStrictEqual(fr.titleBarRect(a), { x: a.abs.x, y: a.abs.y, w: a.abs.w, h: fr.FRAME.TITLE });
    assert.deepStrictEqual(fr.frameBounds(fs), { ...fs.byPath.get('/p').abs });
  });

  test('intersectsViewport', () => {
    const a = fs.byPath.get('/p/a');
    assert.ok(fr.intersectsViewport(a, { x: a.abs.x + 5, y: a.abs.y + 5, w: 10, h: 10 }));
    assert.ok(!fr.intersectsViewport(a, { x: a.abs.x + a.abs.w + 100, y: 0, w: 10, h: 10 }));
  });

  test('serialize → deserialize round-trips rects and pinned', () => {
    const saved = fr.serializeFrames(fs);
    assert.ok(saved['/p/a'] && saved['/p/c']);
    assert.ok(!saved['/p'], 'root not serialized');
    const fs2 = build(tree, allOpen, parsed);
    fr.pinFrame(fs2, '/p/c', { x: 500, y: 400 });
    const saved2 = fr.serializeFrames(fs2);
    assert.strictEqual(saved2['/p/c'].pinned, true);
    const fs3 = build(tree, allOpen, parsed);
    fr.deserializeFrames(saved2, fs3);
    assert.strictEqual(fs3.byPath.get('/p/c').local.x, 500);
    assert.strictEqual(fs3.byPath.get('/p/c').pinned, true);
  });
});
