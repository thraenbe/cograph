import * as vscode from 'vscode';
import * as path from 'path';
import { getWebviewHtml } from '../webviewHtmlBuilder';
import type { PageRequest } from './browserServer';

/**
 * The stage HTML for a browser tab: the panel's own page (getWebviewHtml) through a
 * shim `webview`, so markup, script order and boot config never drift from VS Code's.
 * Resource URIs become `/ext/<path>?token=`, the CSP source is the page's own origin,
 * and the `--vscode-*` variables VS Code would inject come from Dark+ or Light+.
 * In tour mode the page also carries `window.COGRAPH_TOUR` before the stage and the
 * private tour layer after it (docs/tour-protocol.md section 4).
 */

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

/** Light for Light and High Contrast Light, dark otherwise: exact theme colours are not available to extensions. */
export function activeThemeKind(): ThemeKind {
  const kind = vscode.window.activeColorTheme?.kind;
  return kind === vscode.ColorThemeKind.Light || kind === 4 /* HighContrastLight, 1.68+ */ ? 'light' : 'dark';
}

export function themeStyle(kind: ThemeKind): string {
  const vars = kind === 'light' ? LIGHT : DARK;
  const decl = Object.entries(vars).map(([k, v]) => `--vscode-${k}: ${v};`).join(' ');
  return `<style>:root { ${decl} } html, body { margin: 0; height: 100%; background: var(--vscode-editor-background); }</style>`;
}

/** JSON for an inline <script>: `<` escaped, so no value (a path, a title) can close the tag. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** A path with the token (and more query) for this page. */
function withToken(urlPath: string, token: string, query: Record<string, string> = {}): string {
  return `${urlPath}?${new URLSearchParams({ token, ...query }).toString()}`;
}

/** The webview the builder expects, answering from the extension root instead of vscode-resource. */
function shimWebview(extensionRoot: string, token: string): vscode.Webview {
  const asWebviewUri = (uri: vscode.Uri): vscode.Uri => {
    const rel = path.relative(extensionRoot, uri.fsPath).split(path.sep).join('/');
    const encoded = rel.split('/').map(encodeURIComponent).join('/');
    return { toString: () => withToken(`/ext/${encoded}`, token) } as unknown as vscode.Uri;
  };
  return { asWebviewUri, cspSource: "'self'" } as unknown as vscode.Webview;
}

export function renderBrowserPage(page: PageRequest, extensionRoot: string, theme: ThemeKind = activeThemeKind()): string {
  const { token, viewId, tour } = page;
  const eventsUrl = withToken('/events', token, { view: viewId });
  const msgUrl = withToken('/msg', token, { view: viewId });
  const tourConfig = tour ? {
    tourId: tour.tourId,
    scriptUrl: withToken(`/tour/${encodeURIComponent(tour.tourId)}/script`, token),
    graphUrl: withToken(`/tour/${encodeURIComponent(tour.tourId)}/graph`, token),
    actionUrl: withToken(`/tour/${encodeURIComponent(tour.tourId)}/action`, token),
    eventsUrl, msgUrl, theme, stageRoot: page.view.viewRoot(), version: 1,
  } : null;
  return getWebviewHtml(shimWebview(extensionRoot, token), vscode.Uri.file(extensionRoot), {
    transport: 'browser',
    theme,
    inject: (nonce) => ({
      head: themeStyle(theme),
      before: `<script nonce="${nonce}">window.COGRAPH_BROWSER = ${inlineJson({ view: viewId, eventsUrl, msgUrl })};`
        + (tourConfig ? ` window.COGRAPH_TOUR = ${inlineJson(tourConfig)};` : '') + '</script>',
      after: tour?.assets
        ? `<link rel="stylesheet" href="${withToken('/tour-assets/tour.css', token)}" />\n  <script nonce="${nonce}" src="${withToken('/tour-assets/tour.js', token)}"></script>`
        : '',
    }),
  });
}
