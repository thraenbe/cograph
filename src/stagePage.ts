// stagePage.ts — the stage's page with no vscode. getWebviewHtml renders the panel and the browser tab
// through renderStagePage; scripts/build-stage.js writes the static page of the CI tour through
// renderStaticStagePage. Both share the markup and the script order, so the three pages cannot drift.

import { stageMarkup } from './stageMarkup';

export type ThemeKind = 'dark' | 'light';

// Dark+ / Light+ values of the variables CoGraph's styles read. Copied from
// uxtest/lib/theme.ts (the lab must not import from src/, and src/ must not import the
// lab); keep the two in step until the lab can render through this module.
const DARK: Record<string, string> = {
  'font-family': 'system-ui, "Segoe UI", sans-serif',
  'editor-font-family': '"Droid Sans Mono", monospace',
  'foreground': '#cccccc', 'descriptionForeground': '#9d9d9d', 'errorForeground': '#f85149',
  'editor-background': '#1f1f1f', 'editor-foreground': '#cccccc',
  'editorLineNumber-foreground': '#6e7681', 'editorCursor-foreground': '#aeafad',
  'sideBar-background': '#181818', 'widget-border': '#313131', 'focusBorder': '#0078d4',
  'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1',
  'button-secondaryBackground': '#313131',
  'input-background': '#313131', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c',
  'list-hoverBackground': '#2a2d2e', 'toolbar-hoverBackground': 'rgba(90,93,94,0.31)',
  'menu-background': '#1f1f1f', 'menu-foreground': '#cccccc', 'menu-border': '#454545',
  'menu-selectionBackground': '#0078d4', 'menu-selectionForeground': '#ffffff',
  'textLink-foreground': '#4daafc', 'notificationCenterHeader-background': '#1f1f1f',
};

const LIGHT: Record<string, string> = {
  ...DARK,
  'foreground': '#3b3b3b', 'descriptionForeground': '#3b3b3b', 'errorForeground': '#f85149',
  'editor-background': '#ffffff', 'editor-foreground': '#3b3b3b',
  'editorLineNumber-foreground': '#6e7681', 'editorCursor-foreground': '#005fb8',
  'sideBar-background': '#f8f8f8', 'widget-border': '#e5e5e5', 'focusBorder': '#005fb8',
  'button-background': '#005fb8', 'button-hoverBackground': '#0258a8', 'button-secondaryBackground': '#e5e5e5',
  'input-background': '#ffffff', 'input-foreground': '#3b3b3b', 'input-border': '#cecece',
  'list-hoverBackground': '#f2f2f2', 'toolbar-hoverBackground': 'rgba(184,184,184,0.31)',
  'menu-background': '#ffffff', 'menu-foreground': '#3b3b3b', 'menu-border': '#cecece',
  'menu-selectionBackground': '#005fb8', 'textLink-foreground': '#005fb8',
  'notificationCenterHeader-background': '#ffffff',
};

/** The `--vscode-*` declarations of a theme, for a page VS Code does not theme. */
export function themeDeclarations(kind: ThemeKind): string {
  const vars = kind === 'light' ? LIGHT : DARK;
  return Object.entries(vars).map(([k, v]) => `--vscode-${k}: ${v};`).join(' ');
}

export function themeStyle(kind: ThemeKind): string {
  return `<style>:root { ${themeDeclarations(kind)} } html, body { margin: 0; height: 100%; background: var(--vscode-editor-background); }</style>`;
}

/** Tags a browser page adds around the stage (src/browserView/browserHtml.ts); `nonce` is this page's. */
export interface WebviewHtmlInject {
  /** Inside <head>, after the stylesheet (theme variables). */
  head?: string;
  /** Before every stage script (inline page config). */
  before?: string;
  /** After every stage script (the tour layer). */
  after?: string;
}

/** window.COGRAPH_CONFIG: read before state.js, so no message can race it. */
export interface StageBootConfig {
  defaultEngine: string;
  defaultMode: string;
  perf: boolean;
  workers: string;
  workerUri: string | null;
  sameFileEdgesOnly: boolean;
}

// The stage's classic scripts under src/webview, in load order. timeline.js, panel only, goes between the
// first two lists. The static page runs them as one file in this order, d3 first.
const SCRIPTS_BEFORE_TIMELINE = [
  'state.js', 'perf.js', 'hotCache.js', 'hoverIndex.js', 'visibility.js', 'viewCull.js', 'frameCull.js', 'aggregate.js',
  'clustering.js', 'highlight.js', 'rendering.js', 'folder.js', 'drilldown.js', 'fileClusters.js', 'class.js', 'colors.js',
  'popups.js', 'frameChrome.js', 'scope.js', 'frames.js', 'crossLinks.js', 'localSim.js', 'frameScheduler.js', 'simPool.js',
  'localSimWorker.js', 'simBackend.js', 'frameRender.js', 'frameInteract.js', 'globalGuard.js', 'readyHandshake.js', 'main.js',
  'controls.js', 'forcesPanel.js', 'slotDrag.js',
] as const;
const SCRIPTS_AFTER_TIMELINE = ['hoverCard.js', 'funcSave.js'] as const;
const PR_VIEW_SCRIPT = 'prView.js';
const SCRIPTS_LATE = ['scopeFit.js', 'funcCard.js', 'fnNames.js', 'hoverPin.js'] as const;
const STAGE_API_SCRIPT = 'stageApi.js';

