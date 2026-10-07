// prView.js — a pull request shown in the graph (host: src/vcs).
//
// The host sends `pr-view` when a pull request is opened from the sidebar's
// Version Control pane, and again (active:false) when it is left. Entering
// opens every folder on a path to a changed file and closes the rest; the
// colours are the ordinary git colours, fed by the host from the PR's diff
// instead of the working tree. Leaving puts back the expansion, detail depth
// and frame rects that were on screen before.
//
// Language colours are switched off while a pull request is shown: the three
// PR colours are the only ones that should carry meaning (TypeScript's pink
// sits right next to "deleted" red), so untouched functions go neutral.
//
// state.prView = { number, name, title, headRef, baseRef, expand, counts,
//                  snapshot, prevGitMode, prevLanguageMode } | null — never
// saved with a layout.

const PR_DELETED_COLOR = '#e5534b';

const PR_BANNER_CSS = `
  #pr-view-banner {
    position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 150;
    display: flex; align-items: center; gap: 10px; max-width: min(720px, 70vw);
    padding: 5px 6px 5px 12px; border-radius: 6px; font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-focusBorder, #007fd4);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #pr-view-banner .pr-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The tree chip is structural, never a status colour: in this panel green, orange and
     red mean added, modified and deleted, and nothing else may borrow them. */
  #pr-view-banner .pr-tree {
    flex: none; font-size: 11px; padding: 1px 8px; border-radius: 9px; white-space: nowrap;
    color: var(--vscode-badge-foreground, #fff); background: var(--vscode-badge-background, #4d4d4d);
  }
  #pr-view-banner .pr-tree::before { margin-right: 4px; }
  #pr-view-banner .pr-tree.head::before { content: '⎇'; }
  #pr-view-banner .pr-tree.checkout::before { content: '⌂'; }
  #pr-view-banner .pr-sub { flex: none; color: var(--vscode-descriptionForeground, #999); white-space: nowrap; }
  #pr-view-banner .pr-sub.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  #pr-view-banner button {
    flex: none; font: inherit; font-size: 11px; padding: 2px 9px; border-radius: 3px; cursor: pointer;
    color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c);
    border: none;
  }
  #pr-view-banner button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
`;

/** The folders of `expand` that this tree actually has. */
function prViewExpansion(tree, expand) {
  const out = new Set();
  if (!tree || !tree.folders) { return out; }
  for (const p of (expand || [])) { if (tree.folders[p]) { out.add(p); } }
  return out;
}

/** The chip that says WHICH tree is on screen: the PR's own commit, or the user's checkout. */
function prViewTreeLabel(tree) {
  if (tree && tree.kind === 'head') {
    const sha = String(tree.sha || '').slice(0, 7);
    return { text: `the pull request's commit ${sha}`, cls: 'head', title: `This is the pull request's own code at ${tree.sha}${tree.base ? `, compared with ${String(tree.base).slice(0, 7)}` : ''}. It is read-only.` };
  }
  const branch = tree && tree.branch ? ` (${tree.branch})` : '';
  return { text: `your checkout${branch}`, cls: 'checkout', title: 'This is the code in your working tree, coloured with what the pull request changes. Files the pull request adds or removes that your checkout does not have are listed in the sidebar.' };
}

/** One line for the banner: how much of the PR the graph shows, and how exactly. */
function prViewSummary(counts) {
  const c = counts || {};
  const total = c.total || 0;
  if (!c.inGraph) {
    return { text: `none of its ${total} file${total === 1 ? '' : 's'} is in the graph`, warn: true };
  }
  const base = `${c.inGraph} of ${total} file${total === 1 ? '' : 's'} in the graph`;
  if (c.fileLevel > 0) {
    return { text: `${base} · ${c.fileLevel} coloured as whole files (checkout differs)`, warn: true };
  }
  return { text: base, warn: false };
}

/** Called by setInitialDetailDepth: an active PR view decides the first expansion. */
function prViewInitialExpansion(tree) {
  if (!state.prView) { return false; }
  state.expandedFolders = prViewExpansion(tree, state.prView.expand);
  if (typeof setDetailSlider === 'function') { setDetailSlider(state.detailDepth || 0); }
  return true;
}

function prViewSnapshot() {
  if (!state.structureTree || typeof isDrilldown !== 'function' || !isDrilldown()) { return null; }
  return {
    expandedFolders: [...(state.expandedFolders || [])],
    detailDepth: state.detailDepth,
    frames: (state.frames && typeof serializeFrames === 'function') ? serializeFrames(state.frames) : null,
  };
}

function prViewSyncColourUi() {
  if (typeof document === 'undefined') { return; }
  document.getElementById('btn-git-mode')?.classList.toggle('active', state.gitMode);
  if (typeof setGitLegendVisible === 'function') { setGitLegendVisible(state.gitMode); }
  document.getElementById('btn-language-mode')?.classList.toggle('active', state.languageMode);
  if (typeof setLangLegendVisible === 'function') { setLangLegendVisible(state.languageMode); }
}

/** Drop the frames' pack history so the next render packs this picture from scratch. */
function prViewFreshPack() {
  if (typeof usesFrames === 'function' && usesFrames() && typeof resetFrames === 'function') { resetFrames(); }
}

