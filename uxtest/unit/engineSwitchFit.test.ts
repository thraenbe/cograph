// An engine switch re-lays out, so the view must follow the new layout. Before the fix, Shelf → Global → Shelf
// kept Global's zoom transform (only a >30 % overflow re-fitted): synthetic-1k ended with 26 % of its nodes off
// screen, zod with all of them (Tier B smoke step 6: 22 % on click in a portrait window).
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openLab } from '../lib/lab';
import { fitToView, switchEngine } from '../lib/actions';

/** Runs in the page: share of positioned nodes outside the svg under the current zoom transform. */
function offscreenShare(): number {
  const st = (0, eval)('state') as { currentNodes: { x?: number; y?: number }[] };
  const svg = document.querySelector('#graph svg') as SVGSVGElement;
  const t = (globalThis as unknown as { d3: { zoomTransform(el: Element): { applyX(x: number): number; applyY(y: number): number } } }).d3.zoomTransform(svg);
  const nodes = st.currentNodes.filter(n => n.x != null && Number.isFinite(n.x));
  const off = nodes.filter(n => { const x = t.applyX(n.x as number), y = t.applyY(n.y as number); return x < 0 || y < 0 || x > svg.clientWidth || y > svg.clientHeight; });
  return nodes.length ? off.length / nodes.length : 0;
}

for (const size of [{ width: 1280, height: 800 }, { width: 762, height: 1800 }]) {
  test(`Shelf → Global → Shelf ends with every node on screen (${size.width}x${size.height})`, async ({ browser }) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uxtest-engine-fit-'));
    const lab = await openLab({ repo: 'synthetic-1k', engine: 'shelf', motion: 'static', scenario: 'engine-switch-fit', browser, outDir, video: false });
    try {
      await lab.page.setViewportSize(size);
      await fitToView(lab.page);
      // Poll, not a fixed wait: beside a CPU-heavy neighbour (the real-analyzer test) the 500 ms fit
      // transition can outlast 800 ms. Without the fix the share stays at ~26 %, so the poll still fails.
      await expect.poll(() => lab.page.evaluate(offscreenShare), { message: 'fitted Shelf to start with', timeout: 8000 }).toBe(0);
      await switchEngine(lab.page, 'global');
      await lab.page.waitForTimeout(1400);
      await switchEngine(lab.page, 'shelf');
      await lab.page.waitForTimeout(1400); // fit transition is 500 ms
      expect(await lab.page.evaluate('state.layoutEngine')).toBe('shelf');
      await expect.poll(() => lab.page.evaluate(offscreenShare), { message: 'share of nodes off screen after the switch back', timeout: 8000 }).toBe(0);
    } finally {
      await lab.close();
    }
  });
}
