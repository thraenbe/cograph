// Protocol parity (.ai/plans/webview.md test strategy): the same steps (smoke, expand,
// hover, save, a subgraph round trip) in the panel lab and in a browser tab served by the
// production loopback server must make the stage post the same set of message types to
// its host. The panel run is the uxtest lab (production HTML, acquireVsCodeApi stub); the
// tab run is browserServer + browserHtml + browserBridge, nothing stubbed in the page.
//
//   npm run compile && npm run bundle && npx playwright test -c test/browser/playwright.config.ts
import { test, expect, type Page } from '@playwright/test';
import { openLab } from '../../uxtest/lib/lab';
import { loadConfig, loadRepo } from '../../uxtest/lib/corpus';
import { scopeFixture } from '../../uxtest/lib/fixtures';
import { clickSel, fitToView, hoverPoint, locateNode, setSlider } from '../../uxtest/lib/actions';
import { FakeHost } from '../../uxtest/harness/fakeHost';
import { SEL } from '../../uxtest/selectors';
import { startBrowserLab } from './browserHost';

const REPO = process.env.PARITY_REPO ?? 'synthetic-1k';
/** Timer- and machine-driven diagnostics: present or not depending on timing, not on the transport. */
const TIMING_ONLY = new Set(['perf-report', 'webview-log']);
/** Each of these must be in both runs: the steps below exist to produce them. */
const REQUIRED = ['ready', 'expand-folder', 'get-func-source', 'get-annotations', 'save-graph', 'subgraph-include', 'subgraph-exit'];

/** The steps, identical for both runs; `posted` reads the host's log of view → host types. */
async function drive(page: Page, posted: (type: string) => number): Promise<void> {
  await page.waitForFunction('typeof state !== "undefined" && state.currentNodes && state.currentNodes.length > 0', undefined, { timeout: 30000 });
  // Expand: Detail 1 opens every folder; the lazy host is asked to parse them.
  await setSlider(page, 'detailSlider', 1);
  await expect.poll(() => posted('expand-folder'), { timeout: 15000 }).toBeGreaterThan(0);
  await page.waitForTimeout(800);
  await fitToView(page);
  await page.waitForTimeout(500);
  // Hover: the hover card asks for the function's first lines.
  const fn = await locateNode(page, { kind: 'fn' });
  await hoverPoint(page, fn, 900);
  await expect.poll(() => posted('get-func-source'), { timeout: 10000 }).toBeGreaterThan(0);
  await page.mouse.move(5, 5);
  // Save.
  await clickSel(page, 'saveGraph');
  await expect.poll(() => posted('save-graph'), { timeout: 10000 }).toBeGreaterThan(0);
  // Subgraph round trip: Visualize an excluded folder, then leave the subgraph.
  if (await page.locator(SEL.folderFiltersBody.css).isHidden()) { await clickSel(page, 'folderFiltersToggle'); }
  await page.locator(SEL.subgraphVisualize.css).first().click();
  await expect.poll(() => posted('subgraph-include'), { timeout: 10000 }).toBeGreaterThan(0);
  await page.locator(SEL.subgraphExit.css).first().click();
  await expect.poll(() => posted('subgraph-exit'), { timeout: 10000 }).toBeGreaterThan(0);
}

const typesOf = (host: FakeHost): string[] => [...new Set(host.log.map(l => l.message.type))].filter(t => !TIMING_ONLY.has(t)).sort();

test('a browser tab posts the same message types as the panel (smoke, expand, hover, save, subgraph)', async ({ browser }) => {
  const repo = await loadRepo(REPO, loadConfig());
  const scope = scopeFixture(repo);
  test.skip(scope.excludedTop.length === 0, `${REPO} has one top-level folder: no subgraph round trip possible`);

  // Panel: the uxtest lab.
  const lab = await openLab({ repo, browser, hostMode: 'lazy', scope, scenario: 'parity-panel', video: false, keepSnapshots: false });
  let panelTypes: string[];
  let panelKind: string | null = null;
  try {
    await drive(lab.page, (t) => lab.host.posted(t).length);
    panelTypes = typesOf(lab.host);
    panelKind = (await lab.simTransport()).kind;
  } finally { await lab.close(); }

  // Browser tab: the production server and page.
  const host = new FakeHost({ graph: repo.graph, structure: repo.structure, mode: 'lazy', scope });
  const tab = await startBrowserLab(host);
  const context = await browser.newContext({ viewport: loadConfig().viewport });
  const page = await context.newPage();
  const errors: string[] = [];
  const foreign: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const origin = new URL(tab.url).origin;
  // blob: URLs are the simulation workers simPool builds from the fetched worker script (same origin).
  page.on('request', r => { const u = r.url(); if (!u.startsWith(origin) && !u.startsWith(`blob:${origin}/`)) { foreign.push(u); } });
  let tabTypes: string[];
  try {
    await page.goto(tab.url);
    await drive(page, (t) => host.posted(t).length);
    tabTypes = typesOf(host);
    // The worker pool booted in the tab as in the panel (simWorker.js through the token URL, connect-src 'self').
    expect(await page.evaluate('(typeof __fr !== "undefined" && __fr.backend && __fr.backend.kind) ? __fr.backend.kind() : null')).toBe(panelKind);
    // Hover reached the host and the answer came back: the card shows the function's source.
    expect(await page.evaluate('document.querySelector(".hover-card") !== null')).toBe(true);
  } finally {
    await context.close();
    tab.close();
  }

  test.info().annotations.push({ type: 'message types', description: panelTypes.join(', ') });
  for (const t of REQUIRED) { expect(panelTypes, `panel run lacks ${t}`).toContain(t); }
  expect(tabTypes).toEqual(panelTypes);
  expect(errors, 'page errors in the tab').toEqual([]);
  expect(foreign, 'the tab loaded nothing from another origin').toEqual([]);
});
