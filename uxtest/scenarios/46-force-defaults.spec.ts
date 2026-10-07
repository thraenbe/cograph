// 46 — D1-D3 (round 3): the Global force box ships the sweep-derived defaults (center 0.08, repel 450, file
// cluster 0.36, repel range 850), the sliders the sweep found inert are gone (Folder Repel, File Repel, Link
// distance; Slot pad in Shelf), and "Reset Layout" restores exactly the new defaults.
import { scenario } from '../lib/scenario';
import { clickSel, setSlider } from '../lib/actions';
import { StepFinding } from '../lib/step';

const EXPECT: Record<string, number> = { 'slider-center-force': 0.08, 'slider-repel-force': 450, 'slider-link-force': 1, 'slider-file-cluster': 0.36, 'slider-velocity-decay': 0.3, 'slider-collide-pad': 1.5, 'slider-repel-range': 850 };
const REMOVED = ['#slider-folder-repel', '#slider-file-repel', '#slider-link-distance', '#slider-slot-pad'];
const SETTINGS: Record<string, number> = { centerForce: 0.08, repelForce: 450, linkForce: 1, fileClusterForce: 0.36, velocityDecay: 0.3, collidePad: 1.5, repelRange: 850 };

scenario('force-defaults', { only: { engine: 'global', motion: 'dynamic' } }, async ({ page, ux }) => {
  const read = (): Promise<{ sliders: Record<string, number | null>; settings: Record<string, unknown>; removed: string[] }> => page.evaluate(`(() => ({
    sliders: Object.fromEntries(${JSON.stringify(Object.keys(EXPECT))}.map(id => { const el = document.getElementById(id); return [id, el ? Number(el.value) : null]; })),
    settings: typeof settings === 'object' ? Object.fromEntries(${JSON.stringify(Object.keys(SETTINGS))}.map(k => [k, settings[k]])) : {},
    removed: ${JSON.stringify(REMOVED)}.filter(css => document.querySelector(css)),
  }))()`) as Promise<{ sliders: Record<string, number | null>; settings: Record<string, unknown>; removed: string[] }>;
  const diff = (r: { sliders: Record<string, number | null>; settings: Record<string, unknown> }): string[] => [
    ...Object.entries(EXPECT).filter(([id, v]) => r.sliders[id] === null || Math.abs((r.sliders[id] as number) - v) > 1e-6).map(([id, v]) => `${id}=${r.sliders[id]} (want ${v})`),
    ...Object.entries(SETTINGS).filter(([k, v]) => typeof r.settings[k] !== 'number' || Math.abs((r.settings[k] as number) - v) > 1e-6).map(([k, v]) => `settings.${k}=${String(r.settings[k])} (want ${v})`),
  ];

  await ux.step('Removed sliders are absent; shipped defaults on load', async () => {
    const r = await read();
    const bad = diff(r);
    ux.steps[ux.steps.length - 1].note = `sliders ${JSON.stringify(r.sliders)}; settings ${JSON.stringify(r.settings)}; removed still present: ${r.removed.join(', ') || 'none'}`;
    if (r.removed.length) { throw new StepFinding({ rule: 'removed-slider-present', severity: 'medium', ref: 'D1-D3', message: `still in the DOM: ${r.removed.join(', ')}` }); }
    if (bad.length) { throw new StepFinding({ rule: 'force-default-mismatch', severity: 'high', ref: 'D1-D3', message: bad.join('; ') }); }
  }, { metrics: false, settle: false });

  await ux.step('Move repel → 800 and center → 0.3', async () => {
    await setSlider(page, 'forceRepel', 800);
    await setSlider(page, 'forceCenter', 0.3);
    const r = await read();
    if (r.sliders['slider-repel-force'] !== 800 || Math.abs((r.settings.centerForce as number) - 0.3) > 1e-6) { throw new StepFinding({ rule: 'force-slider-dead', severity: 'high', ref: 'D1-D3', message: `after moving: repel slider ${r.sliders['slider-repel-force']}, settings.centerForce ${String(r.settings.centerForce)}` }); }
  }, { expectMotionMs: 8000, stillTimeoutMs: 30000 });

  await ux.step('Reset Layout → the new defaults again', async () => {
    await clickSel(page, 'resetLayout');
    await page.waitForTimeout(600);
    const r = await read();
    const bad = diff(r);
    ux.steps[ux.steps.length - 1].note = `after reset: sliders ${JSON.stringify(r.sliders)}`;
    if (bad.length) { throw new StepFinding({ rule: 'reset-not-defaults', severity: 'high', ref: 'D1-D3', message: bad.join('; ') }); }
  }, { stillTimeoutMs: 30000 });
});
