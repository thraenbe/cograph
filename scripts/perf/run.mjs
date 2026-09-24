// Perf bench, step 2: drive headless Chrome over CDP (Node >= 22 built-in
// WebSocket, no dependencies) through the page built by build-page.cjs.
//
// Usage: node scripts/perf/run.mjs [--out file.json] engine:mode:fixture[:workers[:maxMs]] ...
//   e.g. node scripts/perf/run.mjs shelf:dynamic:3k shelf:static:3k:off global:dynamic:3k
// Prints a markdown table; writes raw JSON to scripts/perf/.out/ (or --out).
import { spawn } from 'child_process';
import { createServer } from 'http';
import { writeFileSync, mkdtempSync, rmSync, readFile } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, normalize, extname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const DIR = dirname(fileURLToPath(import.meta.url));
const OUT = join(DIR, '.out');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const outFile = outIdx >= 0 ? args.splice(outIdx, 2)[1] : join(OUT, `results-${stamp}.json`);
const runs = args.length ? args : ['shelf:dynamic:3k', 'shelf:static:3k'];
const CHROME = process.env.CHROME_BIN || 'google-chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = resolve(DIR, '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

/** Static server over the repo root (127.0.0.1 only): webviews fetch() the worker bundle. */
function serve() {
  const server = createServer((req, res) => {
    const file = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; } // no sibling-prefix escape
    readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function connect(port) {
  for (let i = 0; i < 75; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) { return page.webSocketDebuggerUrl; }
    } catch { /* Chrome not listening yet */ }
    await sleep(200);
  }
  throw new Error(`${CHROME} did not open a debugging port`);
}

function cdp(ws) {
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  });
  return (method, params = {}) => new Promise(resolve => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const fmt = o => (o && o.n ? `${o.p50} / ${o.p95} / ${o.max}` : '–');
function markdown(results) {
  const rows = [
    ['message → paint (ms)', r => r.load?.toPaintMs],
    ['slider reheat: all frames moving after (ms)', r => r.reheat && `${r.reheat.allMovingMs ?? '> 12000'} (${r.reheat.movedFrames}/${r.reheat.frames})`],
    ['4 frames: script ms/frame p50/p95/max', r => fmt(r.fourFrames?.scriptPerFrameMs)],
    ['4 frames: settle wall (ms)', r => r.fourFrames && (r.fourFrames.timedOut ? `> ${r.fourFrames.settleWallMs}` : r.fourFrames.settleWallMs)],
    ['expand all: sync / to-paint (ms)', r => r.expandAll && `${r.expandAll.syncMs} / ${r.expandAll.toPaintMs}`],
    ['expand all: script ms/frame', r => fmt(r.expandAll?.scriptPerFrameMs)],
    ['expand all: settle wall (ms)', r => r.expandAll && (r.expandAll.timedOut ? `> ${r.expandAll.settleWallMs}` : r.expandAll.settleWallMs)],
    ['pan/zoom working view: k · fps · frames shown', r => r.panZoom && `${r.panZoom.k} · ${r.panZoom.fps} (pan ${r.panZoom.panFps} / zoom ${r.panZoom.zoomFps}) · ${r.panZoom.visibleFrames} frames · ${r.panZoom.domAttached} el`],
    ['pan/zoom fit-to-view: k · fps · LOD', r => r.panZoomFit && `${r.panZoomFit.k} · ${r.panZoomFit.fps} (pan ${r.panZoomFit.panFps} / zoom ${r.panZoomFit.zoomFps}) · ${r.panZoomFit.lod} · ${r.panZoomFit.domAttached} el`],
    ['hover over / out p50 (ms)', r => r.hover && `${r.hover.overMs.p50} / ${r.hover.outMs.p50}`],
    ['drag handler ms p50/p95/max', r => fmt(r.drag?.handlerMs)],
    ['drag frames-to-DOM p50', r => r.drag?.framesToDomUpdate.p50],
    ['search keystroke ms p50/p95/max', r => fmt(r.searchKeystrokeSyncMs)],
    ['LOD/culling integrity after re-render', r => r.lodIntegrity && (r.lodIntegrity.ok ? 'ok' : 'BROKEN ' + JSON.stringify(r.lodIntegrity))],
    ['sim backend', r => r.simBackend],
    ['errors', r => (r.fatal ? 'FATAL' : (r.errors || []).length)],
  ];
  const head = results.map(r => `${r.engine}+${r.mode} ${r.fixture}${r.workers !== 'default' ? ' w=' + r.workers : ''}`);
  const lines = [`| metric | ${head.join(' | ')} |`, `|---|${head.map(() => '---').join('|')}|`];
  for (const [label, get] of rows) {
    lines.push(`| ${label} | ${results.map(r => get(r) ?? '–').join(' | ')} |`);
  }
  return lines.join('\n');
}

async function main() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = mkdtempSync(join(tmpdir(), 'cograph-perf-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1600,1000', '--no-first-run',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
  ], { stdio: 'ignore' });
  const results = [];
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/scripts/perf/.out/page.html`;
  try {
    const ws = new WebSocket(await connect(port));
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    const send = cdp(ws);
    await send('Page.enable');
    for (const run of runs) {
      const [engine, mode, fx, workers, max, probe] = run.split(':');
      const q = new URLSearchParams({ engine, mode, fx });
      if (workers) { q.set('workers', workers); }
      if (max) { q.set('max', max); }
      if (probe) { q.set('probe', probe); }
      await send('Page.navigate', { url: `${base}?${q}` });
      const t0 = Date.now();
      let raw = null;
      while (!raw && Date.now() - t0 < 900000) {
        await sleep(1000);
        const r = await send('Runtime.evaluate', {
          expression: 'window.__benchResult ? JSON.stringify(window.__benchResult) : null', returnByValue: true,
        });
        raw = r.result?.result?.value ?? null;
      }
      const parsed = raw ? JSON.parse(raw) : { engine, mode, fixture: fx, workers: workers || 'default', fatal: 'timeout' };
      parsed.totalWallS = +((Date.now() - t0) / 1000).toFixed(1);
      results.push(parsed);
      process.stderr.write(`${run}: ${parsed.totalWallS} s${parsed.fatal ? ' FATAL ' + parsed.fatal : ''}\n`);
    }
    const version = (await send('Browser.getVersion')).result?.product;
    writeFileSync(outFile, JSON.stringify({ chrome: version, date: new Date().toISOString(), results }, null, 1));
    ws.close();
  } finally {
    server.close();
    chrome.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
  process.stdout.write(markdown(results) + `\n\nraw: ${outFile}\n`);
}

main().catch((err) => { process.stderr.write(`perf bench failed: ${err.stack || err}\n`); process.exit(1); });
