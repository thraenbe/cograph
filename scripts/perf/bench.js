// Perf bench scenarios — runs inside the page built by build-page.cjs.
// Results land on window.__benchResult (read by run.mjs over CDP).
// Scenarios: load · 4 open frames · expand all · pan/zoom · hover · drag · search.
(async function () {
  const P = new URLSearchParams(window.__benchParams || location.search);
  const B = window.__bench;
  const R = { engine: P.get('engine'), mode: P.get('mode'), workers: P.get('workers') || 'default', fixture: P.get('fx') };
  const raf = () => new Promise(r => B.rawRaf(r));
  const paint = async () => { await raf(); await raf(); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const MAX_MS = +(P.get('max') || 45000);
  const r2 = v => +v.toFixed(2);
  function stats(a) {
    if (!a.length) { return { n: 0 }; }
    const s = [...a].sort((x, y) => x - y);
    const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, mean: r2(s.reduce((x, y) => x + y, 0) / s.length), p50: r2(q(0.5)), p95: r2(q(0.95)), max: r2(s[s.length - 1]) };
  }
  /** Run fn, then record frames until the app's rAF loops go idle (or MAX_MS). */
  async function record(fn, opts) {
    opts = opts || {};
    await paint();
    B.rec = []; B.acc = 0;
    const loaf0 = B.loaf.length;
    const t0 = performance.now();
    fn();
    const syncMs = performance.now() - t0;
    await paint();
    const toPaintMs = performance.now() - t0;
    B.lastAppCb = Math.max(B.lastAppCb, t0);
    let timedOut = false;
    if (!opts.noIdleWait) {
      // Settled = no app rAF callback pending (scheduler / d3 timer stopped)
      // and the simulation reports no heat, stable for 300 ms.
      let quietSince = 0;
      for (;;) {
        const now = performance.now();
        if (now - t0 > MAX_MS) { timedOut = true; break; }
        if (isQuiet()) {
          if (!quietSince) { quietSince = now; }
          if (now - quietSince >= 300) { break; }
        } else { quietSince = 0; }
        await sleep(50);
      }
    }
    const rec = B.rec; B.rec = null;
    const active = rec.filter(f => f.script > 0.05);
    const loaf = B.loaf.slice(loaf0);
    return {
      syncMs: r2(syncMs), toPaintMs: r2(toPaintMs), timedOut,
      settleWallMs: timedOut ? MAX_MS : r2(Math.max(0, B.lastAppCb - t0)),
      activeFrames: active.length,
      scriptPerFrameMs: stats(active.map(f => f.script)),
      frameIntervalMs: stats(rec.slice(1, Math.max(2, active.length + 2)).map(f => f.dt)),
      longFrames: loaf.length, worstLongFrameMs: loaf.length ? r2(Math.max(...loaf.map(l => l.dur))) : 0,
      worstRenderMs: loaf.length ? r2(Math.max(...loaf.map(l => l.render))) : 0,
    };
  }
  function isQuiet() {
    if (B.pending.size) { return false; }
    const sim = state.simulation;
    if (state.layoutMode === 'static' || !sim || typeof sim.alpha !== 'function') { return true; }
    const min = typeof sim.alphaMin === 'function' ? sim.alphaMin() : 0.001;
    return !(sim.alpha() > min);
  }
  const post = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
  const domCount = () => document.querySelectorAll('#graph *').length;

  try {
    // In-editor calibration (calibrate.mjs): the extension already loaded the
    // synthetic repo into a real webview — skip the fixture + load scenario.
    if (!window.__benchInEditor) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.nonce = (document.querySelector('script[nonce]') || {}).nonce || '';
        s.src = `fixture-${R.fixture}.js`; s.onload = res; s.onerror = () => rej(new Error('fixture load'));
        document.head.appendChild(s);
      });
      const FX = window.__FIXTURE;
      R.graphNodes = FX.graph.nodes.length; R.graphEdges = FX.graph.edges.length;
      R.payloadMB = r2(JSON.stringify(FX.graph).length / 1e6);
      const tc = performance.now(); structuredClone(FX.graph); R.structuredCloneMs = r2(performance.now() - tc);

      // 0) optional A/B probe (?probe=globalSettle): Global+Dynamic with DEFAULT sliders.
    // Separates "more ticks" from "slower ticks" from "never cools": tick count, script
    // ms per frame, alpha reheats, re-renders, re-fits, sim-end vs visual stillness.
    if (P.get('probe') === 'globalSettle') {
      const counts = { renderElements: 0, applyComplexity: 0, applyFileClusters: 0, fitToView: 0, rerunLayout: 0, startSimulation: 0 };
      const events = [];
      const t00 = performance.now();
      for (const name of Object.keys(counts)) {
        const orig = window[name];
        if (typeof orig !== 'function') { continue; }
        window[name] = function (...a) { counts[name]++; events.push([name, r2(performance.now() - t00)]); return orig.apply(this, a); };
      }
      async function settle(label, action) {
        const c0 = { ...counts };
        let ticks = 0, reheats = 0, lastAlpha = null, simSeen = null, sims = 0;
        let simEndMs = null, stillMs = null, stillRun = 0, maxStep = 0;
        let prev = null;
        B.rec = []; B.acc = 0;
        const t0 = performance.now();
        action();
        while (performance.now() - t0 < MAX_MS) {
          await raf();
          const now = performance.now() - t0;
          const sim = state.simulation;
          if (sim && sim !== simSeen) { simSeen = sim; sims++; if (sim.on) { sim.on('tick.bench', () => { ticks++; }); } lastAlpha = null; }
          const alpha = sim && sim.alpha ? sim.alpha() : 0;
          if (lastAlpha != null && alpha > lastAlpha + 1e-6) { reheats++; events.push([`reheat ${r2(lastAlpha)}→${r2(alpha)}`, r2(now)]); }
          lastAlpha = alpha;
          const min = sim && sim.alphaMin ? sim.alphaMin() : 0.001;
          if (alpha < min) { if (simEndMs == null) { simEndMs = r2(now); } } else { simEndMs = null; }
          // visual stillness: max per-frame displacement < 0.5 px for 30 consecutive frames
          let step = 0;
          const cur = new Map();
          for (const n of state.currentNodes) { cur.set(n.id, [n.x, n.y]); const q = prev && prev.get(n.id); if (q) { step = Math.max(step, Math.abs(n.x - q[0]) + Math.abs(n.y - q[1])); } }
          prev = cur; maxStep = Math.max(maxStep, step);
          if (step < 0.5) { stillRun++; if (stillRun === 30 && stillMs == null) { stillMs = r2(now - 30 * 16.7); } } else { stillRun = 0; stillMs = null; }
          if (simEndMs != null && stillMs != null && now - simEndMs > 600) { break; }
        }
        const rec = B.rec; B.rec = null;
        const active = rec.filter(f => f.script > 0.05);
        const delta = {}; for (const k of Object.keys(counts)) { delta[k] = counts[k] - c0[k]; }
        return { label, nodes: state.currentNodes.length, simEndMs, stillMs, timedOut: simEndMs == null || stillMs == null,
          ticks, msPerTick: ticks ? r2(active.reduce((a, f) => a + f.script, 0) / ticks) : null,
          scriptPerFrameMs: stats(active.map(f => f.script)), frameIntervalMs: stats(rec.slice(1).map(f => f.dt)),
          reheats, simObjects: sims, finalAlpha: r2(lastAlpha ?? 0), calls: delta };
      }
      R.globalSettle = [];
      R.globalSettle.push(await settle('load', () => {
        post({ type: 'structure', tree: FX.structure, autoEngage: true });
        post({ type: 'graph', data: FX.graph, gitAvailable: false, fileGitStatus: {}, isReanalysis: false });
      }));
      R.globalSettle.push(await settle('expandAll', () => applyDetailDepth(1)));
      R.engineAtEnd = state.layoutEngine; R.modeAtEnd = state.layoutMode;
      R.events = events.slice(0, 80);
      R.errors = B.errors;
      window.__benchResult = R; return;
    }

    // 1) load: structure + graph messages → paint (+ settle when dynamic)
      R.load = await record(() => {
        post({ type: 'structure', tree: FX.structure, autoEngage: true });
        post({ type: 'graph', data: FX.graph, gitAvailable: false, fileGitStatus: {}, isReanalysis: false });
      });
      R.load.renderedNodes = state.currentNodes.length; R.load.dom = domCount();
    // ux's Global boot guard: a Global boot config + a first graph beyond the guard → Shelf + hint
    { const hint = document.getElementById('global-guard-hint');
      R.bootGuard = { requestedEngine: R.engine, engineAfterLoad: state.layoutEngine,
        hintVisible: !!hint && hint.style.display !== 'none' && !!hint.textContent, hintText: hint ? hint.textContent.slice(0, 90) : null }; }
    } else {
      R.graphNodes = state.graphData ? state.graphData.nodes.length : 0;
      R.viewport = { w: window.innerWidth, h: window.innerHeight };
    }

    // 1b) force-slider reheat (F7/F13): how long until EVERY open frame visibly moves?
    if (R.engine === 'shelf' && R.mode === 'dynamic' && state.frames && state.currentNodes.length > 50) {
      const byFrame = new Map();
      for (const n of state.currentNodes) {
        if (!n._frame || n.fx != null) { continue; }
        if (!byFrame.has(n._frame)) { byFrame.set(n._frame, []); }
        byFrame.get(n._frame).push({ n, x: n.x, y: n.y });
      }
      const moved = new Set();
      const t0 = performance.now();
      let firstAll = null, firstHalf = null;
      settings.repelForce = (settings.repelForce || 250) + 350;
      state.simulation.alpha(0.3).restart();
      while (performance.now() - t0 < 12000 && firstAll == null) {
        await raf();
        for (const [path, list] of byFrame) {
          if (!moved.has(path) && list.some(e => Math.abs(e.n.x - e.x) + Math.abs(e.n.y - e.y) > 0.5)) { moved.add(path); }
        }
        const t = performance.now() - t0;
        if (firstHalf == null && moved.size >= byFrame.size / 2) { firstHalf = r2(t); }
        if (moved.size === byFrame.size) { firstAll = r2(t); }
      }
      R.reheat = { frames: byFrame.size, movedFrames: moved.size, halfMovingMs: firstHalf, allMovingMs: firstAll };
      settings.repelForce -= 350;
    }

    // 1d) optional repro (?probe=f12): uxtest's Global force tuple that froze zod for 13 min.
    // The page must stay responsive and the coordinates finite.
    if (P.get('probe') === 'f12') {
      if (state.layoutEngine !== 'global') { setLayoutEngine('global', { force: true }); }
      setLayoutMode('dynamic');
      applyDetailDepth(1);
      await paint();
      Object.assign(settings, { centerForce: 0.075, repelForce: 191, linkForce: 4.8, fileClusterForce: 0.98, folderRepelForce: 0.26, fileRepelForce: 2.12 });
      B.rec = []; B.acc = 0;
      const t0 = performance.now();
      rerunLayout();
      let maxAbs = 0, worstGapMs = 0, last = performance.now();
      while (performance.now() - t0 < 20000) {
        await raf();
        const now = performance.now(); worstGapMs = Math.max(worstGapMs, now - last); last = now;
        for (const n of state.currentNodes) { const a = Math.max(Math.abs(n.x), Math.abs(n.y)); if (!(a <= maxAbs)) { maxAbs = a; } }
        if (!(state.simulation.alpha() > 0.001)) { break; }
      }
      const rec = B.rec; B.rec = null;
      R.f12 = { nodes: state.currentNodes.length, ranMs: r2(performance.now() - t0), settled: !(state.simulation.alpha() > 0.001),
        worstFrameGapMs: r2(worstGapMs), frameIntervalMs: stats(rec.slice(1).map(f => f.dt)),
        maxAbsCoordinate: maxAbs, nonFinite: state.currentNodes.filter(n => !Number.isFinite(n.x) || !Number.isFinite(n.y)).length };
      window.__benchResult = R; return;
    }

    // 1c) optional repro (?probe=switch): shelf → global → shelf, Detail 0 — is the glyph in the DOM?
    if (P.get('probe') === 'switch') {
      const snap = (tag) => ({ tag, engine: state.layoutEngine, mode: state.layoutMode, k: r2(d3.zoomTransform(svg.node()).k),
        frames: state.frames ? state.frames.byPath.size : 0, framesAttached: document.querySelectorAll('#graph g.frame').length,
        clouds: document.querySelectorAll('#graph path.cloud-node').length, cloudsInState: state.svgCloudNodes ? state.svgCloudNodes.size() : -1,
        frameG: !!document.querySelector('#graph g.frames'), usesFrames: usesFrames() });
      const out = [snap('start')];
      fitToView(); await sleep(800); out.push(snap('fit'));
      setLayoutEngine('global'); setLayoutMode('dynamic'); await sleep(2500); out.push(snap('global'));
      setLayoutEngine('shelf'); setLayoutMode('static'); await paint(); out.push(snap('shelf'));
      applyDetailDepth(0); await paint(); await sleep(900); out.push(snap('detail0'));
      R.switchProbe = out;
      window.__benchResult = R; return;
    }

    // 2) four open frames (shelf target scenario): 4 leaf-most folders with most files
    if (R.engine === 'shelf') {
      const tree = state.structureTree;
      const leafs = Object.keys(tree.folders).filter(p => !(tree.folders[p].childFolders || []).length)
        .sort((a, b) => (tree.folders[b].fileCount || 0) - (tree.folders[a].fileCount || 0) || (a < b ? -1 : 1)).slice(0, 4);
      R.fourFrames = await record(() => {
        state.expandedFolders = new Set();
        for (const leaf of leafs) {
          let p = leaf;
          while (p && tree.folders[p]) { state.expandedFolders.add(p); p = tree.folders[p].parent ?? p.replace(/[\\/][^\\/]*$/, ''); if (p === leaf) { break; } }
          for (const f of tree.files) { if (f.path.startsWith(leaf + '/') && !f.path.slice(leaf.length + 1).includes('/')) { state.expandedFolders.add(f.path); } }
        }
        applyFileClusters();
      });
      R.fourFrames.renderedNodes = state.currentNodes.length; R.fourFrames.dom = domCount();
      R.fourFrames.frames = state.frames ? state.frames.byPath.size : 0;
    }

    // 3) expand all
    R.expandAll = await record(() => applyDetailDepth(1));
    R.expandAll.renderedNodes = state.currentNodes.length; R.expandAll.dom = domCount();
    R.expandAll.frames = state.frames ? state.frames.byPath.size : 0;
    R.expandAll.links = state.currentLinks ? state.currentLinks.length : undefined;

    // 4) pan/zoom: 90 frames of programmatic zoom transforms, at two views:
    //    the working view the engine left us in, and fit-to-view (everything visible).
    async function panZoomAt(base) {
      // mixed = the original scenario (comparable with the baseline); pan and
      // zoom separately, because SVG re-rasterises on scale changes only.
      const motions = {
        mixed: (i) => d3.zoomIdentity.translate(base.x + 3 * i, base.y + 2 * i).scale(base.k * (1 + 0.4 * Math.sin(i / 14))),
        pan: (i) => d3.zoomIdentity.translate(base.x + 4 * i, base.y + 3 * i).scale(base.k),
        zoom: (i) => { const k = base.k * (1 + 0.4 * Math.sin(i / 14)); const W = svg.node().clientWidth / 2, H = svg.node().clientHeight / 2;
          return d3.zoomIdentity.translate(W - (W - base.x) * k / base.k, H - (H - base.y) * k / base.k).scale(k); },
      };
      const out = { k: r2(base.k) };
      for (const [name, at] of Object.entries(motions)) {
        const zt = [];
        B.rec = []; B.acc = 0;
        for (let i = 0; i < 90; i++) {
          await raf();
          const t0 = performance.now();
          svg.call(zoomBehavior.transform, at(i));
          zt.push(performance.now() - t0);
        }
        const rec = B.rec; B.rec = null;
        svg.call(zoomBehavior.transform, base);
        await paint();
        const iv = stats(rec.slice(2).map(f => f.dt));
        if (name === 'mixed') { out.handlerMs = stats(zt); out.frameIntervalMs = iv; out.fps = r2(1000 / iv.mean); }
        else { out[name + 'Fps'] = r2(1000 / iv.mean); }
        out[name + 'ScriptMs'] = stats(rec.map(f => f.script)).p50;
      }
      out.visibleFrames = document.querySelectorAll('#graph g.frame').length;   // culled frames are detached
      out.lod = ['f-labels', 'f-links'].filter(c => !document.querySelector(`#graph g.frame g.${c}`)).map(c => 'no-' + c.slice(2))
        .concat(document.querySelector('#graph g.frame circle.regular-node') ? [] : ['no-nodes']).join(' ') || 'full';
      out.domAttached = document.querySelectorAll('#graph *').length;
      return out;
    }
    R.panZoom = await panZoomAt(d3.zoomTransform(svg.node()));
    if (typeof fitToView === 'function') {
      const before = d3.zoomTransform(svg.node());
      fitToView();
      await sleep(900); // 500 ms transition
      R.panZoomFit = await panZoomAt(d3.zoomTransform(svg.node()));
      svg.call(zoomBehavior.transform, before);
      await paint();
    }

    // 4a) integrity: a re-render while layers are parked / frames culled must lose nothing
    if (R.engine === 'shelf' && typeof fitToView === 'function' && typeof applyFileClusters === 'function') {
      const before = d3.zoomTransform(svg.node());
      const count = () => ({ frames: state.frames.byPath.size,
        nodes: state.svgNodes.size(), labels: state.svgLabels.size(), links: state.svgLinks.size() });
      const expected = count();
      fitToView(); await sleep(900);
      const parkedAtFit = document.querySelectorAll('#graph g.frame circle.regular-node').length;
      applyFileClusters();                       // re-render in the fully parked state
      await paint();
      const afterRerender = count();
      const W = svg.node().clientWidth, H = svg.node().clientHeight;
      svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(1.2)); // zoom in: layers must come back
      await paint(); await paint();
      const attached = [...document.querySelectorAll('#graph g.frame')];
      R.lodIntegrity = {
        ok: JSON.stringify(expected) === JSON.stringify(afterRerender)
          && attached.length > 0 && attached.every(f => f.querySelector('g.f-labels') && f.querySelector('g.f-links') && f.querySelector('g.f-slots')),
        expected, afterRerender, circlesAttachedAtFit: parkedAtFit, framesAttachedZoomedIn: attached.length,
      };
      // annotate's hover card must open on the header of a frame that was just
      // re-attached by the zoom-in (delegated listener + d3 datum on the <g>).
      const tab = attached.map(f => f.querySelector('.frame-tab, .frame-tab-shape, .folder-bubble-titlebar')).find(Boolean);
      if (tab && document.querySelector('.hover-card')) {
        const bb = tab.getBoundingClientRect();
        const at = { bubbles: true, view: window, clientX: bb.x + 4, clientY: bb.y + 4 };
        tab.dispatchEvent(new MouseEvent('mouseover', at));
        tab.dispatchEvent(new MouseEvent('mousemove', at));
        await sleep(450);
        R.lodIntegrity.hoverCardOnReattachedFrame = !!document.querySelector('.hover-card.visible');
        tab.dispatchEvent(new MouseEvent('mouseout', at));
        await sleep(150);
      }
      // F3 class: no NaN geometry anywhere after the culling / LOD round trip
      R.lodIntegrity.nanAttrs = [...document.querySelectorAll('#graph line, #graph circle')]
        .filter(el => ['x1', 'y1', 'x2', 'y2', 'cx', 'cy'].some(a => el.getAttribute(a) === 'NaN')).length;
      svg.call(zoomBehavior.transform, before);
      await paint();
    }

    // 4b) optional paint probe (?probe=lod): which SVG layers cost the frames?
    if (P.get('probe') === 'lod' || P.get('probe') === 'lodfit') {
      if (typeof setLayoutMode === 'function') { setLayoutMode('static'); await paint(); await sleep(400); }
      if (P.get('probe') === 'lodfit') { fitToView(); await sleep(900); }
      const fpsNow = async () => {
        const base = d3.zoomTransform(svg.node());
        B.rec = []; B.acc = 0;
        for (let i = 0; i < 60; i++) {
          await raf();
          const k = base.k * (1 + 0.4 * Math.sin(i / 14)); const W = svg.node().clientWidth / 2, H = svg.node().clientHeight / 2;
          svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(W - (W - base.x) * k / base.k, H - (H - base.y) * k / base.k).scale(k)); // zoom-only
        }
        const rec = B.rec; B.rec = null;
        svg.call(zoomBehavior.transform, base);
        return r2(1000 / stats(rec.slice(2).map(f => f.dt)).mean);
      };
      const parkedEls = [];
      const hide = (sel) => document.querySelectorAll(sel).forEach(el => { parkedEls.push([el, el.parentNode, el.nextSibling]); el.remove(); }); // detach, like the engine
      const layers = [['markers', null], ['bundles', 'line.cross-bundle'], ['slotLabels', 'g.f-slots text'], ['labels', 'g.f-labels, g.labels'], ['links', 'g.f-links'], ['nodes', 'g.f-nodes'], ['slots', 'g.f-slots'], ['frames', 'g.frame'], ['svg', '#graph svg > g']];
      R.lodProbe = { k: r2(d3.zoomTransform(svg.node()).k), bundles: document.querySelectorAll('line.cross-bundle').length, all: await fpsNow() };
      for (const [name, sel] of layers) {
        if (name === 'markers') { document.querySelectorAll('line.cross-bundle').forEach(el => el.removeAttribute('marker-end')); }
        else { hide(sel); }
        R.lodProbe['minus_' + name] = await fpsNow();
      }
      parkedEls.reverse().forEach(([el, parent, next]) => { try { parent.insertBefore(el, next && next.parentNode === parent ? next : null); } catch (e) { /* parent gone */ } });
    }

    // 4c) optional floor probe (?probe=floor): where does a pan/zoom frame go when
    //     (almost) nothing is painted? Separates SVG cost from page/compositor cost.
    if (P.get('probe') === 'floor') {
      if (typeof setLayoutMode === 'function') { setLayoutMode('static'); await paint(); await sleep(400); }
      const loop = async (fn) => {
        B.rec = []; B.acc = 0;
        for (let i = 0; i < 60; i++) { await raf(); fn(i); }
        const rec = B.rec; B.rec = null;
        return r2(1000 / stats(rec.slice(2).map(f => f.dt)).mean);
      };
      const rootG = document.querySelector('#graph svg > g');
      const svgEl = document.querySelector('#graph svg');
      const base = d3.zoomTransform(svg.node());
      const zoomStep = (i) => svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(base.x + 3 * i, base.y + 2 * i).scale(base.k));
      const probeEl = document.createElement('div');
      probeEl.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;';
      document.body.appendChild(probeEl);
      const F = {};
      F.idle = await loop(() => {});
      F.htmlMutation = await loop((i) => { probeEl.style.background = i % 2 ? '#111' : '#222'; });
      F.zoom = await loop(zoomStep);
      rootG.style.display = 'none';
      F.zoomRootHidden = await loop(zoomStep);
      rootG.style.display = '';
      svgEl.style.display = 'none';
      F.zoomSvgHidden = await loop(zoomStep);
      svgEl.style.display = '';
      // detach everything but the visible frames: is it the size of the DOM?
      const hiddenFrames = [...document.querySelectorAll('#graph g.frame')].filter(el => el.style.display === 'none');
      const parents = hiddenFrames.map(el => [el, el.parentNode, el.nextSibling]);
      hiddenFrames.forEach(el => el.remove());
      F.zoomCulledDetached = await loop(zoomStep);
      const scaleStep = (i) => { const k = base.k * (1 + 0.4 * Math.sin(i / 14)); const W = svg.node().clientWidth / 2, H = svg.node().clientHeight / 2;
        svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(W - (W - base.x) * k / base.k, H - (H - base.y) * k / base.k).scale(k)); };
      F.scaleCulledDetached = await loop(scaleStep);
      F.scaleCulledDetachedNoBundles = await (async () => { const b = [...document.querySelectorAll('line.cross-bundle')]; b.forEach(el => { el.style.display = 'none'; });
        const v = await loop(scaleStep); b.forEach(el => { el.style.display = ''; }); return v; })();
      parents.reverse().forEach(([el, parent, next]) => parent.insertBefore(el, next));
      F.scaleCulledHidden = await loop(scaleStep);
      svg.call(zoomBehavior.transform, base);
      probeEl.remove();
      F.dom = document.querySelectorAll('*').length;
      R.floorProbe = F;
    }

    // 5) hover: mouseover/mouseout on a function node
    {
      const el = document.querySelector('#graph circle.regular-node');
      if (el) {
        const over = [], out = [];
        for (let i = 0; i < 5; i++) {
          let t0 = performance.now();
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window }));
          over.push(performance.now() - t0);
          await paint();
          t0 = performance.now();
          el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, view: window }));
          out.push(performance.now() - t0);
          await paint();
        }
        R.hover = { overMs: stats(over), outMs: stats(out) };
      }
    }

    // 6) drag: synthetic d3-drag on a function node, 60 moves, one per frame
    {
      const el = document.querySelector('#graph circle.regular-node');
      if (el) {
        const bb = el.getBoundingClientRect();
        let x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
        const ev = (type, tgt) => tgt.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1 }));
        const handler = [], lat = [];
        B.rec = []; B.acc = 0;
        ev('mousedown', el);
        for (let i = 0; i < 60; i++) {
          await raf(); await sleep(0); // between frames, like real input
          x += 2; y += 1;
          const before = el.getAttribute('cx') + ',' + el.getAttribute('cy');
          const t0 = performance.now();
          ev('mousemove', window);
          handler.push(performance.now() - t0);
          let frames = 0;
          while (frames < 10 && (el.getAttribute('cx') + ',' + el.getAttribute('cy')) === before) { await raf(); frames++; }
          lat.push(frames);
        }
        ev('mouseup', window);
        const rec = B.rec; B.rec = null;
        R.drag = { handlerMs: stats(handler), framesToDomUpdate: stats(lat),
          scriptPerFrameMs: stats(rec.filter(f => f.script > 0.05).map(f => f.script)), frameIntervalMs: stats(rec.slice(2).map(f => f.dt)) };
      }
    }

    // 7) search keystroke (applyFilters path)
    {
      const inp = document.getElementById('search');
      if (inp) {
        const ks = [];
        for (const q of ['f', 'fn', 'fn_1', '']) {
          inp.value = q;
          const t0 = performance.now();
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          ks.push(performance.now() - t0);
          await paint(); await sleep(250); // debounce, if any
        }
        R.searchKeystrokeSyncMs = stats(ks);
      }
    }
    // 8) pan/zoom again with motion Static (no simulation running): the paint ceiling
    if (window.__benchInEditor && typeof setLayoutMode === 'function') {
      setLayoutMode('static');
      await paint(); await sleep(300);
      const base = d3.zoomTransform(svg.node());
      B.rec = []; B.acc = 0;
      for (let i = 0; i < 90; i++) {
        await raf();
        const k = base.k * (1 + 0.4 * Math.sin(i / 14));
        svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(base.x + 3 * i, base.y + 2 * i).scale(k));
      }
      const rec = B.rec; B.rec = null;
      svg.call(zoomBehavior.transform, base);
      const iv = stats(rec.slice(2).map(f => f.dt));
      R.panZoomStatic = { frameIntervalMs: iv, fps: r2(1000 / iv.mean) };
    }
    R.simBackend = (typeof simApi === 'function') ? simApi().kind : 'n/a';
    R.posted = B.posted.filter(t => t === 'webview-log').length;
    R.errors = B.errors;
  } catch (e) {
    R.fatal = String(e && e.stack || e);
    R.errors = B.errors;
  }
  window.__benchResult = R;
})();
