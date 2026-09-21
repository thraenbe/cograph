// Run matrix shared by every scenario file: repos × engine × motion, narrowed
// by the UXTEST_* environment that uxtest/run.mjs derives from CLI flags.
import { loadConfig, selectedRepos } from './corpus';

export type Engine = 'shelf' | 'global';
export type Motion = 'dynamic' | 'static';
export interface Combo { repo: string; engine: Engine; motion: Motion }

function pick<T extends string>(env: string | undefined, all: T[]): T[] {
  if (!env) { return all; }
  const want = env.split(',').map(s => s.trim());
  return all.filter(v => want.includes(v));
}

export function engines(): Engine[] { return pick(process.env.UXTEST_ENGINES, ['shelf', 'global']); }
export function motions(): Motion[] { return pick(process.env.UXTEST_MOTIONS, ['static', 'dynamic']); }

/** Full matrix, or one combo per repo when a scenario does not depend on engine/motion. */
export function matrix(opts: { perEngine?: boolean; perMotion?: boolean } = {}): Combo[] {
  const es = opts.perEngine === false ? engines().slice(0, 1) : engines();
  const ms = opts.perMotion === false ? motions().slice(0, 1) : motions();
  const out: Combo[] = [];
  for (const repo of selectedRepos(loadConfig())) {
    for (const engine of es) { for (const motion of ms) { out.push({ repo, engine, motion }); } }
  }
  return out;
}

export const strict = (): boolean => process.env.UXTEST_STRICT === '1';
