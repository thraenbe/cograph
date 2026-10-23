import * as assert from 'assert';
import * as path from 'path';
import { BROWSER_OFF_SENTENCE, TourRunner, describeTarget } from '../../tour/tourCommand';
import type { TourRunnerDeps, TourServer } from '../../tour/tourCommand';
import type { TourPrepared, TourTarget } from '../../tour/tourApi';
import type { LoadedTour } from '../../tour/tourModule';
import { HeadTreeError } from '../../vcs/engine/headTree';
import { tourGraphView, headShaOf } from '../../vcs/tourView';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SHA = '3f1c2a9'.padEnd(40, '0');
const HEAD_DIR = path.join(path.sep, 'g', 'pr-trees', 'k3y', SHA);

const PREPARED: TourPrepared = {
  tourId: 'pr-104-3f1c2a9-866b815',
  script: { version: 1 },
  headDir: HEAD_DIR,
  statuses: {
    files: [[`${HEAD_DIR}/src/a.ts`, { unstaged: 'modified', staged: null }]],
    hunks: [[`${HEAD_DIR}/src/a.ts`, [{ start: 3, end: 5, isNew: false }]]],
  },
  view: { name: 'PR #104 · head 3f1c2a9', title: 'The doorway', headRef: 'feat/x', baseRef: 'main', expand: ['src', 'src/vcs', `${HEAD_DIR}/lib`], counts: { total: 9, inGraph: 7, other: 2 } },
};

class Server implements TourServer {
  calls: string[] = [];
  views = new Map<string, unknown>();
  registerView(id: string, view: unknown) { this.calls.push(`view:${id}`); this.views.set(id, view); }
  mount(routes: unknown[]) { this.calls.push(`mount:${routes.length}`); }
  serveStatic(prefix: string, dir: string) { this.calls.push(`static:${prefix}:${dir}`); }
  serveTourPage(tourId: string, viewId: string, opts: { assets: boolean }) { this.calls.push(`page:${tourId}:${viewId}:${opts.assets}`); }
}

function setup(over: { tour?: LoadedTour | null; prepare?: (t: TourTarget, report: (m: string) => void, signal: AbortSignal) => Promise<TourPrepared> } = {}) {
  const out = { info: [] as string[], error: [] as string[], log: [] as string[], progress: [] as string[], panels: [] as any[], urls: [] as string[], toasts: [] as any[] };
  const panel = { attachView: () => () => undefined, receiveFromView: () => undefined, replayMessages: () => [], viewRoot: () => HEAD_DIR };
  let server: Server | null = new Server();
  const tour: LoadedTour | null = over.tour === undefined ? {
    source: 'env', webAssetsDir: '/pkg/dist/web',
    host: { version: 1, routes: [{ method: 'GET', pattern: '/tour/:id/script', handler: async () => ({ status: 200, body: '' }) }], webAssetsDir: '/pkg/dist/web', dispose: () => undefined,
      prepare: over.prepare ?? (async (_t, report) => { report('fetching the base…'); report('security check…'); return PREPARED; }) },
  } : over.tour;
  const deps: TourRunnerDeps = {
    loadTour: async () => tour,
    getServer: async () => server,
    openUrl: async (_s, urlPath) => { out.urls.push(urlPath); return { url: `http://127.0.0.1:1${urlPath}?token=t`, opened: true }; },
    showOpened: async (message, url, opened) => { out.toasts.push([message, url, opened]); },
    openPanel: (view, headDir, label) => { out.panels.push([view, headDir, label]); return panel; },
    progress: async (title, task) => { out.progress.push(title); return task((m) => out.progress.push(m), new AbortController().signal); },
    info: (m) => out.info.push(m), error: (m) => out.error.push(m), log: (l) => out.log.push(l),
  };
  return { deps, out, panel, setServer: (s: Server | null) => { server = s; }, server: () => server };
}

