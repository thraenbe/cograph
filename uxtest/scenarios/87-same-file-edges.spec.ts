// 87 — U1 "Only calls within a file" (cograph.display.sameFileEdgesOnly, default ON).
// The property worth guarding: hidden edges still drive the layout. startSimulation receives every edge and
// only a CSS class differs, so the setting cannot touch the simulation by construction; this is the
// regression guard on that invariant:
//   - two FRESH boots, setting on (default) vs off, same Math.random seed → the same settled layout and the
//     same orphan set (state.connectedNodeIds), while the drawn cross-file lines differ;
//   - toggling after settle keeps every line element (identity) and every position;
//   - hover still reveals a function's own cross-file calls (line.xfile.cg-hl / Shelf line.cross-hover);
//   - R3/F20 (giant arrowhead) keeps guarding: with bundles hidden by default it would judge nothing, so the
//     OFF boot zooms in and the arrowhead metric runs there.
// Without the setting on the branch, the two boots have identical config: a determinism baseline only.
import { scenario } from '../lib/scenario';
import { openLab, type Lab } from '../lib/lab';
import { backgroundPoint, fitToView, hoverPoint, locateFrame, locateNode, setSlider, toggleSwitch, waitSimRest, wheelZoom } from '../lib/actions';
import { SkipStep, StepFinding } from '../lib/step';
import { SEL } from '../selectors';
import { maxDisplacement } from '../metrics/compute';
import type { Snapshot } from '../metrics/types';
import { expect } from '@playwright/test';

const SEED = 181;
const KEY = 'display.sameFileEdgesOnly';
const SAME_PX = 1; // Shelf+Static is pure, Global is seeded: "the same" means sub-pixel

interface Drawn { xfile: number; xfileShown: number; bundlesShown: number; crossHoverShown: number; rootClass: boolean }

/** Runs in the page: what the setting shows and hides right now (computed style, the lines stay in the DOM). */
function drawnInPage(): Drawn {
  const shown = (el: Element): boolean => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden'; };
  const all = (css: string): Element[] => [...document.querySelectorAll(css)];
  return {
    xfile: all('#graph line.xfile').length,
    xfileShown: all('#graph line.xfile').filter(shown).length,
    bundlesShown: all('#graph line.cross-bundle').filter(shown).length,
    crossHoverShown: all('#graph line.cross-hover').filter(shown).length,
    rootClass: !!document.querySelector('#graph g.same-file-only'),
  };
}

/** Orphan detection input: computed from ALL edges, must not depend on the setting. */
const connectedIds = (lab: Lab): Promise<string[]> =>
  lab.page.evaluate('state.connectedNodeIds ? [...state.connectedNodeIds].map(String).sort() : []') as Promise<string[]>;

async function hasSetting(lab: Lab): Promise<boolean> { return await lab.page.locator(SEL.toggleSameFileEdges.css).count() > 0; }

/** The same deterministic opening for both boots: Detail 1 when the repo opens collapsed, wait for the
 *  simulation to REST (alpha <= 0.001 or no ticks, not "looks still": Global/Dynamic takes 13-16 s), then fit. */
async function settle(lab: Lab, label: string): Promise<Snapshot> {
  let restNote = '';
  const rec = await lab.ux.step(`Settle (${label}, seed ${SEED})`, async () => {
    const visible = await lab.page.evaluate('typeof getVisibleNodeIds === "function" ? getVisibleNodeIds().size : state.currentNodes.length') as number;
    if (visible < 5) { await setSlider(lab.page, 'detailSlider', 1); await lab.page.waitForTimeout(600); }
    const rest = await waitSimRest(lab.page, 90000);
    if (!rest.rested) { throw new Error(`simulation did not rest within 90 s (alpha ${rest.alpha})`); }
    restNote = `sim at rest after ${rest.ms} ms (${rest.by}, alpha ${rest.alpha})`;
    await fitToView(lab.page);
  }, { stillTimeoutMs: 60000 });
  rec.note = rec.note ? `${rec.note}; ${restNote}` : restNote;
  if (!lab.ux.lastSnapshot) { throw new Error('no snapshot after settle'); }
  return lab.ux.lastSnapshot;
}

