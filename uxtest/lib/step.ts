// Step recorder: caption → action → wait-still → keyframe → snapshot + metrics.
// One StepRecord per ux.step(); the whole run is written to run.json.
import * as fs from 'fs';
import * as path from 'path';
import type { Frame, Page } from '@playwright/test';
import { setCaption } from './overlay';
import { waitForStill, type StillOpts, type StillResult } from './still';
import { drainFps, type FpsWindow } from './fps';
import { collectSnapshot } from '../metrics/collect';
import { computeMetrics } from '../metrics/compute';
import type { LayoutMetrics, Snapshot } from '../metrics/types';
import { findingsFor, type Finding, type LayoutBirth } from '../metrics/score';
import { median } from '../metrics/compute';
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
  findings: Finding[];
}

export interface StepOpts { settle?: boolean; metrics?: boolean; stillTimeoutMs?: number; expectMotionMs?: number;
  /** The step drags nodes/folders by hand: overlaps after it are the user's doing, not a layout bug. */
  userMoved?: boolean }

/** How the layout of `cur` was born, given the previous snapshot and its birth (see LayoutBirth). */
export function layoutBirth(prev: Snapshot | null, prevBirth: LayoutBirth, cur: Snapshot, userMoved: boolean): LayoutBirth {
  if (userMoved) { return 'user-moved'; }
  if (!prev) { return 'grid'; }
  const repacked = prev.engine !== cur.engine || prev.viewMode !== cur.viewMode || prev.nodes.length !== cur.nodes.length
    || Math.abs(median(prev.nodes.map(n => n.r)) - median(cur.nodes.map(n => n.r))) > 0.01;
  if (repacked) { return 'grid'; }                                   // engine switch, Detail change, Node Size re-pack
  if (prev.motion === 'dynamic' && cur.motion === 'static') { return 'frozen'; } // explicit freeze
  if (cur.motion === 'dynamic') { return 'grid'; }                    // a later freeze decides
  return prevBirth;
}

export interface RecorderDeps {
  page: Page;
  outDir: string;
  still: StillOpts;
  caps: { maxLabels: number; maxCrossingEdges: number; maxOverlapNodes: number };
  errors: string[];             // live list filled by the lab's console/pageerror hooks
  keepSnapshots: boolean;
  t0?: number;                  // epoch ms when the video started (context creation)
  /** Where the CoGraph webview lives. Tier A: the page itself (default). Tier B: the webview
   *  iframe inside VS Code; null while no CoGraph panel is open (then only the keyframe is taken). */
  target?: () => Promise<Page | Frame | null>;
}

/** Thrown by a scenario to mark a step as skipped (e.g. a selector the ux session removed). */
export class SkipStep extends Error {}

/** Thrown by a scenario when the PRODUCT misbehaves: the step is recorded with this finding and the
 *  run goes on (observational policy); --strict turns high findings into failures. */
export class StepFinding extends Error {
  constructor(readonly finding: Finding) { super(finding.message); }
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'step';
}

export class StepRecorder {
  readonly steps: StepRecord[] = [];
  lastSnapshot: Snapshot | null = null;
  birth: LayoutBirth = 'grid';
  private readonly t0: number;
  private errCursor = 0;

  constructor(private readonly d: RecorderDeps) {
    this.t0 = d.t0 ?? Date.now();
    fs.mkdirSync(path.join(d.outDir, 'steps'), { recursive: true });
  }

  /** Run one captioned, measured step. A throwing action fails the step and rethrows. */
  async step(name: string, action: () => Promise<void>, opts: StepOpts = {}): Promise<StepRecord> {
    const index = this.steps.length + 1;
    const base = `${String(index).padStart(2, '0')}-${slug(name)}`;
    const rec: StepRecord = { index, name, status: 'ok', videoAtMs: Date.now() - this.t0, durationMs: 0,
      still: null, fps: null, metrics: null, screenshot: null, snapshot: null, consoleErrors: [], findings: [] };
    this.steps.push(rec);
    const started = Date.now();
    let failure: unknown = null;
    let reported: Finding | null = null;
    try {
      await setCaption(this.d.page, `${index}. ${name}`);
      const pre = this.d.target ? await this.d.target() : this.d.page;
      if (pre) { await drainFps(pre); } // frames before the action belong to the previous step
      await action();
    } catch (err) {
      if (err instanceof SkipStep) { rec.status = 'skipped'; rec.note = err.message; }
      else if (err instanceof StepFinding) { reported = err.finding; rec.note = err.message; }
      else { rec.status = 'failed'; rec.note = String((err as Error).message ?? err); failure = err; }
    }
    try { await this.measure(rec, base, opts); }
    catch (err) { log.warn('step-measure-failed', { step: name, error: String(err) }); rec.note = `${rec.note ?? ''} measure: ${String(err)}`.trim(); }
    rec.durationMs = Date.now() - started;
    rec.consoleErrors = this.d.errors.slice(this.errCursor);
    this.errCursor = this.d.errors.length;
    if (rec.metrics && this.lastSnapshot) {
      rec.findings = findingsFor(rec.metrics, { engine: this.lastSnapshot.engine, motion: this.lastSnapshot.motion, birth: this.birth,
        settled: rec.still ? rec.still.settled : null, consoleErrors: rec.consoleErrors.length, longFrames: rec.fps?.longFrames ?? 0 });
    }
    if (reported) { rec.findings.push(reported); }
    log.info('step', { index, name, status: rec.status, ms: rec.durationMs, settled: rec.still?.settled, findings: rec.findings.map(f => f.rule), note: rec.note });
    if (failure) { throw failure; }
    return rec;
  }

  private async measure(rec: StepRecord, base: string, opts: StepOpts): Promise<void> {
    const { page, outDir } = this.d;
    if (page.isClosed()) { return; }
    const target = this.d.target ? await this.d.target() : page;
    if (target && opts.settle !== false && rec.status !== 'skipped') {
      rec.still = await waitForStill(target, { ...this.d.still, timeoutMs: opts.stillTimeoutMs ?? this.d.still.timeoutMs, expectMotionMs: opts.expectMotionMs });
    }
    if (target) { rec.fps = await drainFps(target); }
    rec.screenshot = path.join('steps', `${base}.png`);
    await page.screenshot({ path: path.join(outDir, rec.screenshot), timeout: 45000 }); // a settling 30k-node page answers slowly
    if (opts.metrics === false || !target) { return; }
    const snap = await collectSnapshot(target, { maxLabels: this.d.caps.maxLabels });
    this.birth = layoutBirth(this.lastSnapshot, this.birth, snap, opts.userMoved === true);
    this.lastSnapshot = snap;
    rec.metrics = computeMetrics(snap, this.d.caps);
    if (this.d.keepSnapshots) {
      rec.snapshot = path.join('steps', `${base}.snapshot.json`);
      fs.writeFileSync(path.join(outDir, rec.snapshot), JSON.stringify(snap));
    }
  }
}
