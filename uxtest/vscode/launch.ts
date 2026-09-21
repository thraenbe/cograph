// Tier B: real VS Code (the pinned test build) with the extension loaded from
// source, driven by Playwright's Electron support — the same mechanism VS Code's
// own smoke tests use. Headed: a window opens (Wayland/XWayland); no xvfb needed.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _electron as electron, type ElectronApplication, type Frame, type Page } from '@playwright/test';
import { EXT_ROOT, REPO_ROOT } from '../harness/vscodeStub';
import { expandHome, loadConfig } from '../lib/corpus';
import { installOverlay } from '../lib/overlay';
import { installFpsTrace } from '../lib/fps';
import { StepRecorder, type StepRecord } from '../lib/step';
import { runId } from '../lib/lab';
import { attachLogFile, log } from '../lib/log';

const VSCODE_VERSION = '1.116.0'; // keep in sync with src/test/runTest.ts
const SIZE = { width: 1440, height: 900 };

export interface VsCodeSession {
  app: ElectronApplication; page: Page; ux: StepRecorder; outDir: string; workspace: string; userDataDir: string;
  /** The CoGraph graph webview's inner frame (the document holding #graph), or null. */
  graphFrame(): Promise<Frame | null>;
  close(): Promise<VsCodeRun>;
}
export interface VsCodeRun { repo: string; scenario: string; tier: 'vscode'; startedAt: string; durationMs: number; video: string | null;
  steps: StepRecord[]; outputLog: string | null; engine: string; motion: string; functions: number; sizeClass: string; hostMode: string;
  hostLog: never[]; consoleErrors: string[]; blockedRequests: never[]; perfReport: unknown }

/** Own .vscode-test first, then $UXTEST_VSCODE, then a sibling worktree's download, else download. */
export async function resolveVsCode(): Promise<string> {
  const name = `vscode-linux-x64-${VSCODE_VERSION}`;
  const candidates = [process.env.UXTEST_VSCODE, path.join(EXT_ROOT, '.vscode-test', name, 'code'), path.join(REPO_ROOT, '.vscode-test', name, 'code')];
  const worktrees = path.resolve(REPO_ROOT, '..');
  if (fs.existsSync(worktrees)) { for (const w of fs.readdirSync(worktrees)) { candidates.push(path.join(worktrees, w, '.vscode-test', name, 'code')); } }
  for (const c of candidates) { if (c && fs.existsSync(c)) { return c; } }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
  return downloadAndUnzipVSCode(VSCODE_VERSION);
}

/** The suite edits files and writes .cograph/ — never inside the corpus checkout. */
export function copyWorkspace(repoRoot: string, into: string): string {
  const dest = path.join(into, path.basename(repoRoot));
  fs.cpSync(repoRoot, dest, { recursive: true, filter: src => !/(^|\/)(node_modules|\.cograph|\.venv|venv|__pycache__|dist|build|target)(\/|$)/.test(path.relative(repoRoot, src)) });
  return dest;
}

const SETTINGS = {
  'cograph.debug.perfLog': true, 'cograph.graphIntelligence.enabled': false,
  'workbench.startupEditor': 'none', 'workbench.tips.enabled': false, 'workbench.enableExperiments': false,
  'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
  'security.workspace.trust.enabled': false, 'window.titleBarStyle': 'custom', 'window.dialogStyle': 'custom',
  'git.autofetch': false, 'editor.minimap.enabled': false, 'files.autoSave': 'off', 'window.restoreWindows': 'none',
  'chat.commandCenter.enabled': false, 'workbench.secondarySideBar.defaultVisibility': 'hidden',
};

async function findGraphFrame(page: Page): Promise<Frame | null> {
  for (const f of page.frames()) {
    if (!f.url().startsWith('vscode-webview://')) { continue; }
    try { if (await f.evaluate(() => !!document.querySelector('#graph') && !!document.querySelector('#top-left-controls'))) { return f; } }
    catch { /* frame navigated or detached while probing */ }
  }
  return null;
}