/** Every stage script of a page without the timeline, in load order. */
export const STAGE_SCRIPTS: readonly string[] = [
  ...SCRIPTS_BEFORE_TIMELINE, ...SCRIPTS_AFTER_TIMELINE, PR_VIEW_SCRIPT, ...SCRIPTS_LATE, STAGE_API_SCRIPT,
];

export interface StagePageInput {
  nonce: string;
  cspSource: string;
  /** URL of a file under src/webview, cache-busting suffix included. */
  asset(file: string): string;
  d3Src: string;
  d3IsLocal: boolean;
  bootConfig: StageBootConfig;
  timelineMode: boolean;
  /** The page is served by the loopback server (docs/tour-protocol.md section 4). */
  browser: boolean;
  /** Browser transport: the theme kind the page stands in for (VS Code sets the body class itself). */
  theme?: ThemeKind;
  inject: WebviewHtmlInject;
}

/** The page of the panel and of a browser tab. */
export function renderStagePage(input: StagePageInput): string {
  const { nonce, cspSource, asset, d3Src, d3IsLocal, bootConfig, timelineMode, browser, theme, inject } = input;
  const scriptTag = (file: string): string => `<script nonce="${nonce}" src="${asset(file)}"></script>`;
  const scriptTags = (files: readonly string[]): string => files.map(scriptTag).join('\n  ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}'${browser ? " 'self'" : ''}${d3IsLocal ? '' : ' https://cdnjs.cloudflare.com'};
             style-src 'unsafe-inline' ${cspSource};
             img-src ${cspSource} data:;
             worker-src blob:;
             connect-src ${cspSource};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CoGraph</title>
  <link rel="stylesheet" href="${asset('styles.css')}" />
  ${inject.head ?? ''}
  <script nonce="${nonce}" src="${d3Src}"></script>
</head>
<body${browser ? ` class="vscode-${theme === 'light' ? 'light' : 'dark'} cg-browser"` : ''}>
${stageMarkup({ timelineMode, browser, sameFileEdgesOnly: bootConfig.sameFileEdgesOnly })}
  ${inject.before ?? ''}
  ${browser ? scriptTag('browserBridge.js') : ''}
  <script nonce="${nonce}">window.COGRAPH_CONFIG = ${JSON.stringify(bootConfig)};</script>
  ${scriptTags(SCRIPTS_BEFORE_TIMELINE)}
  ${timelineMode ? scriptTag('timeline.js') : ''}
  ${scriptTags(SCRIPTS_AFTER_TIMELINE)}
  <!-- Pull-request view (Version Control pane): declarations only, called from main.js / fileClusters.js at message time. -->
  ${scriptTag(PR_VIEW_SCRIPT)}

  ${scriptTags(SCRIPTS_LATE)}
  <!-- window.stageApi (docs/tour-protocol.md section 5): last of the stage scripts it drives. -->
  ${scriptTag(STAGE_API_SCRIPT)}
  <!-- Injected tags (the tour layer) stay after every stage script, stageApi.js included. -->
  ${inject.after ?? ''}
</body>
</html>`;
}

/** Where the viewer's own tags go in dist/stage/index.html: right after the stage. */
export const STAGE_AFTER_MARKER = '<!-- cograph:after-stage -->';

/** Delivery's policy for the viewer, without `sandbox` and `frame-ancestors`: a meta tag cannot carry them. */
export const STATIC_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
  + "connect-src 'self'; worker-src blob:; base-uri 'none'; form-action 'none'";

export interface StaticStageFiles {
  bridge: string;
  stage: string;
  css: string;
  worker: string;
}

/** Both theme sets by media query, so the page paints right before any script runs. */
export function staticThemeCss(): string {
  return `:root { ${themeDeclarations('dark')} }
@media (prefers-color-scheme: light) { :root { ${themeDeclarations('light')} } }
html, body { margin: 0; height: 100%; background: var(--vscode-editor-background); }
`;
}

/** The static page: no nonce and no inline script, built once per release, nothing of any tour in it. */
export function renderStaticStagePage(files: StaticStageFiles): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${STATIC_PAGE_CSP}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="cograph-worker" content="${files.worker}" />
  <title>CoGraph</title>
  <link rel="stylesheet" href="${files.css}" />
</head>
<body class="cg-browser">
${stageMarkup({ timelineMode: false, browser: true, sameFileEdgesOnly: true })}
  <script src="${files.bridge}"></script>
  <script src="${files.stage}"></script>
  ${STAGE_AFTER_MARKER}
</body>
</html>
`;
}
