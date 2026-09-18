import { test, expect } from '@playwright/test';
import {
  bboxOf, computeMetrics, containment, edgeCrossings, edgeLengthStats, forEngine, isPinned, labelOverlapRatio,
  maxDisplacement, mulberry32, nodeOverlapPairs, offscreenRatio, pointInRect, rectOverlapPairs, rectsIntersect,
  sampleEdges, segmentsCross,
} from '../metrics/compute';
import { framed, inSlot, node, snapshot } from './fixtures';

test.describe('geometry primitives', () => {
  test('rectsIntersect ignores touching edges', () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 30, y: 30, w: 5, h: 5 })).toBe(false);
  });

  test('pointInRect is inclusive with tolerance', () => {
    const r = { x: 0, y: 0, w: 10, h: 10 };
    expect(pointInRect(10.3, 5, r)).toBe(true);
    expect(pointInRect(11, 5, r)).toBe(false);
    expect(pointInRect(10.3, 5, r, 0)).toBe(false);
  });

  test('segmentsCross: proper crossings only', () => {
    const a = node('a', 0, 0), b = node('b', 10, 10), c = node('c', 0, 10), d = node('d', 10, 0);
    expect(segmentsCross(a, b, c, d)).toBe(true);
    expect(segmentsCross(a, c, b, d)).toBe(false);            // parallel
    expect(segmentsCross(a, b, b, d)).toBe(false);            // shared endpoint
  });

  test('mulberry32 is deterministic and in [0,1)', () => {
    const r1 = mulberry32(7), r2 = mulberry32(7);
    const seq = [r1(), r1(), r1()];
    expect([r2(), r2(), r2()]).toEqual(seq);
    expect(seq.every(v => v >= 0 && v < 1)).toBe(true);
    expect(mulberry32(8)()).not.toBe(seq[0]);
  });
});

test.describe('overlaps', () => {
  test('nodeOverlapPairs counts each overlapping pair once', () => {
    const nodes = [node('a', 0, 0), node('b', 6, 0), node('c', 100, 100), node('d', 103, 100), node('e', 500, 500)];
    expect(nodeOverlapPairs(nodes)).toHaveLength(2);
    expect(nodeOverlapPairs([node('a', 0, 0), node('b', 10, 0)])).toHaveLength(0); // tangent
    expect(nodeOverlapPairs([node('a', 0, 0)])).toEqual([]);
  });

  test('nodeOverlapPairs matches brute force on a dense random cloud', () => {
    const rng = mulberry32(3);
    const nodes = Array.from({ length: 300 }, (_, i) => node(String(i), rng() * 400, rng() * 400, 3 + rng() * 6));
    let brute = 0;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) < nodes[i].r + nodes[j].r - 0.5) { brute++; }
      }
    }
    expect(nodeOverlapPairs(nodes)).toHaveLength(brute);
  });

  test('rectOverlapPairs and labelOverlapRatio', () => {
    const rects = [{ x: 0, y: 0, w: 50, h: 10 }, { x: 40, y: 5, w: 50, h: 10 }, { x: 300, y: 300, w: 20, h: 10 }, { x: 0, y: 100, w: 5, h: 5 }];
    expect(rectOverlapPairs(rects)).toEqual([[0, 1]]);
    expect(labelOverlapRatio(rects)).toBe(0.5);
    expect(labelOverlapRatio([rects[0]])).toBe(0);
  });
});

test.describe('containment (B1/B2)', () => {
  test('counts outside-slot, poking, outside-frame and pinned separately', () => {
    const snap = framed([
      node('ok', 150, 120, 5, inSlot),
      node('outSlot', 300, 120, 5, inSlot),          // inside frame, outside slot
      node('outFrame', 450, 120, 5, inSlot),         // outside both
      node('poke', 247, 120, 5, inSlot),             // centre inside, circle crosses the right wall
      node('pinnedLeft', 57, 120, 5, inSlot),        // x - r == interior.x
      node('free', 900, 700, 5),                     // no owner: never counted
    ]);
    expect(containment(snap)).toEqual({ outsideSlot: 2, pokingOut: 1, outsideFrame: 1, pinned: 1 });
  });

  test('isPinned ignores slots too tight to judge', () => {
    expect(isPinned(node('n', 5, 5, 5), { x: 0, y: 0, w: 11, h: 11 })).toBe(false);
    expect(isPinned(node('n', 50, 95, 5), { x: 0, y: 0, w: 100, h: 100 })).toBe(true); // bottom wall
    expect(isPinned(node('n', 50, 50, 5), { x: 0, y: 0, w: 100, h: 100 })).toBe(false);
  });

  test('forEngine drops stale frames under the global engine', () => {
    const snap = { ...framed([node('outSlot', 300, 120, 5, inSlot)]), engine: 'global' };
    const g = forEngine(snap);
    expect(g.frames).toEqual([]);
    expect(g.nodes[0].slot).toBeNull();
    expect(computeMetrics(snap).nodesOutsideSlot).toBe(0);
    expect(forEngine(framed([]))).toHaveProperty('engine', 'shelf');
  });
});

