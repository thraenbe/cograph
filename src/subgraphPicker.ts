import type { StructureTree } from './structureScanner';
import { toRel } from './subgraphScope';

/**
 * "Create new Subgraph": the explorer-like folder picker in the CoGraph sidebar.
 * Markup, styles and client script are exported as strings (same pattern as
 * annotationCard.ts) so sidebarProvider.ts only interpolates them and routes two
 * messages. The client script is embedded in a template literal: no backticks
 * and no `${}` inside it. It reuses the sidebar's global `vscode`.
 *
 * v1 is include-only: checking a folder includes its whole subtree, and a folder
 * under a checked ancestor is shown checked and locked ("included via …"); to
 * leave it out, uncheck the ancestor. A parent with some checked children is
 * indeterminate. The spec sent on Create is the set of checked folders whose
 * ancestors are not checked (the host normalizes again).
 */

export interface PickerFolder {
  /** Workspace-relative POSIX path, '.' for the root. */
  rel: string;
  name: string;
  depth: number;
  parent: string | null;
  /** Recursive file count. */
  fileCount: number;
  hasChildren: boolean;
}

/** Pure: the rows the picker renders, sorted by path so children follow their parent. */
export function buildPickerFolders(tree: StructureTree, workspaceRoot: string): PickerFolder[] {
  return Object.values(tree.folders)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(f => {
      const rel = toRel(workspaceRoot, f.path);
      return {
        rel,
        name: rel === '.' ? '.' : rel.slice(rel.lastIndexOf('/') + 1),
        depth: f.depth,
        parent: f.parent ? toRel(workspaceRoot, f.parent) : null,
        fileCount: f.fileCount,
        hasChildren: f.childFolders.length > 0,
      };
    });
}

export const SUBGRAPH_PICKER_CSS = `
    #btn-new-subgraph {
      display: block; width: 100%; padding: 5px 10px; margin: -2px 0 8px; font-size: 12px; font-weight: 600;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: none; border-radius: 3px; cursor: pointer;
    }
    #btn-new-subgraph:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    #subgraph-picker { display: none; }
    #body-graphs.picking #subgraph-picker { display: block; }
    #body-graphs.picking #btn-new-graph, #body-graphs.picking #btn-new-subgraph,
    #body-graphs.picking #search, #body-graphs.picking #graph-list { display: none; }
    .sp-title { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
    .sp-field { display: block; width: 100%; box-sizing: border-box; margin-bottom: 6px; padding: 4px 6px; font-size: 12px;
      background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; }
    .sp-tree { max-height: 260px; overflow: auto; border: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.35));
      border-radius: 3px; margin-bottom: 6px; outline: none; }
    .sp-row { display: flex; align-items: center; gap: 4px; padding: 2px 6px; font-size: 12px; cursor: pointer; white-space: nowrap; }
    .sp-row:hover, .sp-row.focused { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .sp-row.focused { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
    .sp-twisty { width: 12px; flex: none; opacity: 0.7; font-size: 10px; text-align: center; }
    .sp-check { flex: none; margin: 0; }
    .sp-name { overflow: hidden; text-overflow: ellipsis; }
    .sp-row.locked .sp-name { opacity: 0.6; }
    .sp-count { margin-left: auto; font-size: 10px; opacity: 0.6; flex: none; }
    .sp-hint { font-size: 11px; opacity: 0.75; min-height: 14px; margin-bottom: 6px; }
    .sp-hint.error { color: var(--vscode-errorForeground, #f48771); opacity: 1; }
    .sp-actions { display: flex; gap: 6px; }
    .sp-actions button { flex: 1; padding: 4px 8px; font-size: 12px; border: none; border-radius: 3px; cursor: pointer; }
    #sp-create { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
    #sp-cancel { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
`;

export const SUBGRAPH_PICKER_MARKUP = `
      <button id="btn-new-subgraph" title="Pick the folders to visualize and save them as a subgraph">⊂ Create new Subgraph</button>
      <div id="subgraph-picker">
        <div class="sp-title">New subgraph</div>
        <input id="sp-name" class="sp-field" type="text" placeholder="Name" />
        <input id="sp-search" class="sp-field" type="text" placeholder="Filter folders…" />
        <div id="sp-tree" class="sp-tree" tabindex="0" role="tree"></div>
        <div id="sp-hint" class="sp-hint"></div>
        <div class="sp-actions"><button id="sp-create">Create</button><button id="sp-cancel">Cancel</button></div>
      </div>`;

