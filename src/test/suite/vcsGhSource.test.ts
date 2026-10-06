import * as assert from 'assert';
import { parsePatchHunks } from '../../vcs/prPatch';
import {
  GhCliSource, classifyGhFailure, firstRemoteHost, parsePaginatedArrays, remoteHost, rollupChecks,
  toPrFile, toPullRequest,
} from '../../vcs/ghCliSource';
import type { Exec, ExecResult } from '../../vcs/ghCliSource';

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', notFound: false });
const fail = (stderr: string, code = 1): ExecResult => ({ code, stdout: '', stderr, notFound: false });
const GITHUB_REMOTE = ok('origin\tgit@github.com:acme/app.git (fetch)\norigin\tgit@github.com:acme/app.git (push)\n');

/** A fake exec that answers by the first two arguments and records every call. */
function fakeExec(answers: Record<string, ExecResult | ExecResult[]>) {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const exec: Exec = async (command, args, cwd) => {
    calls.push({ command, args, cwd });
    const key = `${command} ${args[0]}`;
    const answer = answers[key];
    if (Array.isArray(answer)) { return answer.shift() as ExecResult; }
    return answer ?? fail(`unexpected ${key}`);
  };
  return { exec, calls };
}

suite('vcs — patch → changed lines', () => {
  test('added lines between context are one stretch, in new-file numbers', () => {
    const patch = '@@ -10,4 +10,6 @@ function a() {\n ctx\n ctx\n+one\n+two\n ctx\n ctx';
    assert.deepStrictEqual(parsePatchHunks(patch), [{ start: 12, end: 13, isNew: true }]);
  });

  test('a replacement is not "new"; a pure removal lands on the line after it', () => {
    const replaced = '@@ -5,3 +5,3 @@\n ctx\n-old\n+new\n ctx';
    assert.deepStrictEqual(parsePatchHunks(replaced), [{ start: 6, end: 6, isNew: false }]);
    const removed = '@@ -5,4 +5,2 @@\n ctx\n-gone\n-gone too\n ctx';
    assert.deepStrictEqual(parsePatchHunks(removed), [{ start: 6, end: 6, isNew: false }]);
  });

  test('several hunks, several stretches per hunk, and the no-newline marker', () => {
    const patch = [
      '@@ -1,3 +1,4 @@', '+first', ' a', ' b', ' c',
      '@@ -20,5 +21,6 @@', ' x', '-y', '+Y', ' z', '+tail', '\\ No newline at end of file',
    ].join('\n');
    assert.deepStrictEqual(parsePatchHunks(patch), [
      { start: 1, end: 1, isNew: true },
      { start: 22, end: 22, isNew: false },
      { start: 24, end: 24, isNew: true },
    ]);
  });

  test('a new file is one stretch; nothing before the first hunk header counts', () => {
    assert.deepStrictEqual(parsePatchHunks('@@ -0,0 +1,3 @@\n+a\n+b\n+c'), [{ start: 1, end: 3, isNew: true }]);
    assert.deepStrictEqual(parsePatchHunks('+not a hunk\n-neither'), []);
    assert.deepStrictEqual(parsePatchHunks(''), []);
  });
});

