import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureCommits } from '../../ci/fetch';
import type { EnsureCommitsOptions } from '../../ci/fetch';
import { HeadTreeError } from '../../vcs/engine/headTree';
import { defaultExec } from '../../vcs/ghCliSource';
import type { Exec } from '../../vcs/ghCliSource';
import { clone, commit, makeOrigin, mergeCheckout, pile, push, sh, tempDir } from '../ciRepo';
import type { Origin } from '../ciRepo';

/** Every git argv the step ran, in order. */
function recorded(): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = (command, args, cwd, opts) => { calls.push(args); return defaultExec(command, args, cwd, { ...opts, env: { ...opts?.env, GIT_TERMINAL_PROMPT: '0' } }); };
  return { exec, calls };
}

const fetchesOf = (calls: string[][]) => calls.filter(a => a.includes('fetch'));
const isShallow = (repo: string) => sh(repo, ['rev-parse', '--is-shallow-repository']) === 'true';
const count = (repo: string, rev: string) => Number(sh(repo, ['rev-list', '--count', rev]));

suite('ci fetch: ensureCommits on real remotes', function () {
  this.timeout(60_000);
  let root: string;
  let origin: Origin;
  let forkPoint: string;
  let head: string;
  let tip: string;

  /** main: A, 100 more, B, C. feature: forks at B, adds two commits. The history reaches past the first deepen. */
  setup(() => {
    root = tempDir('cg-ci-fetch-');
    origin = makeOrigin(root);
    commit(origin.work, { 'app.py': 'def a():\n    pass\n', 'notes.txt': 'keep\n', 'unused.txt': 'never read\n' }, 'A');
    pile(origin.work, 'main', 100);
    forkPoint = commit(origin.work, { 'app.py': 'def a():\n    return 1\n' }, 'B');
    sh(origin.work, ['switch', '--quiet', '-c', 'feature']);
    commit(origin.work, { 'lib.py': 'def b():\n    pass\n' }, 'F1');
    head = commit(origin.work, { 'lib.py': 'def b():\n    return 2\n', 'notes.txt': 'changed\n' }, 'F2');
    sh(origin.work, ['switch', '--quiet', 'main']);
    tip = commit(origin.work, { 'app.py': 'def a():\n    return 3\n' }, 'C');
    push(origin, 'main', 'feature');
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  const run = (repoRoot: string, extra: Partial<EnsureCommitsOptions> = {}) => {
    const rec = recorded();
    return { rec, done: ensureCommits({ repoRoot, head, base: tip, baseRef: 'main', headRef: 'feature', exec: rec.exec, ...extra }) };
  };

  test('a default checkout, one merge commit at depth 1: both sides and the merge base arrive', async () => {
    const repo = mergeCheckout(root, origin, head, tip);
    assert.deepStrictEqual(await run(repo).done, { head, mergeBase: forkPoint, targetTip: tip });
    assert.ok(isShallow(repo), 'it stays shallow: only what the tour needs came');
  });

  test('`git init` and nothing else: no whole history comes down', async () => {
    const fresh = tempDir('cg-ci-init-');
    try {
      sh(fresh, ['init', '--quiet']);
      sh(fresh, ['remote', 'add', 'origin', origin.url]);
      const { done, rec } = run(fresh);
      assert.deepStrictEqual(await done, { head, mergeBase: forkPoint, targetTip: tip });
      assert.ok(fetchesOf(rec.calls)[0].includes('--depth=1'), 'the first fetch is shallow');
      assert.ok(isShallow(fresh));
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('depth 50 of the head: the base comes at depth 1 and one deepen meets the fork point', async () => {
    const repo = clone(root, origin, '--depth=50', '--branch=feature', '--single-branch');
    const { done, rec } = run(repo);
    assert.deepStrictEqual(await done, { head, mergeBase: forkPoint, targetTip: tip });
    assert.strictEqual(fetchesOf(rec.calls).filter(a => a.some(x => x.startsWith('--deepen='))).length, 1);
  });

  test('a branch far behind its target: deepening grows until the two sides meet', async () => {
    const far = pile(origin.work, 'main', 300);
    push(origin, 'main');
    const repo = mergeCheckout(root, origin, head, far);
    const { done, rec } = run(repo, { base: far });
    assert.deepStrictEqual(await done, { head, mergeBase: forkPoint, targetTip: far });
    const steps = fetchesOf(rec.calls).map(a => a.find(x => x.startsWith('--deepen='))).filter(Boolean);
    assert.deepStrictEqual(steps, ['--deepen=32', '--deepen=128', '--deepen=512'], 'grown by four, and stopped when they met');
  });

  test('unrelated histories: the whole history comes, there is no merge base, and head is still good', async () => {
    sh(origin.work, ['switch', '--quiet', '--orphan', 'island']);
    const lone = commit(origin.work, { 'lone.py': 'def l():\n    pass\n' }, 'island');
    sh(origin.work, ['switch', '--quiet', 'main']);
    push(origin, 'island');
    const repo = mergeCheckout(root, origin, lone, tip);
    const logged: string[] = [];
    const { done, rec } = run(repo, { head: lone, headRef: 'island', log: l => logged.push(l) });
    assert.deepStrictEqual(await done, { head: lone, mergeBase: null, targetTip: tip });
    assert.ok(!isShallow(repo), 'the history ended');
    assert.ok(fetchesOf(rec.calls).filter(a => a.some(x => x.startsWith('--deepen='))).length <= 2, 'it stops when the history does, not after eight rounds');
    assert.ok(logged.some(l => l.includes('no merge base')), logged.join('|'));
  });

  test('out of budget: no deepening starts, and the tour goes on head-only', async () => {
    const repo = mergeCheckout(root, origin, head, tip);
    const { done, rec } = run(repo, { budgetMs: 0 });
    assert.deepStrictEqual(await done, { head, mergeBase: null, targetTip: tip });
    assert.strictEqual(fetchesOf(rec.calls).filter(a => a.some(x => x.startsWith('--deepen='))).length, 0);
  });

  test('REGRESSION: a complete clone stays complete, --depth would have cut it', async () => {
    const repo = clone(root, origin);
    const fresh = commit(origin.work, { 'more.py': 'def m():\n    pass\n' }, 'D');
    push(origin, 'main');
    const { done, rec } = run(repo, { base: fresh });
    assert.deepStrictEqual(await done, { head, mergeBase: forkPoint, targetTip: fresh });
    assert.ok(!fetchesOf(rec.calls).some(a => a.includes('--depth=1')), 'no --depth on a complete clone');
    assert.ok(!isShallow(repo));
    assert.strictEqual(count(repo, fresh), 104);
  });

  test('REGRESSION: a target tip the checkout holds deeper is not shortened', async () => {
    const repo = clone(root, origin, '--depth=50', '--no-single-branch');
    assert.ok(isShallow(repo));
    const before = fs.existsSync(path.join(repo, '.git', 'shallow')) ? fs.readFileSync(path.join(repo, '.git', 'shallow'), 'utf8') : '';
    const { done, rec } = run(repo);
    assert.deepStrictEqual(await done, { head, mergeBase: forkPoint, targetTip: tip });
    assert.strictEqual(fetchesOf(rec.calls).length, 0, 'it was all here: a blind --depth=1 of the tip would cut its history to one commit');
    assert.strictEqual(fs.existsSync(path.join(repo, '.git', 'shallow')) ? fs.readFileSync(path.join(repo, '.git', 'shallow'), 'utf8') : '', before);
    assert.strictEqual(count(repo, tip), 50);
  });

  test('a server that refuses a bare id: the branch brings the target, and the tip stands in for a base nobody can name', async () => {
    sh(origin.bare, ['config', 'uploadpack.allowAnySHA1InWant', 'false']);
    const repo = mergeCheckout(root, origin, head, tip);
    // Protocol v2 serves any id; version 0 is the protocol that refuses one no ref points at.
    const rec = recorded();
    const v0: Exec = (command, args, cwd, opts) => rec.exec(command, ['-c', 'protocol.version=0', ...args], cwd, opts);
    const done = await ensureCommits({ repoRoot: repo, head, base: forkPoint, baseRef: 'main', headRef: 'feature', exec: v0 });
    assert.deepStrictEqual(done, { head, mergeBase: forkPoint, targetTip: tip });
    assert.ok(fetchesOf(rec.calls).some(a => a.includes(forkPoint)), 'the id was tried first');
    assert.ok(fetchesOf(rec.calls).some(a => a.includes('refs/heads/main')), 'then the branch');
  });

  test('a server that refuses to deepen by id: the branches deepen', async () => {
    const repo = mergeCheckout(root, origin, head, tip);
    const rec = recorded();
    const refusing: Exec = async (command, args, cwd, opts) => {
      const byId = args.some(a => a.startsWith('--deepen=')) && args.some(a => /^[0-9a-f]{40}$/.test(a));
      return byId ? { code: 128, stdout: '', stderr: 'fatal: not our ref', notFound: false } : rec.exec(command, args, cwd, opts);
    };
    const done = await ensureCommits({ repoRoot: repo, head, base: tip, baseRef: 'main', headRef: 'feature', exec: refusing });
    assert.deepStrictEqual(done, { head, mergeBase: forkPoint, targetTip: tip });
    assert.ok(fetchesOf(rec.calls).some(a => a.includes('--deepen=32') && a.includes('refs/heads/main') && a.includes('refs/heads/feature')));
  });

  test('REGRESSION (F16): a hostile branch name never reaches git, and head and base still come by id', async () => {
    const repo = mergeCheckout(root, origin, head, tip);
    const planted = path.join(root, 'ran');
    const name = `--upload-pack=touch ${planted}`;
    const { done, rec } = run(repo, { baseRef: name, headRef: name });
    assert.deepStrictEqual(await done, { head, mergeBase: forkPoint, targetTip: null });
    assert.ok(!fs.existsSync(planted), 'the name ran as an option');
    assert.ok(!rec.calls.flat().some(a => a.includes('upload-pack')), 'it never reached an argv');
  });

  test('REGRESSION (F16): what follows `--` is the remote and then ids or refs/heads/ only', async () => {
    const repo = mergeCheckout(root, origin, head, tip);
    const { done, rec } = run(repo);
    await done;
    const fetches = fetchesOf(rec.calls);
    assert.ok(fetches.length >= 2);
    for (const args of [...fetches, ...rec.calls.filter(a => a[0] === 'ls-remote')]) {
      const [remote, ...what] = args.slice(args.indexOf('--') + 1);
      assert.strictEqual(remote, 'origin', args.join(' '));
      assert.ok(what.every(w => /^[0-9a-f]{40}$/.test(w) || w.startsWith('refs/heads/')), args.join(' '));
    }
  });

  test('a short base id, as a platform may give one, resolves through its branch', async () => {
    const repo = mergeCheckout(root, origin, head, tip);
    const { done, rec } = run(repo, { base: tip.slice(0, 12) });
    assert.deepStrictEqual(await done, { head, mergeBase: forkPoint, targetTip: tip });
    assert.ok(!rec.calls.flat().includes(tip.slice(0, 12)), 'a short id is no refspec');
  });

  test('a target branch that is gone, as a merged stack leaves it, is no tip and no failure', async () => {
    const repo = mergeCheckout(root, origin, head, tip);
    const logged: string[] = [];
    assert.deepStrictEqual(await run(repo, { baseRef: 'deleted/stack', log: l => logged.push(l) }).done, { head, mergeBase: forkPoint, targetTip: null });
    assert.ok(logged.some(l => l.includes('not on the remote')), logged.join('|'));
  });

  test('a base the remote no longer has falls back to the target tip', async () => {
    const repo = mergeCheckout(root, origin, head, tip);
    assert.deepStrictEqual(await run(repo, { base: 'a'.repeat(40) }).done, { head, mergeBase: forkPoint, targetTip: tip });
  });

  test('a head nobody can bring throws; a base nobody can bring does not', async () => {
    const repo = mergeCheckout(root, origin, head, tip);
    await assert.rejects(run(repo, { head: 'a'.repeat(40), headRef: undefined }).done, (e: HeadTreeError) => e.kind === 'no-such-ref');
    await ensureCommits({ repoRoot: repo, head, base: head, exec: recorded().exec });
    sh(repo, ['remote', 'set-url', 'origin', path.join(root, 'gone.git')]);
    assert.deepStrictEqual(await run(repo, { base: 'a'.repeat(40) }).done, { head, mergeBase: null, targetTip: null });
  });

  test('anything but a hexadecimal id is refused before git runs', async () => {
    const { done, rec } = run(root, { head: '--upload-pack=x' });
    await assert.rejects(done, /must be commit ids/);
    assert.strictEqual(rec.calls.length, 0);
    await assert.rejects(run(root, { base: 'main' }).done, /must be commit ids/);
  });

  test('a remote URL with a token in git\'s error stays out of the log', async () => {
    const repo = mergeCheckout(root, origin, head, tip);
    const logged: string[] = [];
    const leaky: Exec = async (command, args, cwd, opts) => {
      if (args[0] === 'ls-remote') { return { code: 128, stdout: '', stderr: "fatal: unable to access 'https://x-access-token:SECRET@host/r.git/'\n", notFound: false }; }
      return recorded().exec(command, args, cwd, opts);
    };
    await ensureCommits({ repoRoot: repo, head, base: tip, baseRef: 'main', exec: leaky, log: l => logged.push(l) });
    assert.ok(logged.some(l => l.includes('//***@host')), logged.join('|'));
    assert.ok(!logged.join('\n').includes('SECRET'));
  });

  test('a cancel stops at once and is not mistaken for a failure', async () => {
    const repo = mergeCheckout(root, origin, head, tip);
    await assert.rejects(run(repo, { signal: AbortSignal.abort() }).done, (e: HeadTreeError) => e.kind === 'cancelled');
  });

  suite('a blobless clone', () => {
    const missing = (repo: string, oid: string) => sh(repo, ['cat-file', '--batch-check'], `${oid}\n`, { GIT_NO_LAZY_FETCH: '1' }).endsWith('missing');
    const blob = (rev: string, rel: string) => sh(origin.work, ['rev-parse', `${rev}:${rel}`]);

    test('`fetch` brings in one request what build reads, and nothing else, and build needs no remote after it', async () => {
      const repo = clone(root, origin, '--filter=blob:none', '--no-checkout');
      commit(origin.work, { '.cograph/tour.json': '{"version":1}\n' }, 'team file');
      push(origin, 'main');
      const newTip = sh(origin.work, ['rev-parse', 'main']);
      assert.ok(missing(repo, blob(head, 'lib.py')), 'a blobless clone starts without blobs');
      const { done, rec } = run(repo, { base: newTip });
      assert.deepStrictEqual(await done, { head, mergeBase: forkPoint, targetTip: newTip });
      assert.strictEqual(fetchesOf(rec.calls).filter(a => a.includes('--stdin')).length, 1, 'one batch, not one fetch per object');
      for (const [rev, rel] of [[head, 'lib.py'], [head, 'app.py'], [forkPoint, 'app.py'], [head, 'notes.txt'], [forkPoint, 'notes.txt'], [newTip, '.cograph/tour.json']]) {
        assert.ok(!missing(repo, blob(rev, rel)), `${rel} at ${rev.slice(0, 7)} is here`);
      }
      assert.ok(missing(repo, blob(head, 'unused.txt')), 'a file no step reads stays on the remote');
    });

    test('an older git marks a partial clone in extensions.partialClone: found all the same', async () => {
      const repo = clone(root, origin, '--filter=blob:none', '--no-checkout');
      sh(repo, ['config', '--unset', 'remote.origin.promisor']);
      sh(repo, ['config', 'extensions.partialClone', 'origin']);
      const { done, rec } = run(repo);
      await done;
      assert.strictEqual(fetchesOf(rec.calls).filter(a => a.includes('--stdin')).length, 1);
    });

    test('a clone that is not partial asks git nothing about blobs', async () => {
      const repo = mergeCheckout(root, origin, head, tip);
      const { done, rec } = run(repo);
      await done;
      assert.ok(!rec.calls.some(a => a[0] === 'cat-file'));
      assert.ok(!fetchesOf(rec.calls).some(a => a.includes('--stdin')));
    });

    test('git refusing the batch is the one failure that stops `fetch`', async () => {
      const repo = clone(root, origin, '--filter=blob:none', '--no-checkout');
      const refusing: Exec = async (command, args, cwd, opts) => (args.includes('--stdin') ? { code: 128, stdout: '', stderr: 'fatal: no', notFound: false } : recorded().exec(command, args, cwd, opts));
      await assert.rejects(ensureCommits({ repoRoot: repo, head, base: tip, baseRef: 'main', exec: refusing }), (e: HeadTreeError) => e.kind === 'fetch-failed');
    });
  });
});