/** "Deleted" is grey for the working tree; a pull request shows it red. */
function prViewPaintDeleted(on) {
  if (typeof document === 'undefined') { return; }
  const rootStyle = document.documentElement.style;
  if (on) { rootStyle.setProperty('--cograph-git-deleted', PR_DELETED_COLOR); }
  else { rootStyle.removeProperty('--cograph-git-deleted'); }
  for (const row of document.querySelectorAll('#git-legend-body .tl-legend-row')) {
    const label = row.querySelector('.tl-legend-label');
    const dot = row.querySelector('.tl-legend-dot');
    if (!label || !dot || label.textContent.trim() !== 'Deleted') { continue; }
    if (on) {
      if (dot.dataset.prPrev === undefined) { dot.dataset.prPrev = dot.style.background; }
      dot.style.background = PR_DELETED_COLOR;
    } else if (dot.dataset.prPrev !== undefined) {
      dot.style.background = dot.dataset.prPrev;
      delete dot.dataset.prPrev;
    }
  }
}

function prViewRenderBanner() {
  if (typeof document === 'undefined') { return; }
  let banner = document.getElementById('pr-view-banner');
  if (!state.prView) { banner?.remove(); return; }
  if (!document.getElementById('pr-view-style')) {
    const style = document.createElement('style');
    style.id = 'pr-view-style';
    style.textContent = PR_BANNER_CSS;
    document.head.appendChild(style);
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'pr-view-banner';
    document.body.appendChild(banner);
  }
  const pv = state.prView;
  banner.textContent = '';
  const name = document.createElement('span');
  name.className = 'pr-name';
  name.textContent = pv.name || `PR #${pv.number}`;   // remote text: textContent only
  name.title = pv.headRef && pv.baseRef ? `${pv.title}\n${pv.headRef} → ${pv.baseRef}` : (pv.title || '');
  const treeLabel = prViewTreeLabel(pv.tree);
  const tree = document.createElement('span');
  tree.className = 'pr-tree ' + treeLabel.cls;
  tree.textContent = treeLabel.text;
  tree.title = treeLabel.title;
  const summary = prViewSummary(pv.counts);
  const sub = document.createElement('span');
  sub.className = 'pr-sub' + (summary.warn ? ' warn' : '');
  sub.textContent = summary.text;
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.textContent = 'Leave';
  exit.title = 'Back to the graph you had before';
  exit.addEventListener('click', () => vscode.postMessage({ type: 'subgraph-exit' }));
  banner.append(name, tree, sub, exit);
}

function prViewRerender() {
  if (!state.structureTree || typeof isDrilldown !== 'function' || !isDrilldown()) {
    if (typeof applyGitColors === 'function') { applyGitColors(); }
    return;
  }
  if (typeof requestParseForExpanded === 'function') { requestParseForExpanded(); }
  // Fit the new picture: what is open now has little to do with what was open.
  state.hasFitted = false;
  state.userZoomed = false;
  if (typeof applyFileClusters === 'function') { applyFileClusters(); }
  if (typeof applyGitColors === 'function') { applyGitColors(); }
}

function prViewEnter(message) {
  const previous = state.prView;
  state.prView = {
    number: message.number,
    name: message.name,
    title: message.title || '',
    headRef: message.headRef || '',
    baseRef: message.baseRef || '',
    expand: Array.isArray(message.expand) ? message.expand : [],
    counts: message.counts || {},
    tree: message.tree || { kind: 'checkout', branch: '' },
    // Going from one pull request to the next keeps what was there before the first.
    snapshot: previous ? previous.snapshot : prViewSnapshot(),
    prevGitMode: previous ? previous.prevGitMode : state.gitMode,
    prevLanguageMode: previous ? previous.prevLanguageMode : state.languageMode,
  };
  if (message.fileGitStatus) { state.fileGitStatus = message.fileGitStatus; }
  state.gitMode = true;
  state.languageMode = false;
  prViewSyncColourUi();
  prViewPaintDeleted(true);
  prViewRenderBanner();
  if (state.structureTree) {
    state.expandedFolders = prViewExpansion(state.structureTree, state.prView.expand);
    prViewFreshPack();
    prViewRerender();
  }
}

function prViewLeave(message) {
  const pv = state.prView;
  if (!pv) { return; }
  state.prView = null;
  if (message.fileGitStatus) { state.fileGitStatus = message.fileGitStatus; }
  state.gitMode = pv.prevGitMode;
  state.languageMode = pv.prevLanguageMode;
  prViewSyncColourUi();
  prViewPaintDeleted(false);
  prViewRenderBanner();
  if (!message.restore) {
    // Another view is taking over (a saved graph, a folder scope): it brings its own layout.
    if (typeof applyGitColors === 'function') { applyGitColors(); }
    return;
  }
  // A fresh pack, then the saved rects on top: frames grow in place and never shrink
  // back on their own, so without this the old picture would come back in a wider root.
  prViewFreshPack();
  const snap = pv.snapshot;
  if (snap) {
    state.detailDepth = snap.detailDepth;
    if (typeof setDetailSlider === 'function') { setDetailSlider(state.detailDepth || 0); }
    state.expandedFolders = new Set(snap.expandedFolders);
    if (snap.frames && typeof usesFrames === 'function' && usesFrames()) {
      // The saved-layout path re-applies the frame rects as the frames reappear.
      state.savedLayout = { frames: snap.frames, _metaApplied: true };
    }
  } else if (state.structureTree && typeof setInitialDetailDepth === 'function') {
    setInitialDetailDepth(); // the panel was opened for the pull request: nothing came before it
  }
  prViewRerender();
}

/** Entry point for the host's `pr-view` message. */
function handlePrViewMessage(message) {
  if (message && message.active) { prViewEnter(message); } else { prViewLeave(message || {}); }
}

if (typeof module !== 'undefined') {
  module.exports = {
    handlePrViewMessage, prViewInitialExpansion, prViewExpansion, prViewSummary, prViewTreeLabel, PR_DELETED_COLOR,
  };
}
