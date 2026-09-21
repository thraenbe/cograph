// 45 — Force sliders must actually move the layout (Shelf + Dynamic), promptly, also after a Detail change.
// Regression scenario for F13 (sliders dead after a Detail re-render) and F7 (seconds of dead time before
// a reheat reaches a visible frame).
import { scenario } from '../lib/scenario';
import { fitToView, setSlider } from '../lib/actions';
import type { StepRecord } from '../lib/step';
import { maxDisplacement } from '../metrics/compute';
import type { Snapshot } from '../metrics/types';

const LATENCY_BUDGET_MS = 2000;

scenario('force-reheat', { only: { engine: 'shelf', motion: 'dynamic' }, largeOk: true }, async ({ page, ux }) => {
  const judge = (rec: StepRecord, before: Snapshot | null, what: string): void => {
    const after = ux.lastSnapshot;
    const d = before && after ? maxDisplacement(before, after) : { max: 0, moved: 0 };
    const first = rec.still?.firstMoveMs ?? null;
    rec.note = `${what}: ${d.moved} node(s) moved (max ${d.max} px), first motion after ${first ?? '–'} ms, still after ${rec.still?.ms ?? '–'} ms`;
    const total = after?.nodes.length ?? 0;
    // A handful of nodes twitching (one tiny frame) is still a dead slider: a force change must reach the layout.
    if (d.moved < Math.max(1, 0.05 * total)) { rec.findings.push({ rule: 'force-slider-dead', severity: 'high', ref: 'F13', message: `${what}: only ${d.moved} of ${total} nodes moved` }); }
    else if (first !== null && first > LATENCY_BUDGET_MS) { rec.findings.push({ rule: 'reheat-latency', severity: 'medium', ref: 'F7', message: `${what}: first motion only after ${first} ms` }); }
  };

  await ux.step('Fresh page, fitted, settled', async () => { await fitToView(page); }, { stillTimeoutMs: 30000 });
  let before = ux.lastSnapshot;
  judge(await ux.step('Repel 250 → 600 on a fresh page', async () => { await setSlider(page, 'forceRepel', 600); },
    { expectMotionMs: 15000, stillTimeoutMs: 40000 }), before, 'fresh page');

  await ux.step('Detail → 0.5 → 1 (re-render), fit', async () => {
    await setSlider(page, 'detailSlider', 0.5);
    await page.waitForTimeout(800);
    await setSlider(page, 'detailSlider', 1);
    await fitToView(page);
  }, { stillTimeoutMs: 40000 });
  before = ux.lastSnapshot;
  judge(await ux.step('Repel 600 → 150 after the Detail change', async () => { await setSlider(page, 'forceRepel', 150); },
    { expectMotionMs: 15000, stillTimeoutMs: 40000 }), before, 'after a Detail change');

  before = ux.lastSnapshot;
  judge(await ux.step('Link force 1 → 6', async () => { await setSlider(page, 'forceLink', 6); },
    { expectMotionMs: 15000, stillTimeoutMs: 40000 }), before, 'link force');
});
