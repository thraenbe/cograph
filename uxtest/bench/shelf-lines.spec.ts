// Bench: Shelf in-frame call lines (F27). Before the fix every in-frame line started display:none; after it
// they are painted at rest. What it costs, per repo, Shelf only (the engine F27 changes), both motions:
//   - settle after expanding everything (Detail 1),
//   - real pointer gestures (mouse-drag pan, wheel zoom) at fit and at a working zoom: frame rate (uncapped,
//     see the bench project), p95 frame time, long frames, and main-thread CPU per frame (Performance.getMetrics,
//     which a 60 Hz cap cannot hide),
//   - whether the gesture LOD parks the lines mid-gesture (sampled during the drag), with the culler's own
//     decision (__cull.want.links) and the in-view counts it decided on,
//   - line counts at rest: in-frame lines in the DOM / painted, bundles painted.
// Everything lands in bench.json next to run.json. Compare builds with --ext-root, interleaved, one worker.
import * as fs from 'fs';
import * as path from 'path';
import type { CDPSession, Page } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { drainFps, type FpsWindow } from '../lib/fps';
import { fitToView, setSlider } from '../lib/actions';
import { SkipStep } from '../lib/step';

interface Lines { inFrameDom: number; inFramePainted: number; layersAttached: number; bundlesPainted: number; k: number; nodesAttached: number; labelsAttached: number }
interface Gesture extends FpsWindow { fps: number; cpuMsPerFrame: number; scriptMsPerFrame: number; layoutStyleMsPerFrame: number; mid: Lines & { wantLinks: boolean | null; gesture: boolean | null; inViewLinks: number | null } }

/** Runs in the page. */
function linesInPage(): Lines {
  const g = globalThis as unknown as { d3?: { zoomTransform(el: Element): { k: number } } };
  const svg = document.querySelector('#graph svg');
  const layers = [...document.querySelectorAll('#graph g.frame g.f-links')];
  const lines = layers.flatMap(l => [...l.querySelectorAll('line')]);
  const painted = lines.filter(el => getComputedStyle(el).display !== 'none').length;
  const bundles = [...document.querySelectorAll('#graph line.cross-bundle')].filter(el => getComputedStyle(el).display !== 'none').length;
  return { inFrameDom: lines.length, inFramePainted: painted, layersAttached: layers.length, bundlesPainted: bundles,
    k: svg && g.d3 ? +g.d3.zoomTransform(svg).k.toFixed(3) : 0,
    // F29/F31: what the LOD left attached (parked layers are detached from the document, so these count real DOM cost)
    nodesAttached: document.querySelectorAll('#graph g.frame circle.regular-node').length,
    labelsAttached: document.querySelectorAll('#graph g.frame text').length };
}

/** Mid-gesture: what is painted, and what the culler decided (globals of frameRender.js, absent on old builds). */
async function midGesture(page: Page): Promise<Gesture['mid']> {
  const l = await page.evaluate(linesInPage);
  const cull = await page.evaluate(`(() => {
    const c = typeof __cull !== 'undefined' ? __cull : null;
    const v = typeof visibleDetailCounts === 'function' ? visibleDetailCounts() : null;
    return { wantLinks: c ? !!c.want.links : null, gesture: c ? !!c.gesture : null, inViewLinks: v ? v.links : null };
  })()`) as { wantLinks: boolean | null; gesture: boolean | null; inViewLinks: number | null };
  return { ...l, ...cull };
}

async function cpu(cdp: CDPSession): Promise<Record<string, number>> {
  const { metrics } = await cdp.send('Performance.getMetrics') as { metrics: { name: string; value: number }[] };
  return Object.fromEntries(metrics.map(m => [m.name, m.value]));
}

/** A point where a drag pans: bare svg, or a frame BODY (path.folder-bubble-shape pans; title strip / nodes do not). */
async function bareCanvasPoint(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const svg = document.querySelector('#graph svg');
    if (!svg) { return null; }
    const r = svg.getBoundingClientRect();
    for (let fy = 0.1; fy < 0.95; fy += 0.08) {
      for (let fx = 0.05; fx < 0.95; fx += 0.06) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        const el = document.elementFromPoint(x, y);
        if (el === svg || (el && el.classList.contains('folder-bubble-shape'))) { return { x, y }; }
      }
    }
    return null;
  });
}

