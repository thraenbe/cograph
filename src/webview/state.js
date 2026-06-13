const state = {
  graphData: null,
  complexityLevel: 1,
  clusterGroupBy: 'connectivity',  // 'connectivity' | 'class' | 'file' | 'folder'
  renderMode: 'force',             // 'force' (default) | 'workflow'
  workflowLevel: 0,                // 0..9 detail level when renderMode === 'workflow'
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
  // ── File-cluster (large-repo progressive drill-down) ──────────────────────
  fileClusterMode: false,        // master toggle for the folder-skeleton render mode
  structureTree: null,           // StructureTree from the `structure` message
  rootFolderPath: null,          // common-root folder = the level-0 node
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
