// THE one selector map. Scenarios never hardcode ids — when the ux session
// lands its panel restructure only this file changes. `optional: true` means a
// step using it is reported as "skipped (selector absent)" instead of failing.
//
// Built against the shelf-base checkpoint (9eda4c8) plus the ux changes that
// were approved on 2026-09-18 (listed under `// ux:`), so both UIs run green.

export interface Sel { css: string; optional?: boolean; note?: string }

export const SEL = {
  // canvas
  graph: { css: '#graph' },
  svg: { css: '#graph svg' },
  frame: { css: '#graph g.frame' },
  frameTitle: { css: '#graph g.frame .folder-bubble-titlebar' },
  frameTab: { css: '#graph g.frame .frame-tab', optional: true, note: 'ux: index-tab header replaces the titlebar' },
  fileSlot: { css: '#graph g.file-slot' },
  fnNode: { css: '#graph circle.regular-node' },
  clusterNode: { css: '#graph path.cloud-node' },
  ctxMenu: { css: '#ctx-menu' },
  ctxMenuItems: { css: '#ctx-menu-list li' },

  // layout panel
  engineShelf: { css: '#btn-engine-shelf' },
  engineGlobal: { css: '#btn-engine-global' },
  motionDynamic: { css: '#btn-layout-dynamic' },
  motionStatic: { css: '#btn-layout-static' },
  layoutHint: { css: '#layout-hint' },
  globalGuardHint: { css: '#global-guard-hint', optional: true, note: 'ux ee36bf5: first Engine:Global click above 4 000 nodes shows this hint; a second click within 6 s switches' },

  // detail + group-by
  detailSlider: { css: '#slider-complexity' },
  detailValue: { css: '#val-complexity' },
  groupFile: { css: '#btn-group-file', optional: true, note: 'ux: removed' },
  groupClass: { css: '#btn-group-class', optional: true, note: 'ux: removed' },
  groupConnect: { css: '#btn-group-connect', optional: true, note: 'ux: removed' },

  // git / language / folder / class
  gitPanel: { css: '#panel-git' },
  gitMode: { css: '#btn-git-mode' },
  gitLegendToggle: { css: '#toggle-git-legend' },
  gitLegendBody: { css: '#git-legend-body' },
  languageMode: { css: '#btn-language-mode' },
  languageLegend: { css: '#language-legend' },
  folderMode: { css: '#btn-folder-mode' },
  folderFiltersToggle: { css: '#toggle-folder-filters' },
  folderFiltersBody: { css: '#folder-filters-body' },
  classMode: { css: '#btn-class-mode' },

  // forces (ux: one engine-specific Forces box in the left toolbar)
  forceFileCluster: { css: '#slider-file-cluster' },
  forceFolderRepel: { css: '#slider-folder-repel' },
  forceFileRepel: { css: '#slider-file-repel' },
  forceCenter: { css: '#slider-center-force' },
  forceRepel: { css: '#slider-repel-force' },
  forceLink: { css: '#slider-link-force' },
  moreForcesOld: { css: '#btn-more-forces', optional: true, note: 'ux: replaced by #btn-show-more-forces' },
  showMoreForces: { css: '#btn-show-more-forces', optional: true, note: 'ux: inline expander' },
  forcesHint: { css: '#forces-hint', optional: true, note: 'ux: shown in Static' },
  forceLinkDistance: { css: '#slider-link-distance', optional: true, note: 'ux: new' },
  forceVelocityDecay: { css: '#slider-velocity-decay', optional: true, note: 'ux: new' },
  forceCollidePad: { css: '#slider-collide-pad', optional: true, note: 'ux: new' },
  forceSlotPad: { css: '#slider-slot-pad', optional: true, note: 'ux: new' },
  forceRepelRange: { css: '#slider-repel-range', optional: true, note: 'ux 7b539b5: Global only, 100-2000 px, slider max = unlimited (shown as ∞, default)' },

  // actions
  openChat: { css: '#btn-open-chat' },
  saveGraph: { css: '#btn-save-graph' },

  // settings (gear) panel
  settingsBtn: { css: '#settings-btn' },
  settingsPanel: { css: '#settings-panel' },
  search: { css: '#search' },
  clearSearch: { css: '#btn-clear-search' },
  searchCount: { css: '#search-count' },
  toggleOrphans: { css: '#toggle-orphans' },
  toggleLibraries: { css: '#toggle-libraries' },
  librariesHint: { css: '#libraries-hint', optional: true, note: 'ux: shown while the Shelf engine disables Show Libraries (F5)' },
  toggleEmptyFiles: { css: '#toggle-empty-files' },
  toggleArrows: { css: '#toggle-arrows' },
  toggleFuncPopup: { css: '#toggle-func-popup' },
  sliderTextFade: { css: '#slider-text-fade' },
  sliderNodeSize: { css: '#slider-node-size' },
  sliderTextSize: { css: '#slider-text-size' },
  sliderLinkThickness: { css: '#slider-link-thickness' },
  resetLayout: { css: '#btn-reset-layout' },

  // popups
  libPopup: { css: '#lib-doc-popup' },
  libPopupClose: { css: '#lib-doc-close' },
  hoverCard: { css: '.hover-card', optional: true, note: 'annotate: hoverCard.js (element exists from load; .visible while shown)' },
  hoverCardVisible: { css: '.hover-card.visible', optional: true, note: 'annotate' },
  hoverCardName: { css: '.hover-card .hc-name', optional: true, note: 'annotate' },
  hoverCardPath: { css: '.hover-card .hc-path', optional: true, note: 'annotate' },
  hoverCardFacts: { css: '.hover-card .hc-facts', optional: true, note: 'annotate' },
  hoverCardSummary: { css: '.hover-card .hc-summary', optional: true, note: 'annotate' },
  hoverCardBadge: { css: '.hover-card .hc-badge', optional: true, note: 'annotate: stale badge, hidden via display:none' },

  // harness self-test: an optional selector that can never exist on any branch
  absentForTest: { css: '#__uxtest-absent__', optional: true, note: 'never present; proves the skip path' },

  // timeline transport (timeline HTML only)
  tlPlay: { css: '#btn-timeline-play' },
  tlReset: { css: '#btn-timeline-reset' },
  tlPos: { css: '#slider-timeline-pos' },
  tlSpeed: { css: '#slider-timeline-speed' },
} satisfies Record<string, Sel>;

export type SelName = keyof typeof SEL;

/** Selectors only present in the timeline variant of the HTML. */
export const TIMELINE_ONLY: SelName[] = ['tlPlay', 'tlReset', 'tlPos', 'tlSpeed'];
/** Selectors created at runtime by the renderer (absent from the static HTML). */
export const RUNTIME_ONLY: SelName[] = ['svg', 'frame', 'frameTitle', 'frameTab', 'fileSlot', 'fnNode', 'clusterNode', 'ctxMenuItems', 'hoverCard', 'hoverCardVisible', 'hoverCardName', 'hoverCardPath', 'hoverCardFacts', 'hoverCardSummary', 'hoverCardBadge'];
