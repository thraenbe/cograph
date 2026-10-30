// stageMarkup.ts — the stage's <body> markup, shared by every page in stagePage.ts. No vscode, no script.

export interface StageMarkupOptions {
  timelineMode: boolean;
  browser: boolean;
  sameFileEdgesOnly: boolean;
}

/** <body> from the graph to the context menu, with no script. */
export function stageMarkup({ timelineMode, browser, sameFileEdgesOnly }: StageMarkupOptions): string {
  // The panel opens a browser tab; inside that tab the button would open a second copy of itself.
  const browserButtonHtml = browser ? '' : `
      <button id="btn-open-browser" class="tl-btn" title="Open this graph in your browser">Open in browser</button>
      <p id="browser-status" class="browser-status" style="display:none"></p>`;

  const timelinePanelHtml = timelineMode ? `
    <div id="tl-transport" role="toolbar" aria-label="Timeline playback" title="Replay graph construction from git history">
      <div class="tl-tx-group">
        <button id="btn-timeline-play" class="tl-tx-play" disabled title="Loading history…" aria-label="Play">
          <span class="tl-tx-play-icon">&#9654;</span>
        </button>
        <button id="btn-timeline-reset" class="tl-tx-reset" disabled title="Reset to empty" aria-label="Reset">&#8634;</button>
      </div>
      <div class="tl-tx-divider"></div>
      <div class="tl-tx-group tl-tx-group--progress">
        <span class="tl-tx-label">Progress</span>
        <input type="range" id="slider-timeline-pos" class="tl-tx-range tl-tx-range--progress" min="0" max="0" step="1" value="0" disabled />
        <span class="tl-tx-counter" id="val-timeline-pos">0 / 0</span>
      </div>
      <div class="tl-tx-divider"></div>
      <div class="tl-tx-group tl-tx-group--speed">
        <span class="tl-tx-label">Speed</span>
        <input type="range" id="slider-timeline-speed" class="tl-tx-range tl-tx-range--speed" min="0.5" max="50" step="0.5" value="5" />
        <span class="tl-tx-value"><span id="val-timeline-speed">5</span>&#215;</span>
      </div>
    </div>` : '';

  return `  <div id="graph"></div>
  <div id="flow-notice">Dagre layout not available in D3 mode</div>
  <div id="tour-pill" role="group" aria-label="PR tour" hidden>
    <button id="tour-pill-start" type="button"><span class="tour-pill-label">Take the PR tour</span><span id="tour-pill-sub" class="tour-pill-sub"></span></button>
    <button id="tour-pill-dismiss" type="button" title="Hide for this session" aria-label="Hide the PR tour button">&#x2715;</button>
  </div>
  <div id="top-left-controls">
    <div id="panel-layout" class="tl-panel">
      <div class="layout-group">
        <span class="layout-group-label">Engine</span>
        <div class="layout-toggle">
          <button id="btn-engine-shelf" class="layout-btn active"
            title="Shelf — every folder gets its own frame, files get slots. Tidy and deterministic.">
            <span class="layout-btn-icon">&#9638;</span>Shelf</button>
          <button id="btn-engine-global" class="layout-btn"
            title="Global — the classic free-floating force layout.">
            <span class="layout-btn-icon">&#9737;</span>Global</button>
        </div>
      </div>
      <div class="layout-group">
        <span class="layout-group-label">Motion</span>
        <div class="layout-toggle">
          <button id="btn-layout-dynamic" class="layout-btn"
            title="Dynamic — the layout settles live and reacts to drags.">
            <span class="layout-btn-icon">&#9889;</span>Dynamic</button>
          <button id="btn-layout-static" class="layout-btn active"
            title="Static — nothing moves until you move it.">
            <span class="layout-btn-icon">&#9679;</span>Static</button>
        </div>
      </div>
      <p id="layout-hint" class="layout-hint">Folder frames &amp; file slots &#183; frozen</p>
      <p id="global-guard-hint" class="layout-hint" style="display:none"></p>
    </div>
    <div id="panel-detail" class="tl-panel">
      <div class="tl-slider-header">
        <label for="slider-complexity">Detail</label>
        <span id="val-complexity">1</span>
      </div>
      <input type="range" id="slider-complexity" min="0" max="1" step="0.01" value="1" />
    </div>
    <div id="panel-git" class="tl-panel" style="display:none">
      <button id="btn-git-mode" class="tl-btn" title="Toggle git diff colors">Git</button>
      <div class="tl-legend-header" id="toggle-git-legend">
        <span>Legend</span>
        <span class="tl-chevron">▾</span>
      </div>
      <div class="tl-legend" id="git-legend-body">
        <div class="tl-legend-row">
          <span class="tl-legend-dot" style="background:#ff9800"></span>
          <span class="tl-legend-label">Modified Func</span>
        </div>
        <div class="tl-legend-row">
          <span class="tl-legend-dot" style="background:#4caf50"></span>
          <span class="tl-legend-label">New Func</span>
        </div>
        <div class="tl-legend-row">
          <span class="tl-legend-dot" style="background:#555555"></span>
          <span class="tl-legend-label">Deleted</span>
        </div>
        <div class="tl-legend-row">
          <span class="tl-legend-dot tl-legend-dot--staged"></span>
          <span class="tl-legend-label">Staged</span>
        </div>
      </div>
    </div>
    <div id="panel-lang" class="tl-panel">
      <button id="btn-language-mode" class="tl-btn" title="Toggle language colors">Language</button>
      <div id="language-legend"></div>
    </div>
    <div id="panel-folder" class="tl-panel">
      <button id="btn-folder-mode" class="tl-btn active" title="Toggle folder/file structure overlay">Folder</button>
      <div class="tl-legend-header" id="toggle-folder-filters">
        <span>Filters</span>
        <span class="tl-chevron collapsed">▾</span>
      </div>
      <div class="tl-legend" id="folder-filters-body" style="display:none"></div>
    </div>
    <div id="panel-forces" class="tl-panel">
      <div class="tl-section-label">Forces</div>
      <p id="forces-hint" class="forces-hint" style="display:none">Static layout &#8212; forces are off. Switch Motion to Dynamic.</p>
      <div class="slider-row" id="row-center-force">
        <div class="slider-header"><label for="slider-center-force">Center Force</label><span id="val-center-force">0.08</span></div>
        <input type="range" id="slider-center-force" min="0" max="1" step="0.005" value="0.08" />
      </div>
      <div class="slider-row" id="row-repel-force">
        <div class="slider-header"><label for="slider-repel-force">Repel Force</label><span id="val-repel-force">450</span></div>
        <input type="range" id="slider-repel-force" min="0" max="1000" step="1" value="450" />
      </div>
      <div class="slider-row" id="row-link-force">
        <div class="slider-header"><label for="slider-link-force">Link Force</label><span id="val-link-force">1</span></div>
        <input type="range" id="slider-link-force" min="0" max="10" step="0.1" value="1" />
      </div>
      <div class="slider-row" id="row-file-cluster">
        <div class="slider-header"><label for="slider-file-cluster" id="label-file-cluster">File Cluster Force</label><span id="val-file-cluster">0.36</span></div>
        <input type="range" id="slider-file-cluster" min="0" max="1" step="0.01" value="0.36" />
      </div>
      <button id="btn-show-more-forces" class="tl-link-btn" title="Show advanced force controls">show more forces &#9662;</button>
      <div id="forces-advanced">
        <div class="slider-row" id="row-velocity-decay">
          <div class="slider-header"><label for="slider-velocity-decay">Damping</label><span id="val-velocity-decay">0.3</span></div>
          <input type="range" id="slider-velocity-decay" min="0.05" max="0.9" step="0.01" value="0.3" />
        </div>
        <div class="slider-row" id="row-collide-pad">
          <div class="slider-header"><label for="slider-collide-pad">Collision Padding</label><span id="val-collide-pad">1.5</span></div>
          <input type="range" id="slider-collide-pad" min="0" max="10" step="0.5" value="1.5" />
        </div>
        <div class="slider-row" id="row-repel-range">
          <div class="slider-header"><label for="slider-repel-range">Repel Range</label><span id="val-repel-range">850</span></div>
          <input type="range" id="slider-repel-range" min="100" max="2000" step="25" value="850" />
        </div>
      </div>
    </div>
    <div id="panel-class" class="tl-panel">
      <button id="btn-class-mode" class="tl-btn active" title="Toggle class structure overlay">Class</button>
    </div>
    <div id="panel-actions" class="tl-panel">
      <button id="btn-save-graph" class="tl-btn" title="Save graph layout">Save Layout</button>${browserButtonHtml}
    </div>
  </div>
  ${timelinePanelHtml}
  <button id="settings-btn" title="Settings">&#9881;</button>
  <div id="settings-panel">

    <div class="panel-section">
      <h4>Filters</h4>
      <div class="search-container">
        <input id="search" type="text" placeholder="Filter functions..." />
        <span id="btn-clear-search" class="clear-icon" title="Clear Search">&#x2715;</span>
      </div>
      <div id="search-count" class="search-count"></div>
      <div class="toggle-row">
        <span>Show Orphans</span>
        <label class="switch"><input type="checkbox" id="toggle-orphans" checked /><span class="pill"></span></label>
      </div>
      <div class="toggle-row" id="row-show-libraries">
        <span>Show Libraries</span>
        <label class="switch"><input type="checkbox" id="toggle-libraries" /><span class="pill"></span></label>
      </div>
      <p id="libraries-hint" class="forces-hint" style="display:none">Libraries are shown in the Global engine.</p>
      <div class="toggle-row">
        <span>Show Empty Files</span>
        <label class="switch"><input type="checkbox" id="toggle-empty-files" /><span class="pill"></span></label>
      </div>
    </div>

    <div class="panel-section">
      <h4>Display</h4>
      <div class="toggle-row">
        <span>Arrows</span>
        <label class="switch"><input type="checkbox" id="toggle-arrows" checked /><span class="pill"></span></label>
      </div>
      <div class="toggle-row" title="On: only calls between functions in the same file are drawn. Calls between files, into libraries, and all edges of collapsed folders/files are hidden; hover a function to see its own. The layout does not change.">
        <span>Only calls within a file</span>
        <label class="switch"><input type="checkbox" id="toggle-same-file-edges" ${sameFileEdgesOnly ? 'checked ' : ''}/><span class="pill"></span></label>
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-text-fade">Text Fade Threshold</label><span id="val-text-fade">0.5</span></div>
        <input type="range" id="slider-text-fade" min="0" max="2" step="0.1" value="0.5" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-node-size">Node Size</label><span id="val-node-size">2.5</span></div>
        <input type="range" id="slider-node-size" min="0.1" max="5" step="0.1" value="2.5" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-text-size">Text Size</label><span id="val-text-size">1.5</span></div>
        <input type="range" id="slider-text-size" min="0" max="3" step="0.1" value="1.5" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-link-thickness">Link Thickness</label><span id="val-link-thickness">4</span></div>
        <input type="range" id="slider-link-thickness" min="0.1" max="8" step="0.1" value="4" />
      </div>
    </div>

    <div class="panel-section">
      <h4>Configuration</h4>
      <div class="toggle-row">
        <span>Open Function Popup</span>
        <label class="switch"><input type="checkbox" id="toggle-func-popup" checked /><span class="pill"></span></label>
      </div>
      <button id="btn-reset-layout" class="tl-btn" style="width: 100%; margin-top: 10px;">Reset Layout</button>
    </div>

  </div>
  <div id="lib-doc-popup">
    <div id="lib-doc-card">
      <div id="lib-doc-header">
        <div>
          <span id="lib-doc-title"></span>
          <span id="lib-doc-lang-badge"></span>
        </div>
        <button id="lib-doc-close" title="Close">&#x2715;</button>
      </div>
      <div id="lib-doc-desc-row">
        <span id="lib-doc-desc"></span>
      </div>
      <div id="lib-doc-body">
        <div id="lib-doc-function-row">
          <span class="lib-doc-label">Function</span>
          <span id="lib-doc-function"></span>
        </div>
        <div id="lib-doc-package-row">
          <span class="lib-doc-label">Package</span>
          <span id="lib-doc-package"></span>
        </div>
        <div id="lib-doc-url-row">
          <span class="lib-doc-label">Docs</span>
          <span id="lib-doc-url"></span>
        </div>
      </div>
      <div id="lib-doc-footer">
        <button id="lib-doc-goto-btn">Go to documentation &#x2197;</button>
      </div>
    </div>
  </div>
<div id="ctx-menu" style="display:none">
    <ul id="ctx-menu-list"></ul>
  </div>`;
}
