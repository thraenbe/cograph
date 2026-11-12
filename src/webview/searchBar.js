// searchBar.js — the canvas search bar (markup: src/webviewSearchBar.ts). Owns the funnel popover with the
// three visibility switches, the "a switch is off its default" dot, and the bar's vertical place. The query
// itself (typing, clear, count, Escape, Ctrl/Cmd+F) stays in controls.js, which also calls
// closeSearchFilters() in its Escape chain.

/** Vertical gap between the bar and anything it has to sit below. */
const SEARCH_BAR_GAP = 6;
/** The bar's resting top and its widest width (styles.css #search-bar); used to test for overlap. */
const SEARCH_BAR_TOP = 10;
const SEARCH_BAR_RIGHT = 48;
const SEARCH_BAR_MAX_W = 260;
/** Top-of-canvas elements the bar must not hide under: the timeline transport and the PR banner. */
const SEARCH_BAR_OBSTACLES = ['#tl-transport', '#pr-view-banner'];

const searchBarEl = document.getElementById('search-bar');
const searchFiltersEl = document.getElementById('search-filters');
const searchFiltersBtn = document.getElementById('btn-search-filters');
const SEARCH_FILTER_TOGGLE_IDS = ['toggle-orphans', 'toggle-libraries', 'toggle-empty-files'];

function setSearchFiltersOpen(open) {
  if (!searchFiltersEl) { return; }
  searchFiltersEl.classList.toggle('open', open);
  searchBarEl?.classList.toggle('filters-open', open);
  searchFiltersBtn?.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/** Closes the switches popover; returns false if it was not open, so Escape can move on. */
function closeSearchFilters() {
  if (!searchFiltersEl?.classList.contains('open')) { return false; }
  setSearchFiltersOpen(false);
  return true;
}

/** The funnel carries a dot while any switch differs from its default, so a hidden category is never invisible. */
function updateSearchFiltersBadge() {
  const changed = SEARCH_FILTER_TOGGLE_IDS.some((id) => {
    const el = document.getElementById(id);
    return !!el && el.checked !== el.defaultChecked;
  });
  searchFiltersBtn?.classList.toggle('has-changes', changed);
  searchBarEl?.classList.toggle('has-changes', changed);
  return changed;
}

/** Pure: the bar's top given its horizontal extent and the obstacle rectangles (viewport px). */
function searchBarTop(barLeft, barRight, obstacles) {
  let top = SEARCH_BAR_TOP;
  for (const r of obstacles) {
    if (!r || r.width <= 0 || r.height <= 0) { continue; }
    const overlapsX = r.left < barRight && r.right > barLeft;
    const overlapsY = r.top < top + 30 && r.bottom > SEARCH_BAR_TOP;
    if (overlapsX && overlapsY) { top = Math.max(top, Math.ceil(r.bottom + SEARCH_BAR_GAP)); }
  }
  return top;
}

/** Drops the bar below the timeline transport or the PR banner when they share its row; else top 10 px. */
function placeSearchBar() {
  if (!searchBarEl) { return; }
  const right = window.innerWidth - SEARCH_BAR_RIGHT;
  const left = right - Math.min(SEARCH_BAR_MAX_W, Math.max(30, window.innerWidth - 260));
  const rects = SEARCH_BAR_OBSTACLES
    .map((css) => document.querySelector(css))
    .filter((el) => el && el.getClientRects().length > 0)
    .map((el) => el.getBoundingClientRect());
  searchBarEl.style.top = `${searchBarTop(left, right, rects)}px`;
}

// The settings panel closes itself on this click (controls.js: any click outside it).
searchFiltersBtn?.addEventListener('click', () => {
  setSearchFiltersOpen(!searchFiltersEl?.classList.contains('open'));
});

// The gear stops propagation of its click, so the outside-click rule below never sees it.
document.getElementById('settings-btn')?.addEventListener('click', () => { closeSearchFilters(); });

document.addEventListener('click', (e) => {
  if (searchBarEl && !searchBarEl.contains(e.target)) { closeSearchFilters(); }
});

for (const id of SEARCH_FILTER_TOGGLE_IDS) {
  document.getElementById(id)?.addEventListener('change', updateSearchFiltersBadge);
}

if (typeof window !== 'undefined' && searchBarEl) {
  window.addEventListener('resize', placeSearchBar);
  // The PR banner is created and removed at runtime and changes height when it goes narrow.
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(placeSearchBar);
    let watched = null;
    const watchBanner = () => {
      const banner = document.getElementById('pr-view-banner');
      if (banner === watched) { return; }
      if (watched) { ro.unobserve(watched); }
      if (banner) { ro.observe(banner); }
      watched = banner;
      placeSearchBar();
    };
    if (typeof MutationObserver === 'function') {
      new MutationObserver(watchBanner).observe(document.body, { childList: true });
    }
    const transport = document.getElementById('tl-transport');
    if (transport) { ro.observe(transport); }
  }
  placeSearchBar();
  updateSearchFiltersBadge();
}

if (typeof module !== 'undefined') {
  module.exports = { closeSearchFilters, updateSearchFiltersBadge, searchBarTop, placeSearchBar, setSearchFiltersOpen };
}
