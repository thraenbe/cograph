// 48 — round 3 W3 (session-111): the name of a collapsed folder sits INSIDE the glyph's body, in both engines.
// Gated on the W3 geometry helper (closedFolderLabelPos); skips on older branches.
import { scenario } from '../lib/scenario';
import { fitToView, setSlider } from '../lib/actions';
import { SkipStep, StepFinding } from '../lib/step';

scenario('glyph-label', { perMotion: false, expandFirst: false }, async ({ page, ux }) => {
  await ux.step('Detail 0.3 → collapsed folder glyphs, fitted', async () => {
    if (!await page.evaluate('typeof closedFolderLabelPos === "function"')) { throw new SkipStep('round-3 W3 not on this branch'); }
    await setSlider(page, 'detailSlider', 0.3);
    await fitToView(page);
  });
  await ux.step('Every collapsed-glyph label lies inside its glyph bbox', async () => {
    if (!await page.evaluate('typeof closedFolderLabelPos === "function"')) { throw new SkipStep('round-3 W3 not on this branch'); }
    const r = await page.evaluate(() => {
      const out = { glyphs: 0, labels: 0, outside: [] as string[], missing: 0 };
      const texts = [...document.querySelectorAll('#graph text')];
      for (const el of document.querySelectorAll('#graph path.cloud-node')) {
        const d = (el as unknown as { __data__?: { isFolderCluster?: boolean; id?: string; label?: string; name?: string } }).__data__;
        if (!d?.isFolderCluster) { continue; }
        out.glyphs++;
        const gb = el.getBoundingClientRect();
        if (gb.width < 4) { continue; }
        const t = texts.find(x => (x as unknown as { __data__?: { id?: string } }).__data__?.id === d.id && x.textContent);
        if (!t) { out.missing++; continue; }
        out.labels++;
        const tb = t.getBoundingClientRect();
        if (tb.width < 1) { continue; }
        if (tb.left < gb.left - 1 || tb.right > gb.right + 1 || tb.top < gb.top - 1 || tb.bottom > gb.bottom + 1) { out.outside.push(String(d.label ?? d.name ?? d.id)); }
      }
      return out;
    });
    ux.steps[ux.steps.length - 1].note = `${r.glyphs} glyph(s), ${r.labels} label(s), ${r.missing} without label, ${r.outside.length} outside`;
    if (r.glyphs === 0) { throw new SkipStep('no collapsed folder glyph on screen'); }
    if (r.outside.length) { throw new StepFinding({ rule: 'glyph-label-outside', severity: 'high', ref: 'round3 W3', message: `${r.outside.length} of ${r.labels} collapsed-folder labels lie outside their glyph: ${r.outside.slice(0, 4).join(', ')}` }); }
  });
});
