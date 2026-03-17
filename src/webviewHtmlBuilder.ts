import * as vscode from 'vscode';
import * as crypto from 'crypto';

export function getLoadingHtml(): string {
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
    <p>Analyzing project…</p>
  </div>
</body>
</html>`;
}

export function getEmptyStateHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { display:flex; align-items:center; justify-content:center; height:100vh; margin:0;
         background:var(--vscode-editor-background); color:var(--vscode-editor-foreground); font-family:sans-serif; }
</style>
</head>
<body>
  <div style="text-align:center">
    <div style="font-size:48px">&#x2205;</div>
    <p>No functions found in this workspace.</p>
  </div>
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

export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const webviewDir = vscode.Uri.joinPath(extensionUri, 'src', 'webview');
  const stateUri     = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'state.js'));
  const clusteringUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'clustering.js'));
  const highlightUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'highlight.js'));
  const renderingUri = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'rendering.js'));
  const folderUri    = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'folder.js'));
  const classUri     = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'class.js'));
  const colorsUri    = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'colors.js'));
  const popupsUri    = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'popups.js'));
  const scriptUri    = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'main.js'));
  const controlsUri  = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'controls.js'));
  const stylesUri    = webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, 'styles.css'));
  const nonce = crypto.randomUUID();

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
    <div id="panel-detail" class="tl-panel">
      <div class="tl-slider-header">
        <label for="slider-complexity">Detail</label>
        <span id="val-complexity">1</span>
      </div>
      <input type="range" id="slider-complexity" min="0" max="1" step="0.01" value="1" />
      <div class="tl-legend-header" id="toggle-detail-legend">
        <span>Legend</span>
        <span class="tl-chevron">▾</span>
      </div>
      <div class="tl-legend" id="detail-legend-body">
        <div class="tl-legend-row">
          <span class="tl-legend-dot" style="background:#d4d4d4"></span>
          <span class="tl-legend-label">Function Node</span>
        </div>
        <div class="tl-legend-row">
          <span class="tl-legend-dot" style="background:#7c4dbb"></span>
          <span class="tl-legend-label">Clustered Node</span>
        </div>
        <div class="tl-legend-row">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="#c8a84b" style="flex-shrink:0"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13.5v-11zM2.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-11zM3 5.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0 2a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0 2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5z"/></svg>
          <span class="tl-legend-label">Library Node</span>
        </div>
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
    </div>
    <div id="panel-class" class="tl-panel">
      <button id="btn-class-mode" class="tl-btn active" title="Toggle class structure overlay">Class</button>
    </div>
  </div>
  <button id="settings-btn" title="Settings">&#9881;</button>
  <div id="settings-panel">

    <div class="panel-section">
      <h4>Layout Mode</h4>
      <div class="layout-toggle">
        <button id="btn-layout-dynamic" class="layout-btn active">&#9889; Dynamic</button>
        <button id="btn-layout-static" class="layout-btn">&#9679; Static</button>
      </div>
    </div>

    <div class="panel-section">
      <h4>Filters</h4>
      <input id="search" type="text" placeholder="Filter functions..." />
      <div class="toggle-row">
        <span>Show Orphans</span>
        <label class="switch"><input type="checkbox" id="toggle-orphans" checked /><span class="pill"></span></label>
      </div>
      <div class="toggle-row">
        <span>Show Libraries</span>
        <label class="switch"><input type="checkbox" id="toggle-libraries" checked /><span class="pill"></span></label>
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
        <div class="slider-header"><label for="slider-text-size">Text Size</label><span id="val-text-size">1</span></div>
        <input type="range" id="slider-text-size" min="0.5" max="2" step="0.1" value="1" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-link-thickness">Link Thickness</label><span id="val-link-thickness">4</span></div>
        <input type="range" id="slider-link-thickness" min="0.1" max="8" step="0.1" value="4" />
      </div>
    </div>

    <div class="panel-section" id="forces-section">
      <h4>Forces</h4>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-center-force">Center Force</label><span id="val-center-force">1</span></div>
        <input type="range" id="slider-center-force" min="0" max="5" step="0.05" value="1" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-repel-force">Repel Force</label><span id="val-repel-force">350</span></div>
        <input type="range" id="slider-repel-force" min="0" max="8192" step="50" value="350" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-link-force">Link Force</label><span id="val-link-force">1</span></div>
        <input type="range" id="slider-link-force" min="0.1" max="2" step="0.1" value="1" />
      </div>
      <div class="slider-row">
        <div class="slider-header"><label for="slider-link-distance">Link Distance</label><span id="val-link-distance">40</span></div>
        <input type="range" id="slider-link-distance" min="10" max="80" step="5" value="40" />
      </div>
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
  <script nonce="${nonce}" src="${clusteringUri}"></script>
  <script nonce="${nonce}" src="${highlightUri}"></script>
  <script nonce="${nonce}" src="${renderingUri}"></script>
  <script nonce="${nonce}" src="${folderUri}"></script>
  <script nonce="${nonce}" src="${classUri}"></script>
  <script nonce="${nonce}" src="${colorsUri}"></script>
  <script nonce="${nonce}" src="${popupsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}" src="${controlsUri}"></script>
</body>
</html>`;
}
