// 99 — Save → reload round trip (v2 layout: positions, frames, expansion) and
// loading a legacy v1 payload. R5 / T4: the restored picture must be the same.
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { openLab } from '../lib/lab';
import { clickSel, dragFrame, fitToView, judgeFrameDrag, locateFrame, setSlider, toggleSwitch } from '../lib/actions';
import { SkipStep } from '../lib/step';
import { SEL } from '../selectors';
import { v1Payload } from '../lib/fixtures';
import { maxDisplacement } from '../metrics/compute';

scenario('save-roundtrip', { perMotion: false }, async (lab, combo) => {
  const { page, ux, host, repo } = lab;
  await ux.step('Arrange: detail 0.6, move one folder', async () => {
    await setSlider(page, 'detailSlider', 0.6);
    await fitToView(page);
    await page.waitForTimeout(700);
    const f = await locateFrame(page, 'smallest');
    judgeFrameDrag(await dragFrame(page, f, 60, 45));
  }, { userMoved: true });
  const arranged = ux.lastSnapshot;
  // U1: the save carries sameFileEdgesOnly. Saved at the NON-default (off) so the restore proves it was read back.
  const sameFile = await page.locator(SEL.toggleSameFileEdges.css).count() > 0;
  await ux.step('Turn "Only calls within a file" off before saving (U1)', async () => {
    if (!sameFile) { throw new SkipStep('no #toggle-same-file-edges on this branch (before U1)'); }
    expect(await toggleSwitch(page, 'toggleSameFileEdges')).toBe(false);
    await page.mouse.click(640, 790); // close the gear panel
  }, { metrics: false });
  await ux.step('Save layout', async () => {
    await clickSel(page, 'saveGraph');
    await expect.poll(() => host.saved.length).toBe(1);
  }, { metrics: false });
  const payload = (host.saved[0].payload ?? host.saved[0]) as Record<string, unknown>;
  if (sameFile) { expect((payload.settings as Record<string, unknown> | undefined)?.sameFileEdgesOnly, 'payload.settings.sameFileEdgesOnly').toBe(false); }

  // A fresh panel, as after closing and reopening CoGraph, then "load saved graph".
  const again = await openLab({ ...combo, repo, scenario: 'save-roundtrip-restore', browser: page.context().browser() ?? undefined });
  again.ux.birth = 'user-moved'; // the restored picture contains the folder the user dragged before saving
  try {
    const restored = await again.ux.step('Fresh panel: host sends graph-loaded (v2)', async () => {
      await again.post({ type: 'graph-loaded', payload });
    });
    if (arranged && again.ux.lastSnapshot) {
      const d = maxDisplacement(arranged, again.ux.lastSnapshot);
      restored.note = `restore delta: ${d.moved} node(s) differ, max ${d.max}px (of ${again.ux.lastSnapshot.nodes.length})`;
      if (d.max > 2) { restored.findings.push({ rule: 'restore-differs', severity: 'high', ref: 'R5/T4', message: restored.note }); }
      if (again.ux.lastSnapshot.nodes.length !== arranged.nodes.length) {
        restored.findings.push({ rule: 'restore-node-count', severity: 'high', ref: 'R5/T4', message: `saved ${arranged.nodes.length} visible nodes, restored ${again.ux.lastSnapshot.nodes.length}` });
      }
    }
    await again.ux.step('Fit the restored layout', async () => { await fitToView(again.page); });
    await again.ux.step('Restored panel keeps the saved "Only calls within a file" = off (U1)', async () => {
      if (!sameFile) { throw new SkipStep('no #toggle-same-file-edges on this branch (before U1)'); }
      expect(await again.page.locator(SEL.toggleSameFileEdges.css).isChecked(), 'toggle after restore').toBe(false);
      expect(await again.page.locator(SEL.sameFileRoot.css).count(), 'g.same-file-only after restore').toBe(0);
    }, { metrics: false });

    await again.ux.step('Load a legacy v1 payload (positions only)', async () => {
      const pos = (again.ux.lastSnapshot?.nodes ?? []).filter(n => n.kind === 'fn').map(n => ({ id: n.id, x: n.x + 15, y: n.y + 10 }));
      await again.post({ type: 'graph-loaded', payload: v1Payload(pos) });
    });
    await again.ux.step('Fit after the v1 migration', async () => { await fitToView(again.page); });
    await again.ux.step('A save without the key (v1) keeps the current setting (U1)', async () => {
      if (!sameFile) { throw new SkipStep('no #toggle-same-file-edges on this branch (before U1)'); }
      expect(await again.page.locator(SEL.toggleSameFileEdges.css).isChecked(), 'unchanged by a payload without sameFileEdgesOnly').toBe(false);
    }, { metrics: false });
  } finally {
    const run = await again.close();
    expect(run.steps.filter(s => s.status === 'failed')).toEqual([]);
  }
});
