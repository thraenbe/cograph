import * as vscode from 'vscode';
import * as path from 'path';
import { getWebviewHtml } from '../webviewHtmlBuilder';
import { themeStyle, ThemeKind } from '../stagePage';
import type { PageRequest } from './browserServer';

/**
 * The stage HTML for a browser tab: the panel's own page (getWebviewHtml) through a
 * shim `webview`, so markup, script order and boot config never drift from VS Code's.
 * Resource URIs become `/ext/<path>?token=`, the CSP source is the page's own origin,
 * and the `--vscode-*` variables VS Code would inject come from Dark+ or Light+.
 * In tour mode the page also carries `window.COGRAPH_TOUR` before the stage and the
 * private tour layer after it (docs/tour-protocol.md section 4).
 */

export { themeStyle };
export type { ThemeKind };

/** Light for Light and High Contrast Light, dark otherwise: exact theme colours are not available to extensions. */
export function activeThemeKind(): ThemeKind {
  const kind = vscode.window.activeColorTheme?.kind;
  return kind === vscode.ColorThemeKind.Light || kind === 4 /* HighContrastLight, 1.68+ */ ? 'light' : 'dark';
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
