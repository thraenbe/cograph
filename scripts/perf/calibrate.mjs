// In-editor calibration: run the bench.js scenarios inside the REAL VS Code
// webview (GPU raster, real CSP, real extension host) so the headless numbers
// can be calibrated. Drives the @vscode/test-electron VS Code build with
// Playwright's _electron — Playwright is NOT a dependency of this repo; point
// PLAYWRIGHT_DIR at any node_modules that has it.
//
// Usage: DISPLAY=:0 PLAYWRIGHT_DIR=/path/to/node_modules \
//   node scripts/perf/calibrate.mjs [--reps 3] [--fixtures 3k,10k] [--out file.json] name:/abs/checkout ...
// Each checkout must be compiled + bundled (dist/extension.js).
import { createRequire } from 'module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIR, '..', '..');
const require = createRequire(import.meta.url);
const PW_DIR = process.env.PLAYWRIGHT_DIR;
if (!PW_DIR) { throw new Error('set PLAYWRIGHT_DIR to a node_modules directory containing playwright'); }
const { _electron } = require(join(PW_DIR, 'playwright'));

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const REPS = +opt('--reps', '3');
const FIXTURES = opt('--fixtures', '3k,10k').split(',');
const OUT = opt('--out', join(DIR, '.out', `calibration-${new Date().toISOString().slice(0, 10)}.json`));
const MAX_MS = opt('--max', '20000');
const CODE = process.env.VSCODE_BIN || join(ROOT, '.vscode-test', 'vscode-linux-x64-1.116.0', 'code');
const checkouts = args.map(a => { const i = a.indexOf(':'); return { name: a.slice(0, i), dir: a.slice(i + 1) }; });
const PICK = { '1k': '1 000', '3k': '3 000', '10k': '10 000' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

const SETTINGS = {
  'cograph.debug.perfLog': true,
  'cograph.layout.defaultEngine': 'shelf',
  'cograph.layout.defaultMode': 'dynamic',
  'workbench.startupEditor': 'none',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.activityBar.location': 'hidden',
  'workbench.statusBar.visible': false,
  'window.commandCenter': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'security.workspace.trust.enabled': false,
  'chat.disableAIFeatures': true,
};

async function findGraphFrame(page, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const f of page.frames()) {
      try {
        const ok = await f.evaluate(() => typeof state !== 'undefined' && !!state.structureTree
          && !!state.graphData && typeof applyDetailDepth === 'function');
        if (ok) { return f; }
      } catch { /* frame not ready / cross-origin shell */ }
    }
    await sleep(500);
  }
  return null;
}

async function oneRun(checkout, fixture) {
  const tmp = mkdtempSync(join(tmpdir(), 'cograph-calib-'));
  const ud = join(tmp, 'user-data'), ed = join(tmp, 'extensions'), ws = join(tmp, 'ws');
  mkdirSync(join(ud, 'User'), { recursive: true }); mkdirSync(ed); mkdirSync(ws);
  writeFileSync(join(ud, 'User', 'settings.json'), JSON.stringify(SETTINGS, null, 1));
  const app = await _electron.launch({
    executablePath: CODE,
    args: [`--extensionDevelopmentPath=${checkout.dir}`, `--user-data-dir=${ud}`, `--extensions-dir=${ed}`,
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--new-window', ws],
    env: { ...process.env },
    timeout: 60000,
  });
  const result = { checkout: checkout.name, fixture };
  try {
    const page = await app.firstWindow();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') { consoleErrors.push(m.text().slice(0, 200)); } });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 200)}`));
    result.consoleErrors = consoleErrors;
    await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
    // GPU feature status is only final once the GPU process reported in.
    result.gpu = await app.evaluate(async ({ app: a }) => {
      await new Promise(r => setTimeout(r, 1500));
      return a.getGPUFeatureStatus();
    });
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setBounds({ x: 0, y: 0, width: 1600, height: 1000 }); w.show(); w.focus();
    });
    await sleep(2500);
    await page.keyboard.press('Control+KeyB');               // close the primary side bar
    await sleep(300);
    // The dev command posts the graph 300 ms after creating the panel; on a cold
    // profile the CDN-d3 checkouts can still be loading then and the message is
    // lost (blank graph). Re-issue the command — the second open is cache-warm.
    let frame = null;
    for (let attempt = 0; attempt < 4 && !frame; attempt++) {
      if (attempt) { await page.keyboard.press('Control+KeyW'); await sleep(500); }
      await page.keyboard.press('F1');
      await page.keyboard.type('CoGraph: Load Synthetic Repo', { delay: 15 });
      await sleep(800);
      await page.keyboard.press('Enter');
      await sleep(1200);
      await page.keyboard.type(PICK[fixture], { delay: 15 });
      await sleep(500);
      await page.keyboard.press('Enter');
      await page.mouse.move(3, 3);
      frame = await findGraphFrame(page, 12000);
      result.loadAttempts = attempt + 1;
    }
    if (!frame) {
      result.fatal = 'webview frame unreachable';
      await page.screenshot({ path: join(DIR, '.out', `calib-fail-${checkout.name}-${fixture}.png`) }).catch(() => {});
      result.frames = [];
      for (const f of page.frames()) {
        const probe = await f.evaluate(() => `d3=${typeof d3} state=${typeof state} graph=${typeof state !== 'undefined' && !!state.graphData} tree=${typeof state !== 'undefined' && !!state.structureTree} nodes=${typeof state !== 'undefined' && state.currentNodes ? state.currentNodes.length : -1} dom=${document.querySelectorAll('#graph *').length}`)
          .catch((e) => `evaluate failed: ${String(e.message).slice(0, 60)}`);
        result.frames.push(`${f.url().slice(0, 60)} → ${probe}`);
      }
      return result;
    }
    await sleep(1500);
    await frame.evaluate((p) => { window.__benchInEditor = true; window.__benchParams = p; },
      `?engine=shelf&mode=dynamic&fx=${fixture}&max=${MAX_MS}`);
    await frame.evaluate(readFileSync(join(DIR, 'preamble.js'), 'utf8'));
    await frame.evaluate(readFileSync(join(DIR, 'bench.js'), 'utf8'));
    const t0 = Date.now();
    while (Date.now() - t0 < 600000) {
      const raw = await frame.evaluate(() => (window.__benchResult ? JSON.stringify(window.__benchResult) : null));
      if (raw) { Object.assign(result, JSON.parse(raw)); break; }
      await sleep(1000);
    }
    if (!result.expandAll && !result.fatal) { result.fatal = 'bench timeout'; }
  } catch (err) {
    result.fatal = String(err && err.message || err).slice(0, 300);
  } finally {
    await app.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
  return result;
}

