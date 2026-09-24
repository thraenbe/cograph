// 50 — Class overlay + the Group-by lens (File / Class / Connect). The three
// group-by buttons are being removed by the ux session → optional selectors.
import { scenario } from '../lib/scenario';
import { clickSel, fitToView } from '../lib/actions';

scenario('class-groupby', { perMotion: false, perEngine: false }, async ({ page, ux }) => {
  await ux.step('Class overlay off', async () => { await clickSel(page, 'classMode'); });
  await ux.step('Class overlay on', async () => { await clickSel(page, 'classMode'); });
  await ux.step('Group by Class', async () => { await clickSel(page, 'groupClass'); await fitToView(page); }, { stillTimeoutMs: 10000 });
  await ux.step('Group by Connect', async () => { await clickSel(page, 'groupConnect'); await fitToView(page); }, { stillTimeoutMs: 10000 });
  await ux.step('Group by File', async () => { await clickSel(page, 'groupFile'); await fitToView(page); }, { stillTimeoutMs: 10000 });
});
