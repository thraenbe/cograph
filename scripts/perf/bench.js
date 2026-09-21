// Perf bench scenarios — runs inside the page built by build-page.cjs.
// Results land on window.__benchResult (read by run.mjs over CDP).
// Scenarios: load · 4 open frames · expand all · pan/zoom · hover · drag · search.
(async function () {
  const P = new URLSearchParams(location.search);
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

    // 1) load: structure + graph messages → paint (+ settle when dynamic)
    R.load = await record(() => {
      post({ type: 'structure', tree: FX.structure, autoEngage: true });
      post({ type: 'graph', data: FX.graph, gitAvailable: false, fileGitStatus: {}, isReanalysis: false });
    });
    R.load.renderedNodes = state.currentNodes.length; R.load.dom = domCount();

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

    // 4) pan/zoom: 90 frames of programmatic zoom transforms
    {
      const zt = [];
      B.rec = []; B.acc = 0;
      const base = d3.zoomTransform(svg.node());
      for (let i = 0; i < 90; i++) {
        await raf();
        const t0 = performance.now();
        const k = base.k * (1 + 0.4 * Math.sin(i / 14));
        svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(base.x + 3 * i, base.y + 2 * i).scale(k));
        zt.push(performance.now() - t0);
      }
      const rec = B.rec; B.rec = null;
      svg.call(zoomBehavior.transform, base);
      R.panZoom = { handlerMs: stats(zt), frameIntervalMs: stats(rec.slice(2).map(f => f.dt)) };
      R.panZoom.fps = r2(1000 / R.panZoom.frameIntervalMs.mean);
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
    R.simBackend = (typeof simApi === 'function') ? simApi().kind : 'n/a';
    R.posted = B.posted.filter(t => t === 'webview-log').length;
    R.errors = B.errors;
  } catch (e) {
    R.fatal = String(e && e.stack || e);
    R.errors = B.errors;
  }
  window.__benchResult = R;
})();
