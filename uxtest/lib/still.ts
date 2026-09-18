// Engine-agnostic settle detector: the layout is "still" once no rendered node
// moved more than epsilon for N consecutive animation frames. Deliberately
// blind to simulation internals (alpha, schedulers, workers) so it survives the
// perf session's refactors; it only watches node data the renderer paints from.
import type { Page } from '@playwright/test';

export interface StillOpts { epsilonPx: number; quietFrames: number; timeoutMs: number }
export interface StillResult { settled: boolean; ms: number; frames: number; movingFrames: number; peakPx: number }

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const state: any;

/** Runs in the page. Self-contained. */
function waitStillInPage(o: StillOpts): Promise<StillResult> {
  return new Promise((resolve) => {
    const st: any = typeof state !== 'undefined' ? state : null;
    const t0 = performance.now();
    let prev = new Map<unknown, [number, number]>();
    let quiet = 0, frames = 0, movingFrames = 0, peakPx = 0, primed = false;
    const sample = (): number => {
      const nodes: any[] = (st && st.currentNodes) || [];
      const next = new Map<unknown, [number, number]>();
      let max = 0;
      for (const n of nodes) {
        if (typeof n.x !== 'number' || typeof n.y !== 'number') { continue; }
        next.set(n.id, [n.x, n.y]);
        const p = prev.get(n.id);
        if (p) { const d = Math.max(Math.abs(n.x - p[0]), Math.abs(n.y - p[1])); if (d > max) { max = d; } }
      }
      // Zoom / pan transitions move every pixel without touching node data.
      const svgEl = document.querySelector('#graph svg');
      const d3g: any = (globalThis as any).d3;
      if (svgEl && d3g && d3g.zoomTransform) {
        const z = d3g.zoomTransform(svgEl);
        next.set('\u0000zoom', [z.x, z.y]); next.set('\u0000zoomk', [z.k * 1000, 0]);
        for (const key of ['\u0000zoom', '\u0000zoomk']) {
          const p = prev.get(key), c = next.get(key) as [number, number];
          if (p) { const d = Math.max(Math.abs(c[0] - p[0]), Math.abs(c[1] - p[1])); if (d > max) { max = d; } }
        }
      }
      // A node set change (expand / patch) counts as movement.
      if (primed && next.size !== prev.size) { max = Math.max(max, o.epsilonPx * 2); }
      prev = next; primed = true;
      return max;
    };
    const tick = (): void => {
      const moved = sample();
      frames++;
      if (moved > peakPx) { peakPx = moved; }
      if (moved > o.epsilonPx) { quiet = 0; movingFrames++; } else { quiet++; }
      const ms = performance.now() - t0;
      if (quiet >= o.quietFrames) { return resolve({ settled: true, ms: Math.round(ms), frames, movingFrames, peakPx: +peakPx.toFixed(2) }); }
      if (ms >= o.timeoutMs) { return resolve({ settled: false, ms: Math.round(ms), frames, movingFrames, peakPx: +peakPx.toFixed(2) }); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function waitForStill(page: Page, opts: StillOpts): Promise<StillResult> {
  return page.evaluate(waitStillInPage, opts);
}
