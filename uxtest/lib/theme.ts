// VS Code injects --vscode-* variables and a body.vscode-dark|light class into
// every webview. The lab reproduces the ones CoGraph's styles read (Dark+ /
// Light+ defaults) so screenshots look like the real panel.
import type { Page } from '@playwright/test';

export type ThemeKind = 'dark' | 'light';

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

/** Runs in the page (addInitScript). Self-contained. */
function installTheme(arg: { vars: Record<string, string>; kind: string }): void {
  const apply = (): void => {
    for (const k of Object.keys(arg.vars)) { document.documentElement.style.setProperty(`--vscode-${k}`, arg.vars[k]); }
    if (document.body) { document.body.classList.add(`vscode-${arg.kind}`); }
  };
  if (document.body) { apply(); } else { document.addEventListener('DOMContentLoaded', apply, { once: true }); }
}

export async function attachTheme(page: Page, kind: ThemeKind = 'dark'): Promise<void> {
  await page.addInitScript(installTheme, { vars: kind === 'light' ? LIGHT : DARK, kind });
}
