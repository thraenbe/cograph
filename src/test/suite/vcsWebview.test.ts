import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

/* eslint-disable @typescript-eslint/no-explicit-any */

const WEBVIEW_DIR = path.join(__dirname, '..', '..', '..', 'src', 'webview');
const PR_VIEW_SRC = fs.readFileSync(path.join(WEBVIEW_DIR, 'prView.js'), 'utf8');
const SIDEBAR_SRC = fs.readFileSync(path.join(WEBVIEW_DIR, 'sidebar-vcs.js'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const prView = require('../../../src/webview/prView.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sidebarVcs = require('../../../src/webview/sidebar-vcs.js');

const TREE = {
  root: '/ws',
  folders: {
    '/ws': { path: '/ws', parent: null, childFolders: ['/ws/src', '/ws/tools'], files: [] },
    '/ws/src': { path: '/ws/src', parent: '/ws', childFolders: ['/ws/src/ui'], files: ['/ws/src/a.ts'] },
    '/ws/src/ui': { path: '/ws/src/ui', parent: '/ws/src', childFolders: [], files: ['/ws/src/ui/v.ts'] },
    '/ws/tools': { path: '/ws/tools', parent: '/ws', childFolders: [], files: ['/ws/tools/g.ts'] },
  },
};

const ENTER = {
  type: 'pr-view', active: true, number: 69, name: 'PR #69 · fix: save', title: 'fix: save',
  headRef: 'fix/save', baseRef: 'main', expand: ['/ws', '/ws/src', '/ws/gone'],
  fileGitStatus: { '/ws/src/a.ts': { unstaged: 'modified', staged: null } },
  counts: { total: 3, inGraph: 1, exact: 1, fileLevel: 0, missing: 1, other: 1 },
};

/** The graph page as far as prView.js needs it: state, the functions it calls, the legend. */
function graphPage(opts: { tree?: boolean; frames?: boolean } = {}) {
  const dom = new JSDOM(`<body>
    <button id="btn-git-mode"></button>
    <div id="git-legend-body">
      <div class="tl-legend-row"><span class="tl-legend-dot" style="background: rgb(255, 152, 0)"></span><span class="tl-legend-label">Modified Func</span></div>
      <div class="tl-legend-row"><span class="tl-legend-dot" style="background: rgb(85, 85, 85)"></span><span class="tl-legend-label">Deleted</span></div>
    </div></body>`, { runScripts: 'outside-only' });
  const w = dom.window as any;
  const calls: string[] = [];
  const posted: any[] = [];
  w.state = {
    prView: null, gitMode: false, languageMode: true, fileGitStatus: { '/ws/tools/g.ts': { unstaged: 'added', staged: null } },
    structureTree: opts.tree === false ? null : TREE,
    expandedFolders: new Set(['/ws', '/ws/tools']), detailDepth: 0.4, hasFitted: true, userZoomed: true,
    frames: opts.frames ? { rects: 'before' } : null, savedLayout: null,
  };
  w.vscode = { postMessage: (m: any) => posted.push(JSON.parse(JSON.stringify(m))) }; // out of the jsdom realm
  w.isDrilldown = () => true;
  w.usesFrames = () => !!opts.frames;
  w.serializeFrames = (f: any) => ({ '/ws': f.rects });
  w.setDetailSlider = (v: number) => calls.push(`slider:${v}`);
  w.setGitLegendVisible = (on: boolean) => calls.push(`legend:${on}`);
  w.resetFrames = () => calls.push('reset');
  w.requestParseForExpanded = () => calls.push('parse');
  w.applyFileClusters = () => calls.push('render');
  w.applyGitColors = () => calls.push('colors');
  w.setInitialDetailDepth = () => { calls.push('initial'); w.state.expandedFolders = new Set(['/ws']); };
  w.eval(PR_VIEW_SRC);
  const deletedDot = () => w.document.querySelectorAll('.tl-legend-dot')[1].style.background;
  return { w, doc: w.document as Document, state: w.state, calls, posted, deletedDot };
}

suite('vcs — prView.js (graph webview)', () => {
  test('pure helpers: expansion keeps only folders the tree has; the summary says how exact the colours are', () => {
    assert.deepStrictEqual([...prView.prViewExpansion(TREE, ['/ws', '/nope', '/ws/src/ui'])], ['/ws', '/ws/src/ui']);
    assert.deepStrictEqual([...prView.prViewExpansion(null, ['/ws'])], []);
    assert.deepStrictEqual(prView.prViewSummary({ total: 13, inGraph: 9, fileLevel: 0 }), { text: '9 of 13 files in the graph', warn: false });
    const whole = prView.prViewSummary({ total: 13, inGraph: 9, fileLevel: 2 });
    assert.ok(whole.warn && whole.text.includes('2 coloured as whole files'));
    assert.deepStrictEqual(prView.prViewSummary({ total: 1, inGraph: 0 }), { text: 'none of its 1 file is in the graph', warn: true });
  });

  test('entering opens exactly the PR\'s folders, turns git colours on, paints deleted red and shows the banner', () => {
    const p = graphPage();
    p.w.handlePrViewMessage(ENTER);
    assert.deepStrictEqual([...p.state.expandedFolders].sort(), ['/ws', '/ws/src'], 'tools is closed, the unknown folder ignored');
    assert.deepStrictEqual([p.state.gitMode, p.state.languageMode], [true, false], 'only the PR\'s colours carry meaning');
    assert.deepStrictEqual(p.state.fileGitStatus, ENTER.fileGitStatus);
    assert.deepStrictEqual([p.state.hasFitted, p.state.userZoomed], [false, false], 'the new picture is fitted');
    assert.deepStrictEqual(p.calls, ['legend:true', 'parse', 'render', 'colors']);
    assert.strictEqual(p.doc.documentElement.style.getPropertyValue('--cograph-git-deleted'), prView.PR_DELETED_COLOR);
    assert.strictEqual(p.deletedDot(), 'rgb(229, 83, 75)');
    assert.ok(p.doc.getElementById('btn-git-mode')!.classList.contains('active'));
    const banner = p.doc.getElementById('pr-view-banner')!;
    assert.strictEqual(banner.querySelector('.pr-name')!.textContent, 'PR #69 · fix: save');
    assert.strictEqual(banner.querySelector('.pr-sub')!.textContent, '1 of 3 files in the graph');
  });

  test('the banner says which tree is on screen: the checkout, or the PR\'s own commit', () => {
    const p = graphPage();
    p.w.handlePrViewMessage({ ...ENTER, tree: { kind: 'checkout', branch: 'main' } });
    let chip = p.doc.querySelector('#pr-view-banner .pr-tree')!;
    assert.deepStrictEqual([chip.textContent, chip.className], ['your checkout (main)', 'pr-tree checkout']);
    p.w.handlePrViewMessage({ ...ENTER, tree: { kind: 'head', sha: '23834be0123456789abcdef' } });
    chip = p.doc.querySelector('#pr-view-banner .pr-tree')!;
    assert.deepStrictEqual([chip.textContent, chip.className], ['the pull request\'s commit 23834be', 'pr-tree head']);
    assert.ok((chip as HTMLElement).title.includes('read-only'));
    p.w.handlePrViewMessage({ ...ENTER, tree: undefined });
    assert.strictEqual(p.doc.querySelector('#pr-view-banner .pr-tree')!.textContent, 'your checkout', 'a message without a tree is the checkout');
    assert.deepStrictEqual(prView.prViewTreeLabel({ kind: 'head', sha: 'abc', base: 'def' }).title.includes('compared with def'), true);
  });

  test('the banner\'s Leave button asks the host through the existing subgraph-exit', () => {
    const p = graphPage();
    p.w.handlePrViewMessage(ENTER);
    (p.doc.querySelector('#pr-view-banner button') as HTMLButtonElement).click();
    assert.deepStrictEqual(p.posted, [{ type: 'subgraph-exit' }]);
  });

  test('a hostile PR title is text, never markup', () => {
    const p = graphPage();
    p.w.handlePrViewMessage({ ...ENTER, name: 'PR #1 · <img src=x onerror=alert(1)>', title: '<script>x</script>' });
    const banner = p.doc.getElementById('pr-view-banner')!;
    assert.strictEqual(banner.querySelector('img'), null);
    assert.strictEqual(banner.querySelector('script'), null);
    assert.ok(banner.textContent!.includes('<img src=x'));
  });

  test('leaving with restore puts back expansion, depth, frame rects, git mode and the grey "deleted"', () => {
    const p = graphPage({ frames: true });
    p.w.handlePrViewMessage(ENTER);
    assert.deepStrictEqual(p.calls, ['legend:true', 'reset', 'parse', 'render', 'colors'], 'the PR picture is packed from scratch');
    p.calls.length = 0;
    p.w.handlePrViewMessage({ type: 'pr-view', active: false, restore: true, fileGitStatus: {} });
    assert.strictEqual(p.state.prView, null);
    assert.deepStrictEqual([...p.state.expandedFolders].sort(), ['/ws', '/ws/tools']);
    assert.strictEqual(p.state.detailDepth, 0.4);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.state.savedLayout)), { frames: { '/ws': 'before' }, _metaApplied: true });
    assert.deepStrictEqual([p.state.gitMode, p.state.languageMode], [false, true], 'colour modes go back to how the user had them');
    assert.deepStrictEqual(p.state.fileGitStatus, {});
    assert.strictEqual(p.doc.documentElement.style.getPropertyValue('--cograph-git-deleted'), '');
    assert.strictEqual(p.deletedDot(), 'rgb(85, 85, 85)');
    assert.strictEqual(p.doc.getElementById('pr-view-banner'), null);
    assert.deepStrictEqual(p.calls, ['legend:false', 'reset', 'slider:0.4', 'parse', 'render', 'colors']);
  });

  test('going from one pull request to the next keeps the snapshot from before the first', () => {
    const p = graphPage();
    p.w.handlePrViewMessage(ENTER);
    p.w.handlePrViewMessage({ ...ENTER, number: 70, name: 'PR #70', expand: ['/ws', '/ws/tools'] });
    assert.deepStrictEqual([...p.state.expandedFolders].sort(), ['/ws', '/ws/tools']);
    assert.strictEqual(p.doc.querySelectorAll('#pr-view-banner').length, 1);
    p.w.handlePrViewMessage({ type: 'pr-view', active: false, restore: true });
    assert.strictEqual(p.state.gitMode, false);
    assert.strictEqual(p.state.detailDepth, 0.4);
  });

  test('leaving without restore (another view takes over) clears the PR dressing and leaves the layout alone', () => {
    const p = graphPage();
    p.w.handlePrViewMessage(ENTER);
    p.calls.length = 0;
    p.w.handlePrViewMessage({ type: 'pr-view', active: false, restore: false });
    assert.deepStrictEqual([...p.state.expandedFolders].sort(), ['/ws', '/ws/src']);
    assert.strictEqual(p.doc.getElementById('pr-view-banner'), null);
    assert.ok(!p.calls.includes('render'));
  });

  test('a panel opened FOR the pull request: pr-view arrives before the tree, the first build uses its folders', () => {
    const p = graphPage({ tree: false });
    p.w.handlePrViewMessage(ENTER);
    assert.deepStrictEqual(p.calls, ['legend:true'], 'nothing to render yet');
    assert.strictEqual(p.w.prViewInitialExpansion(TREE), true);
    assert.deepStrictEqual([...p.state.expandedFolders].sort(), ['/ws', '/ws/src']);
    // Leaving it: nothing came before, so the default depth is what "back" means.
    p.state.structureTree = TREE;
    p.w.handlePrViewMessage({ type: 'pr-view', active: false, restore: true });
    assert.ok(p.calls.includes('initial'));
    assert.strictEqual(p.w.prViewInitialExpansion(TREE), false, 'no PR view → the normal initial depth applies');
  });

  test('an exit that arrives without a PR view is ignored', () => {
    const p = graphPage();
    p.w.handlePrViewMessage({ type: 'pr-view', active: false, restore: true });
    assert.deepStrictEqual(p.calls, []);
  });
});

