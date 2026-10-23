import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTourHostApi, printCommand, shownBody, tourModel } from '../../tour/tourHostApi';
import type { TourHostDeps } from '../../tour/tourHostApi';
import { defaultExec } from '../../vcs/ghCliSource';
import type { Exec, ExecResult } from '../../vcs/ghCliSource';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '', notFound: false });
const SHA = 'a'.repeat(40);

interface Harness {
  deps: TourHostDeps;
  calls: Array<{ command: string; args: string[]; cwd: string; bodyFile?: string }>;
  confirms: Array<{ message: string; detail: string; action: string }>;
  opened: Array<[string, string, number, any?]>;
  lines: string[];
  settings: Record<string, unknown>;
  answer: { confirm: boolean };
}

function harness(repoRoot: string, storageDir: string, replies: (command: string, args: string[]) => ExecResult = () => ok()): Harness {
  const h: Harness = { calls: [], confirms: [], opened: [], lines: [], settings: {}, answer: { confirm: true } } as any;
  const exec: Exec = async (command, args, cwd) => {
    const file = args.find((a, i) => args[i - 1] === '--body-file');
    h.calls.push({ command, args, cwd, ...(file ? { bodyFile: fs.readFileSync(file, 'utf8') } : {}) });
    return replies(command, args);
  };
  h.deps = {
    repoRoot, storageDir, exec,
    appendLine: (l) => h.lines.push(l),
    setting: <T>(key: string, fallback: T) => (key in h.settings ? h.settings[key] as T : fallback),
    prepareDiff: async () => ({ target: { kind: 'branch' } } as any),
    confirm: async (message, detail, action) => { h.confirms.push({ message, detail, action }); return h.answer.confirm; },
    runJson: async (providerId, req) => ({ data: { providerId, prompt: req.prompt } }),
    loadAnnotations: () => null,
    openFile: async (kind, absPath, line, copy) => { h.opened.push([kind, absPath, line, copy]); },
    openExternal: async (url) => { h.opened.push(['external', url, 0]); },
    notify: () => undefined,
  };
  return h;
}

/** git remote -v answers with a GitHub origin; everything else succeeds quietly. */
const withRemote = (more: (c: string, a: string[]) => ExecResult | null = () => null) => (command: string, args: string[]) =>
  (command === 'git' && args[0] === 'remote' ? ok('origin\tgit@github.com:o/r.git (fetch)\n') : more(command, args) ?? ok());

