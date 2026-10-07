// sidebar-vcs.js — the sidebar's Version Control pane (pull requests).
//
// Renders the host's `vcs-state` snapshot (src/vcs/vcsSidebar.ts) and posts
// `vcs-*` messages back. Holds no data of its own beyond the filter text.
// Pull-request titles, authors and branch names are remote text: every row
// is built with textContent, never innerHTML.

const VCS_CSS = `
  #pane-primary .vcs-tools { margin-left: auto; display: flex; align-items: center; gap: 4px; }
  .vcs-tool {
    font: inherit; font-size: 10px; letter-spacing: 0; text-transform: none; font-weight: 500;
    color: var(--vscode-foreground); background: transparent; cursor: pointer;
    border: 1px solid transparent; border-radius: 3px; padding: 1px 6px; line-height: 16px;
  }
  .vcs-tool:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2)); }
  .vcs-tool.active { border-color: var(--vscode-focusBorder, #007fd4); }
  .vcs-tool:disabled { opacity: 0.5; cursor: default; }
  #body-vcs { padding: 8px 10px 10px; }
  .vcs-filter {
    display: block; width: 100%; padding: 4px 8px; margin-bottom: 8px; font-size: 12px; outline: none;
    background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, #555); border-radius: 4px;
  }
  .vcs-list { display: flex; flex-direction: column; gap: 6px; }
  .vcs-pr {
    border: 1px solid var(--vscode-widget-border, #444); border-left-width: 3px; border-radius: 6px;
    background: var(--vscode-editor-background, #1e1e1e); padding: 6px 9px; cursor: pointer;
  }
  .vcs-pr:hover { border-color: var(--vscode-focusBorder, #007fd4); }
  .vcs-pr.active { border-left-color: var(--vscode-focusBorder, #007fd4); }
  .vcs-pr.busy { opacity: 0.6; cursor: progress; }
  .vcs-pr-top { display: flex; align-items: baseline; gap: 6px; }
  .vcs-num { color: var(--vscode-descriptionForeground, #888); font-variant-numeric: tabular-nums; flex: none; }
  .vcs-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vcs-check { flex: none; font-size: 11px; }
  .vcs-check.pass { color: #4caf50; } .vcs-check.fail { color: #e5534b; } .vcs-check.pending { color: #d29922; }
  .vcs-meta {
    margin-top: 2px; font-size: 11px; color: var(--vscode-descriptionForeground, #888);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .vcs-tag {
    display: inline-block; font-size: 10px; line-height: 14px; padding: 0 5px; margin-right: 5px;
    border-radius: 7px; border: 1px solid currentColor;
  }
  .vcs-tag.merged { color: #a371f7; } .vcs-tag.closed { color: #e5534b; }
  .vcs-detail { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--vscode-widget-border, #444); cursor: default; }
  .vcs-line { font-size: 11px; line-height: 1.45; }
  .vcs-line.dim { color: var(--vscode-descriptionForeground, #888); }
  .vcs-line.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  .vcs-actions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .vcs-btn {
    font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 3px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground, #ccc);
    background: var(--vscode-button-secondaryBackground, #3a3d41); border: 1px solid transparent;
  }
  .vcs-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  .vcs-btn.primary { color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); }
  .vcs-btn.primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  .vcs-files { margin-top: 6px; max-height: 180px; overflow-y: auto; }
  .vcs-file { display: flex; gap: 6px; font-size: 11px; line-height: 1.5; white-space: nowrap; }
  .vcs-file .st { flex: none; width: 10px; font-weight: 700; text-align: center; }
  .vcs-file .st.added { color: #4caf50; } .vcs-file .st.modified { color: #ff9800; } .vcs-file .st.deleted { color: #e5534b; }
  .vcs-file .p { overflow: hidden; text-overflow: ellipsis; }
  .vcs-file.off { color: var(--vscode-descriptionForeground, #888); }
  .vcs-file .why { flex: none; margin-left: auto; font-style: italic; }
  .vcs-file .vcs-mini { flex: none; margin-left: auto; font-size: 10px; padding: 0 6px; line-height: 16px; }
  .vcs-note { font-size: 11px; color: var(--vscode-descriptionForeground, #888); text-align: center; padding: 10px 4px; line-height: 1.45; }
  .vcs-note .vcs-actions { justify-content: center; }
  .vcs-foot { margin-top: 8px; font-size: 10px; color: var(--vscode-descriptionForeground, #888); display: flex; gap: 8px; align-items: center; }
  .vcs-foot .vcs-btn { margin-left: auto; }
`;

const VCS_CHECK_GLYPH = { pass: '✓', fail: '✕', pending: '●' };
const VCS_CHECK_TITLE = { pass: 'Checks passed', fail: 'Checks failed', pending: 'Checks running' };
const VCS_STATUS_LETTER = { added: 'A', modified: 'M', deleted: 'D' };

