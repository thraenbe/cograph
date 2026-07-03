# Weekly Tech Debt Review Task
# Create recurring Task

Review tech-debt.md
Pick 1 improvement max
Implement

---

## Open items

### Single-parse cache: apply to `scripts/analyze_java.js`

**Done in C++ (`scripts/analyze_cpp.js`, branch `add-cpp-support`):** the analyzer ran a
two-pass pipeline (`collectDefinitions` then `collectCalls`) that parsed every
workspace file **twice** — and reanalysis runs on every save. Fixed by parsing
each file once and reusing the tree across both passes:

- `getTree(filepath)` memoises the parse tree in a module-level `treeCache`
  (`Map<filepath, Tree | null>`). Both passes call it; the second pass is a cache hit.
- `clearTreeCache()` frees the cached trees and is called in a `finally` in `main()`.
  Needed for C++ specifically because web-tree-sitter trees are WASM-heap objects
  that are **not** garbage-collected and must be `.delete()`d.
- `_stats.parses` is an exported counter so a test can assert N files → N parses
  (not 2N). See suite "parse cache (single-parse)" in `analyzeCpp.test.ts`.

**Trade-off:** all trees are held in memory between the two passes (vs one at a
time before). Fine for typical workspaces. Lower-memory alternative if it ever
matters: a single walk that extracts call-sites into plain JS objects and deletes
each tree immediately, resolving against the global `nameToIds` afterwards.

**Done — Java:** `scripts/analyze_java.js` now uses the same cache (`getCst` +
`cstCache`, `_stats.parses` counter, regression test in `analyzeJava.test.ts`).
As predicted it was simpler than C++: `java-parser` returns a Chevrotain CST that
**is** garbage-collected, so `clearCstCache()` only drops references — no
`.delete()`/WASM-heap lifecycle.

TS/JS analyzers use the TS Compiler API and do not have this double-parse shape,
so no further action there.

### Webview file sizes exceed the <400 LOC guideline (deferred from PR #39 review)

Deferred during the PR #39 review-findings pass (branch
`fix/pr39-review-findings`, 2026-07): several webview modules are well past the
CLAUDE.md "files < 400 LOC preferred" limit and keep growing:

- `src/webview/folder.js` (~975 LOC) — mixes the legacy folder-bubble overlay,
  drill-down boxes, context menus, and four force generators
- `src/webview/rendering.js` (~775 LOC)
- `src/webview/main.js` (~500 LOC) — also not require-able in tests
  (top-level `acquireVsCodeApi()`), which forced the `applySavedViewSettings`
  extraction; more of its `graph-loaded`/message-router logic could move out
- `src/webview/fileClusters.js` (~500 LOC)

Suggested first cut: extract the drill-down box/force code from `folder.js`
into a new `drilldown.js` module (~300 LOC move + a `webviewHtmlBuilder.ts`
script tag). Higher regression risk — do it as its own change with manual
smoke testing of the File lens.
