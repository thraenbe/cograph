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

### Test hygiene: `graphProvider.test.ts` providers are never disposed

Found while fixing the cross-test `scheduleReanalysis` timer leak (2026-07,
gitIntegration message suite — an armed 1s timer fired `killAll()+run()` into a
later test's `cp.spawn` stub; broke CI on macOS/Windows for PR #41). The
gitIntegration and graphProviderWorkflow suites now fire the fake panel's
`onDidDispose` callback in teardown. `graphProvider.test.ts` still creates
`GraphProvider`s via `provider.show()` without ever disposing them. None of its
tests arm the reanalysis timer today (verified: no `save-func-source` /
rename / new-file messages), so there is no live bullet — but each `show()`
leaks a real save-listener and a `.git/index` file watcher (the "File Watcher
Invalid handle" noise in test logs), and a future test that touches a
reanalysis-scheduling path would re-load the gun. Fix shape: same captured
`_disposeCallback` teardown pattern as gitIntegration.

- 2026-08-24: folder.js split — drill-down box code extracted to drilldown.js (764 LOC
  remain in folder.js; next cut: folderForces.js). New frames engine files kept modular
  (frames.js ~470 LOC is over the 400 guideline — candidate: split persistence/queries).
  Frames-engine follow-ups: CSS transition for repack moves; per-frame viewport culling
  wired to the zoom transform (scheduler visibility hook exists, currently always-visible);
  "always individual cross links" settings toggle; class bubbles inside frames.

- 2026-09-21 (perf push, round-2 candidates — measured, see `.ai/plans/perf.md` Results log):
  - **Giant frames at rest** (fmt-class repos: one folder with > 1 000 functions): drag runs at
    ~15 fps and settle costs ~22 ms main-thread per animation frame, because one frame = one
    10-20 ms DOM pass + full SVG repaint. Step 1: split a giant frame's position apply across
    several rAFs and cap visible labels per frame. Step 2 (only if step 1 is not enough): a
    Canvas2D layer for function nodes + intra-frame links above ~2 000 visible elements
    (frames/slots/labels/bundles stay SVG; quadtree hit-testing; ~3-4 days; touches annotate's
    hover card). The agreed W3b gate passes without it (56.6 fps @3k, 41.9 @10k in-editor).
  - **Global engine** still ticks on the main thread (128 ms/tick @3k, F12: a 13-minute freeze
    on zod with extreme slider values) → W4: same worker, single-sim mode + separation-force
    rewrite (precomputed membership, no per-tick allocation).
  - **Analyzer call fan-out** — D6 shipped 2026-09-21 (`scripts/narrowCalls.js`, mirrored in
    `analyze.py`): > 8 same-named definitions → file → directory → top-level package → drop.
    Follow-ups: use each analyzer's import map as a stage (a name imported from module X should
    resolve to X even across packages); guava still needs 74 s (parse-bound → sharding, W5-6).
  - When the global engine moves into the worker (W4), every Global-only force key must travel
    with the settings patch too — notably ux's F4 `repelRange` (charge `.distanceMax`) and the
    drill-down/file separation forces, which exist only in `rendering.js`/`drilldown.js` today.
  - **First-character search keystroke** still runs the full display pass when > 25 % of nodes
    flip (10-14 ms @3k, 34 ms @10k vs ≤ 10 / ≤ 25 targets): index labels or chunk the flip.
  - The simulation worker's Blob URL is never revoked (≈ 56 KB per panel; simBackend.js).
  - `cograph.layout.workers` is read at panel open only (not live).
  - Intra-language analyzer sharding (W5-6) and NDJSON streaming not started.
- **2026-09-21 — Libraries are not rendered in the Shelf engine.** frameRender
  clears `libNodeG`/`libLabelG`, so "Show Libraries" is disabled with a hint
  under Shelf (orchestrator decision, uxtest F5). Follow-up: design library
  rendering inside frames (own shelf strip? per-frame lib slots?) and re-enable
  the toggle.

- **2026-09-21 — Tab titles unreadable when zoomed far out (uxtest, zod).** At
  fit-to-view all 51 folder boxes render < 40 px on screen, so the Draft A tab
  labels are illegible. Follow-up idea: constant on-screen tab label size
  (counter-scale the tab text/glyph against the zoom transform below a
  threshold). No action yet per orchestrator.

