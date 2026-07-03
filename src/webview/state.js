const state = {
  graphData: null,
  complexityLevel: 1,
  // Primary view: 'cluster' = the force graph (grouped per clusterGroupBy);
  // 'workflow' = the AI-pipeline staged layout (auto-detected from graph.workflow).
  viewMode: 'cluster',
  // Cluster lens: 'file' = the folder drill-down (default); 'class'; 'connect'
  // (call-connectivity; the enum value was 'connectivity', the button label "Auto").
  // Drill-down is active when clusterGroupBy === 'file' && viewMode !== 'workflow'
  // && a structure tree is loaded (see isDrilldown()).
  clusterGroupBy: 'file',
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
  layoutMode: 'dynamic',
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
