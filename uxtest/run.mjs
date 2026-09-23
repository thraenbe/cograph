#!/usr/bin/env node
// CLI wrapper: translates uxtest flags into the UXTEST_* environment and runs
// Playwright with uxtest/playwright.config.ts.
//
//   npm run uxtest -- --repo click --scenario smoke
//   npm run uxtest -- --repo click,flask --engine shelf --motion dynamic --headed
//   npm run uxtest -- --all-repos --strict
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
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
if (value('workers-mode')) {
  if (!['auto', 'on', 'off'].includes(value('workers-mode'))) { fail('--workers-mode must be auto | on | off'); }
  env.UXTEST_WORKERS_MODE = value('workers-mode'); // cograph.layout.workers inside the lab (simulation transport), not Playwright workers
}
if (flag('headed')) { env.UXTEST_HEADED = '1'; }
if (flag('strict')) { env.UXTEST_STRICT = '1'; }
if (flag('reanalyze')) { env.UXTEST_REANALYZE = '1'; }
if (value('samples')) { env.UXTEST_SWEEP_SAMPLES = value('samples'); }
if (value('space')) { env.UXTEST_SWEEP_SPACE = path.resolve(value('space')); }
if (flag('video')) { env.UXTEST_SWEEP_VIDEO = '1'; }
if (flag('resume')) { env.UXTEST_SWEEP_RESUME = '1'; } // with --run-id <existing>: only the missing sweep samples run
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

// Tier B loads the extension from dist/ (esbuild bundle), like F5 does.
if (project === 'vscode' && !flag('no-compile')) {
  const b = spawnSync('npm', ['run', 'bundle'], { cwd: extRoot, stdio: 'inherit' });
  if (b.status !== 0) { fail('npm run bundle failed'); }
}

const args = ['playwright', 'test', '-c', path.join(here, 'playwright.config.ts'), `--project=${project}`];
const scenario = value('scenario');
if (scenario) { args.push(scenario); } // file-name filter, e.g. "smoke" → scenarios/00-smoke.spec.ts
if (value('grep')) { args.push('-g', value('grep')); }

process.stderr.write(`uxtest: run ${env.UXTEST_RUN_ID} → uxtest/artifacts/${env.UXTEST_RUN_ID}/\n`);

// The runner gets its OWN PROCESS GROUP. Killing only the runner leaves its workers and their Chromium pages
// alive (two such orphans once spun for hours under everybody's measurements) - so an abort ends the whole group.
function runGroup(cmd, cmdArgs, runEnv) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: root, stdio: 'inherit', env: runEnv, detached: true });
    const stopGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* group already gone */ } };
    const onSignal = (sig) => { stopGroup(sig); setTimeout(() => stopGroup('SIGKILL'), 5000).unref(); };
    const handlers = { SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM'), SIGHUP: () => onSignal('SIGTERM') };
    for (const [sig, h] of Object.entries(handlers)) { process.on(sig, h); }
    child.on('exit', (code, signal) => {
      for (const [sig, h] of Object.entries(handlers)) { process.off(sig, h); }
      stopGroup('SIGTERM'); // anything the runner left behind in its group
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

/** Workers / headless browsers of THIS worktree that survived a run (cwd is checked, nothing is killed here). */
function orphanReport() {
  if (process.platform !== 'linux') { return; }
  const mine = [];
  for (const pid of readdirSync('/proc').filter(d => /^\d+$/.test(d))) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (!/workerProcessEntry|chrome-headless-shell/.test(cmdline)) { continue; }
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      // An orphan has been re-parented to init; workers of ANOTHER live run of this worktree are not orphans.
      if (ppid === 1 && cwd === root) { mine.push(pid); }
    } catch { /* process ended or is not ours to read */ }
  }
  if (mine.length) {
    process.stderr.write(`uxtest: WARNING - ${mine.length} leftover worker/browser process(es) of this worktree: ${mine.join(' ')}. `
      + 'They burn CPU under every later measurement; inspect with `ps -o pid,ppid,pcpu,etime,cmd -p <pids>` and end them.\n');
  }
}

const status = await runGroup('npx', args, env);
// A sweep is only useful aggregated: build sweep.csv / contact sheet / recommendations right away.
let reportStatus = 0;
if (project === 'sweep') {
  reportStatus = await runGroup('npx', ['playwright', 'test', '-c', path.join(here, 'playwright.config.ts'), '--project=report'],
    { ...env, UXTEST_REPORT_RUN: env.UXTEST_RUN_ID });
}
orphanReport();
process.exit(status || reportStatus);
