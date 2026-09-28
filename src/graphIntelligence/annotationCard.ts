/**
 * Markup, styles and client script for the pinned "Annotate Graph" card in the
 * CoGraph sidebar. Kept out of sidebarProvider.ts (already far past the file-size
 * guideline); the sidebar only interpolates these strings into its HTML.
 *
 * The client script is plain ES5-style string building on purpose: it is embedded
 * into another template literal, so it uses no backticks and no `${}`.
 * It reuses the sidebar's globals `vscode` and `aiEnabled`.
 */

export const ANNOTATION_CARD_CSS = `
    .annotate-card {
      border: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.35));
      border-left: 3px solid var(--vscode-focusBorder, #007fd4);
      border-radius: 6px;
      background: var(--vscode-editor-background, #1e1e1e);
      padding: 8px 11px;
      display: grid;
      gap: 4px;
      margin-bottom: 6px;
    }
    .annotate-card.before, .annotate-card.locked { cursor: pointer; }
    .annotate-card.before:hover, .annotate-card.locked:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .annotate-card.locked { opacity: 0.6; border-style: dashed; }
    .an-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .an-title { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .an-glyph { color: var(--vscode-focusBorder, #007fd4); }
    .an-sub, .an-note { font-size: 11px; opacity: 0.7; }
    .an-note { font-style: italic; }
    .an-btn {
      font-size: 10px; padding: 2px 7px; border-radius: 4px; cursor: pointer; border: none; white-space: nowrap;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    .an-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    .an-bar { height: 3px; border-radius: 2px; overflow: hidden; background: rgba(127,127,127,0.2); }
    .an-bar > span { display: block; height: 100%; background: var(--vscode-focusBorder, #007fd4); transition: width 0.3s ease; }
`;

export const ANNOTATION_CARD_SCRIPT = `
    // ── Annotate Graph card ────────────────────────────────────────────
    var annotateStatus = null;

    function anEsc(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function anCardState(s) {
      if (!aiEnabled) { return 'locked'; }
      if (s && s.state === 'running') { return 'running'; }
      if (s && s.annotated > 0) { return 'ready'; }
      return 'before';
    }

    function anCost(s) {
      if (s.costKnown === false) { return 'cost not reported'; }
      return '$' + (typeof s.costUsd === 'number' ? s.costUsd : 0).toFixed(2);
    }

    function renderAnnotateCard() {
      var s = annotateStatus;
      var state = anCardState(s);
      var title = '<span class="an-title"><span class="an-glyph">✎</span> ';
      var note = s && s.note && state !== 'running' ? '<div class="an-note">' + anEsc(s.note) + '</div>' : '';
      var open = '<div id="annotate-card" class="annotate-card ' + state + '"';
      if (state === 'locked') {
        return open + ' title="Enable AI Features to annotate the graph">'
          + '<div class="an-row">' + title + 'Annotate Graph</span></div>'
          + '<div class="an-sub">Enable AI Features to get summaries on hover</div></div>';
      }
      if (state === 'running') {
        var total = s.total || 0, done = s.done || 0;
        var pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        var detail = total > 0 ? (done + ' / ' + total + ' · ' + anCost(s)) : (s.note || 'starting…');
        return open + '><div class="an-row">' + title + 'Annotating graph</span>'
          + '<button class="an-btn" data-an="cancel" title="Stop and keep what is done">Cancel</button></div>'
          + '<div class="an-sub">' + anEsc(detail) + '</div>'
          + '<div class="an-bar"><span style="width:' + pct + '%"></span></div></div>';
      }
      if (state === 'ready') {
        var todo = (s.stale || 0) + (s.pending || 0);
        var parts = [s.annotated + ' summaries'];
        if (s.stale) { parts.push(s.stale + ' outdated'); }
        if (s.pending) { parts.push(s.pending + ' missing'); }
        var btn = todo > 0
          ? '<button class="an-btn" data-an="update" title="Annotate only the outdated and missing paths">Update (' + todo + ')</button>'
          : '';
        return open + ' title="Hover a folder or file in the graph to read its summary">'
          + '<div class="an-row">' + title + 'Annotations</span>' + btn + '</div>'
          + '<div class="an-sub">' + anEsc(parts.join(' · ')) + '</div>' + note + '</div>';
      }
      var scope = s && (s.totalFiles || s.totalFolders)
        ? s.totalFiles + ' files, ' + s.totalFolders + ' folders'
        : 'AI summaries for folders and files';
      return open + ' title="Generate a short AI summary for every folder and file">'
        + '<div class="an-row">' + title + 'Annotate graph</span></div>'
        + '<div class="an-sub">' + anEsc(scope) + ' · shown on hover</div>' + note + '</div>';
    }

    function wireAnnotateCard(root) {
      var card = root.querySelector('#annotate-card');
      if (!card) { return; }
      if (card.classList.contains('locked')) {
        card.addEventListener('click', function () { vscode.postMessage({ type: 'open-ai-settings' }); });
        return;
      }
      if (card.classList.contains('before')) {
        card.addEventListener('click', function () { vscode.postMessage({ type: 'annotate-generate' }); });
        return;
      }
      var btn = card.querySelector('.an-btn');
      if (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          vscode.postMessage({ type: btn.dataset.an === 'cancel' ? 'annotate-cancel' : 'annotate-update' });
        });
      }
    }

    /** Re-render only the card, so progress ticks do not rebuild the saved-graph list. */
    function onAnnotateStatus(msg) {
      annotateStatus = msg.status || null;
      var card = document.getElementById('annotate-card');
      if (!card || !card.parentNode) { return; }
      var holder = document.createElement('div');
      holder.innerHTML = renderAnnotateCard();
      var fresh = holder.firstChild;
      card.parentNode.replaceChild(fresh, card);
      wireAnnotateCard(fresh.parentNode);
    }
`;
