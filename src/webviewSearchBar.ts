// The canvas search bar (UX round after 1.4.3, Bela 10 Nov: "I want the search/filter functions to move out
// of the settings"). Top right, 8 px left of the gear, always visible: the function filter with its match count
// and clear cross inline, and a funnel that opens the three visibility switches (orphans, libraries, empty
// files) right under it. Behaviour lives in webview/searchBar.js and webview/controls.js; the ids #search,
// #btn-clear-search and #search-count are the contract with both and with the tests. Static markup, no
// repository text, so it is safe to inline into the webview HTML.

const MAGNIFIER_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
  + '<circle cx="6.5" cy="6.5" r="4.25" fill="none" stroke="currentColor" stroke-width="1.5"/>'
  + '<path d="M9.75 9.75 14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

const FUNNEL_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
  + '<path d="M2.5 3h11L9.25 8.25v4.5l-2.5 1.25V8.25z" fill="none" stroke="currentColor" stroke-width="1.3" '
  + 'stroke-linejoin="round"/></svg>';

/** Label text of the three switches, in the order the popover shows them. */
export const SEARCH_FILTER_LABELS = ['Show Orphans', 'Show Libraries', 'Show Empty Files'] as const;

export const SEARCH_BAR_HTML = `<div id="search-bar" class="search-container" role="search">
    <label for="search" class="search-bar-icon" title="Filter functions (Ctrl+F)">${MAGNIFIER_SVG}</label>
    <input id="search" type="text" placeholder="Filter functions" aria-label="Filter functions by name"
      spellcheck="false" autocomplete="off" />
    <span id="search-count" class="search-count" aria-live="polite"></span>
    <button id="btn-clear-search" class="clear-icon search-bar-btn" type="button" title="Clear filter (Esc)"
      aria-label="Clear filter">&#x2715;</button>
    <span class="search-bar-sep" aria-hidden="true"></span>
    <button id="btn-search-filters" class="search-bar-btn" type="button"
      title="Show or hide orphans, libraries and empty files" aria-label="Visibility options"
      aria-haspopup="true" aria-expanded="false" aria-controls="search-filters">${FUNNEL_SVG}</button>
    <div id="search-filters" class="search-filters" role="group" aria-label="Visibility options">
      <div class="toggle-row">
        <span>${SEARCH_FILTER_LABELS[0]}</span>
        <label class="switch"><input type="checkbox" id="toggle-orphans" checked /><span class="pill"></span></label>
      </div>
      <div class="toggle-row" id="row-show-libraries">
        <span>${SEARCH_FILTER_LABELS[1]}</span>
        <label class="switch"><input type="checkbox" id="toggle-libraries" /><span class="pill"></span></label>
      </div>
      <p id="libraries-hint" class="forces-hint" style="display:none">Libraries are shown in the Global engine.</p>
      <div class="toggle-row">
        <span>${SEARCH_FILTER_LABELS[2]}</span>
        <label class="switch"><input type="checkbox" id="toggle-empty-files" /><span class="pill"></span></label>
      </div>
    </div>
  </div>`;
