import { test, expect } from '@playwright/test';
import type { PlaywrightTestConfig } from '@playwright/test';

const CONFIG = '../playwright.config';

/** Loads playwright.config.ts afresh under `env` (it reads the environment when it is evaluated). */
function configUnder(env: Record<string, string | undefined>): PlaywrightTestConfig {
  const keys = Object.keys(env);
  const saved = keys.map(k => [k, process.env[k]] as const);
  for (const k of keys) { if (env[k] === undefined) { delete process.env[k]; } else { process.env[k] = env[k]; } }
  try {
    delete require.cache[require.resolve(CONFIG)];
    return (require(CONFIG) as { default: PlaywrightTestConfig }).default;
  } finally {
    for (const [k, v] of saved) { if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; } }
    delete require.cache[require.resolve(CONFIG)];
  }
}

const browserProjects = (cfg: PlaywrightTestConfig) => (cfg.projects ?? []).filter(p => p.use?.browserName);

test.describe('playwright.config browser projects', () => {
  test('every browser project is headless unless --headed asks for a window', () => {
    const cfg = configUnder({ UXTEST_HEADED: undefined, UXTEST_HEADLESS: undefined });
    const projects = browserProjects(cfg);
    expect(projects.map(p => p.name)).toEqual(expect.arrayContaining(['lab', 'examples', 'sweep', 'bench']));
    for (const p of projects) { expect({ project: p.name, headless: p.use?.headless }).toEqual({ project: p.name, headless: true }); }
  });

  test('--headed (UXTEST_HEADED=1) opens a window for the lab and bench projects', () => {
    const cfg = configUnder({ UXTEST_HEADED: '1', UXTEST_HEADLESS: undefined });
    const headless = Object.fromEntries(browserProjects(cfg).map(p => [p.name, p.use?.headless]));
    expect(headless).toMatchObject({ lab: false, examples: false, bench: false });
  });
});
