import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { gitExec, resolveGit, toolEnv } from '../../ci/toolEnv';
import { defaultExec } from '../../vcs/ghCliSource';
import { tempDir } from '../ciRepo';

const realGitDir = () => path.dirname(cp.execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split('\n')[0].trim());

/** A `git` that leaves a mark when it runs. */
function plantGit(dir: string, mark: string): void {
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\ntouch ${mark}\n`, { mode: 0o755 });
}

suite('ci tool environment', () => {
  test('tokens of every platform, the AI key and what bends a tool stay out; the fixed settings go in', () => {
    const job = {
      PATH: '/bin', HOME: '/home/runner', LANG: 'C.UTF-8', GITHUB_TOKEN: 'x', GH_TOKEN: 'x', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x', ACTIONS_ID_TOKEN_REQUEST_URL: 'x',
      CI_JOB_TOKEN: 'x', CI_JOB_JWT: 'x', BITBUCKET_STEP_OIDC_TOKEN: 'x', SYSTEM_ACCESSTOKEN: 'x', ANTHROPIC_API_KEY: 'x', COGRAPH_TOUR_TOKEN: 'x',
      NODE_OPTIONS: '--require=x', PYTHONPATH: '/x', PYTHONSTARTUP: '/x', GIT_DIR: '/x', GIT_CONFIG_COUNT: '1', GIT_ASKPASS: '/x', GIT_SSH_COMMAND: 'x', LD_PRELOAD: '/x',
    };
    assert.deepStrictEqual(toolEnv(job), {
      GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', PYTHONHASHSEED: '0', PATH: '/bin', HOME: '/home/runner', LANG: 'C.UTF-8',
    });
  });

  test('the job cannot switch the lazy fetch back on', () => {
    assert.strictEqual(toolEnv({ GIT_NO_LAZY_FETCH: '0' }).GIT_NO_LAZY_FETCH, '1');
  });

  test('a run with its own base environment sees that and `env`, nothing of this process', async function () {
    if (process.platform === 'win32') { this.skip(); }
    process.env.CG_CANARY = 'of-the-job';
    try {
      const run = (opts: Parameters<typeof defaultExec>[3]) => defaultExec('/usr/bin/env', [], '.', opts);
      const clean = await run({ baseEnv: { PATH: '/bin' }, env: { ADDED: '1' } });
      assert.match(clean.stdout, /^ADDED=1$/m);
      assert.doesNotMatch(clean.stdout, /CG_CANARY/);
      assert.match((await run({})).stdout, /CG_CANARY=of-the-job/, 'without one, the extension inherits as before');
      assert.match((await run({ env: { ADDED: '1' } })).stdout, /CG_CANARY=of-the-job/);
    } finally {
      delete process.env.CG_CANARY;
    }
  });

  suite('git', function () {
    this.timeout(20_000);
    let dir: string;
    setup(function () {
      if (process.platform === 'win32') { this.skip(); }
      dir = tempDir('cg-ci-git-');
    });
    teardown(() => { if (dir) { fs.rmSync(dir, { recursive: true, force: true }); } });

    test('REGRESSION: a `git` in the checkout does not run, through a relative PATH entry either', async () => {
      const mark = path.join(dir, 'ran');
      plantGit(dir, mark);
      const env = { PATH: `.${path.delimiter}${realGitDir()}` };
      const res = await gitExec(env)('git', ['--version'], dir);
      assert.match(res.stdout, /^git version/);
      assert.ok(!fs.existsSync(mark), 'the checkout\'s git ran');
    });

    test('the git found is absolute, skips what is not a file, and is null when there is none', () => {
      fs.mkdirSync(path.join(dir, 'git'));
      const found = resolveGit({ PATH: `${dir}${path.delimiter}${realGitDir()}` });
      assert.strictEqual(found, path.join(realGitDir(), 'git'));
      assert.strictEqual(resolveGit({ PATH: dir }), null);
      assert.strictEqual(resolveGit({}), null);
    });

    test('no git on PATH reads as a missing git, and runs nothing', async () => {
      const mark = path.join(dir, 'ran');
      plantGit(dir, mark);
      const res = await gitExec({ PATH: '.' })('git', ['--version'], dir);
      assert.deepStrictEqual([res.code, res.notFound], [null, true]);
      assert.ok(!fs.existsSync(mark));
    });

    test('a headless run has no other tool: gh is refused', async () => {
      const res = await gitExec({ PATH: realGitDir() })('gh', ['auth', 'token'], dir);
      assert.deepStrictEqual([res.code, res.notFound], [null, false]);
      assert.match(res.stderr, /not available in CI/);
    });

    test('git runs in the environment it was given', async () => {
      process.env.CG_CANARY = 'of-the-job';
      try {
        const env = { PATH: `${realGitDir()}${path.delimiter}/bin${path.delimiter}/usr/bin` };
        const res = await gitExec(env)('git', ['-c', 'alias.e=!env', 'e'], dir);
        assert.strictEqual(res.code, 0, res.stderr);
        assert.doesNotMatch(res.stdout, /CG_CANARY/);
      } finally {
        delete process.env.CG_CANARY;
      }
    });
  });
});
