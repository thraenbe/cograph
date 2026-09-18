// rAF-delta frame trace (P4 / P5). Runs for the whole page lifetime; each step
// drains the frames recorded since the previous drain. Headless numbers are
// only comparable relative to each other on the same machine — use --headed
// for GPU-backed figures.
import type { Page } from '@playwright/test';

export interface FpsWindow { frames: number; avgMs: number; p95Ms: number; maxMs: number; longFrames: number; minFps: number }

/** Runs in the page (addInitScript). Self-contained. */
function installFpsTrace(): void {
  const w = window as unknown as Record<string, unknown>;
  const deltas: number[] = [];
  let last = 0;
  const loop = (t: number): void => {
    if (last) { deltas.push(t - last); if (deltas.length > 20000) { deltas.splice(0, 10000); } }
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  w.__uxDrainFrames = (): number[] => deltas.splice(0, deltas.length);
}

export function summarizeFrames(deltas: number[]): FpsWindow {
  if (!deltas.length) { return { frames: 0, avgMs: 0, p95Ms: 0, maxMs: 0, longFrames: 0, minFps: 0 }; }
  const sorted = [...deltas].sort((a, b) => a - b);
  const avg = deltas.reduce((s, v) => s + v, 0) / deltas.length;
  const max = sorted[sorted.length - 1];
  return {
    frames: deltas.length,
    avgMs: +avg.toFixed(2),
    p95Ms: +sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))].toFixed(2),
    maxMs: +max.toFixed(2),
    longFrames: deltas.filter(d => d > 50).length,
    minFps: max > 0 ? +(1000 / max).toFixed(1) : 0,
  };
}

export async function attachFpsTrace(page: Page): Promise<void> {
  await page.addInitScript(installFpsTrace);
}

export async function drainFps(page: Page): Promise<FpsWindow> {
  const deltas = await page.evaluate(() => {
    const fn = (window as unknown as Record<string, unknown>).__uxDrainFrames as (() => number[]) | undefined;
    return fn ? fn() : [];
  });
  return summarizeFrames(deltas);
}
