// hotCache.js — memo for values that hot render paths used to recompute per
// element. Today: CSS custom properties (getCSSVar ran getComputedStyle once
// per link/label/node inside d3 accessors). The cache is dropped on every
// theme change (body/html class or style mutation) and at each render start,
// so a stale colour can never outlive the frame that produced it.
// Pure logic; DOM access is injected or guarded for unit tests.

const __cssVarCache = new Map();
let __themeObserver = null;

/** Cached lookup; `read(name)` is only called on a miss. */
function cssVarCached(name, read) {
  let v = __cssVarCache.get(name);
  if (v === undefined) {
    v = read(name);
    __cssVarCache.set(name, v);
  }
  return v;
}

function invalidateCssVars() {
  __cssVarCache.clear();
}

/** Drop the cache whenever VS Code swaps the theme (class/style on html or body). */
function watchThemeChanges(doc, ObserverCtor) {
  if (__themeObserver || !doc || typeof ObserverCtor !== 'function') { return false; }
  __themeObserver = new ObserverCtor(invalidateCssVars);
  const opts = { attributes: true, attributeFilter: ['class', 'style'] };
  if (doc.documentElement) { __themeObserver.observe(doc.documentElement, opts); }
  if (doc.body) { __themeObserver.observe(doc.body, opts); }
  return true;
}

function stopWatchingTheme() {
  if (__themeObserver) { __themeObserver.disconnect(); __themeObserver = null; }
}

if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  watchThemeChanges(document, MutationObserver);
}

if (typeof module !== 'undefined') {
  module.exports = { cssVarCached, invalidateCssVars, watchThemeChanges, stopWatchingTheme };
}