async function measure(page: Page, cdp: CDPSession, act: (mid: () => Promise<void>) => Promise<void>): Promise<Gesture> {
  let mid: Gesture['mid'] | null = null;
  await page.waitForTimeout(400); // let the previous gesture's idle timer (180 ms) restore everything
  await drainFps(page);
  const c0 = await cpu(cdp);
  await act(async () => { mid = await midGesture(page); });
  const f = await drainFps(page);
  const c1 = await cpu(cdp);
  const per = (k: string): number => f.frames ? +(((c1[k] ?? 0) - (c0[k] ?? 0)) * 1000 / f.frames).toFixed(2) : 0;
  return { ...f, fps: f.avgMs ? +(1000 / f.avgMs).toFixed(1) : 0, cpuMsPerFrame: per('TaskDuration'), scriptMsPerFrame: per('ScriptDuration'),
    layoutStyleMsPerFrame: +(per('LayoutDuration') + per('RecalcStyleDuration')).toFixed(2), mid: mid as unknown as Gesture['mid'] };
}

const MOVES = 90;
async function pan(page: Page, cdp: CDPSession): Promise<Gesture> {
  const p = await bareCanvasPoint(page);
  if (!p) { throw new SkipStep('no point on screen where a drag pans'); }
  return measure(page, cdp, async (mid) => {
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    for (let i = 1; i <= MOVES; i++) {
      await page.mouse.move(p.x + 120 * Math.sin(i / 9), p.y + 80 * (1 - Math.cos(i / 9))); // a smooth back-and-forth drag
      await page.waitForTimeout(12);
      if (i === MOVES / 2) { await mid(); }
    }
    await page.mouse.up();
  });
}

async function zoom(page: Page, cdp: CDPSession): Promise<Gesture> {
  return measure(page, cdp, async (mid) => {
    await page.mouse.move(640, 400);
    for (let i = 0; i < 24; i++) {
      await page.mouse.wheel(0, i < 12 ? -80 : 80);
      await page.waitForTimeout(30);
      if (i === 6) { await mid(); }
    }
  });
}

