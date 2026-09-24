// scenario(): registers one Playwright test per repo × engine × motion combo,
// owns the lab lifecycle and applies the assertion policy:
//   observational (default) — only failed steps fail the test;
//   --strict                — high-severity findings fail it too.
import { test, expect } from '@playwright/test';
import { openLab, type Lab, type LabOpts } from './lab';
import { matrix, strict, type Combo } from './matrix';
import { loadConfig, loadRepo, sizeClass } from './corpus';
import { fitToView, setSlider } from './actions';

export interface ScenarioOpts extends Pick<LabOpts, 'hostMode' | 'timeline' | 'gitFixture' | 'theme' | 'annotations'> {
  perEngine?: boolean;          // false → run once per repo on the first selected engine
  perMotion?: boolean;
  largeOk?: boolean;            // run on 'large' repos too (default: only smoke-class scenarios do)
  only?: Partial<Pick<Combo, 'engine' | 'motion'>>; // scenario is meaningful for one engine/motion only
  /** Repos with > 200 files open as ONE collapsed root. Scenarios that work on the expanded graph get a
   *  recorded prelude step that opens everything; scenarios about the collapsed/lazy state set this to false. */
  expandFirst?: boolean;
}

const COLLAPSED_BELOW = 5; // visible nodes

async function expandIfCollapsed(lab: Lab): Promise<void> {
  const visible = await lab.page.evaluate('typeof getVisibleNodeIds === "function" ? getVisibleNodeIds().size : state.currentNodes.length') as number;
  if (visible >= COLLAPSED_BELOW) { return; }
  await lab.ux.step(`Prelude: repo opened collapsed (${visible} node) → Detail 1, fit`, async () => {
    await setSlider(lab.page, 'detailSlider', 1);
    await lab.page.waitForTimeout(600);
    await fitToView(lab.page);
  }, { stillTimeoutMs: 60000 });
}

export type ScenarioBody = (lab: Lab, combo: Combo) => Promise<void>;

export function scenario(name: string, opts: ScenarioOpts, body: ScenarioBody): void {
  // Filter first, then collapse: `only: { motion: 'dynamic' }` + perMotion:false must still yield a combo.
  const wanted = matrix().filter(c => (!opts.only?.engine || c.engine === opts.only.engine) && (!opts.only?.motion || c.motion === opts.only.motion));
  const seen = new Set<string>();
  const combos = wanted.filter((c) => {
    const key = [c.repo, opts.perEngine === false ? '' : c.engine, opts.perMotion === false ? '' : c.motion].join('|');
    if (seen.has(key)) { return false; }
    seen.add(key);
    return true;
  });
  for (const c of combos) {
    test(`${name} · ${c.repo} · ${c.engine}/${c.motion}`, async ({ browser }) => {
      const repo = await loadRepo(c.repo, loadConfig());
      test.skip(repo.functions === 0, `${c.repo}: analyzers produced no functions`);
      test.skip(!opts.largeOk && sizeClass(repo.functions) === 'large', `${c.repo}: large repo, scenario not marked largeOk`);
      const lab = await openLab({ ...c, repo, scenario: name, browser, hostMode: opts.hostMode, timeline: opts.timeline,
        gitFixture: opts.gitFixture, theme: opts.theme, annotations: opts.annotations });
      try {
        if (opts.expandFirst !== false) { await expandIfCollapsed(lab); }
        await body(lab, c);
      }
      finally {
        const run = await lab.close();
        expect(run.steps.filter(s => s.status === 'failed').map(s => `${s.index}. ${s.name}: ${s.note}`)).toEqual([]);
        if (strict()) {
          const high = run.steps.flatMap(s => s.findings.filter(f => f.severity === 'high').map(f => `${s.index}. ${s.name}: ${f.message}`));
          expect(high, 'high-severity findings (--strict)').toEqual([]);
        }
      }
    });
  }
}
