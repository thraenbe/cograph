const state = {
  // ── Boot config (injected via window.COGRAPH_CONFIG by webviewHtmlBuilder
  // before this script loads). Node tests have no window → classic 'dynamic'. ──
  perfEnabled: !!(typeof window !== 'undefined' && window.COGRAPH_CONFIG && window.COGRAPH_CONFIG.perf),
  frames: null,          // FrameSet (folder-frames engine; see frames.js)
  savedLayout: null,     // pending saved-layout payload consumed by the frames engine
  graphData: null,
  complexityLevel: 1,
  // Primary view: 'cluster' = the force graph (grouped per clusterGroupBy);
  // 'workflow' = the AI-pipeline staged layout (auto-detected from graph.workflow).
  viewMode: 'cluster',
  // Cluster lens: always 'file' (the folder drill-down). The Class/Connect
  // lenses were removed in 1.3.0; saved views carrying them load as 'file'.
  // Drill-down is active when clusterGroupBy === 'file' && viewMode !== 'workflow'
  // && a structure tree is loaded (see isDrilldown()).
  clusterGroupBy: 'file',
  // Node ids whose position was deliberately placed (slot grid, settled sim,
  // drag, saved layout). Keyed by id so graph patches that replace node
  // objects keep the information. See frameRender.placeMembersInSlots.
  slotPlacedIds: new Set(),
  workflowLevel: 0,                // 0..9 detail level when viewMode === 'workflow'
  workflowStageCount: 1,
  workflowDividerStage: 0,
  importanceScores: null,
  clusterTimer: null,
  expandedClusters: new Set(),
  expandedLibClusters: new Set(),
  connectedNodeIds: new Set(),
  simulation: null,
  svgNodes: null,
  svgCloudNodes: null,
  svgLinks: null,
  svgLabels: null,
  svgLibNodes: null,
  svgLibLabels: null,
  currentNodes: [],
  currentZoom: 1,
  hasFitted: false,
  pendingReheat: false,
  // 'dynamic' | 'static' (classic single-simulation layout) | 'shelf' (frames)
  // Motion axis: 'dynamic' | 'static' (classic semantics on either engine).
  layoutMode: (typeof window !== 'undefined' && window.COGRAPH_CONFIG && window.COGRAPH_CONFIG.defaultMode) || 'dynamic',
  // Engine axis: 'shelf' (folder frames, File lens) | 'global' (classic single sim).
  layoutEngine: (typeof window !== 'undefined' && window.COGRAPH_CONFIG && window.COGRAPH_CONFIG.defaultEngine) || 'global',
  gitMode: true,
  languageMode: true,
  folderMode: true,
  classMode: true,
  svgFileCircles: null,
  svgFolderBubbles: null,
  svgDrilldownBoxes: null,       // folder boxes in file (drill-down) mode
  svgClassBubbles: null,
  gitAvailable: false,
  fileGitStatus: {},
  activeLibNode: null,
  libDescRequestId: 0,
  funcPopups: new Map(),
  funcPopupZCounter: 200,
  allScannedFiles: [],
  hiddenFolders: new Set(),
  onlyShowFolder: null,
  hiddenFiles: new Set(),        // file-level filters (R2a), mirroring the folder ones
  onlyShowFile: null,
  // Host subgraph scope (round 3 W4): {name, root, include:Set, exclude:Set}
  // mapped from the last `subgraph` message, or null. NEVER persisted here —
  // scope is host state; hidden*/onlyShow* above are view state.
  scope: null,
  scopePending: new Set(),       // rel paths whose Visualize is in flight
  // ── File-cluster (folder drill-down — the 'file' lens) ────────────────────
  // Active when clusterGroupBy === 'file' && viewMode !== 'workflow' &&
  // structureTree is set (isDrilldown()).
  structureTree: null,           // StructureTree from the `structure` message
  rootFolderPath: null,          // common-root folder = the level-0 node
  detailDepth: 0,                // file-mode: uniform folder-open depth (slider-driven)
  expandedFolders: new Set(),    // folder/file paths the user has drilled into
  parsedFolders: new Set(),      // folders whose files have been parsed (functions known)
  parsingFolders: new Set(),     // folders with an in-flight subset parse (spinner)
  backgroundParsing: false,      // true while the full background pass runs
  timeline: {
    order: [],
    libOrder: new Map(),
    isPlaying: false,
    currentIdx: 0,
    rafHandle: null,
    lastFrameMs: null,
    nodesPerSec: 5,
    filterPredicate: null,
  },
};