suite('tour — from a click to the browser tab', () => {
  test('the public build says the stub sentence and touches nothing', async () => {
    const t = setup({ tour: null });
    assert.strictEqual(await new TourRunner(t.deps).run({ kind: 'branch' }), 'unavailable');
    assert.deepStrictEqual(t.out.info, ['CoGraph: The PR tour is part of the Marketplace build of CoGraph.']);
    assert.deepStrictEqual([t.out.progress, t.out.panels, t.server()!.calls], [[], [], []]);
  });

  test('browser view switched off, or a server that cannot listen: one sentence each', async () => {
    const off = setup();
    off.setServer(null);
    assert.strictEqual(await new TourRunner(off.deps).run({ kind: 'branch' }), 'unavailable');
    assert.deepStrictEqual(off.out.info, [`CoGraph: ${BROWSER_OFF_SENTENCE}`]);
    const broken = setup();
    broken.deps.getServer = async () => { throw new Error('EADDRINUSE'); };
    assert.strictEqual(await new TourRunner(broken.deps).run({ kind: 'branch' }), 'failed');
    assert.deepStrictEqual(broken.out.error, ['CoGraph: The browser view could not start: EADDRINUSE']);
  });

  test('prepared behind one progress, the PR panel opens on the head copy, the server mirrors it, the page opens', async () => {
    const t = setup();
    const runner = new TourRunner(t.deps);
    assert.strictEqual(await runner.run({ kind: 'pr', number: 104 }), 'opened');
    assert.deepStrictEqual(t.out.progress, ['Preparing the tour of pull request #104', 'fetching the base…', 'security check…']);
    const [view, headDir, label] = t.out.panels[0];
    assert.deepStrictEqual([headDir, label, view.number, view.message.tree], [HEAD_DIR, 'PR #104 · head 3f1c2a9', 104, { kind: 'head', sha: SHA }]);
    assert.deepStrictEqual(t.server()!.calls, [
      'mount:1', 'static:/tour-assets:/pkg/dist/web', `view:tour-${PREPARED.tourId}`, `page:${PREPARED.tourId}:tour-${PREPARED.tourId}:true`,
    ]);
    assert.strictEqual(t.server()!.views.get(`tour-${PREPARED.tourId}`), t.panel, 'the PR panel\'s provider is what the tab mirrors');
    assert.deepStrictEqual(t.out.urls, [`/tour/${PREPARED.tourId}`]);
    assert.deepStrictEqual(t.out.toasts[0], ['CoGraph: Tour opened in your browser.', `http://127.0.0.1:1/tour/${PREPARED.tourId}?token=t`, true]);
    assert.ok(!t.out.log.some(l => l.includes('token')), 'the token never reaches the log');
    await runner.run({ kind: 'pr', number: 104 });
    assert.strictEqual(t.server()!.calls.filter(c => c.startsWith('mount')).length, 1, 'routes are mounted once per server');
    t.setServer(new Server());
    await runner.run({ kind: 'pr', number: 104 });
    assert.deepStrictEqual(t.server()!.calls.slice(0, 2), ['mount:1', 'static:/tour-assets:/pkg/dist/web'], 'a restarted server gets them again');
  });

  test('a cancel says nothing; a HeadTreeError says its sentence; anything else says it could not be prepared', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const cancel = setup({ prepare: async () => { throw abort; } });
    assert.strictEqual(await new TourRunner(cancel.deps).run({ kind: 'branch' }), 'cancelled');
    assert.deepStrictEqual([cancel.out.error, cancel.out.info, cancel.out.panels], [[], [], []]);
    const engine = setup({ prepare: async () => { throw new HeadTreeError('offline', 'The remote could not be reached. Check the connection and try again.'); } });
    assert.strictEqual(await new TourRunner(engine.deps).run({ kind: 'branch' }), 'failed');
    assert.deepStrictEqual(engine.out.error, ['CoGraph: The remote could not be reached. Check the connection and try again.']);
    const other = setup({ prepare: async () => { throw new TypeError('x is undefined'); } });
    await new TourRunner(other.deps).run({ kind: 'branch' });
    assert.deepStrictEqual(other.out.error, ['CoGraph: The tour could not be prepared: x is undefined']);
    assert.ok(other.out.log.some(l => l.startsWith('[tour] prepare failed: TypeError')), 'the stack goes to the log');
  });

  test('no panel, or a server that refuses the page: one sentence, no tab', async () => {
    const t = setup();
    t.deps.openPanel = () => null;
    assert.strictEqual(await new TourRunner(t.deps).run({ kind: 'branch' }), 'failed');
    assert.match(t.out.error[0], /needs an open folder/);
    const s = setup();
    (s.server() as any).serveTourPage = () => { throw new Error('serveTourPage: view "x" is not registered'); };
    assert.strictEqual(await new TourRunner(s.deps).run({ kind: 'branch' }), 'failed');
    assert.deepStrictEqual([s.out.urls, s.out.error], [[], ['CoGraph: The tour could not be opened: serveTourPage: view "x" is not registered']]);
  });

  test('one tour at a time', async () => {
    let release!: () => void;
    const t = setup({ prepare: () => new Promise((res) => { release = () => res(PREPARED); }) });
    const runner = new TourRunner(t.deps);
    const first = runner.run({ kind: 'branch' });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(await runner.run({ kind: 'branch' }), 'cancelled');
    assert.deepStrictEqual(t.out.info, ['CoGraph: A tour is being prepared already.']);
    release();
    assert.strictEqual(await first, 'opened');
  });

  test('the target in words', () => {
    assert.strictEqual(describeTarget({ kind: 'pr', number: 7 }), 'pull request #7');
    assert.strictEqual(describeTarget({ kind: 'branch' }), 'your branch');
    assert.strictEqual(describeTarget({ kind: 'branch', branch: 'feat/x', baseRef: 'main' }), 'feat/x vs main');
  });
});

suite('tour — the stage view of a prepared tour', () => {
  test('statuses become the override, folders become absolute, a branch tour has no PR number', () => {
    const v = tourGraphView(PREPARED, { kind: 'pr', number: 104 });
    assert.strictEqual(headShaOf(HEAD_DIR + path.sep), SHA);
    assert.deepStrictEqual([...v.override.files], [[`${HEAD_DIR}/src/a.ts`, { unstaged: 'modified', staged: null }]]);
    assert.deepStrictEqual([...v.override.hunks], [[`${HEAD_DIR}/src/a.ts`, [{ start: 3, end: 5, isNew: false }]]]);
    assert.deepStrictEqual(v.message.expand, [path.join(HEAD_DIR, 'src'), path.join(HEAD_DIR, 'src', 'vcs'), `${HEAD_DIR}/lib`]);
    assert.deepStrictEqual(v.message.counts, { total: 9, inGraph: 7, exact: 7, fileLevel: 0, missing: 0, other: 2 });
    assert.deepStrictEqual([v.message.type, v.message.active, v.message.title, v.spec], ['pr-view', true, 'The doorway', { include: ['.'], exclude: [] }]);
    assert.deepStrictEqual(v.message.fileGitStatus, { [`${HEAD_DIR}/src/a.ts`]: { unstaged: 'modified', staged: null } });
    assert.strictEqual(tourGraphView(PREPARED, { kind: 'branch', branch: 'feat/x' }).number, 0);
  });
});