scenario('shelf-lines', { only: { engine: 'shelf' }, largeOk: true, expandFirst: false }, async (lab, combo) => {
  const { page, ux } = lab;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const out: Record<string, unknown> = { repo: lab.repo.name, motion: combo.motion, frame: process.env.UXTEST_BENCH_FRAME ?? null, functions: lab.repo.functions, edges: lab.repo.graph.edges.length,
    extRoot: process.env.UXTEST_EXT_ROOT ?? null, loadavg: fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number) };

  const expand = await ux.step('Expand everything (Detail 1) and settle', async () => {
    await setSlider(page, 'detailSlider', 1);
    await page.waitForTimeout(300);
    await fitToView(page);
  }, { stillTimeoutMs: 120000, metrics: false, armBefore: true });
  out.settle = { stepMs: expand.durationMs, still: expand.still ?? null };
  await page.waitForTimeout(1000);
  out.fitLines = await page.evaluate(linesInPage);

  const k = (): Promise<number> => page.evaluate('d3.zoomTransform(svg.node()).k') as Promise<number>;
  // UXTEST_BENCH_FRAME=<path suffix>: aim the working view at that folder (e.g. the one with the most in-frame
  // calls) instead of the largest frame. Re-aims while zooming: a deep zoom from a tiny fit k drifts off target.
  const target = process.env.UXTEST_BENCH_FRAME;
  // Aim from STATE geometry (f.abs, graph space), not the DOM: culled or LOD-detached frames have no grabbable
  // <g> (django once had 0 frame groups attached at fit), and a nested target folder may not be drawn as a title.
  const aim = (): Promise<{ x: number; y: number; path: string } | null> => page.evaluate(`(() => {
    const suffix = ${JSON.stringify(target ?? null)};
    const fr = typeof state !== 'undefined' && state.frames ? state.frames.byPath : null;   // top-level let: not on globalThis
    const svgEl = document.querySelector('#graph svg');
    if (!fr || !svgEl) { return null; }
    let best = null;
    for (const f of fr.values()) {
      if (f.kind === 'root' || !f.abs) { continue; }
      if (suffix) { if (f.path.replace(/\\\\/g, '/').endsWith(suffix)) { best = f; break; } }
      else if (!best || f.abs.w * f.abs.h > best.abs.w * best.abs.h) { best = f; }
    }
    if (!best) { return null; }
    const t = d3.zoomTransform(svgEl), r = svgEl.getBoundingClientRect();
    return { x: r.left + t.x + (best.abs.x + best.abs.w / 2) * t.k, y: r.top + t.y + (best.abs.y + best.abs.h / 2) * t.k, path: best.path };
  })()`) as Promise<{ x: number; y: number; path: string } | null>;
  const zoomTo = async (want: number): Promise<void> => {
    for (let i = 0; i < 200 && await k() < want; i++) {
      if (i % 10 === 0) {
        const p = await aim();
        if (!p) { throw new Error(`no frame to aim at${target ? ` (suffix ${target})` : ''}`); }
        out.aimedAt = p.path;
        await page.mouse.move(Math.max(5, Math.min(1275, p.x)), Math.max(5, Math.min(795, p.y)));
      }
      await page.mouse.wheel(0, -60); await page.waitForTimeout(40);
    }
    await page.waitForTimeout(900);
    out.zoomReached = { ...(out.zoomReached as object ?? {}), [String(want)]: +(await k()).toFixed(3) };
    if (await k() < want) { throw new Error(`zoom stopped at k ${(await k()).toFixed(3)} < ${want}`); }
  };
  // fit = as users reach it after Detail 1 (the LOD may be stale after that re-render, F28);
  // fit-relod = zoomed in past the link LOD (0.4) and fitted again, so the LOD is applied fresh;
  // working = k ~0.8, a few frames at full detail.
  const views: [string, () => Promise<void>][] = [
    ['fit', async () => { /* already fitted */ }],
    ['fit-relod', async () => { await zoomTo(0.6); await fitToView(page); await page.waitForTimeout(900); }],
    // fit-redetail = 216's F29 sequence: at fit (below every LOD threshold) change Detail once, i.e. a re-render while
    // `want` is already parked. Main/F27 attach everything here; F29 re-parks.
    ['fit-redetail', async () => { await fitToView(page); await page.waitForTimeout(900); await setSlider(page, 'detailSlider', 0.9); await page.waitForTimeout(600); await setSlider(page, 'detailSlider', 1); await page.waitForTimeout(1500); }],
    ['working', async () => { await fitToView(page); await page.waitForTimeout(900); await zoomTo(0.8); }],
  ];
  for (const [view, enter] of views) {
    const res: Record<string, unknown> = {};
    const entered = await ux.step(`${view}: enter view`, enter, { metrics: false });
    // A view that was not entered must not be measured as if it had been (it would be the previous view, mislabelled).
    if (entered.status !== 'ok') { throw new Error(`${view}: view not entered (${entered.status}): ${entered.note ?? ''}`); }
    res.lines = await page.evaluate(linesInPage);
    res.wantAtRest = await page.evaluate('typeof __cull !== "undefined" ? { ...__cull.want } : null');
    const p = await ux.step(`${view}: pan (mouse drag)`, async () => { res.pan = await pan(page, cdp); }, { metrics: false, settle: false });
    const z = await ux.step(`${view}: zoom (wheel in/out)`, async () => { res.zoom = await zoom(page, cdp); }, { metrics: false, settle: false });
    for (const [rec, g] of [[p, res.pan], [z, res.zoom]] as const) {
      const x = g as Gesture | undefined;
      if (x) { rec.note = `${x.fps} fps, p95 ${x.p95Ms} ms, ${x.longFrames} long, cpu ${x.cpuMsPerFrame} ms/frame; mid-gesture ${x.mid.inFramePainted}/${x.mid.inFrameDom} in-frame lines painted, want.links=${x.mid.wantLinks}, in-view links ${x.mid.inViewLinks}`; }
    }
    out[view] = res;
  }
  fs.writeFileSync(path.join(lab.outDir, 'bench.json'), JSON.stringify(out, null, 2));
});