// ── Sidebar pane ──────────────────────────────────────────────────────────────

const PR = {
  number: 69, title: 'fix: a save can overwrite the wrong lines', author: 'bela', headRef: 'fix/save', baseRef: 'main',
  headOid: 'abc', state: 'open', isDraft: false, checks: 'pass', changedFiles: 13, additions: 9, deletions: 4,
  updatedAt: '2026-10-05T10:00:00Z', url: 'https://github.com/acme/app/pull/69',
};

function vcsState(over: Record<string, unknown> = {}) {
  return {
    type: 'vcs-state', loading: false, filter: 'open', problem: null, fixLabel: null, pullRequests: [PR],
    truncated: false, fetchedAt: '2026-10-06T09:59:00Z', active: null, opening: null, detail: null, openProblem: null,
    ...over,
  };
}

function sidebarPage() {
  const dom = new JSDOM('<body><div class="pane pane--primary" id="pane-primary" hidden></div></body>', { runScripts: 'outside-only' });
  const w = dom.window as any;
  const posted: any[] = [];
  const wired: string[][] = [];
  w.vscode = { postMessage: (m: any) => posted.push(JSON.parse(JSON.stringify(m))) }; // out of the jsdom realm
  w.wireSection = (...ids: string[]) => wired.push(ids);
  w.eval(SIDEBAR_SRC);
  const send = (state: unknown) => w.dispatchEvent(new w.MessageEvent('message', { data: state }));
  const q = (sel: string) => w.document.querySelector(sel) as HTMLElement | null;
  const all = (sel: string) => [...w.document.querySelectorAll(sel)] as HTMLElement[];
  return { w, posted, wired, send, q, all };
}

