// openLab(): the webview lab's single entry point. Boots the real CoGraph
// webview HTML in Chromium against a scripted fake host and returns the page
// plus a step recorder. Usable from Playwright tests (pass `browser`) and from
// plain node scripts (the lab launches its own Chromium) — e.g. perf baselines.
import * as fs from 'fs';
import * as path from 'path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startServer, type LabServer } from '../harness/server';
import { FakeHost, type HostMode, type LoggedMessage } from '../harness/fakeHost';
import { attachHost, postToWebview } from '../harness/hostBridge';
import { REPO_ROOT } from '../harness/vscodeStub';
import { loadConfig, loadRepo, sizeClass, type UxConfig } from './corpus';
import type { AnalyzedRepo } from './analyze';
import { attachOverlay } from './overlay';
import { attachFpsTrace } from './fps';
import { attachTheme, type ThemeKind } from './theme';
import { StepRecorder, type StepRecord } from './step';
import { attachLogFile, log } from './log';

export interface LabOpts {
  repo: string | AnalyzedRepo;          // corpus name, absolute path, synthetic-1k|3k|10k, or a preloaded repo
  engine?: 'shelf' | 'global';
  motion?: 'dynamic' | 'static';
  hostMode?: HostMode;
  scenario?: string;                    // names the output folder
  browser?: Browser;                    // omit to let the lab launch Chromium itself
  headed?: boolean;
  video?: boolean;                      // default true
  theme?: ThemeKind;
  timeline?: boolean;
  gitFixture?: { gitAvailable: boolean; fileGitStatus: Record<string, unknown> };
  outDir?: string;                      // default uxtest/artifacts/<runId>/<repo>/<scenario>-<engine>-<motion>
  keepSnapshots?: boolean;              // default true
}

export interface RunRecord {
  repo: string; functions: number; sizeClass: string; scenario: string;
  engine: string; motion: string; hostMode: string; startedAt: string; durationMs: number;
  video: string | null; steps: StepRecord[]; hostLog: LoggedMessage[];
  consoleErrors: string[]; blockedRequests: string[]; perfReport: unknown;
}

export interface Lab {
  page: Page; context: BrowserContext; host: FakeHost; repo: AnalyzedRepo; cfg: UxConfig;
  ux: StepRecorder; outDir: string;
  /** Send a host→webview message (same path VS Code uses). */
  post(message: unknown): Promise<void>;
  /** Stop recording, write run.json, release browser/server. Returns the run record. */
  close(): Promise<RunRecord>;
}

const D3_FILE = path.join(REPO_ROOT, 'node_modules', 'd3', 'dist', 'd3.min.js');

export function runId(): string {
  return process.env.UXTEST_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function wireNetwork(page: Page, origin: string, blocked: string[]): Promise<void> {
  const d3Body = fs.readFileSync(D3_FILE, 'utf8');
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin)) { return route.continue(); }
    // Only hit while the HTML still references cdnjs; a vendored d3 is served by the lab server.
    if (/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/d3\//.test(url)) {
      return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: d3Body });
    }
    blocked.push(url); // the lab is offline by design
    return route.abort();
  });
}

async function boot(page: Page, host: FakeHost, server: LabServer, o: LabOpts, stillTimeout: number): Promise<void> {
  await page.goto(server.pageUrl({ engine: o.engine, motion: o.motion, perf: true, timeline: o.timeline }));
  await page.waitForSelector('#graph svg', { state: 'attached', timeout: 15000 });
  for (const r of host.openingMessages()) { await postToWebview(page, r.message, r.delayMs); }
  await page.waitForFunction('typeof state !== "undefined" && state.currentNodes && state.currentNodes.length > 0',
    undefined, { timeout: Math.max(30000, stillTimeout) });
}

export async function openLab(o: LabOpts): Promise<Lab> {
  const cfg = loadConfig();
  const repo = typeof o.repo === 'string' ? await loadRepo(o.repo, cfg) : o.repo;
  const engine = o.engine ?? 'shelf', motion = o.motion ?? 'static', scenario = o.scenario ?? 'adhoc';
  const outDir = o.outDir ?? path.join(REPO_ROOT, 'uxtest', 'artifacts', runId(), repo.name, `${scenario}-${engine}-${motion}`);
  fs.mkdirSync(outDir, { recursive: true });
  attachLogFile(path.join(outDir, 'run.log'));
  const startedAt = new Date();

  const server = await startServer();
  const ownBrowser = o.browser ? null : await chromium.launch({ headless: !o.headed });
  const browser = o.browser ?? (ownBrowser as Browser);
  const videoT0 = Date.now(); // recording starts with the context, so step offsets count from here
  const context = await browser.newContext({
    viewport: cfg.viewport, deviceScaleFactor: 1,
    recordVideo: o.video === false ? undefined : { dir: outDir, size: cfg.viewport },
  });
  const page = await context.newPage();
  const errors: string[] = [], blocked: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') { errors.push(`console.error: ${m.text()}`); } });

  const host = new FakeHost({ graph: repo.graph, structure: repo.structure, mode: o.hostMode ?? 'eager', ...(o.gitFixture ?? {}) });
  await wireNetwork(page, server.origin, blocked);
  await attachTheme(page, o.theme ?? 'dark');
  await attachOverlay(page);
  await attachFpsTrace(page);
  await attachHost(page, host);

  const ux = new StepRecorder({ page, outDir, still: cfg.still, caps: cfg.caps, errors, keepSnapshots: o.keepSnapshots !== false, t0: videoT0 });
  try { await boot(page, host, server, { ...o, engine, motion }, cfg.still.timeoutMs); }
  catch (err) {
    log.error('lab-boot-failed', { repo: repo.name, error: String(err), errors });
    await context.close().catch(() => undefined);
    if (ownBrowser) { await ownBrowser.close().catch(() => undefined); }
    await server.close().catch(() => undefined);
    throw err;
  }

  const close = async (): Promise<RunRecord> => {
    let perfReport: unknown = null;
    try { perfReport = await page.evaluate('typeof perfReport === "function" ? perfReport() : null'); }
    catch (err) { log.warn('perf-report-unavailable', { error: String(err) }); }
    const video = page.video();
    await context.close(); // flushes the video file
    let videoRel: string | null = null;
    if (video) {
      try { const target = path.join(outDir, 'video.webm'); await video.saveAs(target); await video.delete(); videoRel = 'video.webm'; }
      catch (err) { log.warn('video-save-failed', { error: String(err) }); }
    }
    if (ownBrowser) { await ownBrowser.close(); }
    await server.close();
    const record: RunRecord = {
      repo: repo.name, functions: repo.functions, sizeClass: sizeClass(repo.functions), scenario, engine, motion,
      hostMode: host.mode, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
      video: videoRel, steps: ux.steps, hostLog: host.log, consoleErrors: errors, blockedRequests: blocked, perfReport,
    };
    fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(record, null, 2));
    log.info('run-written', { outDir, steps: ux.steps.length, errors: errors.length });
    return record;
  };

  return { page, context, host, repo, cfg, ux, outDir, post: (m) => postToWebview(page, m), close };
}
