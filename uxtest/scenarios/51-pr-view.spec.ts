// 51 — a pull request shown in the graph (Version Control pane, 1.4.0), for the first time in the lab. The
// FakeHost plays PrController + GraphProvider.showPullRequest: `subgraph` (the transient PR scope), then `pr-view`
// (refs, tree, diff summary, the folders to open, the PR's file statuses), then structure and the graph with the
// PR's statuses. Leave posts `subgraph-exit`; the host answers `subgraph` + `pr-view` inactive with restore.
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { clickSel, fitToView } from '../lib/actions';
import { SkipStep, StepFinding } from '../lib/step';
import { prFixture } from '../lib/fixtures';
import { SEL } from '../selectors';

scenario('pr-view', { perMotion: false, expandFirst: false, scope: (r) => prFixture(r).scope, pullRequest: (r) => ({ message: prFixture(r).message }) }, async ({ page, ux, host, repo }) => {
  const pr = prFixture(repo);
  const gate = async (): Promise<void> => { if (!await page.evaluate('typeof handlePrViewMessage === "function"')) { throw new SkipStep('prView.js not on this branch'); } };

  await ux.step('PR view opens: the banner names the PR, its tree and the diff summary', async () => {
    await gate();
    if (pr.files.length < 2) { throw new SkipStep(`${repo.name}: fewer than two source folders for the fixture`); }
    await expect(page.locator(SEL.prBanner.css)).toBeVisible();
    await expect(page.locator(SEL.prBannerName.css)).toHaveText(pr.message.name as string);
    await expect(page.locator(SEL.prBannerTree.css)).toHaveText(/^PR commit abc1234$/);
    await expect(page.locator(SEL.prBannerSummary.css)).toHaveText('+1 ~2 −0 functions · 3 callers affected');
    await fitToView(page);
  });

  await ux.step('The folders on a path to a changed file are open, and only those', async () => {
    await gate();
    const open = (await page.evaluate('[...state.expandedFolders].sort()')) as string[];
    ux.steps[ux.steps.length - 1].note = `expanded: ${open.length}, fixture expand list: ${pr.expand.length}`;
    const missing = pr.expand.filter(d => !open.includes(d));
    const extra = open.filter(d => !pr.expand.includes(d));
    if (missing.length) { throw new StepFinding({ rule: 'pr-folders-not-open', severity: 'high', ref: 'vcs 1.4.0', message: `PR folders left closed: ${missing.join(', ')}` }); }
    if (extra.length) { throw new StepFinding({ rule: 'pr-extra-folders-open', severity: 'low', ref: 'vcs 1.4.0', message: `folders open beyond the PR's: ${extra.join(', ')}` }); }
  });

  await ux.step("Colours: git on, language off, the PR's statuses in state", async () => {
    await gate();
    const st = await page.evaluate('({ git: state.gitMode, lang: state.languageMode, files: Object.keys(state.fileGitStatus || {}).sort(), readOnly: !!(state.prView && state.prView.readOnly) })') as { git: boolean; lang: boolean; files: string[]; readOnly: boolean };
    expect(st.git, 'git colours on').toBe(true);
    expect(st.lang, 'language colours off: only the PR colours carry meaning').toBe(false);
    expect(st.files).toEqual([...pr.files].sort());
    expect(st.readOnly, "the PR's own commit takes no edits").toBe(true);
  }, { metrics: false });

  await ux.step('Leave → subgraph-exit posted, the banner goes, language colours come back', async () => {
    await gate();
    const before = host.posted('subgraph-exit').length;
    await clickSel(page, 'prBannerLeave');
    await expect.poll(() => host.posted('subgraph-exit').length, { timeout: 5000 }).toBeGreaterThan(before);
    await expect(page.locator(SEL.prBanner.css)).toHaveCount(0);
    expect(await page.evaluate('state.prView')).toBeNull();
    expect(await page.evaluate('state.languageMode')).toBe(true);
    await fitToView(page);
  });
});
