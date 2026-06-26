import * as vscode from 'vscode';
import * as crypto from 'crypto';

export function getLoadingHtml(message = 'Analyzing project…'): string {
  const esc = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { display:flex; align-items:center; justify-content:center; height:100vh; margin:0;
         background:var(--vscode-editor-background); color:var(--vscode-editor-foreground); font-family:sans-serif; }
  .spinner { width:40px; height:40px; border:4px solid transparent;
             border-top-color:var(--vscode-focusBorder); border-radius:50%; animation:spin 0.8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  p { margin-top:16px; }
</style>
</head>
<body>
  <div style="text-align:center">
    <div class="spinner"></div>
    <p>${esc}</p>
  </div>
</body>
</html>`;
}

export interface AnalyzerFailureInfo { lang: string; status: string; detail?: string; }

export interface EmptyStateInfo {
  /** Per-analyzer failures (status not 'ok'/'empty'), surfaced as diagnostics. */
  failures?: AnalyzerFailureInfo[];
  /** Whether any supported source file exists on disk (tunes the message). */
  candidateFilesFound?: boolean;
  /** Analysis hit the time limit (do not suggest a quick retry). */
  timedOut?: boolean;
  /** Analysis output exceeded the size guard. */
  tooLarge?: boolean;
  /** Render the Retry button (default true; suppressed for the timeline panel). */
  showRetry?: boolean;
}

/**
 * Actionable empty-state. Distinguishes "still loading / failed" (retry helps)
 * from "genuinely no functions", and surfaces analyzer failures instead of
 * swallowing them. The Retry button posts a `retry-analysis` message.
 */
export function getEmptyStateHtml(info: EmptyStateInfo = {}): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const failures = info.failures ?? [];
  const showRetry = info.showRetry !== false;

  let headline: string;
  let detail: string;
  if (info.timedOut) {
    headline = 'Analysis timed out';
    detail = 'The project was too large to analyze within the time limit. Try again, or open a smaller folder.';
  } else if (info.tooLarge) {
    headline = 'Analysis output too large';
    detail = 'The generated graph exceeded the size limit. Try a smaller workspace.';
  } else if (failures.length > 0) {
    headline = 'Analysis could not complete';
    detail = 'Some language analyzers failed to produce a graph. See the details below, then retry.';
  } else if (info.candidateFilesFound === false) {
    headline = 'No source files found yet';
    detail = 'No supported source files were found. If the workspace is still loading, wait a moment and retry.';
  } else {
    headline = 'No functions found';
    detail = 'The supported source files contain no functions CoGraph could extract.';
  }

  const failuresHtml = failures.length
    ? `<ul class="failures">${failures
        .map(f => `<li><code>${esc(f.lang)}</code> — ${esc(f.status)}${f.detail ? `: ${esc(f.detail)}` : ''}</li>`)
        .join('')}</ul>`
    : '';
  const retryHtml = showRetry ? `<button id="retry">Retry analysis</button>` : '';
  const retryScript = showRetry
    ? `<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const btn = document.getElementById('retry');
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'retry-analysis' });
      btn.disabled = true;
      btn.textContent = 'Retrying…';
    });
  </script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { display:flex; align-items:center; justify-content:center; height:100vh; margin:0;
         background:var(--vscode-editor-background); color:var(--vscode-editor-foreground); font-family:sans-serif; }
  .wrap { text-align:center; max-width:520px; padding:24px; }
  .glyph { font-size:48px; opacity:0.7; }
  h2 { margin:12px 0 6px; font-size:16px; font-weight:600; }
  p { margin:0 0 16px; opacity:0.85; font-size:13px; line-height:1.5; }
  .failures { text-align:left; margin:0 auto 16px; max-width:460px; font-size:12px;
              color:var(--vscode-errorForeground,#f48771); }
  .failures code { color:var(--vscode-editor-foreground); }
  button { font:inherit; padding:6px 18px; border:none; border-radius:4px; cursor:pointer;
           background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  button:hover { background:var(--vscode-button-hoverBackground); }
  button:disabled { opacity:0.6; cursor:default; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="glyph">&#x2205;</div>
    <h2>${esc(headline)}</h2>
    <p>${esc(detail)}</p>
    ${failuresHtml}
    ${retryHtml}
  </div>
  ${retryScript}
</body>
</html>`;
}

export function getErrorHtml(message: string): string {
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { display:flex; align-items:center; justify-content:center; height:100vh; margin:0;
         background:var(--vscode-editor-background); font-family:sans-serif; }
  .box { max-width:600px; padding:24px; border-radius:6px;
         background:var(--vscode-inputValidation-errorBackground,#5a1d1d);
         color:var(--vscode-errorForeground,#f48771); }
  .icon { font-size:32px; }
  pre { white-space:pre-wrap; word-break:break-word; margin:8px 0 0; font-size:13px; }
</style>
</head>
<body>
  <div class="box">
    <div class="icon">&#x26A0;</div>
    <pre>${escaped}</pre>
  </div>
</body>
</html>`;
}

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  opts: { timelineMode?: boolean } = {},
): string {
  const timelineMode = opts.timelineMode === true;
  const webviewDir = vscode.Uri.joinPath(extensionUri, 'src', 'webview');
  const stateUri     = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'state.js'));
  const aggregateUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'aggregate.js'));
  const clusteringUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'clustering.js'));
  const workflowUri  = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'workflow.js'));
  const highlightUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'highlight.js'));
  const renderingUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'rendering.js'));
  const folderUri    = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'folder.js'));
  const fileClustersUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'fileClusters.js'));
  const classUri     = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'class.js'));
  const colorsUri    = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'colors.js'));
  const popupsUri    = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'popups.js'));
  const scriptUri    = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'main.js'));
  const controlsUri  = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'controls.js'));
  const timelineUri  = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'timeline.js'));
  const stylesUri    = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'styles.css'));
  const nonce = crypto.randomBytes(16).toString('hex');

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
  const timelineScriptTag = timelineMode
    ? `<script nonce="${nonce}" src="${timelineUri}"></script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com;
             style-src 'unsafe-inline' ${webview.cspSource};
             img-src ${webview.cspSource} data:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CoGraph</title>
  <link rel="stylesheet" href="${stylesUri}" />
  <script nonce="${nonce}"
    src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
</head>
<body>
  <div id="graph"></div>
  <div id="flow-notice">Dagre layout not available in D3 mode</div>
  <div id="top-left-controls">
    <div id="panel-layout" class="tl-panel">
      <div class="layout-toggle">
        <button id="btn-layout-dynamic" class="layout-btn active">&#9889; Dynamic</button>
        <button id="btn-layout-static" class="layout-btn">&#9679; Static</button>
      </div>
    </div>
    <div id="panel-detail" class="tl-panel">
      <div class="tl-slider-header">
        <label for="slider-complexity">Detail</label>
        <span id="val-complexity">1</span>
      </div>
      <input type="range" id="slider-complexity" min="0" max="1" step="0.01" value="1" />
      <div class="tl-section-label">Group by</div>
      <div class="btn-group">
        <button id="btn-group-file"    class="tl-btn active" title="Navigate by folder (drill down)">File</button>
        <button id="btn-group-class"   class="tl-btn"        title="Cluster by class">Class</button>
        <button id="btn-group-connect" class="tl-btn"        title="Cluster by connection importance">Connect</button>
      </div>
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
      <button id="btn-language-mode" class="tl-btn" title="Toggle language colors">Lang</button>
      <div id="language-legend"></div>
    </div>
    <div id="panel-folder" class="tl-panel">
      <button id="btn-folder-mode" class="tl-btn active" title="Toggle folder/file structure overlay">Folder</button>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-file-cluster">File Cluster Force</label><span id="val-file-cluster">0.2</span></div>
        <input type="range" id="slider-file-cluster" min="0" max="1" step="0.01" value="0.2" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-folder-repel">Folder Repel Force</label><span id="val-folder-repel">0.25</span></div>
        <input type="range" id="slider-folder-repel" min="0" max="10" step="0.01" value="0.25" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-file-repel">File Repel Force</label><span id="val-file-repel">0.25</span></div>
        <input type="range" id="slider-file-repel" min="0" max="10" step="0.01" value="0.25" />
      </div>
      <button id="btn-more-forces" class="tl-link-btn" title="Open settings to adjust all forces">view more forces &#9881;</button>
      <div class="tl-legend-header" id="toggle-folder-filters">
        <span>Filters</span>
        <span class="tl-chevron collapsed">▾</span>
      </div>
      <div class="tl-legend" id="folder-filters-body" style="display:none"></div>
    </div>
    <div id="panel-class" class="tl-panel">
      <button id="btn-class-mode" class="tl-btn active" title="Toggle class structure overlay">Class</button>
    </div>
    <div id="panel-actions" class="tl-panel">
      <button id="btn-open-chat" class="tl-btn" title="Open chat with this graph selected">Open Chat</button>
      <button id="btn-save-graph" class="tl-btn" title="Save graph layout">Save Layout</button>
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
      <div class="toggle-row">
        <span>Show Orphans</span>
        <label class="switch"><input type="checkbox" id="toggle-orphans" checked /><span class="pill"></span></label>
      </div>
      <div class="toggle-row">
        <span>Show Libraries</span>
        <label class="switch"><input type="checkbox" id="toggle-libraries" /><span class="pill"></span></label>
      </div>
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

    <div class="panel-section" id="forces-section">
      <h4>Forces</h4>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-center-force">Center Force</label><span id="val-center-force">0.05</span></div>
        <input type="range" id="slider-center-force" min="0" max="1" step="0.005" value="0.05" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-repel-force">Repel Force</label><span id="val-repel-force">250</span></div>
        <input type="range" id="slider-repel-force" min="0" max="1000" step="1" value="250" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-link-force">Link Force</label><span id="val-link-force">1</span></div>
        <input type="range" id="slider-link-force" min="0" max="10" step="0.1" value="1" />
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
  </div>
  <script nonce="${nonce}" src="${stateUri}"></script>
  <script nonce="${nonce}" src="${aggregateUri}"></script>
  <script nonce="${nonce}" src="${clusteringUri}"></script>
  <script nonce="${nonce}" src="${workflowUri}"></script>
  <script nonce="${nonce}" src="${highlightUri}"></script>
  <script nonce="${nonce}" src="${renderingUri}"></script>
  <script nonce="${nonce}" src="${folderUri}"></script>
  <script nonce="${nonce}" src="${fileClustersUri}"></script>
  <script nonce="${nonce}" src="${classUri}"></script>
  <script nonce="${nonce}" src="${colorsUri}"></script>
  <script nonce="${nonce}" src="${popupsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}" src="${controlsUri}"></script>
  ${timelineScriptTag}
</body>
</html>`;
}
