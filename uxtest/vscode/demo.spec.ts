// README demo take (Tier B, real VS Code): activity bar -> graph from the CoGraph view -> Shelf Static -> Shelf Dynamic
// (drag + snap back) -> Global. Records its own screencast (CDP Page.startScreencast, sharper than Playwright's video)
// plus a timestamped pointer log; uxtest/vscode/demo-render.py turns both into demo.mp4 / demo.gif with a drawn cursor.
//   UXTEST_VSCODE_SIZE=1440x810 UXTEST_VSCODE_NOVIDEO=1 UXTEST_EXT_ROOT=<build> npm run uxtest:vscode -- --repo click --grep demo
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type { Frame, Page } from '@playwright/test';
import { launchVsCode } from './launch';
import { frameElementCenter, frameHittable, runCommand, waitForGraph } from './drive';
import { SEL } from '../selectors';

const repo = process.env.UXTEST_REPOS ?? 'click';

interface Ptr { t: number; x: number; y: number; down: boolean }

test('demo', async () => {
  test.setTimeout(10 * 60 * 1000);
  const s = await launchVsCode(repo, 'demo');
  const { page, outDir } = s;
  const framesDir = path.join(outDir, 'frames'); fs.mkdirSync(framesDir, { recursive: true });
  const ptr: Ptr[] = [];
  const marks: { t: number; label: string }[] = [];
  let cur = { x: 720, y: 405 }, down = false;
  const now = (): number => Date.now() / 1000;
  const mark = (label: string): void => { marks.push({ t: now(), label }); };
  const log = (): void => { ptr.push({ t: now(), x: cur.x, y: cur.y, down }); };
  /** Glide like a hand: eased steps over `ms`, every step logged for the drawn cursor. */
  const glide = async (x: number, y: number, ms = 700): Promise<void> => {
    const from = { ...cur }, steps = Math.max(8, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      cur = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
      await page.mouse.move(cur.x, cur.y); log();
      await page.waitForTimeout(ms / steps);
    }
  };
  const click = async (x: number, y: number, ms = 700): Promise<void> => {
    await glide(x, y, ms);
    down = true; await page.mouse.down(); log(); await page.waitForTimeout(90);
    down = false; await page.mouse.up(); log();
  };
  const hold = async (ms: number): Promise<void> => { const end = Date.now() + ms; while (Date.now() < end) { log(); await page.waitForTimeout(50); } };
  const center = async (f: Frame, css: string): Promise<{ x: number; y: number }> => {
    const c = await frameElementCenter(f, css); if (!c) { throw new Error(`not found: ${css}`); } return c;
  };

  // Screencast of the whole workbench (webviews included: they are composited into the page).
  const cdp = await page.context().newCDPSession(page);
  let nFrames = 0;
  const frameTimes: { file: string; t: number }[] = [];
  cdp.on('Page.screencastFrame', async (ev: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const file = `f${String(++nFrames).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(framesDir, file), Buffer.from(ev.data, 'base64'));
    frameTimes.push({ file, t: ev.metadata.timestamp ?? now() });
    await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => undefined);
  });

  const sidebar = async (): Promise<Frame> => {
    for (let i = 0; i < 60; i++) {
      for (const f of page.frames()) {
        if (f.url().startsWith('vscode-webview://') && await f.evaluate(() => !!document.getElementById('btn-new-graph')).catch(() => false)) { return f; }
      }
      await page.waitForTimeout(250);
    }
    throw new Error('CoGraph sidebar not found');
  };

  try {
    await page.waitForTimeout(3000);
    // The window manager ignores --window-size; set the CONTENT size from inside Electron (16:9 where the screen allows).
    const [W, H] = (process.env.UXTEST_VSCODE_SIZE ?? '1440x810').split('x').map(Number);
    await s.app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); win.setContentSize(w, h); }, [W, H]);
    await page.evaluate(() => document.getElementById('__ux-overlay')?.remove());   // the lab's own cursor: the render draws one
    await page.waitForTimeout(1200);
    // Off camera: open the CoGraph view once, make it narrower with VS Code's own command (it remembers the width),
    // close it again. The take then opens it from the activity bar at that width.
    {
      const ic = page.locator('.activitybar [aria-label*="CoGraph" i], .activitybar [aria-label*="Cograph" i]').first();
      await ic.click(); await sidebar();
      for (let i = 0; i < 4; i++) { await runCommand(page, 'View: Decrease Current View Size').catch(() => undefined); await page.waitForTimeout(150); }
      await ic.click(); await page.waitForTimeout(600);
    }
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    mark('start');
    await hold(800);

    // 1. Activity bar -> CoGraph view, made narrower so the graph gets the room, -> "+ New Graph".
    mark('activity bar');
    const icon = page.locator('.activitybar [aria-label*="CoGraph" i], .activitybar [aria-label*="Cograph" i]').first();
    const ib = await icon.boundingBox(); if (!ib) { throw new Error('no CoGraph activity-bar icon'); }
    await click(ib.x + ib.width / 2, ib.y + ib.height / 2, 800);
    const side = await sidebar();
    await hold(500);
    await hold(300);
    await click(...Object.values(await center(side, '#btn-new-graph')) as [number, number], 700);
    mark('graph opening');
    await waitForGraph(s.graphFrame, 120000, true);
    const g = await s.graphFrame(); if (!g) { throw new Error('no graph frame'); }
    const off = await (await g.frameElement()).boundingBox(); if (!off) { throw new Error('no graph iframe box'); }
    // Fit like a user (double-click bare canvas) when bare canvas is reachable; otherwise the product's own
    // fitToView(). Never skip silently: a skipped fit once left Global building off-screen for 3-4 s of the take.
    const fit = async (): Promise<void> => {
      const bg = await frameHittable(g, '#graph svg', 330);
      if (bg) { await glide(bg.x, bg.y, 500); await page.mouse.dblclick(bg.x, bg.y); log(); return; }
      const ok = await g.evaluate('typeof fitToView === "function" ? (fitToView(), true) : false');
      if (!ok) { throw new Error('could not fit: no bare canvas and no fitToView()'); }
      await hold(500);
    };
    /** Page point at the centre of the frame with the most functions (state geometry, not DOM titles). */
    const busiest = async (): Promise<{ x: number; y: number }> => {
      const p = await g.evaluate(`(() => {
        const want = ${JSON.stringify(process.env.UXTEST_DEMO_FRAME ?? '')};
        let best = null, bestN = -1;
        if (want) { for (const f of state.frames.byPath.values()) { if (f.abs && f.path.endsWith(want)) { best = f; bestN = 1; break; } } }
        if (!best) for (const f of state.frames.byPath.values()) { if (f.kind === 'root' || !f.abs || f.path.split('/').some(seg => ['test', 'tests', 'docs', 'examples'].includes(seg))) { continue; }
          const n = (state.currentNodes || []).filter(x => x._frame === f.path).length;
          if (n > bestN) { bestN = n; best = f; } }
        const t = d3.zoomTransform(svg.node()), r = svg.node().getBoundingClientRect();
        return best ? { x: r.left + t.x + (best.abs.x + best.abs.w / 2) * t.k, y: r.top + t.y + (best.abs.y + best.abs.h / 2) * t.k } : null;
      })()`) as { x: number; y: number } | null;
      if (!p) { throw new Error('no frame to aim at'); }
      return { x: off.x + p.x, y: off.y + p.y };
    };
    await page.waitForTimeout(400);
    // Repos over 200 files open as one collapsed root: the Detail slider, dragged on camera, opens the folders.
    const visible = await g.evaluate('typeof getVisibleNodeIds === "function" ? getVisibleNodeIds().size : state.currentNodes.length') as number;
    if (visible < 5) {
      mark('detail');
      const sl = await g.locator(SEL.detailSlider.css).boundingBox(); if (!sl) { throw new Error('no detail slider'); }
      const y = sl.y + sl.height / 2;   // boundingBox() of a frame locator is already in page coordinates
      await glide(sl.x + 3, y, 700); down = true; await page.mouse.down(); log();
      await glide(sl.x + sl.width - 2, y, 900); down = false; await page.mouse.up(); log();
      await hold(900);
    }
    await fit();
    await hold(1300);

    // 2. Shelf + Static: from the overview into the busiest folder's call structure.
    mark('shelf static');
    const fill = (): Promise<number> => g.evaluate(`(() => {
      const want = ${JSON.stringify(process.env.UXTEST_DEMO_FRAME ?? '')};
      const f = want ? [...state.frames.byPath.values()].find(x => x.abs && x.path.endsWith(want)) : null;
      if (!f) { return 1; }
      const k = d3.zoomTransform(svg.node()).k, r = svg.node().getBoundingClientRect();
      return Math.max(f.abs.w * k / r.width, f.abs.h * k / r.height);
    })()`) as Promise<number>;
    if (process.env.UXTEST_DEMO_FRAME) {
      const present = await g.evaluate(`[...state.frames.byPath.values()].some(x => x.abs && x.path.endsWith(${JSON.stringify(process.env.UXTEST_DEMO_FRAME)}))`);
      if (!present) { throw new Error(`UXTEST_DEMO_FRAME ${process.env.UXTEST_DEMO_FRAME} is not a frame on screen`); }   // never zoom at nothing
    }
    for (let i = 0; i < 16; i++) {
      if (process.env.UXTEST_DEMO_FRAME ? await fill() >= 0.85 : i >= 8) { break; }
      const p = await busiest();
      await glide(p.x, p.y, i === 0 ? 600 : 70);
      await page.mouse.wheel(0, -120); log(); await page.waitForTimeout(100);
    }
    await hold(1200);
    // The hover beat (F28: names only on hover; 216's card adds signature + code): rest on the folder's
    // best-connected visible function long enough to read, then leave it so the card closes before Dynamic.
    const hub = await g.evaluate(`(() => {
      const want = ${JSON.stringify(process.env.UXTEST_DEMO_FRAME ?? '')};
      const deg = new Map();
      // Shelf keeps no global link list in currentLinks: count from the graph data itself.
      for (const l of ((state.graphData && state.graphData.edges) || state.currentLinks || [])) { for (const e of [l.source, l.target]) { const id = e && e.id !== undefined ? e.id : e; deg.set(id, (deg.get(id) || 0) + 1); } }
      let best = null, bd = -1;
      for (const el of document.querySelectorAll('#graph circle.regular-node')) {
        const d = el.__data__; if (!d || (want && !String(d._frame || '').endsWith(want))) { continue; }
        const r = el.getBoundingClientRect(); if (r.width < 2 || r.left < 330 || r.right > innerWidth - 20 || r.top < 60 || r.bottom > innerHeight - 40) { continue; }
        const n = deg.get(d.id) || 0; if (n > bd) { bd = n; best = { x: r.left + r.width / 2, y: r.top + r.height / 2, name: d.label || d.name || String(d.id).split('::')[1] || d.id, degree: n }; }
      }
      return best;
    })()`) as { x: number; y: number; name: string; degree: number } | null;
    if (hub) {
      mark(`hover ${hub.name} (${hub.degree} calls)`);
      await glide(off.x + hub.x, off.y + hub.y, 800);
      await hold(3200);
      await glide(off.x + hub.x + 40, Math.max(off.y + 70, off.y + hub.y - 160), 500);   // off the node: the card closes
      await hold(500);
    } else { await hold(800); }

    // 3. Shelf + Dynamic, still zoomed in: the slots reflow, a node dragged out snaps back.
    mark('shelf dynamic');
    await click(...Object.values(await center(g, SEL.motionDynamic.css)) as [number, number], 800);
    await hold(1000);
    const node = await frameHittable(g, '#graph circle.regular-node', 330);
    if (node) {
      await glide(node.x, node.y, 600);
      down = true; await page.mouse.down(); log();
      await glide(node.x + 120, node.y + 80, 550);
      await hold(150);
      down = false; await page.mouse.up(); log();
      await hold(1000);
    }
    // Fit before the switch: switching engines while zoomed in keeps the zoom, and Global then builds off-screen
    // (measured on 1.4.0: 3-4 s of empty canvas until a fit). A user would fit first; so does the take.
    await fit();
    await hold(500);

    // 4. Global: the classic force layout, settled and fitted.
    mark('global');
    await click(...Object.values(await center(g, SEL.engineGlobal.css)) as [number, number], 800);
    await hold(1200);
    await fit();
    // Rest the pointer on the controls panel (never on a node: no hover card in the last frames).
    await glide(...Object.values(await center(g, SEL.engineGlobal.css)) as [number, number], 500);
    await hold(1300);
    mark('end');
    await cdp.send('Page.stopScreencast');
    await page.waitForTimeout(400);
  } finally {
    const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }));
    fs.writeFileSync(path.join(outDir, 'take.json'), JSON.stringify({ viewport, frames: frameTimes, pointer: ptr, marks }, null, 1));
    await s.close();
  }
});