suite('vcs — sidebar-vcs.js (Version Control pane)', () => {
  test('pure helpers: relative time and the filter', () => {
    const now = Date.parse('2026-10-06T10:00:00Z');
    assert.strictEqual(sidebarVcs.vcsAgo('2026-10-06T09:59:40Z', now), 'now');
    assert.strictEqual(sidebarVcs.vcsAgo('2026-10-06T09:15:00Z', now), '45m');
    assert.strictEqual(sidebarVcs.vcsAgo('2026-10-06T03:00:00Z', now), '7h');
    assert.strictEqual(sidebarVcs.vcsAgo('2026-10-01T10:00:00Z', now), '5d');
    assert.strictEqual(sidebarVcs.vcsAgo('2024-10-01T10:00:00Z', now), '2y');
    assert.strictEqual(sidebarVcs.vcsAgo('', now), '');
    assert.strictEqual(sidebarVcs.vcsMatches(PR, ''), true);
    assert.strictEqual(sidebarVcs.vcsMatches(PR, '#69'), true);
    assert.strictEqual(sidebarVcs.vcsMatches(PR, 'OVERWRITE'), true);
    assert.strictEqual(sidebarVcs.vcsMatches(PR, 'fix/save'), true);
    assert.strictEqual(sidebarVcs.vcsMatches(PR, 'webview'), false);
  });

  test('detail lines say which tree, what is drawn, what is whole-file and what is left out', () => {
    const checkout = { kind: 'checkout', branch: 'main' };
    const lines = sidebarVcs.vcsDetailLines({ tree: checkout, counts: { total: 13, inGraph: 9, exact: 7, fileLevel: 2, missing: 1, other: 3 }, filesCut: true });
    assert.deepStrictEqual(lines.map((l: any) => l.cls), ['dim', '', 'warn', 'dim', 'dim', 'dim']);
    assert.strictEqual(lines[0].text, 'Showing your checkout (main), coloured with the pull request\'s changes.');
    assert.ok(lines[1].text.startsWith('9 of 13 files'));
    assert.ok(lines[2].text.includes('whole file'));
    assert.ok(lines[3].text.includes('not in this checkout'));
    const head = sidebarVcs.vcsDetailLines({ tree: { kind: 'head', sha: '23834be0123' }, counts: { total: 3, inGraph: 2, exact: 2, fileLevel: 0, missing: 1, other: 0 } });
    assert.strictEqual(head[0].text, 'Showing the pull request\'s own commit 23834be, read-only, in its own panel.');
    assert.ok(head[2].text.includes('removed by the pull request'));
    const none = sidebarVcs.vcsDetailLines({ tree: checkout, counts: { total: 1, inGraph: 0, exact: 0, fileLevel: 0, missing: 0, other: 1 } });
    assert.deepStrictEqual([none[1].cls, none.length], ['warn', 3]);
  });

  test('boot fills the empty primary pane, wires its header and announces itself', () => {
    const p = sidebarPage();
    assert.strictEqual(p.q('#pane-primary')!.hidden, false);
    assert.strictEqual(p.q('#hdr-vcs')!.textContent!.includes('Version Control'), true);
    assert.deepStrictEqual(p.wired, [['hdr-vcs', 'body-vcs', 'pane-primary']]);
    assert.deepStrictEqual(p.posted, [{ type: 'vcs-ready' }]);
  });

  test('a list renders one card per PR with number, title, checks and meta; a click opens it', () => {
    const p = sidebarPage();
    p.send(vcsState({ pullRequests: [PR, { ...PR, number: 70, title: 'second', state: 'merged', isDraft: true, checks: 'fail' }], filter: 'all' }));
    const cards = p.all('.vcs-pr');
    assert.strictEqual(cards.length, 2);
    assert.strictEqual(cards[0].querySelector('.vcs-num')!.textContent, '#69');
    assert.strictEqual(cards[0].querySelector('.vcs-check')!.textContent, '✓');
    const meta = cards[0].querySelector('.vcs-meta')!.textContent!;
    assert.ok(meta.startsWith('bela · 13 files · ') && meta.endsWith(' · fix/save → main'), meta);
    assert.deepStrictEqual([...cards[1].querySelectorAll('.vcs-tag')].map(t => t.textContent), ['merged', 'draft']);
    assert.ok(cards[1].querySelector('.vcs-check')!.classList.contains('fail'));
    assert.ok(p.all('.vcs-tool')[1].classList.contains('active'), 'All is the active filter');
    cards[1].click();
    assert.deepStrictEqual(p.posted[1], { type: 'vcs-open', number: 70 });
  });

  test('header tools post filter and refresh without toggling the section', () => {
    const p = sidebarPage();
    p.send(vcsState());
    let headerClicks = 0;
    p.q('#hdr-vcs')!.addEventListener('click', () => headerClicks++);
    for (const b of p.all('.vcs-tool')) { b.click(); }
    assert.deepStrictEqual(p.posted.slice(1), [{ type: 'vcs-filter', state: 'open' }, { type: 'vcs-filter', state: 'all' }, { type: 'vcs-refresh' }]);
    assert.strictEqual(headerClicks, 0);
  });

  test('every problem is a readable note with Retry, plus the fix when there is one', () => {
    const p = sidebarPage();
    p.send(vcsState({ pullRequests: [], fixLabel: 'Sign in…', problem: { kind: 'gh-unauthenticated', message: 'The GitHub CLI is not signed in.', detail: 'HTTP 401' } }));
    const note = p.q('.vcs-note')!;
    assert.ok(note.textContent!.includes('not signed in'));
    assert.strictEqual(note.title, 'HTTP 401');
    const buttons = [...note.querySelectorAll('button')];
    assert.deepStrictEqual(buttons.map(b => b.textContent), ['Sign in…', 'Retry']);
    buttons[0].click(); buttons[1].click();
    assert.deepStrictEqual(p.posted.slice(1), [{ type: 'vcs-fix' }, { type: 'vcs-refresh' }]);
    p.send(vcsState({ pullRequests: [], problem: { kind: 'not-a-repo', message: 'This folder is not a git repository.' } }));
    assert.deepStrictEqual([...p.q('.vcs-note')!.querySelectorAll('button')].map(b => b.textContent), ['Retry']);
    assert.strictEqual(p.q('.vcs-foot')!.textContent, '');
  });

  test('empty and loading states', () => {
    const p = sidebarPage();
    p.send(vcsState({ pullRequests: [], loading: true }));
    assert.strictEqual(p.q('.vcs-note')!.textContent, 'Loading pull requests…');
    assert.strictEqual((p.all('.vcs-tool')[2] as HTMLButtonElement).disabled, true);
    p.send(vcsState({ pullRequests: [] }));
    assert.strictEqual(p.q('.vcs-note')!.textContent, 'No open pull requests.');
    p.send(vcsState({ pullRequests: [], filter: 'all' }));
    assert.strictEqual(p.q('.vcs-note')!.textContent, 'This repository has no pull requests.');
  });

  test('the open PR shows what the graph draws, its files, Leave and the GitHub link', () => {
    const p = sidebarPage();
    p.send(vcsState({
      active: 69,
      detail: {
        number: 69, tree: { kind: 'checkout', branch: 'main' }, filesCut: false, counts: { total: 3, inGraph: 2, exact: 1, fileLevel: 1, missing: 0, other: 1 },
        files: [
          { path: 'src/funcEnd.ts', status: 'added', place: 'graph', exact: true },
          { path: 'src/graphProvider.ts', status: 'modified', place: 'graph', exact: false },
          { path: 'CHANGELOG.md', status: 'modified', place: 'other', exact: false },
        ],
      },
    }));
    const card = p.q('.vcs-pr.active')!;
    assert.ok(card.querySelectorAll('.vcs-line')[1].textContent!.startsWith('2 of 3 files'));
    assert.deepStrictEqual([...card.querySelectorAll('.vcs-file .st')].map(s => `${s.textContent}:${s.className}`), ['A:st added', 'M:st modified', 'M:st modified']);
    assert.deepStrictEqual([...card.querySelectorAll('.vcs-file .why')].map(s => s.textContent), ['whole file', 'not in graph']);
    const [leave, github] = [...card.querySelectorAll('.vcs-actions button')] as HTMLButtonElement[];
    leave.click(); github.click();
    assert.deepStrictEqual(p.posted.slice(1), [{ type: 'vcs-exit' }, { type: 'vcs-browse', number: 69 }], 'neither click re-opens the PR');
  });

  test('while a PR is opening, cards are busy and further clicks do nothing', () => {
    const p = sidebarPage();
    p.send(vcsState({ opening: 69 }));
    const card = p.q('.vcs-pr')!;
    assert.ok(card.classList.contains('busy'));
    assert.ok(card.querySelector('.vcs-meta')!.textContent!.startsWith('opening…'));
    card.click();
    assert.strictEqual(p.posted.length, 1);
  });

  test('a PR that could not be opened explains itself on its own card', () => {
    const p = sidebarPage();
    p.send(vcsState({ openProblem: { number: 69, problem: { kind: 'offline', message: 'GitHub could not be reached.' } } }));
    assert.strictEqual(p.q('.vcs-pr .vcs-line.warn')!.textContent, 'GitHub could not be reached.');
    assert.strictEqual(p.q('.vcs-pr .vcs-actions'), null, 'no fallback offered for a list problem');
  });

  test('when the head cannot be fetched the card offers the checkout as a fallback, and nothing else re-opens', () => {
    const p = sidebarPage();
    p.send(vcsState({ openProblem: { number: 69, problem: { kind: 'head-unavailable', message: 'The remote could not be reached.', fallback: 'checkout' } } }));
    const btn = p.q('.vcs-pr .vcs-actions button') as HTMLButtonElement;
    assert.strictEqual(btn.textContent, 'Show in the current checkout instead');
    btn.click();
    assert.deepStrictEqual(p.posted.slice(1), [{ type: 'vcs-open', number: 69, tree: 'checkout' }]);
  });

  test('hostile PR text stays text', () => {
    const p = sidebarPage();
    p.send(vcsState({ pullRequests: [{ ...PR, title: '<img src=x onerror=alert(1)>', author: '<b>x</b>', headRef: '"><script>' }] }));
    assert.strictEqual(p.q('.vcs-pr img'), null);
    assert.strictEqual(p.q('.vcs-pr b'), null);
    assert.strictEqual(p.q('.vcs-pr script'), null);
    assert.strictEqual(p.q('.vcs-title')!.textContent, '<img src=x onerror=alert(1)>');
  });

  test('the filter box appears with a long list, narrows it, and "Show more" asks for the next page', () => {
    const p = sidebarPage();
    const many = Array.from({ length: 8 }, (_, i) => ({ ...PR, number: 100 + i, title: i === 3 ? 'needle here' : `pr ${i}` }));
    p.send(vcsState({ pullRequests: many, truncated: true }));
    const filter = p.q('.vcs-filter') as HTMLInputElement;
    assert.strictEqual(filter.style.display, '');
    filter.value = 'needle';
    filter.dispatchEvent(new p.w.Event('input'));
    assert.deepStrictEqual(p.all('.vcs-pr').map(c => c.dataset.number), ['103']);
    filter.value = 'zzz';
    filter.dispatchEvent(new p.w.Event('input'));
    assert.strictEqual(p.q('.vcs-note')!.textContent, 'No pull request matches the filter.');
    assert.ok(p.q('.vcs-foot')!.textContent!.startsWith('8+ pull requests'));
    (p.q('.vcs-foot button') as HTMLButtonElement).click();
    assert.deepStrictEqual(p.posted[1], { type: 'vcs-more' });
    p.send(vcsState());
    assert.strictEqual((p.q('.vcs-filter') as HTMLInputElement).style.display, 'none', 'a short list needs no filter');
  });
});