export async function launchVsCode(repo: string, scenario: string, settings: Record<string, unknown> = {}): Promise<VsCodeSession> {
  const cfg = loadConfig();
  const repoRoot = path.isAbsolute(expandHome(repo)) ? expandHome(repo) : path.join(cfg.corpusDir, repo);
  if (!fs.existsSync(repoRoot)) { throw new Error(`repo not found: ${repoRoot}`); }
  if (!fs.existsSync(path.join(EXT_ROOT, 'dist', 'extension.js'))) { throw new Error(`${EXT_ROOT}/dist/extension.js missing - run "npm run bundle"`); }
  const name = path.basename(repoRoot);
  const outDir = path.join(REPO_ROOT, 'uxtest', 'artifacts', runId(), name, `${scenario}-vscode`);
  fs.mkdirSync(outDir, { recursive: true });
  attachLogFile(path.join(outDir, 'run.log'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-vscode-'));
  const workspace = copyWorkspace(repoRoot, path.join(tmp, 'ws'));
  const userDataDir = path.join(tmp, 'user-data');
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({ ...SETTINGS, ...settings }, null, 2));

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) { if (v !== undefined && !/^(ELECTRON_RUN_AS_NODE|VSCODE_|NODE_OPTIONS$)/.test(k)) { env[k] = v; } }
  const startedAt = new Date();
  const app = await electron.launch({
    executablePath: await resolveVsCode(), env, timeout: 60000,
    args: [`--extensionDevelopmentPath=${EXT_ROOT}`, `--user-data-dir=${userDataDir}`, `--extensions-dir=${path.join(tmp, 'extensions')}`,
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry', '--disable-crash-reporter',
      '--password-store=basic', '--no-sandbox', '--disable-gpu-sandbox', `--window-size=${SIZE.width},${SIZE.height}`, workspace],
    recordVideo: { dir: outDir, size: SIZE },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
  await page.evaluate(installOverlay);

  const graphFrame = async (): Promise<Frame | null> => {
    const f = await findGraphFrame(page);
    if (f) { await f.evaluate(installFpsTrace).catch(() => undefined); }
    return f;
  };
  const ux = new StepRecorder({ page, outDir, still: cfg.still, caps: cfg.caps, errors, keepSnapshots: true, t0: startedAt.getTime(), target: graphFrame });

  const close = async (): Promise<VsCodeRun> => {
    let perfReport: unknown = null;
    try { const f = await findGraphFrame(page); if (f) { perfReport = await f.evaluate('typeof perfReport === "function" ? perfReport() : null'); } }
    catch (err) { log.warn('perf-report-unavailable', { error: String(err) }); }
    const video = page.video();
    await app.close().catch(err => log.warn('vscode-close-failed', { error: String(err) }));
    let videoRel: string | null = null;
    if (video) {
      try { await video.saveAs(path.join(outDir, 'video.webm')); await video.delete(); videoRel = 'video.webm'; }
      catch (err) { log.warn('video-save-failed', { error: String(err) }); }
    }
    const outputLog = collectOutputLog(userDataDir, outDir);
    const run: VsCodeRun = { repo: name, scenario, tier: 'vscode', startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
      video: videoRel, steps: ux.steps, outputLog, engine: 'vscode', motion: 'real', functions: 0, sizeClass: 'n/a', hostMode: 'real',
      hostLog: [], consoleErrors: errors, blockedRequests: [], perfReport };
    fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(run, null, 2));
    log.info('run-written', { outDir, steps: ux.steps.length });
    return run;
  };
  return { app, page, ux, outDir, workspace, userDataDir, graphFrame, close };
}

/** B7 evidence: keep what the CoGraph output channel and the extension host logged. */
export function collectOutputLog(userDataDir: string, outDir: string): string | null {
  const logs = path.join(userDataDir, 'logs');
  if (!fs.existsSync(logs)) { return null; }
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); } else if (/cograph/i.test(e.name) || e.name === 'exthost.log') { hits.push(p); }
    }
  };
  walk(logs);
  if (!hits.length) { return null; }
  const body = hits.map(h => `===== ${path.relative(logs, h)} =====\n${fs.readFileSync(h, 'utf8')}`).join('\n');
  fs.writeFileSync(path.join(outDir, 'vscode-output.log'), body);
  return 'vscode-output.log';
}
