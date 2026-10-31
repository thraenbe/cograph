// The stage with no VS Code and no server: dist/stage as built, one concatenated file, under the CSP the
// hosted viewer sends, `sandbox` included. Only the viewer's handover is scripted (feed.js, in place of
// CoGraphViewer.open); the tour layer is the private repository's own gate.
//
// fixtures/stage-replay.json is a recording: the four replay messages and four slices of psf/requests
// PR #7497, built by the core plan's prototype with the real engine. Re-record it from src/ci when that exists.
//
//   npx playwright test -c test/browser/playwright.config.ts stage.spec.ts
import { test, expect, type Browser, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { instrumentedStage } from './loadTypeofs';
import { startStageServer, type StageManifest, type StageServer } from './stageServer';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildStage } = require('../../scripts/build-stage.js');

const LINK_BASE = 'https://github.com/psf/requests/blob/38b7702/';

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stage-replay.json'), 'utf8')) as {
  replay: object[]; sources: Record<string, { signature: string }>;
};

/** `delayMs`: open() well after the stage said ready, as a slow decrypt would. */
function feedJs(delayMs: number): string {
  return `
window.__violations = [];
window.__logged = [];
document.addEventListener('securitypolicyviolation', (e) => window.__violations.push(e.violatedDirective + ' ' + e.blockedURI));
const REPLAY = ${JSON.stringify(fixture)};
const handOver = () => window.__cographStaticBridge.open({
  replay: REPLAY.replay, sources: REPLAY.sources, stageRoot: '/repo',
  fileLink: (file, line) => ${JSON.stringify(LINK_BASE)} + file.replace('/repo/', '') + '#L' + line,
  log: (entry) => window.__logged.push(entry),
});
${delayMs ? `setTimeout(handOver, ${delayMs});` : 'handOver();'}
`;
}

let dir: string;
let manifest: StageManifest;
const servers: StageServer[] = [];

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-stage-spec-'));
  manifest = buildStage(dir);
});

test.afterAll(() => {
  for (const s of servers.splice(0)) { s.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Open { page: Page; server: StageServer; errors: string[] }

async function openStage(browser: Browser, delayMs = 0): Promise<Open> {
  const server = await startStageServer(dir, manifest, feedJs(delayMs));
  servers.push(server);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await context.route('https://**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!DOCTYPE html><title>platform</title>' }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); } });
  await page.goto(server.url);
  await page.evaluate('stageApi.ready()');
  return { page, server, errors };
}

/** The screen position of a function, after the camera moved onto it. */
async function centreOn(page: Page, relFile: string, line: number): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(async ([file, at]) => {
    const w = window as unknown as { stageApi: any; d3: any };
    const abs = `/repo/${file}`;
    const folder = abs.slice(0, abs.lastIndexOf('/'));
    await w.stageApi.expand([folder]);
    const node = w.stageApi.nodes().find((n: any) => n.file === abs && n.line === at && n.kind === 'function');
    if (!node) { return null; }
    await w.stageApi.fit([node.id], { ms: 0, padding: 300 });
    const el = w.d3.selectAll('#graph circle').filter((d: any) => d && d.id === node.id).node();
    if (!el) { return null; }
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, [relFile, line] as const);
  expect(point, `${relFile}:${line} on screen`).not.toBeNull();
  return point as { x: number; y: number };
}

test('the page really is sandboxed: opaque origin, no storage', async ({ browser }) => {
  const { page, errors } = await openStage(browser);
  expect(await page.evaluate('self.origin')).toBe('null');
  expect(await page.evaluate(`(() => { try { sessionStorage.length; return 'open'; } catch (e) { return e.name; } })()`)).toBe('SecurityError');
  expect(await page.evaluate(`(() => { const api = vscode; api.setState({ a: 1 }); return api.getState(); })()`)).toEqual({ a: 1 });
  expect(errors).toEqual([]);
});

test('the recorded replay plays: nodes drawn, the worker booted, no violation, nothing unhandled', async ({ browser }) => {
  const { page, errors } = await openStage(browser);
  const nodes = await page.evaluate('stageApi.nodes().length');
  expect(nodes).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(`document.querySelectorAll('#graph circle').length`)).toBeGreaterThan(0);
  expect(await page.evaluate('state.prView && state.prView.readOnly')).toBe(true);
  expect(await page.evaluate(`document.body.classList.contains('vscode-dark')`)).toBe(true);
  expect(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim()`)).toBe('#1f1f1f');
  expect(await page.evaluate('__fr.backend ? __fr.backend.kind() : null')).toBe('worker');
  expect(await page.evaluate('__violations')).toEqual([]);
  expect(await page.evaluate(`__logged.filter((l) => l.event !== 'webview-log')`)).toEqual([]);
  expect(errors).toEqual([]);
});

test('open() long after ready plays the same', async ({ browser }) => {
  const { page, errors } = await openStage(browser, 400);
  expect(await page.evaluate('stageApi.nodes().length')).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('light theme: the css and the body class agree before the stage runs', async ({ browser }) => {
  const server = await startStageServer(dir, manifest, feedJs(0));
  servers.push(server);
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.evaluate('stageApi.ready()');
  expect(await page.evaluate(`document.body.classList.contains('vscode-light')`)).toBe(true);
  expect(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim()`)).toBe('#ffffff');
  expect(await page.evaluate(`window.stageApi.theme()`)).toBe('light');
  await context.close();
});