const METRICS = [
  ['4 frames: script ms/frame p50', r => r.fourFrames?.scriptPerFrameMs?.p50],
  ['4 frames: frame interval p50 (ms)', r => r.fourFrames?.frameIntervalMs?.p50],
  ['4 frames: settled (ms, cap = not settled)', r => r.fourFrames?.settleWallMs],
  ['expand all: to-paint (ms)', r => r.expandAll?.toPaintMs],
  ['expand all: script ms/frame p50', r => r.expandAll?.scriptPerFrameMs?.p50],
  ['expand all: settled (ms, cap = not settled)', r => r.expandAll?.settleWallMs],
  ['pan/zoom fps (dynamic, as left by expand-all)', r => r.panZoom?.fps],
  ['working view: pan-only fps', r => r.panZoom?.panFps],
  ['working view: zoom-only fps', r => r.panZoom?.zoomFps],
  ['working view: zoom factor k / frames shown', r => r.panZoom?.k],
  ['fit-to-view: mixed fps', r => r.panZoomFit?.fps],
  ['fit-to-view: pan-only fps', r => r.panZoomFit?.panFps],
  ['fit-to-view: zoom-only fps', r => r.panZoomFit?.zoomFps],
  ['fit-to-view zoom factor k', r => r.panZoomFit?.k],
  ['pan/zoom fps (static, all expanded)', r => r.panZoomStatic?.fps],
  ['zoom handler p50 (ms)', r => r.panZoom?.handlerMs?.p50],
  ['hover over p50 (ms)', r => r.hover?.overMs?.p50],
  ['drag handler p50 (ms)', r => r.drag?.handlerMs?.p50],
  ['drag frame interval p50 (ms)', r => r.drag?.frameIntervalMs?.p50],
  ['search keystroke p50 (ms)', r => r.searchKeystrokeSyncMs?.p50],
];

function summarize(runs) {
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const cell = (rs, get) => {
    const v = rs.map(get).filter(x => typeof x === 'number');
    return v.length ? `${med(v)} (${Math.min(...v)}–${Math.max(...v)})` : '–';
  };
  const groups = new Map();
  for (const r of runs) { const k = `${r.checkout} ${r.fixture}`; groups.set(k, [...(groups.get(k) || []), r]); }
  const keys = [...groups.keys()];
  const lines = [`| metric — median (min–max) of ${REPS} | ${keys.join(' | ')} |`, `|---|${keys.map(() => '---').join('|')}|`];
  for (const [label, get] of METRICS) { lines.push(`| ${label} | ${keys.map(k => cell(groups.get(k), get)).join(' | ')} |`); }
  lines.push(`| sim backend / webview viewport | ${keys.map(k => { const r = groups.get(k)[0]; return `${r.simBackend ?? '–'} / ${r.viewport ? r.viewport.w + '×' + r.viewport.h : '–'}`; }).join(' | ')} |`);
  lines.push(`| failed runs | ${keys.map(k => groups.get(k).filter(r => r.fatal).map(r => r.fatal).join('; ') || 0).join(' | ')} |`);
  return lines.join('\n');
}

async function main() {
  if (!existsSync(CODE)) { throw new Error(`VS Code binary not found: ${CODE}`); }
  const runs = [];
  for (const fixture of FIXTURES) {
    for (let rep = 0; rep < REPS; rep++) {
      for (const c of checkouts) {               // interleave checkouts → drift hits all equally
        const r = await oneRun(c, fixture);
        r.rep = rep;
        runs.push(r);
        log(`${c.name} ${fixture} #${rep + 1}: ${r.fatal ? 'FATAL ' + r.fatal : 'ok'} gpu.raster=${r.gpu?.rasterization} gpu.comp=${r.gpu?.gpu_compositing}`);
        writeFileSync(OUT, JSON.stringify({ date: new Date().toISOString(), runs }, null, 1));
        const g = r.gpu || {};
        if (runs.length === 1 && (!/enabled/.test(g.rasterization || '') || !/enabled/.test(g.gpu_compositing || ''))) {
          log('STOP: no hardware raster/compositing — numbers would not calibrate anything:', JSON.stringify(g));
          process.exit(2);
        }
      }
    }
  }
  process.stdout.write(summarize(runs) + `\n\nraw: ${OUT}\n`);
}

main().catch((err) => { log(`calibration failed: ${err.stack || err}`); process.exit(1); });