/** Tag every drawn line/path; afterwards count tagged vs untagged (re-render = new elements). */
const tagLines = (lab: Lab): Promise<number> => lab.page.evaluate(() => {
  const els = [...document.querySelectorAll('#graph svg line, #graph svg path')];
  els.forEach(el => { (el as unknown as { __uxTag?: number }).__uxTag = 1; });
  return els.length;
});
const untaggedLines = (lab: Lab): Promise<{ tagged: number; fresh: number }> => lab.page.evaluate(() => {
  const els = [...document.querySelectorAll('#graph svg line, #graph svg path')];
  const tagged = els.filter(el => (el as unknown as { __uxTag?: number }).__uxTag === 1).length;
  return { tagged, fresh: els.length - tagged };
});

async function toggleAndCompare(lab: Lab, to: boolean): Promise<void> {
  const before = lab.ux.lastSnapshot;
  const tagged = await tagLines(lab);
  const rec = await lab.ux.step(`Toggle "Only calls within a file" ${to ? 'on' : 'off'}: same elements, same positions`, async () => {
    const checked = await toggleSwitch(lab.page, 'toggleSameFileEdges');
    await lab.page.mouse.click(640, 790); // close the gear panel (as 80 does)
    expect(checked, 'toggle state after the click').toBe(to);
    const d = await lab.page.evaluate(drawnInPage);
    expect(d.rootClass, 'zoom root carries g.same-file-only exactly while the setting is on').toBe(to);
    if (to) { expect(d.xfileShown + d.bundlesShown, 'no cross-file line or bundle visible while on').toBe(0); }
    else if (d.xfile > 0) { expect(d.xfileShown, 'cross-file lines visible while off').toBeGreaterThan(0); }
    const after = await untaggedLines(lab);
    if (after.fresh > 0 || after.tagged !== tagged) {
      throw new StepFinding({ rule: 'same-file-toggle-rerendered', severity: 'high', ref: 'U1',
        message: `toggle replaced line elements: ${tagged} before, ${after.tagged} kept, ${after.fresh} new` });
    }
  });
  if (before && lab.ux.lastSnapshot) {
    const m = maxDisplacement(before, lab.ux.lastSnapshot);
    rec.note = `${rec.note ? rec.note + '; ' : ''}positions: ${m.moved} moved, max ${m.max}px`;
    if (m.max > SAME_PX) { rec.findings.push({ rule: 'same-file-toggle-moved', severity: 'high', ref: 'U1', message: `toggle moved ${m.moved} node(s), max ${m.max}px` }); }
  }
}

