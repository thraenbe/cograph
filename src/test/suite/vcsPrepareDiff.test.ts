import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultExec } from '../../vcs/ghCliSource';
import { PrController } from '../../vcs/prController';
import type { PrGraph, PrGraphView, PrHeadGraph } from '../../vcs/prController';
import type { TreeAnalyzer } from '../../vcs/engine/treeAnalysis';
import type { EngineGraph } from '../../vcs/engine/types';
import type { PrFilesResult, PrListResult, PrViewResult, PullRequest, PullRequestSource } from '../../vcs/types';
import { scanStructure } from '../../structureScanner';

/* eslint-disable @typescript-eslint/no-explicit-any */

const GIT_ID = { GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };

function sh(cwd: string, args: string[]): string {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ID, GIT_TERMINAL_PROMPT: '0' } }).trim();
}
function write(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

/** A tiny analyzer: `export function name()` defines, `name(` inside a body calls. Enough to diff. */
const regexAnalyzer: TreeAnalyzer = async (dir) => {
  const graph: EngineGraph = { nodes: [], edges: [], files: [] };
  const bodies: Array<{ id: string; body: string }> = [];
  for (const f of scanStructure(dir).files) {
    graph.files!.push(f.path);
    const lines = fs.readFileSync(f.path, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = /function (\w+)\(\) \{(.*)\}/.exec(line);
      if (m) { const id = `${f.path}::${m[1]}::${i + 1}`; graph.nodes.push({ id, name: m[1], file: f.path, line: i + 1 }); bodies.push({ id, body: m[2] }); }
    });
  }
  for (const { id, body } of bodies) {
    for (const m of body.matchAll(/(\w+)\(/g)) {
      const target = graph.nodes.find(n => n.name === m[1]);
      if (target) { graph.edges.push({ source: id, target: target.id }); }
    }
  }
  return graph;
};

class Graph implements PrHeadGraph {
  shown: PrGraphView[] = [];
  open = false;
  showPullRequest(view: PrGraphView) { this.shown.push(view); this.open = true; return true; }
  exitPullRequest() { this.open = false; }
  activePullRequest() { return this.open ? this.shown[this.shown.length - 1].number : null; }
  onPullRequestChange() { return { dispose: () => undefined }; }
  isOpen() { return this.open; }
  close() { this.open = false; }
}

class Source implements PullRequestSource {
  readonly id = 'fake';
  constructor(private readonly pr: PullRequest, private readonly withView = true) {
    if (!withView) { (this as any).view = undefined; }
  }
  listed = 0;
  viewed = 0;
  filesResult: PrFilesResult = { ok: true, truncated: false, files: [] };
  async list(): Promise<PrListResult> { this.listed++; return { ok: true, pullRequests: [this.pr], truncated: false }; }
  async files(): Promise<PrFilesResult> { return this.filesResult; }
  async fileText() { return { ok: false as const, problem: { kind: 'error' as const, message: 'no' } }; }
  async view(_root: string, n: number): Promise<PrViewResult> {
    this.viewed++;
    return n === this.pr.number ? { ok: true, pullRequest: this.pr } : { ok: false, problem: { kind: 'error', message: 'not found' } };
  }
}

suite('vcs — PrController.prepareDiff: the tour\'s trees for both target kinds', () => {
  let root: string;
  let origin: string;
  let work: string;
  let storage: string;
  let branchPoint: string;
  let head: string;
  const log: string[] = [];
  const PR: PullRequest = {
    number: 1, title: 'add extra', author: 'ada', headRef: 'feat/x', baseRef: 'main', headOid: '', state: 'open', isDraft: false,
    checks: 'none', changedFiles: 2, additions: 3, deletions: 1, updatedAt: '', url: 'https://github.com/o/r/pull/1',
  };

  suiteSetup(function () {
    try { sh(os.tmpdir(), ['--version']); } catch { this.skip(); }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cograph-prepare-'));
    origin = path.join(root, 'origin.git');
    fs.mkdirSync(origin);
    sh(origin, ['init', '--bare', '--quiet', '-b', 'main']);
    work = path.join(root, 'work');
    fs.mkdirSync(work);
    sh(work, ['init', '--quiet', '-b', 'main']);
    write(work, { 'src/app.ts': 'export function main() { helper(); }\n', 'src/util.ts': 'export function helper() { }\nexport function dropped() { }\n', 'README.md': '# r\n' });
    sh(work, ['add', '-A']);
    sh(work, ['commit', '--quiet', '-m', 'base']);
    branchPoint = sh(work, ['rev-parse', 'HEAD']);
    sh(work, ['remote', 'add', 'origin', origin]);
    sh(work, ['push', '--quiet', 'origin', 'main']);
    sh(work, ['remote', 'set-head', 'origin', 'main']);
    sh(work, ['checkout', '--quiet', '-b', 'feat/x']);
    write(work, { 'src/util.ts': 'export function helper() { extra(); }\nexport function extra() { }\n', 'README.md': '# r2\n' });
    sh(work, ['add', '-A']);
    sh(work, ['commit', '--quiet', '-m', 'add extra']);
    head = sh(work, ['rev-parse', 'HEAD']);
    sh(work, ['push', '--quiet', 'origin', 'feat/x:refs/pull/1/head']);
  });
  suiteTeardown(() => { if (root) { fs.rmSync(root, { recursive: true, force: true }); } });

  function controller(source: PullRequestSource, opts: { storage?: boolean; analyzer?: boolean } = {}) {
    storage = fs.mkdtempSync(path.join(root, 'storage-'));
    log.length = 0;
    return new PrController(source, new Graph() as PrGraph, {
      workspaceRoot: () => work, scanStructure, unchangedFolders: () => 'collapse', log: (l) => log.push(l), exec: defaultExec,
      ...(opts.storage === false ? {} : { storageDir: storage }),
      createHeadGraph: () => new Graph(),
      ...(opts.analyzer === false ? {} : { analyzer: regexAnalyzer }),
    });
  }

  test('a branch target: HEAD against the merge base, analysed, diffed, with commits and every changed path', async function () {
    this.timeout(30_000);
    const stages: string[] = [];
    const trees = await controller(new Source(PR)).prepareDiff({ kind: 'branch' }, (m) => stages.push(m), new AbortController().signal);
    assert.deepStrictEqual(trees.target, { kind: 'branch', branch: 'feat/x', baseRef: 'main' });
    assert.strictEqual(trees.repoRoot, work);
    assert.strictEqual(trees.head.sha, head);
    assert.strictEqual(trees.base?.sha, branchPoint);
    assert.ok(trees.head.dir.startsWith(storage) && trees.base!.dir.startsWith(storage));
    assert.ok(trees.head.graph.nodes.some(n => n.name === 'extra'));
    assert.deepStrictEqual(trees.diff?.summary && [trees.diff.summary.added, trees.diff.summary.changed, trees.diff.summary.removed], [1, 1, 1]);
    assert.deepStrictEqual(trees.commits.map(c => c.subject), ['add extra']);
    assert.deepStrictEqual(trees.changedPaths.map(p => [p.path, p.status, p.analysable]), [['README.md', 'modified', false], ['src/util.ts', 'modified', true]]);
    assert.ok(trees.head.files.includes('README.md'));
    assert.deepStrictEqual([trees.pr, trees.prFiles, trees.checkoutBranch, trees.dirty], [null, null, 'feat/x', false]);
    assert.deepStrictEqual(stages, ['fetching the base…', 'copying the files…', 'analysing…', 'diffing…']);
  });

  test('a pull request target: the PR\'s head and merge base, the PR record, its file list and commits', async function () {
    this.timeout(30_000);
    const source = new Source(PR);
    source.filesResult = { ok: true, truncated: false, files: [{ path: 'src/util.ts', status: 'modified', previousPath: null, additions: 2, deletions: 1, blobSha: null, hunks: [{ start: 1, end: 2, isNew: false }] }] };
    const trees = await controller(source).prepareDiff({ kind: 'pr', number: 1 }, () => undefined, new AbortController().signal);
    assert.strictEqual(source.viewed, 1, 'looked up by number');
    assert.deepStrictEqual(trees.target, { kind: 'pr', number: 1 });
    assert.strictEqual(trees.pr?.title, 'add extra');
    assert.strictEqual(trees.head.sha, head);
    assert.strictEqual(trees.base?.sha, branchPoint);
    assert.strictEqual(trees.diff?.summary.added, 1);
    assert.deepStrictEqual(trees.prFiles?.map(f => f.path), ['src/util.ts']);
    assert.deepStrictEqual(trees.commits.map(c => c.sha), [head]);
    assert.deepStrictEqual(trees.changedPaths.map(p => p.path), ['README.md', 'src/util.ts']);
    assert.deepStrictEqual([trees.checkoutBranch, trees.dirty], ['feat/x', false]);
  });

  test('the caller\'s PR record skips the lookup; a source without view() is searched instead', async function () {
    this.timeout(30_000);
    const withRecord = new Source(PR);
    await controller(withRecord).prepareDiff({ kind: 'pr', number: 1 }, () => undefined, new AbortController().signal, PR);
    assert.deepStrictEqual([withRecord.viewed, withRecord.listed], [0, 0]);
    const noView = new Source(PR, false);
    const trees = await controller(noView).prepareDiff({ kind: 'pr', number: 1 }, () => undefined, new AbortController().signal);
    assert.deepStrictEqual([noView.listed, trees.pr?.number], [1, 1]);
    await assert.rejects(controller(new Source(PR, false)).prepareDiff({ kind: 'pr', number: 7 }, () => undefined, new AbortController().signal), /#7 was not found/);
  });

  test('a missing base gives base, diff and changed paths empty; a failed file list gives prFiles null', async function () {
    this.timeout(30_000);
    const source = new Source({ ...PR, baseRef: 'no-such-base' });
    source.filesResult = { ok: false, problem: { kind: 'offline', message: 'offline' } };
    const trees = await controller(source).prepareDiff({ kind: 'pr', number: 1 }, () => undefined, new AbortController().signal);
    assert.deepStrictEqual([trees.base, trees.diff, trees.prFiles, trees.changedPaths], [null, null, null, []]);
    assert.ok(trees.commits.length >= 2, 'with no base, every commit of the head');
    assert.ok(log.some(l => /base of #1 unavailable/.test(l)));
    assert.ok(log.some(l => /\[tour\] file list of #1 unavailable \(offline\)/.test(l)));
  });

  test('without storage or analyzer there is nothing to tour, said in one sentence; a cancel rejects', async () => {
    await assert.rejects(controller(new Source(PR), { storage: false }).prepareDiff({ kind: 'branch' }, () => undefined, new AbortController().signal), /nothing to tour/);
    await assert.rejects(controller(new Source(PR), { analyzer: false }).prepareDiff({ kind: 'branch' }, () => undefined, new AbortController().signal), /nothing to tour/);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(controller(new Source(PR)).prepareDiff({ kind: 'branch', baseRef: 'main' }, () => undefined, ac.signal), (e: any) => e.kind === 'cancelled');
  });

  test('open keeps the whole structural diff on PrOpened, beside the sidebar\'s summary', async function () {
    this.timeout(30_000);
    const res = await controller(new Source(PR)).open(PR);
    assert.ok(res.ok);
    assert.strictEqual(res.opened.structuralDiff?.summary.added, 1);
    assert.deepStrictEqual(res.opened.structuralDiff?.summary, res.opened.diff?.summary);
    assert.ok(res.opened.structuralDiff?.functions.some(f => f.name === 'extra' && f.kind === 'added'));
    assert.ok(res.opened.structuralDiff?.edges.length, 'edges are kept, not only counted');
  });
});
