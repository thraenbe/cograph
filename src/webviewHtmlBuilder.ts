import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { renderStagePage, WebviewHtmlInject } from './stagePage';

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

const D3_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js';

/** URIs of the esbuild-produced webview assets, with dev fallbacks when absent. */
function bundledWebviewAssets(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): { d3Src: string; d3IsLocal: boolean; workerUri: string | null } {
  const dir = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const has = (name: string): boolean => {
    try { return !!extensionUri.fsPath && fs.existsSync(path.join(extensionUri.fsPath, 'dist', 'webview', name)); }
    catch { return false; }
  };
  const d3IsLocal = has('d3.min.js');
  return {
    d3IsLocal,
    d3Src: d3IsLocal ? webview.asWebviewUri(vscode.Uri.joinPath(dir, 'd3.min.js')).toString() : D3_CDN,
    workerUri: has('simWorker.js') ? webview.asWebviewUri(vscode.Uri.joinPath(dir, 'simWorker.js')).toString() : null,
  };
}

export type { WebviewHtmlInject };

export interface WebviewHtmlOptions {
  timelineMode?: boolean;
  /** 'browser': the page is served by the loopback server (docs/tour-protocol.md section 4). */
  transport?: 'vscode' | 'browser';
  /** Browser transport: the theme kind the page stands in for (VS Code sets the body class itself). */
  theme?: 'dark' | 'light';
  inject?: (nonce: string) => WebviewHtmlInject;
}

/** The stage page for a webview: what only VS Code knows, handed to the template in stagePage.ts. */
export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  opts: WebviewHtmlOptions = {},
): string {
  const webviewDir = vscode.Uri.joinPath(extensionUri, 'src', 'webview');
  const nonce = crypto.randomBytes(16).toString('hex');
  // Cache-busting suffix; a browser-transport URI already carries `?token=`.
  const bust = (uri: { toString(): string }): string => {
    const s = uri.toString();
    return `${s}${s.includes('?') ? '&' : '?'}v=${nonce}`;
  };

  // Boot config injected before state.js — no message-ordering race. Settings
  // that do not exist yet fall back to their defaults.
  const cfg = vscode.workspace.getConfiguration('cograph');
  // Bundled webview assets (esbuild → dist/webview): vendored d3 and the
  // simulation worker. A checkout that never ran `npm run bundle` has neither:
  // d3 then comes from the CDN (dev only) and simulations stay on the main thread.
  const bundled = bundledWebviewAssets(webview, extensionUri);
  return renderStagePage({
    nonce,
    cspSource: webview.cspSource,
    asset: (file) => bust(webview.asWebviewUri(vscode.Uri.joinPath(webviewDir, file))),
    d3Src: bundled.d3Src,
    d3IsLocal: bundled.d3IsLocal,
    bootConfig: {
      defaultEngine: cfg.get<string>('layout.defaultEngine', 'shelf') ?? 'shelf',
      defaultMode: cfg.get<string>('layout.defaultMode', 'static') ?? 'static',
      perf: cfg.get<boolean>('debug.perfLog', false) ?? false,
      workers: cfg.get<string>('layout.workers', 'auto') ?? 'auto',
      workerUri: bundled.workerUri,
      sameFileEdgesOnly: cfg.get<boolean>('display.sameFileEdgesOnly', true) ?? true,
    },
    timelineMode: opts.timelineMode === true,
    browser: opts.transport === 'browser',
    theme: opts.theme,
    inject: opts.inject?.(nonce) ?? {},
  });
}