test('stageApi drives it: expand answers at once, and the camera and the overlays work', async ({ browser }) => {
  const { page, errors } = await openStage(browser);
  const ms = await page.evaluate(async () => {
    const api = (window as unknown as { stageApi: any }).stageApi;
    const t0 = performance.now();
    await api.expand(['/repo/tests', '/repo/docs']);
    const took = performance.now() - t0;
    const ids = api.nodes().filter((n: any) => n.kind === 'function').slice(0, 3).map((n: any) => n.id);
    await api.fit(ids, { ms: 0 });
    api.spotlight(ids);
    api.pulse(ids[0]);
    api.spotlight(null);
    api.pulse(null);
    await api.fitAll({ ms: 0 });
    api.chrome(false);
    return took;
  });
  expect(ms, 'stageApi.expand would wait 15 s for an answer that never came').toBeLessThan(1000);
  expect(errors).toEqual([]);
});

test('hover: a changed function shows its slice, any other the fallback sentence', async ({ browser }) => {
  const { page, errors } = await openStage(browser);
  const key = Object.keys(fixture.sources)[1];
  const [file, line] = [key.slice(0, key.lastIndexOf(':')), Number(key.slice(key.lastIndexOf(':') + 1))];
  const changed = await centreOn(page, file, line);
  await page.mouse.move(changed.x, changed.y, { steps: 5 });
  await expect(page.locator('.hover-card')).toContainText(fixture.sources[key].signature.slice(0, 20), { timeout: 5000 });

  const other = await page.evaluate(`stageApi.nodes().find((n) => n.kind === 'function' && n.file.endsWith('.py') && !${JSON.stringify(Object.keys(fixture.sources))}.includes(n.file.replace('/repo/', '') + ':' + n.line) && n.file.startsWith('/repo/src/requests'))`) as { file: string; line: number };
  await page.mouse.move(5, 5);
  const unchanged = await centreOn(page, other.file.replace('/repo/', ''), other.line);
  await page.mouse.move(unchanged.x, unchanged.y, { steps: 5 });
  await expect(page.locator('.hover-card')).toContainText('This function is not part of the tour.', { timeout: 5000 });
  expect(errors).toEqual([]);
});

test('a link opens the platform in a new tab, escaped from the sandbox, with no opener', async ({ browser }) => {
  const { page, errors } = await openStage(browser);
  const popup = page.context().waitForEvent('page');
  await page.evaluate(`vscode.postMessage({ type: 'navigate', file: '/repo/src/requests/auth.py', line: 34 })`);
  const tab = await popup;
  expect(tab.url()).toBe(`${LINK_BASE}src/requests/auth.py#L34`);
  expect(await tab.evaluate('window.opener')).toBeNull();
  expect(await tab.evaluate('self.origin')).toBe('https://github.com');
  expect(errors).toEqual([]);
});

test('a message from another window is dropped, and one from this window still lands', async ({ browser }) => {
  const { page, server, errors } = await openStage(browser);
  const other = await page.context().newPage();
  await other.goto(server.otherOrigin);
  // The viewer opened by a foreign page: the one window that holds a reference to it.
  const popupPromise = other.waitForEvent('popup');
  await other.evaluate(`window.__viewer = window.open(${JSON.stringify(server.url)})`);
  const viewer = await popupPromise;
  // Not waitForFunction: it evaluates a string inside the page, which this CSP rightly refuses.
  await expect.poll(() => viewer.evaluate('typeof window.stageApi')).toBe('object');
  await viewer.evaluate('stageApi.ready()');
  const forged = (id: string) => ({ type: 'graph', gitAvailable: false, data: { nodes: [{ id, name: 'forged', file: '/repo/x.py', line: 1, language: 'python' }], edges: [], files: [] } });
  await viewer.evaluate(`window.__seen = []; window.addEventListener('message', (e) => window.__seen.push(e.data.type))`);
  await other.evaluate(`window.__viewer.postMessage(${JSON.stringify(forged('forged-from-outside'))}, '*')`);
  await viewer.waitForTimeout(300);
  expect(await viewer.evaluate(`state.graphData.nodes.some((n) => n.id === 'forged-from-outside')`)).toBe(false);
  expect(await viewer.evaluate('__seen')).toEqual([]);
  await viewer.evaluate(`window.postMessage({ type: 'pr-view-probe' }, '*')`);
  await expect.poll(() => viewer.evaluate('__seen')).toEqual(['pr-view-probe']);
  expect(errors).toEqual([]);
});

test('at load, one file behaves as many tags: the one typeof that sees a later function is guarded', async ({ browser }) => {
  const instrumented = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-stage-load-'));
  fs.cpSync(dir, instrumented, { recursive: true });
  fs.writeFileSync(path.join(instrumented, manifest.files.stage), instrumentedStage());
  const server = await startStageServer(instrumented, manifest, feedJs(0));
  servers.push(server);
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.url);
  await page.evaluate('stageApi.ready()');
  expect(errors).toEqual([]);
  expect(await page.evaluate('__loaded')).toBe(true);
  // A new name here means a guard now passes in the viewer and fails in the panel: guard it as forcesPanel.js does.
  expect(await page.evaluate('[...new Set(__loadTypeofs)]')).toEqual(['updateForcesPanel']);
  await page.close();
  fs.rmSync(instrumented, { recursive: true, force: true });
});
