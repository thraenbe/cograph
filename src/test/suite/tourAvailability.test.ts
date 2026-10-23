import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TourAvailability, computeAvailability } from '../../tour/tourAvailability';
import type { AvailabilityDeps, TourAvailabilityMessage } from '../../tour/tourAvailability';
import { defaultExec } from '../../vcs/ghCliSource';
import type { Exec } from '../../vcs/ghCliSource';
import type { PullRequest } from '../../vcs/types';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x', GIT_TERMINAL_PROMPT: '0' };

function sh(cwd: string, args: string[]): string {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();
}
function commit(cwd: string, file: string, text: string, msg: string): void {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), text);
  sh(cwd, ['add', '-A']);
  sh(cwd, ['commit', '--quiet', '-m', msg]);
}

const PR = (over: Partial<PullRequest>): PullRequest => ({
  number: 104, title: 't', author: 'a', headRef: 'feat/x', baseRef: 'main', headOid: '', state: 'open', isDraft: false,
  checks: 'none', changedFiles: 12, additions: 1, deletions: 1, updatedAt: '', url: '', ...over,
});

suite('tour — availability of the blue button, on real repositories', () => {
  let root: string;
  let work: string;
  let settings: Record<string, unknown>;
  let prs: PullRequest[];
  let bundled: boolean;
  const posted: TourAvailabilityMessage[] = [];

  const deps = (over: Partial<AvailabilityDeps> = {}): AvailabilityDeps => ({
    workspaceRoot: () => work, exec: defaultExec, bundled: () => bundled,
    setting: <T>(k: string, f: T) => (k in settings ? settings[k] as T : f),
    pullRequests: () => prs, post: (m) => posted.push(m), log: () => undefined, ...over,
  });

  suiteSetup(function () { try { sh(os.tmpdir(), ['--version']); } catch { this.skip(); } });
  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-avail-'));
    const origin = path.join(root, 'origin.git');
    fs.mkdirSync(origin);
    sh(origin, ['init', '--bare', '--quiet', '-b', 'main']);
    work = path.join(root, 'work');
    fs.mkdirSync(work);
    sh(work, ['init', '--quiet', '-b', 'main']);
    commit(work, 'src/a.ts', 'export function a() {}\n', 'base');
    sh(work, ['remote', 'add', 'origin', origin]);
    sh(work, ['push', '--quiet', 'origin', 'main']);
    sh(work, ['remote', 'set-head', 'origin', 'main']);
    sh(work, ['checkout', '--quiet', '-b', 'feat/x']);
    settings = {}; prs = []; bundled = true; posted.length = 0;
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test('a branch ahead of its base: branch, with commits and files in the label', async () => {
    commit(work, 'src/b.ts', 'x\n', 'one');
    commit(work, 'src/a.ts', 'export function a() { return 1; }\n', 'two');
    assert.deepStrictEqual(await computeAvailability(deps()), {
      type: 'tour-availability', state: 'branch', branch: 'feat/x', baseRef: 'main', counts: { commits: 2, files: 2 },
      label: 'feat/x vs main · 2 commits · 2 files',
    });
  });

  test('nothing ahead: none; with tour.button always, a muted pill that says so', async () => {
    assert.deepStrictEqual(await computeAvailability(deps()), { type: 'tour-availability', state: 'none' });
    settings['tour.button'] = 'always';
    const m = await computeAvailability(deps());
    assert.deepStrictEqual([m.state, m.label, m.counts], ['branch', 'nothing to tour yet on feat/x', { commits: 0, files: 0 }]);
  });

  test('behind the base only is nothing to tour; the base branch itself never shows, not even with always', async () => {
    sh(work, ['checkout', '--quiet', 'main']);
    commit(work, 'src/c.ts', 'c\n', 'main moves');
    sh(work, ['push', '--quiet', 'origin', 'main']);
    sh(work, ['checkout', '--quiet', 'feat/x']);
    assert.strictEqual((await computeAvailability(deps())).state, 'none');
    sh(work, ['checkout', '--quiet', 'main']);
    settings['tour.button'] = 'always';
    assert.strictEqual((await computeAvailability(deps())).state, 'none');
  });

  test('a detached HEAD and a folder that is no repository show nothing', async () => {
    commit(work, 'src/b.ts', 'x\n', 'one');
    sh(work, ['checkout', '--quiet', '--detach']);
    assert.strictEqual((await computeAvailability(deps())).state, 'none');
    const plain = fs.mkdtempSync(path.join(root, 'plain-'));
    assert.strictEqual((await computeAvailability(deps({ workspaceRoot: () => plain }))).state, 'none');
    assert.strictEqual((await computeAvailability(deps({ workspaceRoot: () => undefined }))).state, 'none');
  });

  test('no remote: the local main is the base', async () => {
    sh(work, ['remote', 'remove', 'origin']);
    commit(work, 'src/b.ts', 'x\n', 'one');
    const m = await computeAvailability(deps());
    assert.deepStrictEqual([m.state, m.baseRef, m.counts], ['branch', 'main', { commits: 1, files: 1 }]);
  });

  test('an open pull request for HEAD (from the pane\'s list) wins; closed ones and other branches do not count', async () => {
    commit(work, 'src/b.ts', 'x\n', 'one');
    prs = [PR({ number: 7, headRef: 'feat/x', state: 'merged' }), PR({ number: 8, headRef: 'other' })];
    assert.strictEqual((await computeAvailability(deps())).state, 'branch');
    prs.push(PR({}));
    assert.deepStrictEqual(await computeAvailability(deps()), {
      type: 'tour-availability', state: 'pr', number: 104, branch: 'feat/x', baseRef: 'main', label: 'PR #104 · 12 files',
    });
  });

  test('not bundled, disabled and never come first, before any git call', async () => {
    const calls: string[][] = [];
    const counting: Exec = async (c, a, cwd, o) => { calls.push(a); return defaultExec(c, a, cwd, o); };
    bundled = false;
    assert.strictEqual((await computeAvailability(deps({ exec: counting }))).state, 'not-bundled');
    bundled = true;
    settings['browserView.enabled'] = false;
    assert.strictEqual((await computeAvailability(deps({ exec: counting }))).state, 'disabled');
    settings['browserView.enabled'] = true;
    settings['tour.button'] = 'never';
    assert.strictEqual((await computeAvailability(deps({ exec: counting }))).state, 'none');
    assert.deepStrictEqual(calls, []);
  });

  test('refresh posts only changes, runs one computation at a time and answers the newest request', async () => {
    const a = new TourAvailability(deps());
    await a.refresh();
    await a.refresh();
    assert.deepStrictEqual(posted.map(m => m.state), ['none'], 'unchanged: posted once');
    commit(work, 'src/b.ts', 'x\n', 'one');
    const first = a.refresh();
    prs = [PR({})];
    const second = a.refresh();
    await Promise.all([first, second]);
    assert.deepStrictEqual(posted.map(m => m.state), ['none', 'pr'], 'the request made during the run is answered, once');
    assert.strictEqual(a.current().state, 'pr');
    const broken = new TourAvailability(deps({ exec: async () => { throw new Error('spawn EMFILE'); } }));
    await broken.refresh();
    assert.strictEqual(broken.current().state, 'none', 'an error is a hidden pill, not a crash');
  });
});
