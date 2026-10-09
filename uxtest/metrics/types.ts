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
  zoom: { k: number; x: number; y: number };
  viewport: { w: number; h: number };
  nodes: SnapNode[];
  frames: SnapFrame[];
  slots: SnapSlot[];
  edges: Array<[number, number]>;        // indices into nodes
  labels: Rect[];                        // screen coordinates, visible labels only
  boxes?: Array<Rect & { path?: string }>; // screen coordinates of folder boxes (frames / drill-down boxes) + folder path
  labelsTruncated: boolean;
  domNodes: number;
  heapMB: number | null;
  /** largest on-screen arrowhead (marker) in px over all rendered lines, with the marker id it came from */
  maxMarkerPx?: number; maxMarkerId?: string; markerLines?: number;
  /** frames whose first slot row intersects the frame's own name line (R4 reserves NAME_H for it) */
  slotsOverName?: number;
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
  /** Overlap area between folder boxes that are NOT ancestor/descendant of each other, relative to the total box
   *  area (0 = every folder has its own territory). Global layouts that merge folders score high here. */
  folderOverlapRatio?: number;
  domNodes: number;
  heapMB: number | null;
  maxMarkerPx?: number; maxMarkerId?: string; markerLines?: number;   // markerLines = visible lines with an arrowhead (0 = R3 guards nothing here). R3: bundle arrowheads must stay small at every zoom
  slotsOverName?: number;                       // R4: slot rows must not touch the folder name line
}
