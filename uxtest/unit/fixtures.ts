// Hand-built snapshots with known answers.
import type { SnapNode, Snapshot } from '../metrics/types';

export function node(id: string, x: number, y: number, r = 5, extra: Partial<SnapNode> = {}): SnapNode {
  return { id, x, y, r, kind: 'fn', file: null, frame: null, slot: null, ...extra };
}

export function snapshot(partial: Partial<Snapshot> = {}): Snapshot {
  return {
    engine: 'shelf', motion: 'static', zoom: { k: 1, x: 0, y: 0 }, viewport: { w: 1000, h: 800 },
    nodes: [], frames: [], slots: [], edges: [], labels: [], labelsTruncated: false, domNodes: 100, heapMB: 12,
    ...partial,
  };
}

/** One frame (0,0,400,300) with one slot (50,50,200,150); interior inset 2 / label 16. */
export function framed(nodes: SnapNode[]): Snapshot {
  return snapshot({
    nodes,
    frames: [
      { path: '/r', kind: 'root', parent: null, rect: { x: -50, y: -50, w: 1000, h: 800 }, inner: { x: -50, y: -50, w: 1000, h: 800 } },
      { path: '/r/a', kind: 'folder', parent: '/r', rect: { x: 0, y: 0, w: 400, h: 300 }, inner: { x: 40, y: 70, w: 320, h: 190 } },
    ],
    slots: [{ frame: '/r/a', key: 'f.ts', rect: { x: 50, y: 50, w: 200, h: 150 }, interior: { x: 52, y: 66, w: 196, h: 132 } }],
  });
}

export const inSlot = { frame: '/r/a', slot: 'f.ts' };