suite('tour — the TourHostApi the extension injects', () => {
  let root: string;
  let repo: string;
  let storage: string;

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-hostapi-'));
    repo = path.join(root, 'repo');
    storage = path.join(root, 'storage');
    fs.mkdirSync(repo);
    fs.mkdirSync(storage);
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test('version, roots, settings and the [tour] log line', () => {
    const h = harness(repo, storage);
    h.settings['tour.chapters'] = ['overview'];
    const api = createTourHostApi(h.deps);
    assert.deepStrictEqual([api.version, api.repoRoot, api.storageDir], [1, repo, storage]);
    assert.deepStrictEqual(api.settings('tour.chapters', []), ['overview']);
    assert.strictEqual(api.settings('tour.maxStepsPerChapter', 12), 12);
    api.log('hello');
    assert.deepStrictEqual(h.lines, ['[tour] hello']);
  });

  test('ai is null while AI features are off, and follows the setting live; the gate is a modal', async () => {
    const h = harness(repo, storage);
    const api = createTourHostApi(h.deps);
    assert.strictEqual(api.ai, null);
    h.settings['graphIntelligence.enabled'] = true;
    const ai = api.ai!;
    assert.ok(ai);
    assert.deepStrictEqual([ai.enabled(), ai.providerId(), ai.model()], [true, 'claude-code', 'haiku']);
    h.answer.confirm = false;
    assert.strictEqual(await ai.confirmGate('Sends 12 hunks, at most $0.50.'), false);
    assert.deepStrictEqual(h.confirms[0], { message: 'CoGraph PR tour: send this to the AI?', detail: 'Sends 12 hunks, at most $0.50.', action: 'Continue' });
    h.settings['graphIntelligence.provider'] = 'codex';
    assert.deepStrictEqual((await ai.runJson({ prompt: 'p' } as any)).data, { providerId: 'codex', prompt: 'p' });
    h.settings['graphIntelligence.enabled'] = false;
    assert.strictEqual(api.ai, null, 'switched off mid-tour: gone');
  });

  test('the model: tour.ai.model, inherit takes Annotate\'s, another provider\'s model falls back, default is the CLI\'s', () => {
    const s = (m: Record<string, unknown>) => <T>(k: string, f: T) => (k in m ? m[k] as T : f);
    assert.strictEqual(tourModel(s({}), 'claude-code'), 'haiku');
    assert.strictEqual(tourModel(s({ 'graphIntelligence.annotate.model': 'sonnet' }), 'claude-code'), 'sonnet');
    assert.strictEqual(tourModel(s({ 'tour.ai.model': 'opus' }), 'claude-code'), 'opus');
    assert.strictEqual(tourModel(s({ 'tour.ai.model': 'opus' }), 'codex'), 'gpt-5-mini', 'a Claude alias is not passed to Codex');
    assert.strictEqual(tourModel(s({ 'tour.ai.model': 'gpt-5' }), 'codex'), 'gpt-5');
    assert.strictEqual(tourModel(s({ 'tour.ai.model': 'default' }), 'claude-code'), undefined);
  });

  test('push: a native confirmation with the exact command first; declined changes nothing', async () => {
    const h = harness(repo, storage, withRemote());
    const api = createTourHostApi(h.deps);
    h.answer.confirm = false;
    assert.deepStrictEqual(await api.git.push('feat/x'), { ok: false, reason: 'cancelled' });
    assert.deepStrictEqual(h.confirms[0], { message: 'Push feat/x to origin?', detail: 'git push -u origin feat/x', action: 'Run' });
    assert.ok(!h.calls.some(c => c.args[0] === 'push'), 'nothing pushed');
    h.answer.confirm = true;
    assert.deepStrictEqual(await api.git.push('feat/x'), { ok: true, remote: 'origin' });
    const push = h.calls.find(c => c.args[0] === 'push')!;
    assert.deepStrictEqual([push.command, push.args, push.cwd], ['git', ['push', '-u', 'origin', 'feat/x'], repo], 'an argument array, never a shell');
    h.confirms.length = 0;
    for (const bad of ['-f', 'a..b', 'x;rm -rf /', '']) {
      assert.strictEqual((await api.git.push(bad)).ok, false, bad);
    }
    assert.strictEqual(h.confirms.length, 0, 'a bad name is refused before anything is asked');
  });

  test('push failures come back as the first line git printed', async () => {
    const h = harness(repo, storage, withRemote((c, a) => (a[0] === 'push' ? { code: 1, stdout: '', stderr: '\nerror: failed to push some refs\nhint: …', notFound: false } : null)));
    assert.deepStrictEqual(await createTourHostApi(h.deps).git.push('feat/x'), { ok: false, reason: 'error: failed to push some refs' });
    assert.ok(h.lines.some(l => l.startsWith('[tour] git push failed')));
  });

  test('createPr: the confirmation shows title, body and command; gh gets the body from a file that is gone afterwards', async () => {
    let bodyPath = '';
    const h = harness(repo, storage, (c, a) => {
      if (c === 'gh') { bodyPath = a[a.indexOf('--body-file') + 1]; return ok('Creating pull request…\nhttps://github.com/o/r/pull/104\n'); }
      return ok();
    });
    const api = createTourHostApi(h.deps);
    const title = '-x `rm -rf` $(whoami) "quoted"';
    const body = '## What\nThe doorway.\n\n$(not a command)';
    const res = await api.git.createPr({ title, body, base: 'main', head: 'feat/x', draft: true });
    assert.deepStrictEqual(res, { ok: true, number: 104, url: 'https://github.com/o/r/pull/104' });
    const call = h.calls.find(c => c.command === 'gh')!;
    assert.deepStrictEqual(call.args, ['pr', 'create', `--title=${title}`, '--body-file', bodyPath, '--base', 'main', '--head', 'feat/x', '--draft']);
    assert.strictEqual(call.bodyFile, body, 'the body went through the file, byte for byte');
    assert.ok(!fs.existsSync(bodyPath), 'the temporary file is removed');
    const shown = h.confirms[0];
    assert.strictEqual(shown.message, `Create the pull request "${title}"?`);
    assert.ok(shown.detail.startsWith(printCommand('gh', ['pr', 'create', `--title=${title}`, '--body-file', '<body below>', '--base', 'main', '--head', 'feat/x', '--draft'])));
    assert.ok(shown.detail.endsWith(body));
    h.answer.confirm = false;
    const before = h.calls.length;
    assert.deepStrictEqual(await api.git.createPr({ title, body, base: 'main', head: 'feat/x', draft: false }), { ok: false, reason: 'cancelled' });
    assert.strictEqual(h.calls.length, before, 'declined: gh never ran');
    assert.strictEqual((await api.git.createPr({ title, body, base: '--evil', head: 'feat/x', draft: false })).ok, false);
  });

  test('createPr without a URL in gh\'s output is a failure, not a guess', async () => {
    const h = harness(repo, storage, (c) => (c === 'gh' ? ok('done\n') : ok()));
    const res = await createTourHostApi(h.deps).git.createPr({ title: 't', body: 'b', base: 'main', head: 'x', draft: false });
    assert.strictEqual(res.ok, false);
  });

  test('editPrBody and commentPr: confirmed, through a body file, numbers checked', async () => {
    const h = harness(repo, storage, (c, a) => (a[1] === 'comment' ? ok('https://github.com/o/r/pull/7#issuecomment-1\n') : ok()));
    const api = createTourHostApi(h.deps);
    assert.deepStrictEqual(await api.git.editPrBody(7, 'new body'), { ok: true });
    assert.deepStrictEqual(await api.git.commentPr(7, 'a note'), { ok: true, url: 'https://github.com/o/r/pull/7#issuecomment-1' });
    const gh = h.calls.filter(c => c.command === 'gh');
    assert.deepStrictEqual(gh.map(c => c.args.slice(0, 4)), [['pr', 'edit', '7', '--body-file'], ['pr', 'comment', '7', '--body-file']]);
    assert.deepStrictEqual(gh.map(c => c.bodyFile), ['new body', 'a note']);
    assert.deepStrictEqual(h.confirms.map(c => c.message), ['Replace the description of pull request #7?', 'Comment on pull request #7?']);
    assert.strictEqual((await api.git.editPrBody(-1, 'x')).ok, false);
    assert.strictEqual((await api.git.commentPr(1.5, 'x')).ok, false);
    h.answer.confirm = false;
    assert.deepStrictEqual(await api.git.commentPr(7, 'x'), { ok: false, reason: 'cancelled' });
  });

  test('the confirmation cuts a very long body and says how much is left', () => {
    const long = 'x'.repeat(3500);
    assert.ok(shownBody(long).endsWith('… (500 more characters)'));
    assert.strictEqual(shownBody('short'), 'short');
    assert.strictEqual(printCommand('gh', ['pr', 'view', 'a b', '--x=1']), 'gh pr view "a b" --x=1');
  });

  test('readFileAtRef reads a committed file from the objects, within the byte cap, and nothing outside the tree', async function () {
    this.timeout(20_000);
    const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' };
    const git = (args: string[]) => cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();
    git(['init', '--quiet', '-b', 'main']);
    fs.mkdirSync(path.join(repo, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.github/workflows/ci.yml'), 'on: push\n');
    fs.writeFileSync(path.join(repo, 'big.txt'), 'y'.repeat(5000));
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'c']);
    const sha = git(['rev-parse', 'HEAD']);
    const api = createTourHostApi({ ...harness(repo, storage).deps, exec: defaultExec });
    assert.strictEqual(await api.readFileAtRef(sha, '.github/workflows/ci.yml', 1000), 'on: push\n');
    assert.strictEqual(await api.readFileAtRef(sha, 'big.txt', 4999), null, 'above the cap');
    assert.strictEqual((await api.readFileAtRef(sha, 'big.txt', 5000))?.length, 5000);
    assert.strictEqual(await api.readFileAtRef(sha, 'missing.txt', 1000), null);
    for (const bad of ['../x', '/etc/passwd', 'a//b', '']) { assert.strictEqual(await api.readFileAtRef(sha, bad, 1000), null, bad); }
    assert.strictEqual(await api.readFileAtRef('HEAD', 'big.txt', 9999), null, 'a sha, not a ref name');
  });

  test('impact runs over a head graph in memory, rooted at its copy; funcBrief reads only the repository and its copies', () => {
    const copy = path.join(storage, 'k3y', SHA);
    const file = path.join(copy, 'src', 'a.ts');
    const test = path.join(copy, 'test', 'a.test.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '/** Adds. */\nexport function leaf() {\n  return 1;\n}\nexport function mid() { return leaf(); }\n');
    const id = (f: string, n: string, l: number) => `${f}::${n}::${l}`;
    const graph = {
      nodes: [
        { id: id(file, 'leaf', 2), name: 'leaf', file, line: 2 }, { id: id(file, 'mid', 5), name: 'mid', file, line: 5 },
        { id: id(test, 'testMid', 1), name: 'testMid', file: test, line: 1 },
      ],
      edges: [{ source: id(file, 'mid', 5), target: id(file, 'leaf', 2) }, { source: id(test, 'testMid', 1), target: id(file, 'mid', 5) }],
    };
    const api = createTourHostApi(harness(repo, storage).deps);
    const r = api.impact(graph, [id(file, 'leaf', 2), 'unknown']);
    assert.deepStrictEqual(r.seeds.map(s => s.rel), ['src/a.ts'], 'relative to the copy, not the storage');
    assert.deepStrictEqual(r.affected.map(a => [a.sym.name, a.depth]), [['mid', 1], ['testMid', 2]]);
    assert.deepStrictEqual(r.tests.map(s => s.rel), ['test/a.test.ts']);
    const brief = api.funcBrief(file, 2, 8);
    assert.ok(brief.ok && brief.signature.startsWith('export function leaf'));
    const outside = path.join(root, 'elsewhere.ts');
    fs.writeFileSync(outside, 'export function x() {}\n');
    assert.deepStrictEqual(api.funcBrief(outside, 1, 8), { ok: false, error: 'outside the repository and its copies' });
  });

  test('annotations: null when there are none, summaries only when there are', () => {
    const h = harness(repo, storage);
    assert.strictEqual(createTourHostApi(h.deps).annotations(), null);
    h.deps.loadAnnotations = () => ({ version: 1, provider: 'p', model: 'm', generatedAt: '', files: { 'src/a.ts': { summary: 'A.', hash: 'h', size: 1, mtimeMs: 1, at: '' } }, folders: { src: { summary: 'S.', childrenHash: 'c', at: '' } } });
    assert.deepStrictEqual(createTourHostApi(h.deps).annotations(), { files: { 'src/a.ts': { summary: 'A.' } }, folders: { src: { summary: 'S.' } } });
  });

  test('navigate: the user\'s file, a copy read-only, the user\'s own file when the copy is HEAD; nothing outside', async () => {
    let head = 'b'.repeat(40);
    const h = harness(repo, storage, (c, a) => (a[0] === 'rev-parse' ? ok(head + '\n') : ok()));
    const api = createTourHostApi(h.deps);
    const own = path.join(repo, 'src', 'a.ts');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, 'x');
    const copied = path.join(storage, 'k3y', SHA, 'src', 'a.ts');
    await api.navigate(own, 3);
    await api.navigate(copied, 0);
    head = SHA;
    await api.navigate(copied, 9);
    await api.navigate('/etc/passwd', 1);
    await api.openExternal('file:///etc/passwd');
    await api.openExternal('https://github.com/o/r/pull/1');
    assert.deepStrictEqual(h.opened, [
      ['user', own, 3, undefined],
      ['copy', copied, 1, { root: path.join(storage, 'k3y', SHA), label: `tour · ${SHA.slice(0, 7)}` }],
      ['user', own, 9, undefined],
      ['external', 'https://github.com/o/r/pull/1', 0],
    ]);
    assert.ok(h.lines.some(l => /navigate refused/.test(l)) && h.lines.some(l => /openExternal refused/.test(l)));
  });
});
