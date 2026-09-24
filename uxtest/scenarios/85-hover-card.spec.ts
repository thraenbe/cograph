// 85 — Hover card (annotate session, src/webview/hoverCard.js): resting the pointer on a
// folder header, a file slot label or a collapsed folder glyph shows a card with name, path
// and static facts. AI stays off: nothing may be requested from the host by hovering.
// All selectors are optional → every step skips on branches without the hover card.
import { expect } from '@playwright/test';
import { scenario } from '../lib/scenario';
import { backgroundPoint, fitToView, hoverPoint, locateFrame, locateNode, need, setSlider, wheelZoom } from '../lib/actions';
import { SkipStep, StepFinding } from '../lib/step';
import { SEL } from '../selectors';
import { annotationsFixture } from '../lib/fixtures';

scenario('hover-card', { perMotion: false, perEngine: false, only: { engine: 'shelf' }, annotations: annotationsFixture }, async ({ page, ux, host, repo }) => {
  const ann = annotationsFixture(repo);
  const card = page.locator(SEL.hoverCardVisible.css);
  const text = async (css: string): Promise<string> => (await page.locator(css).first().innerText().catch(() => '')).trim();
  const postedBefore = host.log.length;
  /** A card that does not open is a product finding, not a harness failure. */
  const cardOpens = async (what: string): Promise<void> => {
    try { await expect(card).toBeVisible({ timeout: 2000 }); }
    catch { throw new StepFinding({ rule: 'hover-card-missing', severity: 'high', ref: 'annotate', message: `no hover card after resting on ${what}` }); }
  };

  await ux.step('Fit', async () => { await need(page, 'hoverCard'); await fitToView(page); });

  await ux.step('Rest on a folder header → card with name + path', async () => {
    await need(page, 'hoverCard');
    const f = await locateFrame(page, 'largest');
    await hoverPoint(page, f.title, 700);
    await cardOpens(`the header of ${f.path}`);
    const name = (await text(SEL.hoverCardName.css)).replace(/[\\/]+$/, ''); // folders are shown as "src/"
    expect(name.length, 'card name').toBeGreaterThan(0);
    expect(f.path.endsWith(name) || f.path.includes(name), `card name "${name}" should belong to ${f.path}`).toBe(true);
  }, { metrics: false });

  await ux.step('Card carries static facts (counts) without AI', async () => {
    await need(page, 'hoverCard');
    if (!await card.isVisible()) { throw new SkipStep('card not visible'); }
    expect((await text(SEL.hoverCardFacts.css)).length + (await text(SEL.hoverCardPath.css)).length, 'path/facts text').toBeGreaterThan(0);
  }, { metrics: false });

  await ux.step('Pointer leaves → card hides', async () => {
    await need(page, 'hoverCard');
    await hoverPoint(page, await backgroundPoint(page), 500);
    await expect(card).toBeHidden({ timeout: 2000 });
  }, { metrics: false });

  await ux.step('Rest on a file slot label → file card', async () => {
    await need(page, 'hoverCard');
    const f = await locateFrame(page, 'smallest');
    await wheelZoom(page, { x: f.rect.x + f.rect.w / 2, y: f.rect.y + f.rect.h / 2 }, -240, 4);
    await page.waitForTimeout(500);
    const label = page.locator('#graph g.file-slot .file-slot-label').first();
    if (await label.count() === 0) { throw new SkipStep('no file slot label rendered'); }
    const boxes = await page.locator('#graph g.file-slot .file-slot-label').evaluateAll(els => els.map(e => { const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width }; })
      .filter(b => b.x > 230 && b.x < window.innerWidth - 20 && b.y > 10 && b.y < window.innerHeight - 60 && b.w > 8));
    if (!boxes.length) { throw new SkipStep('no file slot label on screen'); }
    await hoverPoint(page, boxes[0], 700);
    await cardOpens('a file slot label');
    expect((await text(SEL.hoverCardName.css)).length).toBeGreaterThan(0);
  }, { metrics: false });

  await ux.step('Wheel zoom hides the card', async () => {
    await need(page, 'hoverCard');
    await page.mouse.wheel(0, 120);
    await expect(card).toBeHidden({ timeout: 2000 });
  }, { metrics: false });

  await ux.step('Collapsed folder glyph → folder card', async () => {
    await need(page, 'hoverCard');
    await setSlider(page, 'detailSlider', 0.3);
    await fitToView(page);
    await page.waitForTimeout(800);
    const n = await locateNode(page, { kind: 'folder', pick: 'largest' });
    await hoverPoint(page, n, 900);
    await cardOpens(`the collapsed folder glyph ${n.id}`);
  });

  await ux.step('Annotated folder: canned summary + workspace-relative path', async () => {
    await need(page, 'hoverCard');
    await setSlider(page, 'detailSlider', 1);
    await fitToView(page);
    await page.waitForTimeout(800);
    const f = await locateFrame(page, 'largest', ann.folderRel === '.' ? undefined : '/' + ann.folderRel);
    await hoverPoint(page, f.title, 700);
    await cardOpens(`the annotated folder ${ann.folderRel}`);
    expect(await text(SEL.hoverCardSummary.css)).toContain('canned folder summary');
    expect(await text(SEL.hoverCardPath.css)).toBe(ann.folderRel);
  }, { metrics: false });

  await ux.step('Stale file: the "outdated" badge is shown', async () => {
    await need(page, 'hoverCard');
    const f = await locateFrame(page, 'largest', ann.folderRel === '.' ? undefined : '/' + ann.folderRel);
    await wheelZoom(page, { x: f.rect.x + f.rect.w / 2, y: f.rect.y + f.rect.h / 2 }, -240, 3);
    await page.waitForTimeout(600);
    const spot = await page.locator('#graph g.file-slot').evaluateAll((els, suffix) => {
      for (const el of els) {
        const d = (el as unknown as { __data__?: { file?: string } }).__data__;
        const label = el.querySelector('.file-slot-label');
        if (!d || !label || !String(d.file ?? '').replace(/\\/g, '/').endsWith(suffix)) { continue; }
        const b = label.getBoundingClientRect();
        if (b.left > 230 && b.right < window.innerWidth - 20 && b.top > 10 && b.bottom < window.innerHeight - 60) { return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }
      }
      return null;
    }, ann.staleRel);
    if (!spot) { throw new SkipStep(`slot label of ${ann.staleRel} is not on screen`); }
    await hoverPoint(page, spot, 700);
    await cardOpens(`the slot label of ${ann.staleRel}`);
    expect(await page.locator(SEL.hoverCardBadge.css).first().evaluate(el => (el as HTMLElement).style.display !== 'none'), 'stale badge visible').toBe(true);
  }, { metrics: false });

  await ux.step('Escape hides the card', async () => {
    await need(page, 'hoverCard');
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden({ timeout: 2000 });
  }, { metrics: false });

  await ux.step('Hovering asked the host for nothing (AI stays off)', async () => {
    await need(page, 'hoverCard');
    const asked = host.log.slice(postedBefore).map(l => l.message.type).filter(t => !['dirty-state', 'perf-report', 'expand-folder', 'parse-file', 'get-annotations'].includes(t));
    expect(asked, 'messages posted to the host while hovering').toEqual([]);
  }, { metrics: false, settle: false });
});
