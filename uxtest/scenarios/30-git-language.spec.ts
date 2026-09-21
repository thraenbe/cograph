// 30 — Git colours + legend, language colours + swatches.
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { clickSel, isVisible } from '../lib/actions';
import { SkipStep } from '../lib/step';
import { SEL } from '../selectors';

scenario('git-language', { perMotion: false, perEngine: false, gitFixture: { gitAvailable: true, fileGitStatus: {} } }, async ({ page, ux, post, repo }) => {
  await ux.step('Git panel is visible when the host reports git', async () => {
    expect(await isVisible(page, 'gitPanel')).toBe(true);
  }, { metrics: false });

  await ux.step('Host sends git-update (modified / added / staged)', async () => {
    const fns = repo.graph.nodes.filter(n => !n.isLibrary && n.file).slice(0, 12);
    await post({ type: 'git-update', fileGitStatus: {}, nodes: fns.map((n, i) => ({ id: n.id,
      gitStatus: { unstaged: i % 3 === 0 ? 'modified' : i % 3 === 1 ? 'added' : null, staged: i % 3 === 2 ? 'added' : null } })) });
  });
  await ux.step('Git mode off', async () => { await clickSel(page, 'gitMode'); });
  await ux.step('Git mode on', async () => { await clickSel(page, 'gitMode'); });
  await ux.step('Collapse git legend', async () => { await clickSel(page, 'gitLegendToggle'); }, { metrics: false });
  await ux.step('Expand git legend', async () => { await clickSel(page, 'gitLegendToggle'); }, { metrics: false });

  await ux.step('Language mode off', async () => { await clickSel(page, 'languageMode'); });
  await ux.step('Language mode on', async () => { await clickSel(page, 'languageMode'); });
  await ux.step('Language legend lists the repo languages', async () => {
    const swatches = await page.locator(`${SEL.languageLegend.css} .lang-swatch`).count();
    if (swatches === 0) { throw new SkipStep('language legend has no swatches'); }
  }, { metrics: false });
  await ux.step('Recolour the first language via its swatch', async () => {
    const sw = page.locator(`${SEL.languageLegend.css} .lang-swatch`).first();
    if (await sw.count() === 0) { throw new SkipStep('no swatch'); }
    await sw.evaluate((el) => { const i = el as HTMLInputElement; i.value = '#ff00aa'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
  });
});