export const SUBGRAPH_PICKER_SCRIPT = `
    // ── Subgraph picker ────────────────────────────────────────────────
    var sp = { folders: [], byRel: {}, children: {}, checked: {}, expanded: {}, query: '', focus: null, open: false };

    function spEsc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function spAncestorChecked(rel) {
      var f = sp.byRel[rel];
      while (f && f.parent !== null) { if (sp.checked[f.parent]) { return f.parent; } f = sp.byRel[f.parent]; }
      return null;
    }
    // 'checked' (self or an ancestor), 'mixed' (some descendant checked), or 'none'.
    function spState(rel) {
      if (sp.checked[rel] || spAncestorChecked(rel)) { return 'checked'; }
      var kids = sp.children[rel] || [];
      for (var i = 0; i < kids.length; i++) { if (spState(kids[i]) !== 'none') { return 'mixed'; } }
      return 'none';
    }
    function spMatches(rel) {
      if (!sp.query) { return true; }
      return rel.toLowerCase().indexOf(sp.query) >= 0;
    }
    function spHasMatchBelow(rel) {
      var kids = sp.children[rel] || [];
      for (var i = 0; i < kids.length; i++) { if (spMatches(kids[i]) || spHasMatchBelow(kids[i])) { return true; } }
      return false;
    }
    // Rows in display order: a folder is shown when it matches, or an ancestor of a match
    // (then it is forced open); without a query, only expanded folders show their children.
    function spVisibleRows() {
      var out = [];
      function walk(rel) {
        var below = sp.query ? spHasMatchBelow(rel) : false;
        if (sp.query && !spMatches(rel) && !below) { return; }
        out.push(rel);
        var open = sp.query ? (below || spMatches(rel)) : !!sp.expanded[rel];
        if (!open) { return; }
        var kids = sp.children[rel] || [];
        for (var i = 0; i < kids.length; i++) { walk(kids[i]); }
      }
      if (sp.byRel['.']) { walk('.'); }
      return out;
    }
    /** The include list: checked folders whose ancestors are not checked. */
    function spSelection() {
      var out = [];
      for (var rel in sp.checked) { if (sp.checked[rel] && !spAncestorChecked(rel)) { out.push(rel); } }
      return out.sort();
    }
    function spRenderTree() {
      var tree = document.getElementById('sp-tree');
      if (!tree) { return; }
      var rows = spVisibleRows();
      if (sp.focus === null || rows.indexOf(sp.focus) < 0) { sp.focus = rows.length ? rows[0] : null; }
      var html = '';
      for (var i = 0; i < rows.length; i++) {
        var rel = rows[i], f = sp.byRel[rel], st = spState(rel);
        var via = spAncestorChecked(rel);
        var open = sp.query ? true : !!sp.expanded[rel];
        var twisty = f.hasChildren ? (open ? '▾' : '▸') : '';
        html += '<div class="sp-row' + (via ? ' locked' : '') + (rel === sp.focus ? ' focused' : '') + '" role="treeitem" data-rel="' + spEsc(rel)
          + '" style="padding-left:' + (6 + f.depth * 14) + 'px" title="' + (via ? 'Included via ' + spEsc(via) : spEsc(rel)) + '">'
          + '<span class="sp-twisty" data-act="toggle">' + twisty + '</span>'
          + '<input class="sp-check" type="checkbox" data-act="check"' + (st === 'checked' ? ' checked' : '') + (via ? ' disabled' : '') + ' />'
          + '<span class="sp-name">' + spEsc(f.name) + (f.hasChildren ? '/' : '') + '</span>'
          + '<span class="sp-count">' + f.fileCount + '</span></div>';
      }
      tree.innerHTML = html || '<div class="empty-state">No folder matches.</div>';
      var boxes = tree.querySelectorAll('.sp-check');
      for (var b = 0; b < boxes.length; b++) {
        var r = boxes[b].closest('.sp-row').dataset.rel;
        boxes[b].indeterminate = spState(r) === 'mixed';
      }
      var sel = spSelection();
      var hint = document.getElementById('sp-hint');
      if (hint && !hint.classList.contains('error')) {
        hint.textContent = sel.length ? (sel.length === 1 ? '1 folder selected' : sel.length + ' folders selected') : 'Check the folders to include (subfolders come along).';
      }
      var focused = tree.querySelector('.sp-row.focused');
      if (focused && focused.scrollIntoView) { focused.scrollIntoView({ block: 'nearest' }); }
    }
    function spSetHint(text, isError) {
      var hint = document.getElementById('sp-hint');
      if (!hint) { return; }
      hint.textContent = text;
      hint.classList.toggle('error', !!isError);
    }
    function spToggleCheck(rel) {
      if (spAncestorChecked(rel)) { return; } // locked: uncheck the ancestor instead
      if (sp.checked[rel]) { delete sp.checked[rel]; }
      else {
        sp.checked[rel] = true;
        // Descendants checked explicitly are now implied by this one.
        for (var other in sp.checked) { if (other !== rel && other.indexOf(rel === '.' ? '' : rel + '/') === 0) { delete sp.checked[other]; } }
      }
      spSetHint('', false);
      spRenderTree();
    }
    function spToggleExpand(rel) {
      var f = sp.byRel[rel];
      if (!f || !f.hasChildren) { return; }
      sp.expanded[rel] = !sp.expanded[rel];
      spRenderTree();
    }
    function spOpen(msg) {
      sp.folders = msg.folders || [];
      sp.byRel = {}; sp.children = {}; sp.checked = {}; sp.expanded = {}; sp.query = ''; sp.focus = null; sp.open = true;
      for (var i = 0; i < sp.folders.length; i++) {
        var f = sp.folders[i];
        sp.byRel[f.rel] = f;
        if (f.parent !== null) { (sp.children[f.parent] = sp.children[f.parent] || []).push(f.rel); }
      }
      // Root and its first level open, so the picker starts with something to click.
      sp.expanded['.'] = true;
      var name = document.getElementById('sp-name'), search = document.getElementById('sp-search');
      if (name) { name.value = msg.defaultName || 'Subgraph'; }
      if (search) { search.value = ''; }
      spSetHint('', false);
      document.getElementById('body-graphs').classList.add('picking');
      spRenderTree();
      if (name) { name.focus(); name.select(); }
    }
    function spClose() {
      sp.open = false;
      document.getElementById('body-graphs').classList.remove('picking');
    }
    function spCreate() {
      var sel = spSelection();
      var name = (document.getElementById('sp-name').value || '').trim();
      if (!name) { spSetHint('Give the subgraph a name.', true); document.getElementById('sp-name').focus(); return; }
      if (!sel.length) { spSetHint('Check at least one folder.', true); return; }
      if (sel.length === 1 && sel[0] === '.') { spSetHint('That is the whole project — use "+ New Graph" for that.', true); return; }
      vscode.postMessage({ type: 'subgraph-create', name: name, include: sel });
      spClose();
    }
    function spMove(delta) {
      var rows = spVisibleRows();
      var i = rows.indexOf(sp.focus);
      var next = Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + delta));
      if (rows.length) { sp.focus = rows[next]; spRenderTree(); }
    }
    function spOnTreeKey(e) {
      if (!sp.open) { return; }
      var rel = sp.focus;
      if (e.key === 'ArrowDown') { e.preventDefault(); spMove(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); spMove(-1); }
      else if (e.key === 'ArrowRight' && rel !== null) { e.preventDefault(); if (!sp.expanded[rel]) { spToggleExpand(rel); } }
      else if (e.key === 'ArrowLeft' && rel !== null) { e.preventDefault(); if (sp.expanded[rel]) { spToggleExpand(rel); } }
      else if (e.key === ' ' && rel !== null) { e.preventDefault(); spToggleCheck(rel); }
      else if (e.key === 'Enter') { e.preventDefault(); spCreate(); }
      else if (e.key === 'Escape') { e.preventDefault(); spClose(); }
    }
    function wireSubgraphPicker() {
      var btn = document.getElementById('btn-new-subgraph');
      if (btn) { btn.addEventListener('click', function () { vscode.postMessage({ type: 'subgraph-picker-open' }); }); }
      var tree = document.getElementById('sp-tree');
      if (tree) {
        tree.addEventListener('click', function (e) {
          var row = e.target.closest('.sp-row');
          if (!row) { return; }
          var rel = row.dataset.rel;
          sp.focus = rel;
          var act = e.target.dataset ? e.target.dataset.act : null;
          if (act === 'toggle') { spToggleExpand(rel); }
          else if (act === 'check') { e.preventDefault(); spToggleCheck(rel); }
          else if (sp.byRel[rel] && sp.byRel[rel].hasChildren) { spToggleExpand(rel); }
          else { spToggleCheck(rel); }
        });
        tree.addEventListener('keydown', spOnTreeKey);
      }
      var search = document.getElementById('sp-search');
      if (search) {
        search.addEventListener('input', function () { sp.query = search.value.trim().toLowerCase(); sp.focus = null; spRenderTree(); });
        search.addEventListener('keydown', function (e) { if (e.key === 'Escape') { spClose(); } });
      }
      var name = document.getElementById('sp-name');
      if (name) { name.addEventListener('keydown', function (e) { if (e.key === 'Enter') { spCreate(); } if (e.key === 'Escape') { spClose(); } }); }
      var create = document.getElementById('sp-create'), cancel = document.getElementById('sp-cancel');
      if (create) { create.addEventListener('click', spCreate); }
      if (cancel) { cancel.addEventListener('click', spClose); }
    }
`;