suite('vcs — gh output parsing', () => {
  test('remote hosts: scp-like, ssh and https', () => {
    assert.strictEqual(remoteHost('git@github.com:acme/app.git'), 'github.com');
    assert.strictEqual(remoteHost('https://user@GitLab.com/acme/app.git'), 'gitlab.com');
    assert.strictEqual(remoteHost('ssh://git@git.example.dev:2222/acme/app.git'), 'git.example.dev');
    assert.strictEqual(remoteHost('/srv/git/app.git'), null);
    assert.strictEqual(firstRemoteHost(''), null, 'no remote at all');
    assert.strictEqual(firstRemoteHost('origin\t/srv/git/app.git (fetch)\n'), '', 'a remote without a host is still a remote');
  });

  test('check rollup: any failure fails, anything unfinished is pending, empty is none', () => {
    assert.strictEqual(rollupChecks([]), 'none');
    assert.strictEqual(rollupChecks(undefined), 'none');
    assert.strictEqual(rollupChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]), 'pass');
    assert.strictEqual(rollupChecks([{ status: 'COMPLETED', conclusion: 'SKIPPED' }]), 'pass');
    assert.strictEqual(rollupChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
    assert.strictEqual(rollupChecks([{ state: 'PENDING' }]), 'pending');
    assert.strictEqual(rollupChecks([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]), 'fail');
    assert.strictEqual(rollupChecks([{ state: 'ERROR' }]), 'fail');
  });

  test('a list row maps onto a PullRequest; a row without a number is dropped', () => {
    const pr = toPullRequest({
      number: 69, title: 'fix: save', author: { login: 'bela', name: 'Bela T.' }, headRefName: 'fix/save',
      baseRefName: 'main', headRefOid: 'abc', state: 'MERGED', isDraft: true, changedFiles: 13,
      additions: 932, deletions: 45, updatedAt: '2026-09-28T23:54:20Z', url: 'https://github.com/acme/app/pull/69',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    assert.deepStrictEqual(pr, {
      number: 69, title: 'fix: save', author: 'bela', headRef: 'fix/save', baseRef: 'main', headOid: 'abc',
      state: 'merged', isDraft: true, checks: 'pass', changedFiles: 13, additions: 932, deletions: 45,
      updatedAt: '2026-09-28T23:54:20Z', url: 'https://github.com/acme/app/pull/69',
    });
    assert.strictEqual(toPullRequest({ title: 'no number' }), null);
    assert.strictEqual(toPullRequest(null), null);
  });

  test('file statuses: removed → deleted, renamed keeps the old path, unchanged is dropped, no patch → no hunks', () => {
    assert.strictEqual(toPrFile({ filename: 'a.ts', status: 'removed' })?.status, 'deleted');
    assert.strictEqual(toPrFile({ filename: 'a.ts', status: 'copied' })?.status, 'added');
    const renamed = toPrFile({ filename: 'new.ts', status: 'renamed', previous_filename: 'old.ts', sha: 'f00', patch: '@@ -1 +1 @@\n-a\n+b' });
    assert.deepStrictEqual(renamed, {
      path: 'new.ts', status: 'modified', previousPath: 'old.ts', additions: 0, deletions: 0, blobSha: 'f00',
      hunks: [{ start: 1, end: 1, isNew: false }],
    });
    assert.strictEqual(toPrFile({ filename: 'big.bin', status: 'modified' })?.hunks, null);
    assert.strictEqual(toPrFile({ filename: 'same.ts', status: 'unchanged' }), null);
    assert.strictEqual(toPrFile({ status: 'added' }), null);
  });

  test('paginated output: pages back to back, brackets inside strings ignored', () => {
    const text = '[{"filename":"a]b[.ts","patch":"x \\" ] y"}]\n[{"filename":"c.ts"}][]';
    assert.deepStrictEqual(parsePaginatedArrays(text), [{ filename: 'a]b[.ts', patch: 'x " ] y' }, { filename: 'c.ts' }]);
    assert.deepStrictEqual(parsePaginatedArrays(''), []);
    assert.deepStrictEqual(parsePaginatedArrays('{"message":"Not Found"}'), [], 'a lone object is not a page of files');
  });
});

suite('vcs — every gh failure is a named situation', () => {
  const kind = (res: ExecResult, host: string | null = 'github.com') => classifyGhFailure(res, host).kind;

  test('gh missing: ENOENT, and the shell\'s own wording on Windows and POSIX', () => {
    assert.strictEqual(kind({ code: null, stdout: '', stderr: 'spawn gh ENOENT', notFound: true }), 'gh-missing');
    assert.strictEqual(kind(fail("'gh' is not recognized as an internal or external command,")), 'gh-missing');
    assert.strictEqual(kind(fail('sh: 1: gh: command not found', 127)), 'gh-missing');
  });

  test('a non-GitHub remote wins over the sign-in hint the same message carries', () => {
    const res = fail('none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`');
    const problem = classifyGhFailure(res, 'gitlab.com');
    assert.strictEqual(problem.kind, 'not-github');
    assert.ok(problem.message.includes('gitlab.com'));
  });

  test('not signed in, no access, offline, and the rest', () => {
    assert.strictEqual(kind(fail('To get started with GitHub CLI, please run:  gh auth login')), 'gh-unauthenticated');
    assert.strictEqual(kind(fail('HTTP 401: Bad credentials (https://api.github.com/graphql)')), 'gh-unauthenticated');
    assert.strictEqual(kind(fail("GraphQL: Could not resolve to a Repository with the name 'acme/secret'. (repository)")), 'no-access');
    assert.strictEqual(kind(fail('gh: Not Found (HTTP 404)')), 'no-access');
    assert.strictEqual(kind(fail('error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com')), 'offline');
    assert.strictEqual(kind(fail('dial tcp: lookup api.github.com: no such host')), 'offline');
    assert.strictEqual(kind(fail('HTTP 403: API rate limit exceeded for user ID 1.')), 'error');
    const other = classifyGhFailure(fail('something new\nsecond line'), 'github.com');
    assert.deepStrictEqual([other.kind, other.detail], ['error', 'something new']);
  });
});

suite('vcs — GhCliSource', () => {
  const ROW = { number: 1, title: 't', author: { login: 'a' }, headRefName: 'h', baseRefName: 'main', state: 'OPEN', changedFiles: 2 };

  test('not a repository and no remote are answered by git alone — gh is never run', async () => {
    const notRepo = fakeExec({ 'git remote': fail('fatal: not a git repository (or any of the parent directories): .git', 128) });
    const a = await new GhCliSource(notRepo.exec).list('/ws', { state: 'open', limit: 50 });
    assert.deepStrictEqual([a.ok, !a.ok && a.problem.kind], [false, 'not-a-repo']);
    assert.strictEqual(notRepo.calls.length, 1);

    const noRemote = fakeExec({ 'git remote': ok('') });
    const b = await new GhCliSource(noRemote.exec).list('/ws', { state: 'open', limit: 50 });
    assert.strictEqual(!b.ok && b.problem.kind, 'no-remote');
    assert.strictEqual(noRemote.calls.length, 1);
  });

  test('list asks for one more than the limit to know whether more exist, and never uses a shell string', async () => {
    const rows = [1, 2, 3].map(n => ({ ...ROW, number: n }));
    const { exec, calls } = fakeExec({ 'git remote': GITHUB_REMOTE, 'gh pr': ok(JSON.stringify(rows)) });
    const res = await new GhCliSource(exec).list('/ws', { state: 'all', limit: 2 });
    assert.ok(res.ok);
    assert.deepStrictEqual(res.pullRequests.map(p => p.number), [1, 2]);
    assert.strictEqual(res.truncated, true);
    const gh = calls[1];
    assert.deepStrictEqual(gh.args.slice(0, 6), ['pr', 'list', '--state', 'all', '--limit', '3']);
    assert.ok(gh.args[7].includes('statusCheckRollup'));
    assert.strictEqual(gh.cwd, '/ws');
  });

  test('an unknown state filter falls back to open; a silly limit is clamped', async () => {
    const { exec, calls } = fakeExec({ 'git remote': GITHUB_REMOTE, 'gh pr': ok('[]') });
    const res = await new GhCliSource(exec).list('/ws', { state: 'bogus; rm -rf' as never, limit: 1e9 });
    assert.ok(res.ok && res.pullRequests.length === 0 && !res.truncated);
    assert.deepStrictEqual(calls[1].args.slice(2, 6), ['--state', 'open', '--limit', '1001']);
  });

  test('when the query with checks fails for an unknown reason it is retried without them', async () => {
    const { exec, calls } = fakeExec({
      'git remote': GITHUB_REMOTE,
      'gh pr': [fail('GraphQL: Something went wrong while executing your query'), ok(JSON.stringify([ROW]))],
    });
    const res = await new GhCliSource(exec).list('/ws', { state: 'open', limit: 50 });
    assert.ok(res.ok && res.pullRequests[0].checks === 'none');
    assert.strictEqual(calls.length, 3);
    assert.ok(!calls[2].args[7].includes('statusCheckRollup'));
  });

  test('a named failure is not retried', async () => {
    const { exec, calls } = fakeExec({ 'git remote': GITHUB_REMOTE, 'gh pr': fail('HTTP 401: Bad credentials') });
    const res = await new GhCliSource(exec).list('/ws', { state: 'open', limit: 50 });
    assert.strictEqual(!res.ok && res.problem.kind, 'gh-unauthenticated');
    assert.strictEqual(calls.length, 2);
  });

  test('unreadable gh output is an error row, not a throw', async () => {
    const { exec } = fakeExec({ 'git remote': GITHUB_REMOTE, 'gh pr': ok('<html>') });
    const res = await new GhCliSource(exec).list('/ws', { state: 'open', limit: 50 });
    assert.strictEqual(!res.ok && res.problem.kind, 'error');
  });

  test('files: only an integer reaches the command line; pages are concatenated', async () => {
    const { exec, calls } = fakeExec({
      'gh api': ok('[{"filename":"src/a.ts","status":"added","sha":"1"}][{"filename":"README.md","status":"modified"}]'),
    });
    const src = new GhCliSource(exec);
    for (const bad of [0, -3, 1.5, NaN, Number('12; echo')]) {
      const r = await src.files('/ws', bad);
      assert.strictEqual(r.ok, false, `rejected ${bad}`);
    }
    assert.strictEqual(calls.length, 0, 'nothing was run for a bad number');
    const res = await src.files('/ws', 69);
    assert.ok(res.ok);
    assert.deepStrictEqual(res.files.map(f => [f.path, f.status]), [['src/a.ts', 'added'], ['README.md', 'modified']]);
    assert.strictEqual(res.truncated, false);
    assert.deepStrictEqual(calls[0].args, ['api', '--paginate', 'repos/{owner}/{repo}/pulls/69/files?per_page=100']);
  });

  test('files: a failure is classified like any other', async () => {
    const { exec } = fakeExec({ 'gh api': fail('gh: Not Found (HTTP 404)') });
    const res = await new GhCliSource(exec).files('/ws', 7);
    assert.strictEqual(!res.ok && res.problem.kind, 'no-access');
  });
});
