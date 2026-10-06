import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from '../../gitService';
import { scanStructure } from '../../structureScanner';
import { isAnalyzablePath } from '../../structureScanner';
import { fileInScope } from '../../subgraphScope';
import { PrController, repoRootFrom } from '../../vcs/prController';
import type { PrGraph, PrGraphView } from '../../vcs/prController';
import { buildPrView, gitBlobSha, prViewName } from '../../vcs/prView';
import { VcsSidebar } from '../../vcs/vcsSidebar';
import type { VcsStateMessage } from '../../vcs/vcsSidebar';
import type { PrFile, PrFilesResult, PrListResult, PullRequest, PullRequestSource } from '../../vcs/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SOURCES: Record<string, string> = {
  'src/main.ts': 'export function main() {}\n',
  'src/server/api.ts': 'export function api() {}\n',
  'src/server/db/q.ts': 'export function q() {}\n',
  'src/ui/view.ts': 'export function view() {}\n',
  'tools/gen.ts': 'export function gen() {}\n',
};

const PR: PullRequest = {
  number: 69, title: 'fix: a save can overwrite the wrong lines', author: 'bela', headRef: 'fix/save', baseRef: 'main',
  headOid: 'abc', state: 'open', isDraft: false, checks: 'pass', changedFiles: 3, additions: 1, deletions: 1,
  updatedAt: '2026-09-28T23:54:20Z', url: 'https://github.com/acme/app/pull/69',
};

function file(p: string, status: PrFile['status'], extra: Partial<PrFile> = {}): PrFile {
  return { path: p, status, previousPath: null, additions: 1, deletions: 0, blobSha: null, hunks: null, ...extra };
}

