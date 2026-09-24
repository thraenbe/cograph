// Geometry snapshot taken in the page (collect.ts) and consumed by the pure
// metric functions (compute.ts). Plain JSON so it can be stored next to the
// video and re-scored later without re-running the browser.

export interface Rect { x: number; y: number; w: number; h: number }

export interface SnapNode {
  id: string;
  x: number; y: number; r: number;       // graph coordinates
  kind: 'fn' | 'cluster' | 'lib';
  file: string | null;
  frame: string | null;                  // owning frame path (shelf engine)
  slot: string | null;                   // slot key inside that frame
}

export interface SnapFrame { path: string; kind: string; parent: string | null; rect: Rect; inner: Rect }
export interface SnapSlot { frame: string; key: string; rect: Rect; interior: Rect }

export interface Snapshot {
  engine: string;
  motion: string;
  viewMode?: string;                     // 'cluster' | 'workflow'
  zoom: { k: number; x: number; y: number };
  viewport: { w: number; h: number };
  nodes: SnapNode[];
  frames: SnapFrame[];
  slots: SnapSlot[];
  edges: Array<[number, number]>;        // indices into nodes
  labels: Rect[];                        // screen coordinates, visible labels only
  boxes?: Rect[];                        // screen coordinates of folder boxes (frames / drill-down boxes)
  labelsTruncated: boolean;
  domNodes: number;
  heapMB: number | null;
}

export interface LayoutMetrics {
  nodes: number;
  edges: number;
  frames: number;
  slots: number;
  nodeOverlapPairs: number;
  nodeOverlapRatio: number;              // nodes involved in >= 1 overlap / nodes
  nodesOutsideSlot: number;              // centre outside its slot rect (B1)
  nodesPokingOutOfSlot: number;          // circle crosses the slot rect
  nodesOutsideFrame: number;             // centre outside its frame rect (B1)
  nodesPinnedToWall: number;             // resting on the clamp wall (B2)
  frameOverlapPairs: number;             // sibling frames intersecting (R2)
  slotOverlapPairs: number;              // slots of one frame intersecting (R2)
  edgeLenMean: number;
  edgeLenCv: number;
  edgeCrossingsPerEdge: number;          // on a seeded sample
  edgesSampled: number;
  labels: number;
  labelOverlapRatio: number;             // labels intersecting another label / labels (B6, R4)
  bboxAspect: number;
  inkRatio: number;                      // node area / bbox area (1 - whitespace)
  viewportCoverage: number;              // on-screen bbox area / viewport area
  offscreenNodeRatio: number;            // nodes painted outside the viewport / nodes
  // Legibility at the CURRENT zoom (meaningful on fitted steps): a layout that spreads wide is small at fit.
  nodePxMedian?: number;                 // median on-screen node radius in px
  labelPxMedian?: number;                // median on-screen label height in px
  smallBoxShare?: number;                // folder boxes narrower or lower than 40 px / folder boxes
  domNodes: number;
  heapMB: number | null;
}
