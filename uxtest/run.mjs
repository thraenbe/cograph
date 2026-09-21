#!/usr/bin/env node
// CLI wrapper: translates uxtest flags into the UXTEST_* environment and runs
// Playwright with uxtest/playwright.config.ts.
//
//   npm run uxtest -- --repo click --scenario smoke
//   npm run uxtest -- --repo click,flask --engine shelf --motion dynamic --headed
//   npm run uxtest -- --all-repos --strict
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const argv = process.argv.slice(2);

function flag(name) { const i = argv.indexOf(`--${name}`); return i !== -1; }
function value(name) { const i = argv.indexOf(`--${name}`); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; }
function fail(msg) { process.stderr.write(`uxtest: ${msg}\n`); process.exit(2); }

if (flag('help')) {
  process.stdout.write(readFileSync(path.join(here, 'README.md'), 'utf8').split('## CLI')[1]?.split('\n## ')[0] ?? 'see uxtest/README.md\n');
  process.exit(0);
}

const project = value('project') ?? 'lab';
const env = { ...process.env };
env.UXTEST_RUN_ID = value('run-id') ?? env.UXTEST_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
if (value('repo')) { env.UXTEST_REPOS = value('repo'); }
if (flag('all-repos')) {
  const cfg = JSON.parse(readFileSync(path.join(here, 'uxtest.config.json'), 'utf8'));
  env.UXTEST_REPOS = [...cfg.defaultRepos, ...cfg.largeRepos].join(',');
}
if (value('engine')) { env.UXTEST_ENGINES = value('engine'); }
if (value('motion')) { env.UXTEST_MOTIONS = value('motion'); }
if (value('corpus')) { env.UXTEST_CORPUS = value('corpus'); }
if (value('ext-root')) { env.UXTEST_EXT_ROOT = path.resolve(value('ext-root')); }
if (value('workers')) { env.UXTEST_WORKERS = value('workers'); }
if (flag('headed')) { env.UXTEST_HEADED = '1'; }
if (flag('strict')) { env.UXTEST_STRICT = '1'; }
if (flag('reanalyze')) { env.UXTEST_REANALYZE = '1'; }
if (value('samples')) { env.UXTEST_SWEEP_SAMPLES = value('samples'); }
if (value('space')) { env.UXTEST_SWEEP_SPACE = path.resolve(value('space')); }
if (flag('video')) { env.UXTEST_SWEEP_VIDEO = '1'; }
if (project === 'report' && value('run-id')) { env.UXTEST_REPORT_RUN = value('run-id'); }
if (value('baseline')) { env.UXTEST_REPORT_BASELINE = value('baseline'); }

// The lab serves the compiled html builder + analyzers glue from out/.
const extRoot = env.UXTEST_EXT_ROOT ?? root;
const builder = path.join(extRoot, 'out', 'webviewHtmlBuilder.js');
const src = path.join(extRoot, 'src', 'webviewHtmlBuilder.ts');
const stale = !existsSync(builder) || statSync(builder).mtimeMs < statSync(src).mtimeMs;
if (stale && !flag('no-compile')) {
  const tsc = spawnSync('npm', ['run', 'compile'], { cwd: extRoot, stdio: 'inherit' });
  if (tsc.status !== 0) { fail('npm run compile failed'); }
}

const args = ['playwright', 'test', '-c', path.join(here, 'playwright.config.ts'), `--project=${project}`];
const scenario = value('scenario');
if (scenario) { args.push(scenario); } // file-name filter, e.g. "smoke" → scenarios/00-smoke.spec.ts
if (value('grep')) { args.push('-g', value('grep')); }

process.stderr.write(`uxtest: run ${env.UXTEST_RUN_ID} → uxtest/artifacts/${env.UXTEST_RUN_ID}/\n`);
const res = spawnSync('npx', args, { cwd: root, stdio: 'inherit', env });
// A sweep is only useful aggregated: build sweep.csv / contact sheet / recommendations right away.
if (project === 'sweep') {
  const rep = spawnSync('npx', ['playwright', 'test', '-c', path.join(here, 'playwright.config.ts'), '--project=report'],
    { cwd: root, stdio: 'inherit', env: { ...env, UXTEST_REPORT_RUN: env.UXTEST_RUN_ID } });
  if (rep.status !== 0) { process.exit(rep.status ?? 1); }
}
process.exit(res.status ?? 1);