test.describe('edges', () => {
  const nodes = [node('a', 0, 0), node('b', 10, 0), node('c', 5, -5), node('d', 5, 5), node('e', 100, 100), node('f', 100, 130)];

  test('edgeLengthStats', () => {
    const s = edgeLengthStats(snapshot({ nodes, edges: [[0, 1], [4, 5]] }));
    expect(s.mean).toBe(20);
    expect(s.cv).toBeCloseTo(0.5, 5);
    expect(edgeLengthStats(snapshot())).toEqual({ mean: 0, cv: 0 });
  });

  test('edgeCrossings counts one X', () => {
    expect(edgeCrossings(snapshot({ nodes, edges: [[0, 1], [2, 3], [4, 5]] }), 100, 1)).toEqual({ crossings: 1, sampled: 3 });
  });

  test('sampleEdges is seeded and capped', () => {
    const edges = Array.from({ length: 50 }, (_, i) => [i, i + 1] as [number, number]);
    expect(sampleEdges(edges, 100, 1)).toBe(edges);
    const a = sampleEdges(edges, 10, 5), b = sampleEdges(edges, 10, 5);
    expect(a).toHaveLength(10);
    expect(a).toEqual(b);
    expect(sampleEdges(edges, 10, 6)).not.toEqual(a);
  });
});

test.describe('computeMetrics', () => {
  test('clean grid → zero violations, sane ratios', () => {
    const nodes = [];
    for (let i = 0; i < 12; i++) { nodes.push(node(String(i), 70 + (i % 6) * 25, 90 + Math.floor(i / 6) * 25, 5, inSlot)); }
    const m = computeMetrics(framed(nodes));
    expect(m).toMatchObject({ nodes: 12, frames: 2, slots: 1, nodeOverlapPairs: 0, nodeOverlapRatio: 0, nodesOutsideSlot: 0,
      nodesPokingOutOfSlot: 0, nodesOutsideFrame: 0, nodesPinnedToWall: 0, frameOverlapPairs: 0, slotOverlapPairs: 0, offscreenNodeRatio: 0 });
    expect(m.bboxAspect).toBeGreaterThan(1);
    expect(m.inkRatio).toBeGreaterThan(0);
    expect(m.viewportCoverage).toBeGreaterThan(0);
  });

  test('sibling frame + slot overlaps are counted, root is ignored', () => {
    const snap = framed([]);
    snap.frames.push({ path: '/r/b', kind: 'folder', parent: '/r', rect: { x: 350, y: 0, w: 200, h: 200 }, inner: { x: 390, y: 70, w: 120, h: 90 } });
    snap.slots.push({ frame: '/r/a', key: 'g.ts', rect: { x: 240, y: 60, w: 100, h: 100 }, interior: { x: 242, y: 76, w: 96, h: 82 } });
    snap.slots.push({ frame: '/r/b', key: 'h.ts', rect: { x: 240, y: 60, w: 100, h: 100 }, interior: { x: 242, y: 76, w: 96, h: 82 } }); // other frame
    const m = computeMetrics(snap);
    expect(m.frameOverlapPairs).toBe(1);
    expect(m.slotOverlapPairs).toBe(1);
  });

  test('empty snapshot does not divide by zero', () => {
    const m = computeMetrics(snapshot());
    expect(m.nodes).toBe(0);
    expect(m.bboxAspect).toBe(0);
    expect(m.inkRatio).toBe(0);
    expect(bboxOf([])).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  test('overlap node cap limits the work', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => node(String(i), 0, 0));
    expect(computeMetrics(snapshot({ nodes }), { maxOverlapNodes: 5 }).nodeOverlapPairs).toBe(10);
  });

  test('offscreenRatio honours the zoom transform', () => {
    const nodes = [node('a', 10, 10), node('b', 2000, 10)];
    expect(offscreenRatio(snapshot({ nodes }))).toBe(0.5);
    expect(offscreenRatio(snapshot({ nodes, zoom: { k: 0.25, x: 0, y: 0 } }))).toBe(0);
    expect(offscreenRatio(snapshot())).toBe(0);
  });
});

test('maxDisplacement filters and ignores unknown ids', () => {
  const before = snapshot({ nodes: [node('a', 0, 0, 5, { frame: 'x' }), node('b', 0, 0, 5, { frame: 'y' })] });
  const after = snapshot({ nodes: [node('a', 30, 40, 5, { frame: 'x' }), node('b', 0, 0.2, 5, { frame: 'y' }), node('new', 9, 9)] });
  expect(maxDisplacement(before, after)).toEqual({ max: 50, moved: 1 });
  expect(maxDisplacement(before, after, n => n.frame !== 'x')).toEqual({ max: 0.2, moved: 0 });
});