/** "3d", "5h", "12m", "now" — how long ago an ISO time was; '' when unreadable. */
function vcsAgo(iso, nowMs) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) { return ''; }
  const min = Math.max(0, Math.floor((nowMs - t) / 60000));
  if (min < 1) { return 'now'; }
  if (min < 60) { return min + 'm'; }
  if (min < 60 * 24) { return Math.floor(min / 60) + 'h'; }
  if (min < 60 * 24 * 365) { return Math.floor(min / (60 * 24)) + 'd'; }
  return Math.floor(min / (60 * 24 * 365)) + 'y';
}

/** Does a pull request match the filter box (number, title, author, branches)? */
function vcsMatches(pr, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) { return true; }
  return [`#${pr.number}`, pr.title, pr.author, pr.headRef, pr.baseRef]
    .some(s => String(s || '').toLowerCase().includes(q));
}

/** The sentences under an open pull request: what of it the graph shows, and how. */
function vcsDetailLines(detail) {
  const c = detail.counts;
  const head = detail.tree && detail.tree.kind === 'head';
  const lines = [];
  lines.push(head
    ? { text: `Showing the pull request's own commit ${String(detail.tree.sha).slice(0, 7)}, read-only, in its own panel.`, cls: 'dim' }
    : { text: `Showing your checkout${detail.tree && detail.tree.branch ? ` (${detail.tree.branch})` : ''} in its own panel, coloured with the pull request's changes.`, cls: 'dim' });
  if (c.inGraph === 0) {
    lines.push({ text: `None of this pull request's ${c.total} file${c.total === 1 ? '' : 's'} is in the graph.`, cls: 'warn' });
  } else {
    lines.push({ text: `${c.inGraph} of ${c.total} file${c.total === 1 ? '' : 's'} in the graph.`, cls: '' });
    if (c.fileLevel > 0) {
      lines.push({
        text: `${c.fileLevel} coloured as a whole file: your checkout's version differs from the pull request's, so its functions cannot be told apart.`,
        cls: 'warn',
      });
    }
  }
  if (c.missing > 0) {
    lines.push(head
      ? { text: `${c.missing} removed by the pull request (not in its commit).`, cls: 'dim' }
      : { text: `${c.missing} not in this checkout (added or removed by the pull request).`, cls: 'dim' });
  }
  if (c.other > 0) {
    lines.push({ text: `${c.other} not shown: the graph has source files only.`, cls: 'dim' });
  }
  if (detail.filesCut) { lines.push({ text: 'The file list is cut short.', cls: 'dim' }); }
  if (detail.diff) {
    const s = detail.diff.summary;
    lines.push({
      text: `Against the merge base ${String(detail.diff.base).slice(0, 7)}: ${s.added} function${s.added === 1 ? '' : 's'} added, ${s.changed} changed, ${s.removed} removed · ${s.edgesAdded} call${s.edgesAdded === 1 ? '' : 's'} added, ${s.edgesRemoved} removed · ${s.callersAffected} caller${s.callersAffected === 1 ? '' : 's'} affected.`,
      cls: '',
    });
  } else if (detail.tree && detail.tree.kind === 'head') {
    lines.push({ text: 'The base could not be fetched: coloured from the pull request\'s file list, not a structural diff.', cls: 'warn' });
  }
  return lines;
}

/**
 * Build the pane inside `mount` and return `{ render(state) }`.
 * `post` sends a message to the host; `wire` hooks the header into the
 * sidebar's collapse logic (optional: absent under test).
 */