scenario('same-file-edges', { expandFirst: false, seed: SEED }, async (lab, combo) => {
  const { page, ux } = lab;
  // Boot 1: default settings (the setting must default to ON).
  const snapOn = await settle(lab, 'default settings');
  const feature = await hasSetting(lab);
  const connOn = await connectedIds(lab);
  await ux.step('Default: only same-file calls drawn', async () => {
    if (!feature) { throw new SkipStep('no #toggle-same-file-edges on this branch (before U1)'); }
    expect(await page.locator(SEL.toggleSameFileEdges.css).isChecked(), 'default ON').toBe(true);
    const d = await page.evaluate(drawnInPage);
    expect(d.rootClass, 'g.same-file-only on the zoom root').toBe(true);
    expect(d.xfileShown, 'visible cross-file lines').toBe(0);
    expect(d.bundlesShown, 'visible cross-folder bundles').toBe(0);
  }, { metrics: false });

  // Boot 2: a fresh panel with the setting OFF, same seed.
  const twin = await openLab({ ...combo, repo: lab.repo, scenario: 'same-file-edges-off', browser: page.context().browser() ?? undefined,
    seed: SEED, settings: { [KEY]: false } });
  let drawnOff: Drawn | null = null;
  try {
    const snapOff = await settle(twin, `${KEY} = false`);
    drawnOff = await twin.page.evaluate(drawnInPage);
    const connOff = await connectedIds(twin);
    const rec = await ux.step(feature ? 'Hidden edges still drive the layout: fresh boots on vs off match' : 'Determinism baseline: two seeded boots match', async () => {
      if (feature && drawnOff && drawnOff.rootClass) { throw new Error(`boot setting ${KEY}=false did not reach the page (root still same-file-only)`); }
    }, { metrics: false });
    const m = maxDisplacement(snapOn, snapOff);
    const idsOn = snapOn.nodes.map(n => n.id).sort().join('\n'), idsOff = snapOff.nodes.map(n => n.id).sort().join('\n');
    rec.note = `${snapOn.nodes.length} vs ${snapOff.nodes.length} visible nodes, ${m.moved} differ, max ${m.max}px; connected ${connOn.length} vs ${connOff.length}; ` +
      `off draws ${drawnOff.xfileShown} cross-file line(s) + ${drawnOff.bundlesShown} bundle(s)`;
    if (m.max > SAME_PX || idsOn !== idsOff) {
      rec.findings.push({ rule: feature ? 'same-file-layout-differs' : 'boot-not-deterministic', severity: 'high', ref: 'U1', message: rec.note });
    }
    if (connOn.join('\n') !== connOff.join('\n')) {
      rec.findings.push({ rule: 'same-file-orphans-differ', severity: 'high', ref: 'U1', message: `state.connectedNodeIds differs on vs off (${connOn.length} vs ${connOff.length})` });
    }

    // R3/F20 keeps a guard: the OFF boot zooms in, every step's arrowhead metric is judged (score.ts giant-arrowhead).
    let judged = 0;
    for (const ticks of [3, 6]) {
      const z = await twin.ux.step(`Arrowhead guard (R3/F20) with ${KEY} off: zoom in (${ticks} wheel ticks)`, async () => {
        const f = await locateFrame(twin.page, 'largest').catch(() => null);
        const at = f ? { x: f.rect.x + f.rect.w / 2, y: f.rect.y + f.rect.h / 2 } : { x: 640, y: 400 };
        await wheelZoom(twin.page, at, -240, ticks);
      });
      judged += z.metrics?.markerLines ?? 0;
    }
    const guard = twin.ux.steps[twin.ux.steps.length - 1];
    guard.note = `${guard.note ? guard.note + '; ' : ''}R3 judged ${judged} visible arrowhead line(s) across the zoom steps (setting off)` +
      (judged === 0 ? ' - nothing to guard here (arrows off or no bundles in view)' : '');
  } finally {
    const run = await twin.close();
    expect(run.steps.filter(s => s.status === 'failed').map(s => `${s.index}. ${s.name}: ${s.note}`)).toEqual([]);
  }

  // Back in boot 1: toggle after settle (instant, no re-render, no re-layout).
  if (feature) {
    await toggleAndCompare(lab, false);
    await toggleAndCompare(lab, true);
  }

  await ux.step('Hover a function with cross-file calls: its own cross-file lines show (setting on)', async () => {
    if (!feature) { throw new SkipStep('no #toggle-same-file-edges on this branch (before U1)'); }
    const f = await locateFrame(page, 'smallest');
    await wheelZoom(page, { x: f.rect.x + f.rect.w / 2, y: f.rect.y + f.rect.h / 2 }, -240, 5);
    await page.waitForTimeout(600);
    // A function at the end of a cross-file line (Global / Shelf in-frame), else any visible function (Shelf cross-folder → line.cross-hover).
    const ids = await page.evaluate(() => [...document.querySelectorAll('#graph line.xfile')].flatMap((el) => {
      const d = (el as unknown as { __data__?: { source?: { id?: unknown } | unknown; target?: { id?: unknown } | unknown } }).__data__;
      const id = (e: unknown): string => String(e && typeof e === 'object' && 'id' in (e as object) ? (e as { id: unknown }).id : e);
      return d ? [id(d.source), id(d.target)] : [];
    }));
    let hit = null;
    for (const id of [...new Set(ids)]) { hit = await locateNode(page, { kind: 'fn', id }).catch(() => null); if (hit) { break; } }
    if (!hit && combo.engine === 'shelf') { hit = await locateNode(page, { kind: 'fn' }); }
    if (!hit) { throw new SkipStep('no function with a cross-file line on screen'); }
    await hoverPoint(page, hit, 500);
    const on = await page.evaluate(drawnInPage);
    const away = await backgroundPoint(page);
    await hoverPoint(page, away, 300);
    const off = await page.evaluate(drawnInPage);
    if (on.xfileShown + on.crossHoverShown === 0) {
      if (ids.length === 0) { throw new SkipStep(`hovered ${hit.label}: no cross-file line in view and none drawn on hover (it may have no cross-file calls)`); }
      throw new StepFinding({ rule: 'same-file-hover-missing', severity: 'high', ref: 'U1', message: `hovering ${hit.label} showed no cross-file line` });
    }
    if (off.xfileShown + off.crossHoverShown > 0) {
      throw new StepFinding({ rule: 'same-file-hover-stuck', severity: 'medium', ref: 'U1', message: `after leaving ${hit.label}: ${off.xfileShown} cross-file + ${off.crossHoverShown} cross-hover line(s) still visible` });
    }
  }, { metrics: false });
});
