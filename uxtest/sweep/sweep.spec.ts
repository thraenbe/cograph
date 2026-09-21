// Force sweep driver: one test per repo × engine × sample. Forces are set
// through the REAL sliders (input events) in Dynamic motion, from a fresh page,
// so every sample starts from the same deterministic state.
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { openLab } from '../lib/lab';
import { loadConfig, selectedRepos } from '../lib/corpus';
import { engines } from '../lib/matrix';
import { fitToView, setSlider } from '../lib/actions';
import { SkipStep } from '../lib/step';
import { layoutScore, QUALITY_WEIGHTS } from '../metrics/score';
import { buildSamples, toSliderValue } from './sampler';
import type { SweepSample } from './analyze';
import { SEL, type SelName } from '../selectors';
import { REPO_ROOT } from '../harness/vscodeStub';

interface Space {
  seed: number; samples: number; mode: 'lhs' | 'grid'; repos: string[]; detail: number; settleTimeoutMs: number; motionGraceMs: number;
  engines: Record<string, { params: SelName[]; ranges?: Record<string, [number, number]> }>;
}
const spaceFile = process.env.UXTEST_SWEEP_SPACE ?? path.join(REPO_ROOT, 'uxtest', 'sweep', 'spaces', 'default.json');
const space = JSON.parse(fs.readFileSync(spaceFile, 'utf8')) as Space;
const nSamples = process.env.UXTEST_SWEEP_SAMPLES ? Number(process.env.UXTEST_SWEEP_SAMPLES) : space.samples;
const repos = process.env.UXTEST_REPOS ? selectedRepos(loadConfig()) : space.repos;

for (const repo of repos) {
  for (const engine of engines()) {
    const def = space.engines[engine];
    if (!def) { continue; }
    for (const sample of buildSamples(def.params, nSamples, space.seed, space.mode)) {
      test(`sweep · ${repo} · ${engine} · #${sample.index}`, async ({ browser }) => {
        const lab = await openLab({ repo, engine, motion: 'dynamic', scenario: `sweep-${String(sample.index).padStart(2, '0')}`,
          browser, video: process.env.UXTEST_SWEEP_VIDEO === '1', keepSnapshots: false });
        const { page, ux } = lab;
        const values: Record<string, number> = {}, dropped: string[] = [];
        try {
          // Fit first: the shelf scheduler only ticks frames that are on screen. The Detail slider is only
          // touched when it is not already at the target: on shelf-base a Detail re-render disconnects the
          // frame sims from the rendered nodes (F13), after which no force moves anything.
          await ux.step('Full detail, fitted', async () => {
            const cur = Number(await page.locator(SEL.detailSlider.css).inputValue());
            if (Math.abs(cur - space.detail) > 0.005) { await setSlider(page, 'detailSlider', space.detail); }
            await fitToView(page);
          }, { stillTimeoutMs: space.settleTimeoutMs, metrics: false });
          const apply = await ux.step(sample.unit ? `Apply forces (sample ${sample.index})` : 'Defaults (baseline)', async () => {
            for (const name of def.params) {
              const loc = page.locator(SEL[name].css).first();
              if (await loc.count() === 0) { dropped.push(name); continue; }
              const [min, max, step, cur] = await loc.evaluate((el) => { const i = el as HTMLInputElement; return [Number(i.min), Number(i.max), Number(i.step) || 0, Number(i.value)]; });
              if (!sample.unit) {
                // Baseline: re-apply the current value so the defaults go through the same reheat as every sample.
                values[name] = cur;
                try { await setSlider(page, name, cur); } catch (err) { if (!(err instanceof SkipStep)) { throw err; } }
                continue;
              }
              const v = toSliderValue(sample.unit[name], min, max, step, def.ranges?.[name]);
              try { await setSlider(page, name, v); values[name] = v; }
              catch (err) { if (err instanceof SkipStep) { dropped.push(name); } else { throw err; } }
            }
          }, { stillTimeoutMs: space.settleTimeoutMs, expectMotionMs: space.motionGraceMs });
          const end = await ux.step('End state (fitted)', async () => { await fitToView(page); });
          expect(end.metrics, 'end-state metrics').toBeTruthy();
          const metrics = end.metrics!;
          const settleMs = apply.still ? apply.still.ms : null;
          const record: SweepSample = { repo, engine, index: sample.index, baseline: sample.unit === null, values, dropped,
            settleMs, settled: apply.still?.settled ?? false, metrics, score: layoutScore(metrics, 0, QUALITY_WEIGHTS),
            screenshot: path.relative(path.dirname(path.dirname(lab.outDir)), path.join(lab.outDir, end.screenshot ?? '')) };
          fs.writeFileSync(path.join(lab.outDir, 'sample.json'), JSON.stringify(record, null, 2));
        } finally { await lab.close(); }
      });
    }
  }
}