function mountVcsPane(doc, mount, post, wire) {
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined) { n.textContent = text; }
    return n;
  };
  const button = (cls, text, title, onClick) => {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title) { b.title = title; }
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  };

  if (!doc.getElementById('vcs-style')) {
    const style = el('style');
    style.id = 'vcs-style';
    style.textContent = VCS_CSS;
    doc.head.appendChild(style);
  }

  let state = null;
  let query = '';

  const header = el('div', 'section-header');
  header.id = 'hdr-vcs';
  header.appendChild(el('span', 'chevron', '▼'));
  header.appendChild(el('span', '', 'Version Control'));
  const tools = el('span', 'vcs-tools');
  const btnOpen = button('vcs-tool', 'Open', 'Open pull requests', () => post({ type: 'vcs-filter', state: 'open' }));
  const btnAll = button('vcs-tool', 'All', 'Open, merged and closed pull requests', () => post({ type: 'vcs-filter', state: 'all' }));
  const btnRefresh = button('vcs-tool', '↻', 'Refresh', () => post({ type: 'vcs-refresh' }));
  tools.append(btnOpen, btnAll, btnRefresh);
  header.appendChild(tools);

  const body = el('div', 'section-body');
  body.id = 'body-vcs';
  const filter = el('input', 'vcs-filter');
  filter.type = 'text';
  filter.placeholder = 'Filter pull requests…';
  filter.addEventListener('input', () => { query = filter.value; renderList(); });
  const list = el('div', 'vcs-list');
  const foot = el('div', 'vcs-foot');
  body.append(filter, list, foot);

  mount.textContent = '';
  mount.append(header, body);
  mount.hidden = false;
  if (typeof wire === 'function') { wire('hdr-vcs', 'body-vcs', mount.id); }

  function note(text, actions) {
    const n = el('div', 'vcs-note', text);
    if (actions && actions.length) {
      const row = el('div', 'vcs-actions');
      row.append(...actions);
      n.appendChild(row);
    }
    return n;
  }

  function detailBlock(pr) {
    const box = el('div', 'vcs-detail');
    box.addEventListener('click', (e) => e.stopPropagation());
    const detail = state.detail && state.detail.number === pr.number ? state.detail : null;
    if (detail) {
      for (const line of vcsDetailLines(detail)) { box.appendChild(el('div', ('vcs-line ' + line.cls).trim(), line.text)); }
    }
    const actions = el('div', 'vcs-actions');
    actions.appendChild(button('vcs-btn primary', 'Leave pull request', 'Back to the graph you had before', () => post({ type: 'vcs-exit' })));
    if (pr.url) {
      actions.appendChild(button('vcs-btn', 'Open on GitHub', pr.url, () => post({ type: 'vcs-browse', number: pr.number })));
    }
    box.appendChild(actions);
    if (detail && detail.diff && detail.diff.removed.length) {
      // Removed functions have no node in the head: this list is the only place they appear.
      const removed = el('div', 'vcs-files');
      removed.appendChild(el('div', 'vcs-line dim', `Removed function${detail.diff.removed.length === 1 ? '' : 's'}${detail.diff.removedCut ? ' (first ' + detail.diff.removed.length + ')' : ''}:`));
      for (const r of detail.diff.removed) {
        const row = el('div', 'vcs-file');
        row.title = r.callers.length ? `Called in the base by:\n${r.callers.join('\n')}` : 'Nothing called it in the base.';
        row.appendChild(el('span', 'st deleted', 'D'));
        row.appendChild(el('span', 'p', r.key));
        row.appendChild(el('span', 'why', r.callers.length ? `${r.callers.length} caller${r.callers.length === 1 ? '' : 's'}` : 'no callers'));
        removed.appendChild(row);
      }
      box.appendChild(removed);
    }
    if (detail && detail.files.length) {
      const files = el('div', 'vcs-files');
      for (const f of detail.files) {
        const row = el('div', 'vcs-file' + (f.place === 'graph' ? '' : ' off'));
        row.title = f.path;
        row.appendChild(el('span', 'st ' + f.status, VCS_STATUS_LETTER[f.status] || '?'));
        row.appendChild(el('span', 'p', f.path));
        if (f.place === 'missing' && !(detail.tree && detail.tree.kind === 'head') && f.status !== 'deleted') {
          // The checkout lacks it, so no slot can open it: the PR's own version, from GitHub, read-only.
          row.appendChild(button('vcs-btn vcs-mini', 'view PR version', 'Open the pull request\'s version of this file, read-only',
            () => post({ type: 'vcs-open-file', number: pr.number, path: f.path })));
        } else if (f.place === 'missing') { row.appendChild(el('span', 'why', detail.tree && detail.tree.kind === 'head' ? 'removed' : 'not in checkout')); }
        else if (f.place === 'other') { row.appendChild(el('span', 'why', 'not in graph')); }
        else if (!f.exact) { row.appendChild(el('span', 'why', 'whole file')); }
        files.appendChild(row);
      }
      box.appendChild(files);
    }
    return box;
  }

  function prCard(pr, nowMs) {
    const busy = state.opening !== null;
    const card = el('div', 'vcs-pr' + (state.active === pr.number ? ' active' : '') + (busy ? ' busy' : ''));
    card.dataset.number = String(pr.number);
    card.title = pr.title;
    card.addEventListener('click', () => { if (!busy) { post({ type: 'vcs-open', number: pr.number }); } });

    const top = el('div', 'vcs-pr-top');
    top.appendChild(el('span', 'vcs-num', '#' + pr.number));
    top.appendChild(el('span', 'vcs-title', pr.title || '(no title)'));
    if (VCS_CHECK_GLYPH[pr.checks]) {
      const check = el('span', 'vcs-check ' + pr.checks, VCS_CHECK_GLYPH[pr.checks]);
      check.title = VCS_CHECK_TITLE[pr.checks];
      top.appendChild(check);
    }
    card.appendChild(top);

    const meta = el('div', 'vcs-meta');
    if (pr.state !== 'open') { meta.appendChild(el('span', 'vcs-tag ' + pr.state, pr.state)); }
    if (pr.isDraft) { meta.appendChild(el('span', 'vcs-tag', 'draft')); }
    const bits = [];
    if (state.opening === pr.number) { bits.push('opening…'); }
    if (pr.author) { bits.push(pr.author); }
    bits.push(`${pr.changedFiles} file${pr.changedFiles === 1 ? '' : 's'}`);
    const ago = vcsAgo(pr.updatedAt, nowMs);
    if (ago) { bits.push(ago); }
    // Branch names last: they are the long part, and the line is cut at the pane's edge.
    if (pr.headRef) { bits.push(pr.baseRef ? `${pr.headRef} → ${pr.baseRef}` : pr.headRef); }
    meta.appendChild(doc.createTextNode(bits.join(' · ')));
    card.appendChild(meta);

    if (state.openProblem && state.openProblem.number === pr.number) {
      const p = state.openProblem.problem;
      const line = el('div', 'vcs-line warn', p.message);
      if (p.detail) { line.title = p.detail; }
      card.appendChild(line);
      if (p.fallback === 'checkout') {
        const actions = el('div', 'vcs-actions');
        actions.addEventListener('click', (e) => e.stopPropagation());
        actions.appendChild(button('vcs-btn', 'Show in the current checkout instead', 'Colour your own checkout with this pull request\'s changes',
          () => post({ type: 'vcs-open', number: pr.number, tree: 'checkout' })));
        card.appendChild(actions);
      }
    }
    if (state.active === pr.number) { card.appendChild(detailBlock(pr)); }
    return card;
  }

  function renderList() {
    list.textContent = '';
    if (!state) { return; }
    const retry = () => button('vcs-btn', 'Retry', 'Load the list again', () => post({ type: 'vcs-refresh' }));
    if (state.problem) {
      const actions = [];
      if (state.fixLabel) { actions.push(button('vcs-btn primary', state.fixLabel, '', () => post({ type: 'vcs-fix' }))); }
      actions.push(retry());
      const n = note(state.problem.message, actions);
      if (state.problem.detail) { n.title = state.problem.detail; }
      list.appendChild(n);
      return;
    }
    if (!state.pullRequests.length) {
      list.appendChild(note(state.loading ? 'Loading pull requests…'
        : state.filter === 'all' ? 'This repository has no pull requests.' : 'No open pull requests.'));
      return;
    }
    const shown = state.pullRequests.filter(pr => vcsMatches(pr, query));
    if (!shown.length) { list.appendChild(note('No pull request matches the filter.')); return; }
    const nowMs = Date.now();
    for (const pr of shown) { list.appendChild(prCard(pr, nowMs)); }
  }

  function render(next) {
    state = next;
    btnOpen.classList.toggle('active', state.filter !== 'all');
    btnAll.classList.toggle('active', state.filter === 'all');
    btnRefresh.disabled = !!state.loading;
    // A filter box earns its place only once the list is longer than a glance.
    filter.style.display = state.pullRequests.length > 6 ? '' : 'none';
    if (filter.style.display === 'none' && query) { query = ''; filter.value = ''; }
    renderList();

    foot.textContent = '';
    if (state.problem || !state.pullRequests.length) { return; }
    const count = `${state.pullRequests.length}${state.truncated ? '+' : ''} pull request${state.pullRequests.length === 1 ? '' : 's'}`;
    const when = state.loading ? 'refreshing…' : state.fetchedAt ? `updated ${vcsAgo(state.fetchedAt, Date.now())}` : '';
    foot.appendChild(el('span', '', when ? `${count} · ${when}` : count));
    if (state.truncated) {
      foot.appendChild(button('vcs-btn', 'Show more', 'Load 50 more', () => post({ type: 'vcs-more' })));
    }
  }

  return { render };
}

// ── Boot (sidebar webview only) ───────────────────────────────────────────────
/* global vscode, wireSection */
if (typeof document !== 'undefined' && typeof vscode !== 'undefined' && document.getElementById('pane-primary')) {
  const pane = mountVcsPane(
    document,
    document.getElementById('pane-primary'),
    (m) => vscode.postMessage(m),
    typeof wireSection === 'function' ? wireSection : null,
  );
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'vcs-state') { pane.render(event.data); }
  });
  vscode.postMessage({ type: 'vcs-ready' });
}

if (typeof module !== 'undefined') {
  module.exports = { mountVcsPane, vcsAgo, vcsMatches, vcsDetailLines, VCS_CSS };
}
