// 88-stage-api — window.stageApi (docs/tour-protocol.md section 5) on the real
// webview in Chromium: ready after the first layout, a camera fit that lands the
// node in the middle of the region the tour's overlays leave free, spotlight
// opacity as rendered, ghosts, overlay edges, a pulse, expand, chrome, resolve.
import { test, expect } from '@playwright/test';
import { openLab } from '../lib/lab';

for (const engine of ['shelf', 'global'] as const) {
  test(`stageApi · ${engine}`, async ({ browser }) => {
    const lab = await openLab({ repo: 'synthetic-1k', engine, motion: 'static', scenario: 'stage-api', browser, video: false });
    const { page } = lab;
    try {
      const facts = await page.evaluate(async () => {
        const w = window as any;
        const api = w.stageApi;
        const st = (0, eval)('state'); // a script-scope const of state.js, not a window property
        await Promise.race([api.ready(), new Promise((_, rej) => setTimeout(() => rej(new Error('ready timed out')), 20_000))]);
        const fns = api.nodes().filter((n: any) => n.kind === 'function' && n.file);
        const target = fns[Math.floor(fns.length / 2)] ?? api.nodes()[0];
        const el = () => [...document.querySelectorAll('circle.regular-node, path.cloud-node')].find((e: any) => e.__data__ && e.__data__.id === target.id) as Element | undefined;

        await api.fit([target.id], { ms: 0, padding: 80, inset: { left: 180, right: 300, top: 44, bottom: 40 } });
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const r = el()!.getBoundingClientRect();
        const centre = { x: r.x + r.width / 2, y: r.y + r.height / 2 };

        api.spotlight([target.id]);
        const lit = el()!.classList.contains('stage-lit');
        const other = [...document.querySelectorAll('circle.regular-node, path.cloud-node')].find((e: any) => e.__data__ && e.__data__.id !== target.id);
        const dimmed = other ? getComputedStyle(other).opacity : null;
        const litOpacity = getComputedStyle(el()!).opacity;

        const root = st.structureTree.root;
        const rel = target.file.startsWith(root) ? target.file.slice(root.length + 1).split('\\').join('/') : target.file;
        const resolved = api.resolve({ file: rel, name: target.name, line: target.line });

        api.ghost([{ id: 'ghost-1', file: rel, name: 'removedFn', line: 1, callers: [target.id] }]);
        const second = fns.find((n: any) => n.id !== target.id);
        api.edges(second ? [{ source: target.id, target: second.id, kind: 'added' }] : []);
        api.pulse(target.id);
        const overlay = {
          ghosts: document.querySelectorAll('.stage-overlay g.stage-ghost').length,
          edges: document.querySelectorAll('.stage-overlay line.stage-edge.added').length,
          callerLines: document.querySelectorAll('.stage-overlay line.stage-edge.removed').length,
          pulse: document.querySelectorAll('.stage-overlay circle.stage-pulse').length,
        };

        const closed = Object.keys(st.structureTree.folders).find((p) => !st.expandedFolders.has(p));
        if (closed) { await api.expand([closed]); }
        const expanded = closed ? st.expandedFolders.has(closed) : true;

        api.chrome(false);
        const toolbarHidden = getComputedStyle(document.getElementById('top-left-controls')!).display === 'none';
        api.chrome(true);
        const toolbarBack = getComputedStyle(document.getElementById('top-left-controls')!).display !== 'none';
        api.spotlight(null);
        return {
          version: api.version, nodes: api.nodes().length, id: target.id, resolved, centre, lit, litOpacity, dimmed, overlay,
          expanded, toolbarHidden, toolbarBack, spotCleared: !document.querySelector('.stage-spot'), theme: api.theme(),
          viewport: { w: innerWidth, h: innerHeight },
        };
      });
      console.log(JSON.stringify(facts));
      expect(facts.version).toBe(1);
      expect(facts.nodes).toBeGreaterThan(0);
      expect(facts.resolved).toBe(facts.id);
      // Centre of the free region: left 180 + (w - 480) / 2, top 44 + (h - 84) / 2.
      expect(Math.abs(facts.centre.x - (180 + (facts.viewport.w - 480) / 2))).toBeLessThan(6);
      expect(Math.abs(facts.centre.y - (44 + (facts.viewport.h - 84) / 2))).toBeLessThan(6);
      expect(facts.lit).toBe(true);
      expect(facts.litOpacity).toBe('1');
      expect(facts.dimmed).toBe('0.25');
      expect(facts.overlay).toEqual({ ghosts: 1, edges: 1, callerLines: 1, pulse: 1 });
      expect(facts.expanded).toBe(true);
      expect([facts.toolbarHidden, facts.toolbarBack, facts.spotCleared]).toEqual([true, true, true]);
      expect(['dark', 'light']).toContain(facts.theme);
    } finally {
      const run = await lab.close();
      expect(run.consoleErrors).toEqual([]);
    }
  });
}
