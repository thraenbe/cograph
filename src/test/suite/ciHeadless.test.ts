import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createHeadlessApi } from '../../ci/headlessApi';
import type { HeadlessAi, HeadlessOptions } from '../../ci/headlessApi';
import { toolEnv } from '../../ci/toolEnv';
import { ANNOTATION_VERSION } from '../../graphIntelligence/annotationTypes';
import { clone, commit, makeOrigin, push, sh, tempDir } from '../ciRepo';
import type { Origin } from '../ciRepo';

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
const PYTHON = cp.spawnSync('python3', ['--version']).status === 0 ? 'python3' : 'python';
const TEAM = (who: string) => `{"version":1,"maxStepsPerChapter":3,"who":"${who}"}\n`;
const SUMMARY = (who: string) => JSON.stringify({ version: ANNOTATION_VERSION, provider: '', model: '', generatedAt: '', files: { 'a.py': { summary: who } }, folders: {} });
const AI: HeadlessAi = { model: () => 'claude-haiku-5-5', runJson: async () => ({ ok: false, error: 'stub' } as unknown as Awaited<ReturnType<HeadlessAi['runJson']>>) };

suite('ci headless api', function () {
  this.timeout(60_000);
  let root: string;
  let origin: Origin;
  let repo: string;
  let forkPoint: string;
  let head: string;
  let tip: string;
  let logged: string[];

  /** The team's files differ on every side, so a read from the wrong one shows. */
  setup(() => {
    root = tempDir('cg-ci-headless-');
    origin = makeOrigin(root);
    const teamFiles = (who: string) => ({ '.cograph/tour.json': TEAM(who), '.cograph/annotations/annotations.json': SUMMARY(who) });
    forkPoint = commit(origin.work, { 'a.py': 'def a():\n    pass\n', ...teamFiles('fork point') }, 'base');
    sh(origin.work, ['switch', '--quiet', '-c', 'feature']);
    head = commit(origin.work, { 'a.py': 'def a():\n    return 1\n', ...teamFiles('pull request') }, 'change');
    sh(origin.work, ['switch', '--quiet', 'main']);
    tip = commit(origin.work, teamFiles('target tip'), 'target');
    push(origin, 'main', 'feature');
    repo = clone(root, origin);
    fs.mkdirSync(path.join(repo, '.cograph'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.cograph', 'tour.json'), TEAM('working tree'));
    logged = [];
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  const make = (extra: Partial<HeadlessOptions> = {}) => createHeadlessApi({
    repoRoot: repo, workDir: path.join(root, 'work'), head, base: forkPoint, configSha: tip, context: null, scriptsDir: SCRIPTS, pythonBin: PYTHON,
    sourceMode: 'slices', log: l => logged.push(l), env: { ...toolEnv(), ELECTRON_RUN_AS_NODE: '1' }, ...extra,
  });
  const prepared = async (extra: Partial<HeadlessOptions> = {}) => {
    const run = make(extra);
    await run.api.prepareTrees(run.target, () => undefined, new AbortController().signal);
    return run;
  };
  const summaryOf = (api: ReturnType<typeof make>['api']) => api.annotations()?.files['a.py']?.summary;

  test('REGRESSION (F16): tour.json comes from the target tip, not the pull request, the fork point or the working tree', async () => {
    assert.strictEqual(await make().api.teamFile?.(), TEAM('target tip'));
  });

  test('without a target tip it comes from --base, and the log says that is the weaker case', async () => {
    assert.strictEqual(await make({ configSha: undefined }).api.teamFile?.(), TEAM('fork point'));
    assert.ok(logged.some(l => l.includes('no target tip')), logged.join('|'));
  });

  test('no commit to read it from, or no such file: no team file, and the checkout is not a fallback', async () => {
    assert.strictEqual(await make({ configSha: undefined, base: null }).api.teamFile?.(), null);
    const bare = commit(origin.work, { '.cograph/tour.json': null, '.cograph/annotations/annotations.json': null }, 'none');
    push(origin, 'main');
    sh(repo, ['fetch', '--quiet', 'origin', 'main']);
    assert.strictEqual(await make({ configSha: bare }).api.teamFile?.(), null);
  });

  test('REGRESSION (F16): committed annotations come from the target tip too', async () => {
    const run = await prepared();
    assert.strictEqual(summaryOf(run.api), 'target tip');
  });

  test('annotations that do not parse, or none, are no annotations', async () => {
    const broken = commit(origin.work, { '.cograph/annotations/annotations.json': '{ not json' }, 'broken');
    push(origin, 'main');
    sh(repo, ['fetch', '--quiet', 'origin', 'main']);
    assert.strictEqual((await prepared({ configSha: broken })).api.annotations(), null);
    assert.strictEqual((await prepared({ configSha: null, base: null })).api.annotations(), null);
  });

  test('settings: AI off with no provider, on with one, and no caller turns on reading source', () => {
    const off = make({ settings: { 'tour.ai.mode': 'on', 'graphIntelligence.enabled': true, 'tour.ai.readSource': true, 'tour.chapters': ['overview'] } }).api;
    assert.strictEqual(off.settings('tour.ai.mode', 'ask'), 'off', 'a setting alone does not switch the model on');
    assert.strictEqual(off.settings('graphIntelligence.enabled', true), false);
    assert.strictEqual(off.settings('tour.ai.readSource', true), false);
    assert.strictEqual(off.settings('graphIntelligence.annotate.readSource', true), false);
    assert.deepStrictEqual(off.settings('tour.chapters', []), ['overview']);
    assert.strictEqual(off.settings('tour.maxStepsPerChapter', 12), 12, 'an unset key is its default, no environment guessing');
    const on = make({ ai: AI, settings: { 'tour.ai.mode': 'off' } }).api;
    assert.strictEqual(on.settings('tour.ai.mode', 'ask'), 'on');
    assert.strictEqual(on.settings('graphIntelligence.enabled', false), true);
  });

  test('AI: null unless a provider is given; then the API provider, whose gate answers no, so a repository\'s `ask` means no calls', async () => {
    assert.strictEqual(make().api.ai, null);
    const ai = make({ ai: AI }).api.ai;
    assert.ok(ai);
    assert.strictEqual(ai.providerId(), 'anthropic-api');
    assert.strictEqual(ai.enabled(), true);
    assert.strictEqual(ai.model(), 'claude-haiku-5-5');
    assert.strictEqual(await ai.confirmGate('anything'), false);
  });

  test('the actions of a live page are not available, and nothing opens', async () => {
    const { api } = make();
    const none = { ok: false, reason: 'not available in CI' };
    assert.deepStrictEqual(await api.git.push('main'), none);
    assert.deepStrictEqual(await api.git.createPr({ title: 't', body: 'b', base: 'main', head: 'x', draft: false }), none);
    assert.deepStrictEqual(await api.git.editPrBody(1, 'b'), none);
    assert.deepStrictEqual(await api.git.commentPr(1, 'b'), none);
    await api.openExternal('https://example.com/');
    api.notify('hello');
    assert.ok(logged.some(l => l.includes('example.com')) && logged.some(l => l.includes('hello')), logged.join('|'));
  });

  test('trees live under the work dir, the source mode is the caller\'s, and git is the only tool', async () => {
    const run = make({ sourceMode: 'none' });
    assert.strictEqual(run.api.storageDir, path.join(root, 'work', 'trees'));
    assert.strictEqual(run.api.sourceMode, 'none');
    assert.match((await run.api.exec('gh', ['auth', 'token'], repo)).stderr, /not available in CI/);
    assert.throws(() => run.trees(), /not prepared/);
  });

  test('the read helpers work on what a run prepared: a file at a ref, a slice, the impact', async () => {
    const run = await prepared();
    const trees = run.trees();
    assert.strictEqual(await run.api.readFileAtRef(head, 'a.py', 1024), 'def a():\n    return 1\n');
    assert.strictEqual(await run.api.readFileAtRef(head, '../a.py', 1024), null);
    const brief = run.api.funcBrief(path.join(trees.head.dir, 'a.py'), 1, 8);
    assert.ok(brief.ok && brief.signature === 'def a()');
    const seed = trees.head.graph.nodes.find(n => n.name === 'a');
    assert.ok(seed);
    assert.ok(run.api.impact(trees.head.graph, [seed.id]));
  });
});
