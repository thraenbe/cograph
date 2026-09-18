// Step recorder: caption → action → wait-still → keyframe → snapshot + metrics.
// One StepRecord per ux.step(); the whole run is written to run.json.
import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { setCaption } from './overlay';
import { waitForStill, type StillOpts, type StillResult } from './still';
import { drainFps, type FpsWindow } from './fps';
import { collectSnapshot } from '../metrics/collect';
import { computeMetrics } from '../metrics/compute';
import type { LayoutMetrics, Snapshot } from '../metrics/types';
import { log } from './log';

export interface StepRecord {
  index: number;
  name: string;
  status: 'ok' | 'skipped' | 'failed';
  note?: string;
  videoAtMs: number;            // offset into the video where the step starts
  durationMs: number;
  still: StillResult | null;
  fps: FpsWindow | null;
  metrics: LayoutMetrics | null;
  screenshot: string | null;    // relative to the run dir
  snapshot: string | null;
  consoleErrors: string[];
}

export interface StepOpts { settle?: boolean; metrics?: boolean; stillTimeoutMs?: number }

export interface RecorderDeps {
  page: Page;
  outDir: string;
  still: StillOpts;
  caps: { maxLabels: number; maxCrossingEdges: number; maxOverlapNodes: number };
  errors: string[];             // live list filled by the lab's console/pageerror hooks
  keepSnapshots: boolean;
}

/** Thrown by a scenario to mark a step as skipped (e.g. a selector the ux session removed). */
export class SkipStep extends Error {}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'step';
}

export class StepRecorder {
  readonly steps: StepRecord[] = [];
  lastSnapshot: Snapshot | null = null;
  private readonly t0 = Date.now();
  private errCursor = 0;

  constructor(private readonly d: RecorderDeps) {
    fs.mkdirSync(path.join(d.outDir, 'steps'), { recursive: true });
  }

  /** Run one captioned, measured step. A throwing action fails the step and rethrows. */
  async step(name: string, action: () => Promise<void>, opts: StepOpts = {}): Promise<StepRecord> {
    const index = this.steps.length + 1;
    const base = `${String(index).padStart(2, '0')}-${slug(name)}`;
    const rec: StepRecord = { index, name, status: 'ok', videoAtMs: Date.now() - this.t0, durationMs: 0,
      still: null, fps: null, metrics: null, screenshot: null, snapshot: null, consoleErrors: [] };
    this.steps.push(rec);
    const started = Date.now();
    let failure: unknown = null;
    try {
      await setCaption(this.d.page, `${index}. ${name}`);
      await drainFps(this.d.page); // frames before the action belong to the previous step
      await action();
    } catch (err) {
      if (err instanceof SkipStep) { rec.status = 'skipped'; rec.note = err.message; }
      else { rec.status = 'failed'; rec.note = String((err as Error).message ?? err); failure = err; }
    }
    try { await this.measure(rec, base, opts); }
    catch (err) { log.warn('step-measure-failed', { step: name, error: String(err) }); rec.note = `${rec.note ?? ''} measure: ${String(err)}`.trim(); }
    rec.durationMs = Date.now() - started;
    rec.consoleErrors = this.d.errors.slice(this.errCursor);
    this.errCursor = this.d.errors.length;
    log.info('step', { index, name, status: rec.status, ms: rec.durationMs, settled: rec.still?.settled, note: rec.note });
    if (failure) { throw failure; }
    return rec;
  }

  private async measure(rec: StepRecord, base: string, opts: StepOpts): Promise<void> {
    const { page, outDir } = this.d;
    if (page.isClosed()) { return; }
    if (opts.settle !== false && rec.status !== 'skipped') {
      rec.still = await waitForStill(page, { ...this.d.still, timeoutMs: opts.stillTimeoutMs ?? this.d.still.timeoutMs });
    }
    rec.fps = await drainFps(page);
    rec.screenshot = path.join('steps', `${base}.png`);
    await page.screenshot({ path: path.join(outDir, rec.screenshot) });
    if (opts.metrics === false) { return; }
    const snap = await collectSnapshot(page, { maxLabels: this.d.caps.maxLabels });
    this.lastSnapshot = snap;
    rec.metrics = computeMetrics(snap, this.d.caps);
    if (this.d.keepSnapshots) {
      rec.snapshot = path.join('steps', `${base}.snapshot.json`);
      fs.writeFileSync(path.join(outDir, rec.snapshot), JSON.stringify(snap));
    }
  }
}
