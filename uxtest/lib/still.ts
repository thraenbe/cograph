// Engine-agnostic settle detector: the layout is "still" once no rendered node
// drifted more than epsilon across a whole window of N animation frames. Deliberately
// blind to simulation internals (alpha, schedulers, workers) so it survives the
// perf session's refactors; it only watches node data the renderer paints from.
import type { Frame, Page } from '@playwright/test';

export interface StillOpts {
  epsilonPx: number; quietFrames: number; timeoutMs: number;
  /** The action is expected to move the layout: do not accept stillness until motion was seen
   *  (or this many ms passed). Reheats can take seconds to reach a visible frame. */
  expectMotionMs?: number;
}
export interface StillResult { settled: boolean; ms: number; frames: number; movingFrames: number; peakPx: number;
  /** ms from the start of the wait to the first observed movement; null when nothing moved. */
  firstMoveMs: number | null }

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const state: any;

/** Runs in the page. Self-contained.
 *  "Still" = over a whole window of `quietFrames` frames nothing drifted more than `epsilonPx`
 *  from where it was when the window opened. Measuring against the window start (not the
 *  previous frame) is what catches slow settling: 0.3 px/frame looks still frame-to-frame
 *  but is 9 px over half a second. */
function waitStillInPage(o: StillOpts): Promise<StillResult> {
  return new Promise((resolve) => {
    const st: any = typeof state !== 'undefined' ? state : null;
    const t0 = performance.now();
    let ref = new Map<unknown, [number, number]>();
    let quiet = 0, frames = 0, movingFrames = 0, peakPx = 0, lastMoveMs = 0, firstMoveMs: number | null = null;
    const read = (): Map<unknown, [number, number]> => {
      const cur = new Map<unknown, [number, number]>();
      const nodes: any[] = (st && st.currentNodes) || [];
      for (const n of nodes) { if (typeof n.x === 'number' && typeof n.y === 'number') { cur.set(n.id, [n.x, n.y]); } }
      // Zoom / pan transitions move every pixel without touching node data.
      const svgEl = document.querySelector('#graph svg');
      const d3g: any = (globalThis as any).d3;
      if (svgEl && d3g && d3g.zoomTransform) {
        const z = d3g.zoomTransform(svgEl);
        cur.set('\u0000zoom', [z.x, z.y]); cur.set('\u0000zoomk', [z.k * 1000, 0]);
      }
      return cur;
    };
    const drift = (cur: Map<unknown, [number, number]>): number => {
      if (cur.size !== ref.size) { return Infinity; } // node set changed (expand / patch)
      let max = 0;
      for (const [id, c] of cur) {
        const r = ref.get(id);
        if (!r) { return Infinity; }
        const d = Math.max(Math.abs(c[0] - r[0]), Math.abs(c[1] - r[1]));
        if (d > max) { max = d; }
      }
      return max;
    };
    const done = (settled: boolean): void => resolve({ settled, ms: Math.round(settled ? lastMoveMs : performance.now() - t0), frames, movingFrames,
      peakPx: Number.isFinite(peakPx) ? +peakPx.toFixed(2) : -1, firstMoveMs: firstMoveMs === null ? null : Math.round(firstMoveMs) });
    const tick = (): void => {
      const cur = read();
      const d = frames === 0 ? Infinity : drift(cur);
      frames++;
      if (d > o.epsilonPx) {
        if (frames > 1) { movingFrames++; lastMoveMs = performance.now() - t0; if (firstMoveMs === null) { firstMoveMs = lastMoveMs; } if (Number.isFinite(d) && d > peakPx) { peakPx = d; } }
        ref = cur; quiet = 0; // open a new window here
      } else { quiet++; }
      const mayFinish = !o.expectMotionMs || movingFrames > 0 || performance.now() - t0 >= o.expectMotionMs;
      if (quiet >= o.quietFrames && mayFinish) { return done(true); }
      if (performance.now() - t0 >= o.timeoutMs) { return done(false); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function waitForStill(page: Page | Frame, opts: StillOpts): Promise<StillResult> {
  return page.evaluate(waitStillInPage, opts);
}