suite('vcs — buildPrView', () => {
  let root: string;
  const abs = (rel: string) => path.join(root, ...rel.split('/'));
  const fwd = (rel: string) => abs(rel).replace(/\\/g, '/');
  const shaOf = (rel: string) => gitBlobSha(Buffer.from(SOURCES[rel]));
  const build = (files: PrFile[], unchangedFolders: 'collapse' | 'hide' = 'collapse', repoRoot = root, ws = root) => buildPrView({
    pr: PR, files, tree: scanStructure(ws), workspaceRoot: ws, repoRoot, unchangedFolders,
    blobShaOf: (p) => { try { return gitBlobSha(fs.readFileSync(p)); } catch { return null; } },
  });

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-pr-view-'));
    for (const [rel, text] of Object.entries(SOURCES)) {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), text);
    }
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test('git blob ids match git (the empty blob and a known one)', () => {
    assert.strictEqual(gitBlobSha(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    assert.strictEqual(gitBlobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  });

  test('every folder on a path to a changed file is open, and no other', () => {
    const view = build([file('src/server/db/q.ts', 'modified'), file('tools/gen.ts', 'added')]);
    assert.deepStrictEqual(view.expand, [root, abs('src'), abs('src/server'), abs('src/server/db'), abs('tools')].sort());
    assert.ok(!view.expand.includes(abs('src/ui')), 'a folder without changes stays closed');
  });

  test('collapse keeps the whole project in scope; hide scopes to the folders that hold changes', () => {
    const files = [file('src/server/api.ts', 'modified'), file('tools/gen.ts', 'deleted')];
    assert.deepStrictEqual(build(files, 'collapse').spec, { include: ['.'], exclude: [] });
    const hidden = build(files, 'hide').spec;
    assert.deepStrictEqual(hidden, { include: ['src/server', 'tools'], exclude: [] });
    assert.strictEqual(fileInScope(hidden, 'src/server/api.ts'), true);
    assert.strictEqual(fileInScope(hidden, 'src/ui/view.ts'), false);
  });

  test('statuses are keyed like fileGitStatus and carried in the unstaged slot', () => {
    const view = build([file('src/main.ts', 'added'), file('src/ui/view.ts', 'deleted'), file('tools/gen.ts', 'modified')]);
    assert.deepStrictEqual(Object.fromEntries(view.override.files), {
      [fwd('src/main.ts')]: { unstaged: 'added', staged: null },
      [fwd('src/ui/view.ts')]: { unstaged: 'deleted', staged: null },
      [fwd('tools/gen.ts')]: { unstaged: 'modified', staged: null },
    });
  });

  test('a modified file is coloured per function only when the checkout holds the PR head\'s blob', () => {
    const hunks = [{ start: 1, end: 1, isNew: false }];
    const view = build([
      file('src/main.ts', 'modified', { blobSha: shaOf('src/main.ts'), hunks }),          // same content → exact
      file('src/ui/view.ts', 'modified', { blobSha: 'f'.repeat(40), hunks }),             // different content
      file('tools/gen.ts', 'modified', { blobSha: shaOf('tools/gen.ts'), hunks: null }),  // same content, no patch
      file('src/server/api.ts', 'modified', { blobSha: null, hunks }),                    // source does not say
    ]);
    assert.deepStrictEqual([...view.override.hunks.keys()], [fwd('src/main.ts')]);
    assert.deepStrictEqual(view.files.map(f => f.exact), [true, false, false, false]);
    assert.deepStrictEqual(view.counts, { total: 4, inGraph: 4, exact: 1, fileLevel: 3, missing: 0, other: 0 });
  });

  test('added and deleted files need no line numbers, so they are always exact', () => {
    const view = build([file('src/main.ts', 'added', { blobSha: 'f'.repeat(40) }), file('tools/gen.ts', 'deleted')]);
    assert.deepStrictEqual(view.files.map(f => f.exact), [true, true]);
    assert.strictEqual(view.override.hunks.size, 0);
  });

  test('files the graph cannot draw are counted, not dropped: absent sources and non-sources', () => {
    const view = build([
      file('src/new/feature.ts', 'added'),      // a source file this checkout does not have
      file('README.md', 'modified'),            // not a source file
      file('src/webview/styles.css', 'modified'),
      file('dist/bundle.js', 'modified'),       // a skipped folder
      file('types/api.d.ts', 'added'),          // declaration files are not analysed
      file('src/main.ts', 'modified'),
    ]);
    assert.deepStrictEqual(view.files.map(f => f.place), ['missing', 'other', 'other', 'other', 'other', 'graph']);
    assert.deepStrictEqual([view.counts.inGraph, view.counts.missing, view.counts.other], [1, 1, 4]);
    assert.strictEqual(view.override.files.size, 1);
  });

  test('a rename is coloured at the new path, or at the old one when only that exists here', () => {
    const atNew = build([file('src/main.ts', 'modified', { previousPath: 'src/old.ts' })]);
    assert.deepStrictEqual([...atNew.override.files.keys()], [fwd('src/main.ts')]);
    const atOld = build([file('src/renamed.ts', 'modified', { previousPath: 'src/ui/view.ts', blobSha: shaOf('src/ui/view.ts'), hunks: [] })]);
    assert.deepStrictEqual([...atOld.override.files.keys()], [fwd('src/ui/view.ts')]);
    assert.deepStrictEqual(atOld.files[0], { path: 'src/renamed.ts', status: 'modified', place: 'graph', exact: false });
    assert.ok(atOld.expand.includes(abs('src/ui')));
  });

  test('a PR with nothing in the graph still gives a usable view: whole project, root open', () => {
    const view = build([file('README.md', 'modified')], 'hide');
    assert.deepStrictEqual(view.spec, { include: ['.'], exclude: [] });
    assert.deepStrictEqual(view.expand, [scanStructure(root).root]);
    assert.strictEqual(view.counts.inGraph, 0);
  });

  test('a workspace below the repository root: PR paths resolve from the repository, scope from the workspace', () => {
    const ws = abs('src');
    const view = build([file('src/server/api.ts', 'modified'), file('tools/gen.ts', 'modified')], 'hide', root, ws);
    assert.deepStrictEqual(view.files.map(f => f.place), ['graph', 'other'], 'tools/ lies outside the workspace');
    assert.deepStrictEqual(view.spec.include, ['server']);
    assert.strictEqual(repoRootFrom(ws, 'src/\n'), root);
    assert.strictEqual(repoRootFrom(root, '\n'), root);
    assert.strictEqual(repoRootFrom(abs('src/server/db'), 'src/server/db/'), root);
  });

  test('names and analyzable paths', () => {
    assert.strictEqual(prViewName(PR), 'PR #69 · fix: a save can overwrite the wrong lines');
    assert.strictEqual(prViewName({ ...PR, title: '' }), 'PR #69');
    assert.ok(prViewName({ ...PR, title: 'x'.repeat(200) }).length < 64);
    assert.strictEqual(isAnalyzablePath('src/a.ts'), true);
    assert.strictEqual(isAnalyzablePath('src/a.d.ts'), false);
    assert.strictEqual(isAnalyzablePath('node_modules/x/a.js'), false);
    assert.strictEqual(isAnalyzablePath('.github/a.py'), false);
    assert.strictEqual(isAnalyzablePath('docs/readme.md'), false);
    assert.strictEqual(isAnalyzablePath(''), false);
  });
});

suite('vcs — GitService override', () => {
  const node = (id: string, fileRel: string, line: number): any => ({ id, name: id, file: `/ws/${fileRel}`, line });

  test('while set, statuses come from the override and git is never run', () => {
    const git = new GitService();
    let ran = 0;
    git.parseGitStatus = () => { ran++; return new Map(); };
    git.setOverride({
      files: new Map([
        ['/ws/a.ts', { unstaged: 'modified', staged: null }],
        ['/ws/new.ts', { unstaged: 'added', staged: null }],
        ['/ws/whole.ts', { unstaged: 'modified', staged: null }],
      ]),
      hunks: new Map([['/ws/a.ts', [{ start: 10, end: 12, isNew: false }, { start: 30, end: 34, isNew: true }]]]),
    });
    const nodes = [node('a1', 'a.ts', 1), node('a2', 'a.ts', 9), node('a3', 'a.ts', 30), node('n1', 'new.ts', 5),
      node('w1', 'whole.ts', 3), node('u1', 'untouched.ts', 1)];
    assert.strictEqual(git.applyGitStatuses(nodes, '/ws'), true);
    assert.strictEqual(ran, 0);
    const status = (id: string) => nodes.find(n => n.id === id).gitStatus.unstaged;
    assert.strictEqual(status('a1'), null, 'a function the diff does not touch stays neutral');
    assert.strictEqual(status('a2'), 'modified');
    assert.strictEqual(status('a3'), 'added', 'defined on an added-only stretch');
    assert.strictEqual(status('n1'), 'added');
    assert.strictEqual(status('w1'), null, 'no hunks: the file is coloured, its functions are not');
    assert.strictEqual(status('u1'), null);
    assert.deepStrictEqual(git.fileStatuses['/ws/whole.ts'], { unstaged: 'modified', staged: null });
  });

  test('the async path honours it too, and clearing it goes back to git', async () => {
    const git = new GitService();
    git.setOverride({ files: new Map([['/ws/a.ts', { unstaged: 'deleted', staged: null }]]), hunks: new Map() });
    const nodes = [node('a1', 'a.ts', 1)];
    assert.strictEqual(await git.applyGitStatusesAsync(nodes, '/ws'), true);
    assert.strictEqual(nodes[0].gitStatus.unstaged, 'deleted');
    git.setOverride(null);
    let ran = 0;
    git.parseGitStatus = () => { ran++; return null; };
    assert.strictEqual(git.applyGitStatuses(nodes, '/ws'), false);
    assert.strictEqual(ran, 1);
  });
});

// ── Controller + sidebar host ────────────────────────────────────────────────

class FakeGraph implements PrGraph {
  shown: PrGraphView[] = [];
  active: number | null = null;
  canOpen = true;
  private listeners = new Set<(a: number | null) => void>();
  showPullRequest(view: PrGraphView): boolean {
    if (!this.canOpen) { return false; }
    this.shown.push(view);
    this.set(view.number);
    return true;
  }
  exitPullRequest(): void { this.set(null); }
  activePullRequest(): number | null { return this.active; }
  onPullRequestChange(l: (a: number | null) => void) { this.listeners.add(l); return { dispose: () => this.listeners.delete(l) }; }
  set(n: number | null) { this.active = n; for (const l of this.listeners) { l(n); } }
}

class FakeSource implements PullRequestSource {
  readonly id = 'fake';
  listResult: PrListResult = { ok: true, pullRequests: [PR, { ...PR, number: 70, title: 'second' }], truncated: true };
  filesResult: PrFilesResult = { ok: true, files: [file('src/main.ts', 'modified'), file('README.md', 'modified')], truncated: false };
  listCalls: Array<{ state: string; limit: number }> = [];
  filesCalls: number[] = [];
  throwOnList = false;
  async list(_root: string, opts: { state: 'open' | 'all'; limit: number }) {
    this.listCalls.push(opts);
    if (this.throwOnList) { throw new Error('boom'); }
    return this.listResult;
  }
  async files(_root: string, n: number) { this.filesCalls.push(n); return this.filesResult; }
}

suite('vcs — controller and sidebar host', () => {
  let root: string;
  let source: FakeSource;
  let graph: FakeGraph;
  let states: VcsStateMessage[];
  let opened: string[];
  let typed: string[];
  let logs: string[];
  let workspace: string | undefined;
  let sidebar: VcsSidebar;
  const last = () => states[states.length - 1];

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-pr-ctl-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), SOURCES['src/main.ts']);
    workspace = root;
    source = new FakeSource(); graph = new FakeGraph(); states = []; opened = []; typed = []; logs = [];
    const controller = new PrController(source, graph, {
      workspaceRoot: () => workspace,
      scanStructure,
      unchangedFolders: () => 'collapse',
      log: (l) => logs.push(l),
      exec: async () => ({ code: 0, stdout: '\n', stderr: '', notFound: false }),
    });
    sidebar = new VcsSidebar(controller, {
      openExternal: (u) => opened.push(u),
      openTerminal: (c) => typed.push(c),
      now: () => new Date('2026-10-06T10:00:00Z'),
    });
    sidebar.attach((m) => states.push(m));
  });
  teardown(() => fs.rmSync(root, { recursive: true, force: true }));

  test('messages that are not the pane\'s are left alone', async () => {
    assert.strictEqual(await sidebar.handle({ type: 'open-graph' }), false);
    assert.strictEqual(await sidebar.handle({}), false);
    assert.strictEqual(states.length, 0);
  });

  test('ready loads once: a loading snapshot, then the list; a second ready replays without fetching', async () => {
    assert.strictEqual(await sidebar.handle({ type: 'vcs-ready' }), true);
    assert.deepStrictEqual(states.map(s => s.loading), [true, false]);
    assert.deepStrictEqual(last().pullRequests.map(p => p.number), [69, 70]);
    assert.deepStrictEqual([last().truncated, last().fetchedAt, last().filter], [true, '2026-10-06T10:00:00.000Z', 'open']);
    await sidebar.handle({ type: 'vcs-ready' });
    assert.strictEqual(source.listCalls.length, 1);
    assert.strictEqual(states.length, 3);
  });

  test('filter and "show more" reload with the new arguments', async () => {
    await sidebar.handle({ type: 'vcs-ready' });
    await sidebar.handle({ type: 'vcs-more' });
    await sidebar.handle({ type: 'vcs-filter', state: 'all' });
    await sidebar.handle({ type: 'vcs-filter', state: 'nonsense' });
    assert.deepStrictEqual(source.listCalls, [
      { state: 'open', limit: 50 }, { state: 'open', limit: 100 }, { state: 'all', limit: 50 }, { state: 'open', limit: 50 },
    ]);
  });

  test('a problem is a state with its fix label, and the fix runs the injected side effect only', async () => {
    source.listResult = { ok: false, problem: { kind: 'gh-unauthenticated', message: 'Sign in.' } };
    await sidebar.handle({ type: 'vcs-ready' });
    assert.deepStrictEqual([last().problem?.kind, last().fixLabel, last().pullRequests.length], ['gh-unauthenticated', 'Sign in…', 0]);
    await sidebar.handle({ type: 'vcs-fix' });
    assert.deepStrictEqual(typed, ['gh auth login']);
    source.listResult = { ok: false, problem: { kind: 'gh-missing', message: 'Install.' } };
    await sidebar.handle({ type: 'vcs-refresh' });
    await sidebar.handle({ type: 'vcs-fix' });
    assert.deepStrictEqual(opened, ['https://cli.github.com/']);
    source.listResult = { ok: false, problem: { kind: 'offline', message: 'Offline.' } };
    await sidebar.handle({ type: 'vcs-refresh' });
    assert.strictEqual(last().fixLabel, null);
  });

  test('no workspace and a throwing source are problems too', async () => {
    workspace = undefined;
    await sidebar.handle({ type: 'vcs-ready' });
    assert.strictEqual(last().problem?.kind, 'no-workspace');
    assert.strictEqual(source.listCalls.length, 0);
    workspace = root;
    source.throwOnList = true;
    await sidebar.handle({ type: 'vcs-refresh' });
    assert.deepStrictEqual([last().problem?.kind, last().problem?.detail], ['error', 'boom']);
    assert.ok(logs.some(l => l.includes('boom')));
  });

  test('opening a PR shows it in the graph and reports what the graph could draw', async () => {
    await sidebar.handle({ type: 'vcs-ready' });
    await sidebar.handle({ type: 'vcs-open', number: 69 });
    assert.deepStrictEqual(source.filesCalls, [69]);
    const view = graph.shown[0];
    assert.deepStrictEqual([view.number, view.name, view.spec.include], [69, prViewName(PR), ['.']]);
    assert.deepStrictEqual([view.message.type, view.message.active, view.message.number], ['pr-view', true, 69]);
    assert.deepStrictEqual(Object.values(view.message.fileGitStatus), [{ unstaged: 'modified', staged: null }]);
    assert.ok(view.message.expand.includes(path.join(root, 'src')));
    assert.deepStrictEqual([last().active, last().opening, last().detail?.number], [69, null, 69]);
    assert.deepStrictEqual(last().detail?.counts, { total: 2, inGraph: 1, exact: 0, fileLevel: 1, missing: 0, other: 1 });
    assert.deepStrictEqual(last().detail?.files.map(f => f.place), ['graph', 'other']);
  });

  test('a number that is not in the loaded list opens nothing', async () => {
    await sidebar.handle({ type: 'vcs-ready' });
    await sidebar.handle({ type: 'vcs-open', number: 4242 });
    await sidebar.handle({ type: 'vcs-open', number: 'x' });
    assert.strictEqual(source.filesCalls.length, 0);
    assert.strictEqual(graph.shown.length, 0);
  });

  test('a PR whose files cannot be fetched keeps the list and explains on the row', async () => {
    await sidebar.handle({ type: 'vcs-ready' });
    source.filesResult = { ok: false, problem: { kind: 'offline', message: 'GitHub could not be reached.' } };
    await sidebar.handle({ type: 'vcs-open', number: 70 });
    assert.deepStrictEqual([last().active, last().detail, last().openProblem?.number, last().openProblem?.problem.kind], [null, null, 70, 'offline']);
    assert.strictEqual(last().pullRequests.length, 2);
  });

  test('leaving — from the pane or from the graph — clears the detail', async () => {
    await sidebar.handle({ type: 'vcs-ready' });
    await sidebar.handle({ type: 'vcs-open', number: 69 });
    await sidebar.handle({ type: 'vcs-exit' });
    assert.deepStrictEqual([last().active, last().detail], [null, null]);
    await sidebar.handle({ type: 'vcs-open', number: 70 });
    graph.set(null); // the graph panel was closed
    assert.deepStrictEqual([last().active, last().detail], [null, null]);
  });

  test('"open on GitHub" takes the URL from the loaded list and only an https one', async () => {
    source.listResult = { ok: true, truncated: false, pullRequests: [PR, { ...PR, number: 71, url: 'javascript:alert(1)' }] };
    await sidebar.handle({ type: 'vcs-ready' });
    await sidebar.handle({ type: 'vcs-browse', number: 69, url: 'https://evil.example/' });
    await sidebar.handle({ type: 'vcs-browse', number: 71 });
    await sidebar.handle({ type: 'vcs-browse', number: 9999 });
    assert.deepStrictEqual(opened, ['https://github.com/acme/app/pull/69']);
  });

  test('when no panel can be opened the click ends in a problem, not a half-open view', async () => {
    await sidebar.handle({ type: 'vcs-ready' });
    graph.canOpen = false;
    await sidebar.handle({ type: 'vcs-open', number: 69 });
    assert.deepStrictEqual([last().active, last().openProblem?.problem.kind], [null, 'no-workspace']);
  });

  test('a detached pane receives nothing', async () => {
    sidebar.attach(null);
    await sidebar.handle({ type: 'vcs-ready' });
    assert.strictEqual(states.length, 0);
    assert.strictEqual(sidebar.state().pullRequests.length, 2);
  });
});
