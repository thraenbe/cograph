# Task — Feature 1: Performance (workers, render hot paths, extension host)

Planner: session `perf` (worktree s180, branch `termi/s180`, base `shelf-base` 9eda4c8).
Date: 2026-09-18. Status: **APPROVED 2026-09-18 (D1 yes, D2 snap, D3 W0+W1+W2+W3+W5[1-5,7], D4 yes, D5 auto) — executor phase; results log at the end.**

## Problem

Bela: "make CoGraph as fast as possible using multithreading and more state of the art
methods". The Shelf engine (P0-P5) cut layout work per frame, but until today there were
**no real-Chromium numbers**, the frames path is uninstrumented (`[perf]` reports show 0
tick samples under shelf), and everything — simulation, DOM writes, analysis merge, git —
still runs on one thread per process.

### Step 0 baseline (measured 2026-09-18, this worktree, before any change)

Scratch harness (not in the repo yet, see W0): the real `getWebviewHtml()` page loaded from
`file://` in **headless Chrome 153** (`--headless=new`, 1600×1000), `acquireVsCodeApi`
stubbed, fixtures = `makeSyntheticRepo` 1k/3k/10k (same presets as
`cograph.dev.loadSynthetic`) + 3 corpus repos analysed with this worktree's analyzers.
`requestAnimationFrame` is wrapped before d3 loads, so "script ms/frame" = all rAF-driven
main-thread JS per animation frame; "interval" = rAF-to-rAF time (16.7 = 60 fps).
Machine: 22 cores, Linux. Caveat: headless Chrome rasterises in software, so
**paint-bound numbers (interval, fps) are pessimistic vs. the editor's GPU raster; script
numbers are representative.** One in-editor confirmation pass is part of W0.

| Scenario (p50 / p95 / max unless noted) | shelf+dynamic 3k | shelf+static 3k | global+dynamic 3k |
|---|---|---|---|
| `structure`+`graph` message → paint | 67 ms | 34 ms | 34 ms |
| 4 open frames (805 nodes, 5.4k DOM): script ms/frame during settle | **9.3 / 26.8 / 78.9** (target ≤ 2) | 0 (zero-tick) | n/a |
| 4 open frames: wall-clock until settled | **10.7 s** (target ≤ 1 s) | 0.12 s | n/a |
| 4 open frames: frame interval during settle | 33 / 50 / 100 ms | 16.7 | n/a |
| Expand all (3 000 nodes, 20k DOM, 30 frames): sync / to-paint | 280 / 523 ms | 226 / 352 ms | 269 / 562 ms |
| Expand all: settle | **> 30 s** (cap), 8.9 / 16.3 / 112 ms script | 0.34 s | 128 / 216 ms script per tick, ≈ 3 fps |
| Pan/zoom, everything expanded: zoom handler / fps | 7.1 ms / **10.7 fps** | 1.2 ms / 13.3 fps | 40 ms / 3 fps (sim still running) |
| Hover a node: mouseover / mouseout handler | **32.7 / 31.7 ms** | 34 / 35 ms | 37 / 37 ms |
| Drag a node: handler per mousemove | **53 / 131 / 134 ms** | 46 / 82 / 97 ms | 0.1 ms (+94 ms tick/frame) |
| Drag: frames until the DOM reflects the move | 0 (sync write) | 0 | 1 |
| Search keystroke, sync | **78 / 128 ms** | 98 / 108 ms | 8.8 ms |
| `graph` payload / `structuredClone` cost | 1.2 MB / 8-17 ms | | |

1k shelf+dynamic (all 10 frames open by default): settle 16.8 s wall, 8.8 / 16.2 / 67 ms
script per frame, interval 33 ms; drag handler 16 ms p50; hover 10.5 ms; keystroke 40 ms.
10k and corpus rows (fmt, excalidraw, nest): see "Baseline addendum" at the end.

Pure simulation cost (Node 22, same `localSim.js` + d3 7.9, no DOM), one frame settling
from alpha 1 (170 ticks): 100 nodes = **63-94 ms total** (0.37 ms/tick); 400 nodes = 352 ms;
1 000 nodes = 932 ms; 4 300 nodes = 6.9 s (40 ms/tick).

Extension host, corpus repos (sequential here; the extension runs the 5 analyzers in
parallel): excalidraw TS analyzer 2.6 s / 2.4 MB stdout / `JSON.parse` 10 ms; nest 2.0 s /
3.1 MB / 17 ms; structure scan 9-47 ms. Known from the corpus table: django 8.9 s, pandas
12.5 s, junit5 7.2 s, guava = Java analyzer OOM at ~85 s.

### What the numbers say (this re-ranks the brief's candidate list)

1. **The settle is frame-rate-bound, not CPU-bound.** A 100-node frame needs ~70 ms of sim
   CPU but takes 3-10 s on screen because the scheduler does one tick per frame per rAF and
   every tick pays a DOM pass. 4 frames × 0.37 ms = 1.5 ms of the 9.3 ms/frame is simulation;
   **~85 % is per-tick DOM work** (`tickFrame` rewrites the frame chrome — fill, stroke,
   title text, regex split — on every tick, then 4 `.each()` walks). A worker alone would
   only remove the 1.5 ms. The win comes from the *combination*: sim free-runs off-thread
   (settle ≈ 70 ms per frame, 30 frames / 4 workers < 1 s) and the main thread applies only
   the positions that arrive (≤ 60 Hz, ~5 paints per frame instead of 170).
2. **Interaction handlers are the worst offenders and the cheapest to fix.** Drag = 53 ms
   per mousemove because `ticked()` → `tickFrames()` re-ticks *every* frame and
   `updateCrossLinks()` rebuilds + re-joins all bundles; hover = 33 ms (3 full link passes +
   `updateCrossLinks` on over *and* out); keystroke = 78-98 ms (6 full `display` passes +
   `tickFrames`). All O(graph) for an O(1) change.
3. **Pan/zoom is paint-bound** (handler 1-7 ms, 11-13 fps at 20k SVG elements in software
   raster). Needs an in-editor number before we spend on Canvas; culling/LOD are cheap and
   help either way.
4. **Global engine at 3k = 128 ms/tick.** Unusable while settling; moving it to the same
   worker makes the UI responsive, and the separation forces need an algorithmic fix.
5. **Host and transport are not the bottleneck at corpus-typical sizes** (2-3 s analysis,
   ≤ 17 ms parse, ≤ 17 ms clone). They matter for django/pandas-class repos and guava.

## Constraints

- File ownership per `00-common.md`; in `frameRender.js` only `syncFrameSims`,
  `tickFrame(s)`, `updateCrossLinks`, culling. No panel HTML, no restyling, no tooltip layer.
- `cograph.layout.workers: off` must be **byte-identical to today** and stays the unit-test
  path. Settings patches are forwarded to sims **opaquely** (ux adds force keys).
- New code in new modules (< 400 LOC, functions < 50 LOC), no `console.log`, explicit async
  error handling, ≥ 80 % coverage on new code, version stays 1.3.0, CHANGELOG under
  `[Unreleased]` only. Merge order puts perf **last** → one merge pass at the end.
- **Finding that changes the agreed P6 design:** VS Code webviews can only start workers from
  `blob:`/`data:` URIs ("You cannot directly load a worker from your extension's folder";
  no `importScripts`/`import()` — VS Code Webview guide, *Using Web Workers*). The agreed
  "`worker-src ${cspSource}`, no blob workers" cannot work. Required instead:
  `fetch(simWorkerUri)` → `Blob` → `new Worker(URL.createObjectURL(blob))`, CSP
  `worker-src blob:; connect-src ${webview.cspSource};`. `script-src` stays nonce-only;
  the worker body is our own bundled file from `dist/webview/`, fetched from the webview's
  own origin. **Needs Bela's OK (decision D1).**

## Plan — workstreams in order of measured payoff

Each W is a separate commit series and leaves the suite green; W1-W3 are the core of this
push, W4-W6 are gated.

### W0 — Instrument + reproducible bench (½ day) — prerequisite
- `perf.js`: add `perfFrame(ms)` ring (main-thread ms per animation frame), `perfSpan(name,
  fn)` helper; report gains `frame`, `settleByFrame`, `drag`, `hover` sections.
- Hook the frames path: `frameScheduler` gets an optional `onStep(ms, n)` callback (pure,
  injected) → `perfTick`/`perfFrame`; facade fires `perfSettled` when `maxAlpha` drops below
  alphaMin for all records; `perfMeasure` around `renderFrameLayout`, `updateCrossLinks`,
  hover and drag handlers. All behind `perfOn()` (one boolean when off).
- `scripts/perf/` (dev-only, already excluded from the .vsix): the scratch harness from
  Step 0 cleaned up — `build-page.cjs` (real HTML via `getWebviewHtml` with a `vscode` mock),
  `bench.js` scenarios, `run.mjs` (CDP over Node's built-in `WebSocket`, **no new
  dependency**), `npm run perf:bench`. Output = dated JSON + markdown table. If `uxtest`
  ships its Playwright harness first, the scenarios move there and `scripts/perf` shrinks to
  the page builder (coordinate via session-110).
- One manual in-editor pass (F5, `perfLog` on, synthetic 3k/10k) to calibrate the
  headless-vs-GPU paint gap; numbers appended to this file.

### W1 — Main-thread hot paths (1-1½ days) — biggest win per line changed
| # | Change | Where | Baseline → expected |
|---|---|---|---|
| 1 | `tickFrame` split: `tickFrameChrome` (transform, rect, colours, label) only on render / move / resize / theme; per-tick path = node/label/link position writes only | `frameRender.js` 307-368 | 9.3 → ~4 ms/frame (workers off) |
| 2 | Drag under frames ticks **only the dragged node's frame** + re-routes only bundles touching it; rAF-coalesced | `rendering.js` `ticked` 265-271, `frameRender.js` | 53 → < 2 ms per mousemove |
| 3 | `updateCrossLinks` dirty-tracking: bundle aggregation cached per render (`__fr.cross` is stable between renders), geometry recomputed only for frames flagged moved; hover builds `individual` only, no bundle re-join | `frameRender.js` 377-420, `crossLinks.js` (add `buildBundleIndex` / `routeBundles`) | removes the rebuild from every hover, drag and keystroke |
| 4 | Hover: adjacency index `nodeId → [link elements]` built at render; hover toggles a class on the touched links + one root class for dimming instead of 3 full attr passes; label lookup via id map | `rendering.js` 333-425, 764-782; CSS rules in perf's own delimited block at the end of `styles.css` (ruling R-a) | 33 → < 2 ms |
| 5 | `getCSSVar` memo (Map, cleared on theme change / `applyDisplaySettings`); `isLightTheme` cached the same way | `rendering.js` 80-93 | removes `getComputedStyle` per datum on every render / git-update |
| 6 | `getVisibleNodeIds`: memo keyed on a filter generation (query, hidden sets, node list identity); search text pushed from the `input` listener instead of read from the DOM; fix `tickDrilldownBoxes(vis)` ignoring its argument (`drilldown.js:141`) and `tickClassOverlay()` called without it (`main.js:156`) | `main.js` 104-139 | 1-2 O(N) scans per tick → 0 |
| 7 | `applyFilters`: diff against the previous visible set, write `display` only on changed elements; no `tickFrames()`; rAF-coalesced inside `applyFilters` (ruling R-b: no debounce in `controls.js`) | `main.js` 141-159 | 78-98 → < 10 ms per keystroke |
| 8 | Zoom handler: `updateTextVisibility` toggles one class on the root `<g>` only when `k` crosses the threshold (today: inline opacity on every label per zoom event) | `rendering.js` 63-69, 206-211 | 7 → < 0.5 ms |
| 9 | `renderLabels`: rebuild tspans only when the label text/line count changed (stamp on the element) | `rendering.js` 584-607 | expand-all sync −15-25 % (measure) |
| 10 | `syncFrameSims`: numeric slot-geometry hash instead of two sorted strings per frame; `frameScheduler.pick()` result reused by `loop()` | `frameRender.js` 240-295, 588-596; `frameScheduler.js` | small, removes per-rAF sort ×2 |

### W2 — Worker pool for frame simulations (P6) (2-3 days)
- **Modules (new):** `src/webview/simCore.js` (the d3-touching body of today's `localSim.js`
  — `buildD3Sim`, clamp, slot pull — moved verbatim so both transports share it);
  `src/webview/simWorker.js` (worker entry: owns `Map<frameId, rec>`, free-running tick loop
  in ≤ 8 ms slices via `setTimeout(0)` so pin/destroy messages interleave; posts `positions`
  at most once per 16 ms per frame plus a final one with `settled`);
  `src/webview/simPool.js` (pool = `min(4, hardwareConcurrency − 1)`, least-loaded
  assignment, blob bootstrap, crash → transparent fallback to the sync path with one
  structured warning); `src/webview/localSimWorker.js` (the `localSim` API over a
  **transport interface** `{post(msg, transfer), onMessage(cb)}`).
  `localSim.js` keeps the synchronous implementation untouched apart from importing
  `simCore` (`off` == today).
- **Protocol** (gen-stamped, per frame): `create {frameId, gen, ids[], xyr:Float32Array,
  fileIdx, links:Uint32Array, slots:Float32Array, inner, settings}` · `positions {frameId,
  gen, alpha, buf:Float32Array(2n)}` (transferable; buffers ping-pong back via `recycle` to
  avoid allocation) · `pin/release {frameId, gen, idx, x, y}` · `settings {frameId, patch}`
  (opaque `Object.assign` + generic force re-application; unknown keys pass through) ·
  `slots` · `resize` · `reheat {alpha|alphaTarget}` · `destroy` · `settled`. Main thread
  drops any message whose `(frameId, gen)` is not current (same rule as the scheduler today).
- **Scheduler:** `frameScheduler` gains a second mode behind an injected `transport`:
  "≤ N in flight" replaces "≤ 4 ticks per rAF"; the rAF loop only drains the latest
  positions per frame and calls the (now cheap, W1-1) `tickFrame`. Ranking unchanged.
  Off-viewport frames get `pause` (no positions posts) — wires the existing, never-called
  `setVisibility` + `frames.intersectsViewport` to the zoom transform.
- **Drag:** optimistic — the drag handler writes the node on the main thread exactly as
  today and posts `pin`; incoming positions skip the pinned index while the drag is active.
- **Setting:** `cograph.layout.workers: "auto" | "on" | "off"` (default `auto` = on when
  `Worker` + blob bootstrap succeed). Passed through `COGRAPH_CONFIG.workers` plus
  `workerUri`. jsdom tests have no `Worker` → `auto` resolves to the sync path.
- **Build / shipping:** third esbuild context (`platform: 'browser'`, `format: 'iife'`,
  `src/webview/simWorker.js` → `dist/webview/simWorker.js`, bundles `d3-force` (+ its deps
  `d3-quadtree`, `d3-dispatch`, `d3-timer`) as a new **npm dependency**, ~30 KB min).
  `localResourceRoots` += `dist/webview` in all **three** panels (`graphProvider.ts` 160,
  477, 598 — the brief says two; the timeline panel is the third). CSP per D1.
  Dev/test fallback when `dist/webview/simWorker.js` is absent: sync path + one log line.
- **Feel (decision D2):** with free-running workers a frame snaps into its settled layout
  in ~100 ms (≈ 5 painted steps) instead of "swimming" for 3-10 s. Recommended; the
  alternative is pacing the worker (e.g. 8 ticks per 16 ms) to keep visible motion.

### W3 — Render ceiling, stage 1: culling + LOD (1 day), Canvas gated
- Per-frame viewport culling: frames whose `abs` rect misses the (padded) viewport get
  `display: none` on their `<g>`; recomputed on zoom end / rAF-throttled during zoom.
- LOD by zoom: below a `k` threshold hide function labels and intra-frame links via root
  classes (one style write, reuses W1-8's mechanism).
- `will-change: transform` on the root `<g>` during an active pan gesture only.
- **Gate for Canvas2D (W3b, not in this push unless approved):** if the in-editor pass
  still shows < 45 fps pan/zoom at 3k expanded or < 30 fps at 10k after culling + LOD,
  propose a Canvas2D layer for function nodes + intra-frame links above **2 000 visible
  elements**, frames / slots / labels / bundles stay SVG; hit-testing through a d3-quadtree
  per frame (hover/drag/click/context menu keep their handlers via a synthetic datum
  lookup). Cost: every node interaction and the `annotate` hover card must go through the
  lookup → coordinate with annotate. WebGL only if Canvas2D misses the gate.

### W4 — Global engine (1½ days) — gated on D3
- Single-sim mode in the same worker (`create` with `kind: 'global'`, same positions
  buffer); the synchronous static-boot settle (60-150 ticks on the main thread at load,
  `rendering.js` 653-663) moves off-thread with a progress-free "layout…" state.
- Custom forces need worker-side equivalents: `createDrilldownSeparationForce` /
  `createFileSeparationForce` rewritten over precomputed membership arrays (no per-tick
  `filter`, one pass for centroid + extent), pair pruning by bounding-box overlap;
  `tickFolderOverlay` stops allocating + sorting per tick (depth order cached per render).
- Risk: the global engine has the most legacy call sites (`state.simulation.force(...)`
  setters in `rendering.js` 731+ are being edited by ux) → do after ux has merged.

### W5 — Extension host (1-1½ days, independent of the webview work)
Cheap, measured-safe items first:
1. Remove the double serialisation: `analyzerRunner` hands the merged object to
   `handleAnalysisResult` instead of `JSON.stringify` → `JSON.parse` (`analyzerRunner.ts:133`,
   `graphProvider.ts:716`). Internal callback signature only.
2. `gitService`: `execFile` (async) instead of 3× `execFileSync` per refresh, the three
   commands in parallel; fix the O(n²) `siblings.indexOf`; `git-update` sends only nodes
   whose status changed (webview handler already patches by id).
3. `cacheStore.writeCache`: async write, coalesced (latest wins); `buildManifest` with
   `fs.promises.stat` in bounded parallel batches.
4. `structureScanner`: async variant (`fs.promises.readdir`, bounded concurrency) used by
   `show()`; sync export kept for tests / `measure.mjs`. Fix O(n²) `childFolders.includes`.
5. Java analyzer OOM (guava): stop retaining every CST between passes (extract call sites
   into plain objects, drop the CST) — already recorded in `tech-dept.md`; plus
   `--max-old-space-size` sized from `os.totalmem()` for node analyzers.
6. **Intra-language sharding** for large repos: when a language has > 400 files, split the
   file list into `min(availableParallelism() − 1, 8)` shards through the existing
   `--files` path and merge. Caveat: definitions must be visible across shards for call
   resolution → two-phase (definitions pass shared via a temp JSON, then sharded call pass).
   That is an analyzer change in 5 scripts → **only TS/JS + Python in this push**, the
   rest follow if the numbers justify it. Expected: django/pandas 9-12 s → 2-3 s.
7. Vendor d3 (`d3.min.js` copied to `dist/webview/` at bundle time, cdnjs removed from the
   CSP): faster first paint, works offline, tightens the CSP. +280 KB in the .vsix (D4).
Deferred: NDJSON streaming + incremental paint (large analyzer protocol change; the
skeleton-first flow already hides most of the wait), `worker_threads` for merge (merge is
< 20 ms at corpus sizes).

### W6 — Transport + "state of the art" spike — not planned
`structuredClone` of the 3k graph = 8-17 ms; typed-array payloads are not worth the
protocol churn now (re-check with the 10k number). WASM / ForceAtlas2 / cosmos.gl spike only
if Global@10k misses its target after W4; none of them fit the frame semantics.

## Acceptance Criteria

Measured with `npm run perf:bench` (headless Chrome) **and** confirmed once in the editor;
before/after table appended to this file.

| Metric (3k fixture unless noted) | Baseline | Target |
|---|---|---|
| Main-thread script per animation frame during settle, 4 open frames, workers on | 9.3 ms p50 / 26.8 p95 | ≤ 2 ms p50, ≤ 4 ms p95 |
| A frame settles (wall-clock), workers on | 10.7 s (4 frames) | ≤ 1 s |
| Expand-all settled, workers on | > 30 s | ≤ 2 s |
| First stable layout after `structure` (default shelf+static) | 34-67 ms | stays < 1 s (also 10k) |
| Drag: handler per mousemove / drag-to-paint | 53 ms / same frame but 150 ms frames | ≤ 2 ms / ≤ 1 frame at 60 fps |
| Hover over / out | 33 / 32 ms | ≤ 2 ms |
| Search keystroke (sync) | 78-98 ms | ≤ 10 ms |
| Zoom handler | 1.2-7.1 ms | ≤ 0.5 ms |
| Pan/zoom fps, all expanded | 11-13 fps headless | 60 fps in-editor with culling/LOD at typical zoom; else W3b gate fires |
| Stale positions | — | never paint (unit-tested: old gen, destroyed frame, re-created frame) |
| `workers: off` | — | position sequence identical to today's `localSim` for the same seed (golden test); all 746 existing tests untouched and green |
| Global 3k script per frame during settle (W4) | 128 ms | ≤ 4 ms main thread |
| Host: git refresh blocks the extension host | 3 sync subprocesses | 0 sync calls; guava completes or fails < 30 s without OOM |
10k targets: proposed in the addendum once the 10k rows are in.

## Test strategy
- **Unit (mocha, existing harness):** `simProtocol.test.ts` (fake in-process transport:
  create / positions / pin / release / settings-opaque / reheat / destroy / settled, gen
  drop, buffer recycle), `simPool.test.ts` (assignment, crash fallback, `auto` resolution
  without `Worker`), `localSimWorker.test.ts` (API parity with `localSim` — same suite run
  against both implementations), golden-sequence test for `off`, `frameScheduler` in-flight
  mode, `crossLinks` dirty routing, hover adjacency index, `getVisibleNodeIds` memo
  invalidation, `applyFilters` diffing, `getCSSVar` cache invalidation, perf hooks emit
  under frames; host: git async + delta payload, cache write coalescing, async scanner
  parity with the sync one, shard merge == unsharded result on fixture repos.
- **`simWorker.js` itself** is exercised in Node via the same message handler function
  (exported), no real `Worker` needed; the blob bootstrap + CSP is covered by one bench
  scenario (`workers=on` must report `positions` messages) and a manual smoke per OS.
- **Regression:** full `npm test` before each commit series; `packageContribution.test.ts`
  extended for the new setting; bench JSON diffed against the baseline in this file.

## Risks
- **Worker cannot start in some host** (old VS Code, web, policy) → `auto` falls back
  silently to today's path; `on` logs one structured warning.
- **Race class "stale result lands in a changed view"** → single rule (gen-stamped, drop on
  mismatch), tested through the fake transport; positions never create nodes, only move
  ids that still exist.
- **Merge pain (perf merges last):** `frameRender.js`, `rendering.js`, `package.json`,
  `webviewHtmlBuilder.ts`. Mitigation: new logic in new modules, touch the big files only
  at call sites, land W1 early and re-merge `termi/s111` (ux) as soon as it is reported done.
- **CSS classes for hover/LOD** touch ux territory → appended block, agreed with ux first.
- **Headless numbers ≠ editor numbers** for paint → in-editor calibration in W0 before any
  Canvas decision.
- **Sharded analysis changes results** if cross-shard definitions are missed → equality
  test against the unsharded run on 3 corpus repos; sharding stays off below the threshold.
- `.vsix` size: + d3-force in the worker bundle (~30 KB) + vendored d3 (~280 KB).

## Files touched
New: `src/webview/simCore.js`, `simWorker.js`, `simPool.js`, `localSimWorker.js`,
`hoverIndex.js` (W1-4), `visibility.js` (W1-6/7 memo + filter diff, culling helpers),
`scripts/perf/*`, tests listed above.
Edited (owned by perf): `localSim.js`, `frameScheduler.js`, `frameInteract.js`, `perf.js`,
`esbuild.js`, `analyzerRunner.ts`, `structureScanner.ts`, `rendering.js` (tick/hover/zoom/
labels only), `main.js` (`getVisibleNodeIds`, `applyFilters`), `frameRender.js` (allowed
functions only), `crossLinks.js`, `drilldown.js` + `folder.js` (W4 only).
Shared, minimal, appended: `webviewHtmlBuilder.ts` (CSP line, boot config keys, script
list end), `graphProvider.ts` (`localResourceRoots` ×3, analysis callback, git-update
delta), `gitService.ts`, `cacheStore.ts`, `package.json` (setting, `d3-force` dep,
`perf:bench` script), `CHANGELOG.md`, `.ai/memory/decision.md`, `scripts/analyze_*.js|py`
(W5-5/6 only). Nothing is deleted.

## Orchestrator rulings (session-110, 2026-09-18) — supersede the text above where they differ
- **R-a** Hover / LOD CSS classes go in perf's **own delimited block at the END of
  `styles.css`** (`/* ── perf: hover + LOD (session perf) ── */ … /* ── /perf ── */`); no
  need to ask ux.
- **R-b** **No debounce in `controls.js`.** W1-7 uses the fallback: rAF-coalesce inside
  `applyFilters` (last call wins, one filter pass per animation frame).
- **R-c** `scripts/perf/` stays small (page builder + scenarios + CDP runner); migrating the
  scenarios into `uxtest` is round 2. The uxtest thin slice is usable for cross-checks:
  branch `termi/s180-2` @ 42a1ef1, `openLab()` in `uxtest/README.md`, example
  `uxtest/examples/baseline.spec.ts`
  (`npm run uxtest -- --project examples --repo synthetic-3k`).
- **R-d** ux (session-111) lands one isolated `localSim.js` commit (new force keys
  `linkDistance` / `velocityDecay` / `collidePad` / `slotPad` + removal of the dead Center
  plumbing). session-110 sends the SHA; perf **cherry-picks it before W2** so `simCore.js`
  is extracted from that version (the worker's opaque settings patch then covers the new
  keys without a second pass).

## Decisions needed from Bela
- **D1** Blob-bootstrapped worker + `worker-src blob:; connect-src ${cspSource}` (VS Code
  leaves no alternative) — OK?
- **D2** Settle feel with workers: snap in ~100 ms (recommended) vs paced visible motion.
- **D3** Scope of this push: recommended **W0 + W1 + W2 + W3 + W5(1-5, 7)**; W4 (global
  engine) and W5-6 (sharding) as a second round after the other three features merged;
  W3b Canvas only if its gate fires.
- **D4** Vendor d3 locally (+280 KB .vsix, removes the cdnjs dependency and CSP host).
- **D5** `cograph.layout.workers` default `auto` (= on).

## Out of Scope
Panel HTML / controls / styling, force-setting semantics (ux); hover card (annotate);
`uxtest/`; WebGL / WASM / GPU layout engines; NDJSON analyzer streaming; typed-array graph
transport; changing layout results (shelf packing, slot geometry, force constants);
release / version bump / corpus re-measure (`measure-all.sh` only when asked).

## Baseline addendum (10k + corpus), 2026-09-18
Raw data for all 12 runs: `.ai/plans/perf-baseline-2026-09-18.json`. Values are p50 unless
noted; same harness and caveats as above.

| Run | Expand-all sync / to-paint (nodes, DOM) | Settle script ms/frame (p50 / p95) | Settle wall (4 frames / all) | Pan-zoom fps | Hover over | Drag handler | Keystroke |
|---|---|---|---|---|---|---|---|
| shelf+dynamic 10k | 862 / 1 256 ms (10 000, 65k) | 7.8 / 15.1 | 13.2 s / > 30 s | 4.2 | 102 ms | 132 ms | 265 ms |
| shelf+static 10k | 803 / 1 123 ms | 0 | 0.14 s / 1.1 s | 5.1 | 103 ms | 127 ms | 276 ms |
| global+dynamic 10k | 770 / 1 534 ms | 150-330 ms per tick | not captured (frames > idle window) | 0.95 | 120 ms | 0.1 ms (+330 ms tick) | 25 ms |
| global+dynamic 1k | 52 / 111 ms | 28-30 / 57 | 22-25 s | 27 | 11.5 ms | 0.1 ms (+17 ms tick) | 3.6 ms |
| **fmt** (C++, 4 332 fns, 18 frames, big folders) dynamic | 318 / 806 ms (27k DOM) | **62 / 104** (max 440) | > 30 s / 24.6 s | 5.4 | 46 ms | 72 ms | 112 ms |
| fmt static | 340 / 483 ms | 0 | 0.34 s / 0.48 s | 8.9 | 51 ms | 77 ms | 110 ms |
| excalidraw (TS, 3 116 nodes, 99 frames) dynamic | 268 / 403 ms (15k DOM) | 3.2 / 13.9 (4 frames); 1.0 / 3.1 (all) | 11.1 s / > 30 s | 11.9 | 18 ms | 28 ms | 47 ms |
| nest (TS, 5 058 nodes, 683 frames) dynamic | 624 / 768 ms (25k DOM) | 2.0 / 4.5; 0.4 / 0.6 | 8.7 s / > 30 s | 9.0 | 8 ms | 39 ms | 54 ms |

Readings:
- Interaction handlers scale linearly with graph size (hover 33 → 102 ms, drag 53 → 132 ms,
  keystroke 78 → 265 ms from 3k → 10k): W1 turns them into O(touched).
- Repos with **few, large folders** (fmt: up to ~1 500 functions in one frame) are the
  shelf engine's worst case: 62 ms/frame on the main thread during settle. This is where
  W2 pays most (pure sim for a 1 000-node frame = 5.5 ms/tick, off-thread).
- Repos with **many small frames** (nest, excalidraw) are cheap per frame but take > 30 s
  to finish because only 4 frames tick per rAF: W2's free-running pool fixes wall-clock.
- Shelf+static (the default) is already zero-tick; its costs are render (expand-all
  0.8-1.3 s at 10k), interaction handlers and paint → W1 + W3.
- First stable layout after `structure` is 34-83 ms for collapsed repos at every size and
  0.7-1.0 s for fmt (auto-expanded: < 200 files but 4 332 functions) → within target, fmt
  borderline; W1-5/9 reduce its render cost.

**Proposed 10k targets** (shelf, workers on): settle script ≤ 3 ms p50 / ≤ 6 ms p95 per
frame; 4 open frames settled ≤ 1 s, expand-all settled ≤ 5 s; hover ≤ 3 ms; drag handler
≤ 3 ms; keystroke ≤ 25 ms; expand-all to-paint ≤ 800 ms (from 1 256); pan/zoom ≥ 30 fps
in-editor at fit-to-view with LOD, ≥ 55 fps zoomed in with culling — otherwise the W3b
Canvas gate fires. Global@10k (W4): main thread ≤ 6 ms/frame while the worker settles.

## Results log (executor phase)

### W0 — instrumentation + bench (commit 5c68e59, 2026-09-18)
`npm run perf:bench` reproduces the Step-0 baseline within noise (3k shelf+dynamic: 9.1 ms
script/frame, drag 61 ms, hover 52/33 ms, keystroke 82 ms). `[perf]` reports under shelf now
carry tick / frame / settle samples. In-editor calibration pass still open (needs a display
session with F5; headless numbers are used meanwhile).

### W1 — main-thread hot paths (2026-09-19) — headless Chrome 153, p50 unless noted
| Metric | Fixture | Before | After |
|---|---|---|---|
| Hover over / out handler | 3k | 32.7 / 31.7 ms | **0.2 / 0.1 ms** |
| | 10k static | 103 / 98 ms | **0.5 / 0.4 ms** |
| | fmt static | 51 / 51 ms | **0.3 / 0.3 ms** |
| Drag handler per mousemove (p50 / p95) | 3k dynamic | 53 / 131 ms | **0.1 / 0.3 ms** |
| | 10k static | 127 / 196 ms | **0.1 / 0.2 ms** |
| | fmt static | 77 / 136 ms | **0.2 / 0.3 ms** |
| Drag: frame interval while dragging | 3k static | 150 ms (≈ 7 fps) | **16.7 ms (60 fps)**, 1.2 ms script/frame |
| Drag: frames until the DOM shows the move | all | 0 (sync, but 150 ms frames) | 1 (rAF-coalesced, same paint) |
| Search keystroke (sync) | 3k dynamic / static | 78 / 98 ms | **9.7 / 14.8 ms** |
| | 10k static | 276 ms | **33.6 ms** |
| | fmt static | 110 ms | **14.4 ms** |
| Zoom handler | 3k static / 10k static | 1.2 / 3.6 ms | **0.1 / 0.1 ms** |
| Expand-all sync / to-paint | 3k dynamic | 280 / 523 ms | 161 / 374 ms |
| Settle script per frame (4 frames) | 3k dynamic | 9.3 ms | 8.7 ms (unchanged — see note) |

Notes: (1) the chrome split alone barely moves settle cost: of the ~9 ms per frame, ~3.5 ms
is the 4 sims (200 nodes each ≈ 0.9 ms/tick in-browser) and ~5 ms the position writes for
800 nodes + 2 500 links + labels — both only go away with W2 (sim off-thread, ~5 position
paints per frame instead of 170). (2) Keystroke cost that remains is the full-pass fallback
on the first character (> 25 % of nodes flip) + `getVisibleNodeIds`; subsequent narrowing
keystrokes take the diff path. 10k target (≤ 25 ms) missed by 9 ms on that first character.
(3) Pan/zoom fps unchanged (paint-bound) → W3. (4) Found, not fixed (not perf scope):
`getCSSVar` reads `documentElement`, so the `body.vscode-light` overrides of the
`--cograph-*` tokens never reach JS-set colours; the new CSS hover rule uses `var()` and
therefore shows the correct light-theme hover colour.
Tests: 777 passing (was 752), lint 0 errors.

### W2 — worker pool (commits ee7c089 + b184027, 2026-09-21) — headless Chrome 153, real CSP
Design as approved (D1 blob bootstrap, D2 snap, D5 auto) with two simplifications found
while building: (a) **no `simCore.js` extraction** — the worker bundle simply `require`s the
unchanged `localSim.js` (DOM-free, d3 injected) next to `d3-force`, so the main thread and
the worker run literally the same file and ux's force keys (ec555db) work in the worker
with zero extra code; (b) **no buffer recycling** — one `Float32Array(2n)` per post is
cheaper than the bookkeeping. One addition: a **1 ms apply budget** per animation frame in
the scheduler (worker mode only) — without it all frames deliver positions at once and the
main thread spent 16-44 ms/frame for the ~1 s the snap takes.

| Metric (shelf+dynamic, p50 unless noted) | Fixture | Baseline | W1 | W2 workers=auto |
|---|---|---|---|---|
| Settle script per animation frame, 4 open frames (p50 / p95) | 3k | 9.3 / 26.8 ms | 8.7 / 20.1 | **3.1 / 8.6** (2.3 / 3.6 in a single run; one 200-node frame apply ≈ 2 ms) |
| | 10k | 7.8 / 15.1 | – | **2.2 / 5.6** |
| | nest | 2.0 / 4.5 | – | **1.0 / 1.8** |
| | excalidraw | 3.2 / 13.9 | – | 3.9 / 9.0 |
| | fmt (frames up to ~1 500 fns) | 43 / 82 | 38 / 72 | 20 / 33 (one giant frame = one 10-20 ms DOM pass; SVG floor → W3b territory) |
| 4 open frames settled (wall) | 3k | 10.7 s | 10.4 s | **0.42 s** |
| | 10k | 13.2 s | – | **0.50 s** |
| | fmt / nest / excalidraw | > 30 s / 8.7 s / 11.1 s | – | **1.2 s / 0.27 s / 0.47 s** |
| Expand-all settled (wall) | 3k | > 30 s | > 30 s | **1.5 s** |
| | 10k (100 frames, 65k DOM) | > 30 s | – | 9.0 s (apply-budget-bound at headless' 83 ms paint frames — re-check in-editor) |
| | fmt / nest / excalidraw | 24.6 s / > 30 s / > 30 s | – | **1.4 s / 2.1 s / 1.3 s** |
| Frame interval while 4 frames settle | 3k | 33 ms | 33 ms | **16.7 ms (60 fps)** |
| Drag (dynamic): script per frame / interval | 3k | 9 ms / 50 ms | 9 ms / 50 ms | **1.1 ms / 16.7 ms** |
| workers=off | 3k | — | 8.8 ms, 10.5 s | identical to W1 (same functions by reference, asserted in simBackend.test) |

CSP verified in the bench (kept, not stripped): `worker-src blob:` + `connect-src <origin>`
start 4 workers with zero `securitypolicyviolation` events; `script-src` stays nonce-only.
Tests 822 passing (W2 adds simWorkerCore, simPool, localSimWorker, simBackend,
webviewHtmlWorkers + scheduler/contribution cases), lint 0 errors.
Known limits: `cograph.layout.workers` applies on the next panel open (not live);
a node left pinned by a big-graph drag keeps its frame ticking at the paced real-time rate
(same perpetual-tick behaviour as the sync path, now bounded to one tick per 16 ms).

### In-editor calibration checklist (5 minutes, for whoever has a display)
1. Settings: `"cograph.debug.perfLog": true` → F5 (Extension Development Host).
2. Command palette → **CoGraph: Load Synthetic Repo (Perf Dev)** → `3 000 nodes`.
3. Panel: ENGINE Shelf, MOTION **Dynamic** → drag the detail slider to 1.00 (expand all),
   wait ~3 s, hover a few nodes, drag one node around for 2 s, type `fn_1` in search, clear.
4. Output → **CoGraph**: read the last `[perf synthetic 3 000 nodes] {…}` line:
   `frame.p50Ms/p95Ms` (main-thread ms per animation frame during settle),
   `stats["sim:settle"].lastMs` (wall-clock to settled), `stats["hover:over"].avgMs`,
   `stats["drag:move"].avgMs`, `stats["drag:flush"].avgMs`, `stats.applyFilters.avgMs`,
   `stats.renderElements.lastMs`. Any `[webview] {"event":"sim-workers-fallback"…}` line
   means workers did not start — copy it.
5. Pan/zoom feel: DevTools (Help → Toggle Developer Tools → Rendering → Frame rendering
   stats) while zooming with everything expanded; W3b gate = ≥ 45 fps @3k, ≥ 30 fps @10k.
6. Repeat 2-5 with `10 000 nodes`.

### In-editor calibration (2026-09-21) — real VS Code 1.116.0, GPU raster + compositing enabled
`scripts/perf/calibrate.mjs` (Playwright `_electron`, headed on DISPLAY :0, fresh profile per
run, `CoGraph: Load Synthetic Repo`, the same `bench.js` scenarios evaluated inside the webview
frame). Three checkouts, 3 repetitions each, **median (min–max)**; webview viewport 1600×935;
settle cap 20 s. Raw: `.ai/plans/perf-calibration-2026-09-21.json`.

| metric (shelf+dynamic) | base 9eda4c8 · 3k | W1 5fdae34 · 3k | W2 · 3k | base · 10k | W1 · 10k | W2 · 10k |
|---|---|---|---|---|---|---|
| settle script ms/frame p50 (4 frames) | 8.5 (6.4–8.8) | 6.6 (5.9–10.5) | **2.0 (1.4–3.5)** | 5.7 (5.5–5.9) | 5.5 (5.3–7.9) | **1.7 (1.5–4.3)** |
| frame interval while settling (ms) | 33.3 | 33.2 | **16.7** | 18.8 | 16.7 | 16.7 |
| 4 frames settled (ms) | 11 769 (8 551–13 745) | 8 991 (7 972–17 009) | **400 (300–657)** | 11 069 | 10 983 | **434 (433–731)** |
| expand all → paint (ms) | 647 (486–949) | 439 (413–961) | 616 (498–998) | 1 579 | 1 356 | 1 817 (1 708–2 988) |
| expand all settled (ms) | > 20 000 | > 20 000 | **1 417 (1 071–2 239)** | > 20 000 | > 20 000 | **9 177 (8 271–13 862)** |
| pan/zoom fps, static, all expanded | 13.9 (5.8–15.2) | 12.6 (6.4–15.0) | 14.0 (11.7–14.1) | 4.4 (3.0–5.2) | 4.5 (2.9–5.2) | 4.7 (3.1–5.1) |
| zoom handler p50 (ms) | 7.9 | 6.0 | **0.1** | 11.3 | 7.6 | **0.1** |
| hover over p50 (ms) | 46 (45–157) | **0.2** | 0.3 | 173 (128–224) | **0.3** | 0.4 |
| drag handler p50 (ms) | 45 (45–74) | **0.1** | 0.1 | 195 (131–210) | **0.1** | 0.1 |
| frame interval while dragging (ms) | 150 | 50 | **16.7** | 650 | 83 | 50 |
| search keystroke p50 (ms) | 92 (88–178) | **8.8** | 10.5 | 334 (271–344) | **23** | 29 |

**Headless vs editor.** Script-side numbers agree within noise (3k: 9.3 vs 8.5 ms/frame,
hover 33 vs 46 ms, drag 53 vs 45 ms, W2 settle 0.42 vs 0.40 s, 1.4 s vs 1.5 s). Contrary to
the Step-0 caveat, **the paint-bound numbers agree too**: fully expanded pan/zoom is 14 fps @3k
and 4.7 fps @10k in the editor with GPU raster (headless 13 / 4.8). 20k-65k SVG elements are
paint-bound regardless of the GPU — headless Chrome is a valid proxy for this codebase.

**W3b gate (≥ 45 fps @3k, ≥ 30 fps @10k, all expanded): fails today by 3-6×.** W3 (culling +
LOD) is measured against it next; verdict recorded below the W3 results.

**Finding F11** (host): `structure`/`graph` are posted on a timer (150 ms / 300 ms synthetic),
not when the webview is ready. On a cold profile with CDN d3 the message was lost in 2 of 3
opens of the base and W1 checkouts → blank graph (the calibration script retries the load).
Vendored d3 (W2) hides it; the fix (webview `ready` handshake) is scheduled as the last W5 item.

### F13 / F7 / F10 (commits e35c553, 0107663, 02aefc8 — 2026-09-21)
- **F13** dead force sliders / drag reheats after any Detail change: every render builds new
  node objects, a reused sim record kept `_ref` on the discarded ones. Re-pointed on reuse
  (one loop in `syncFrameSims`, covers both transports). Suite `frameRenderSims.test` fails 3/3
  without the fix.
- **F7** (independent of F13, proven on a fresh 1k page without touching Detail, workers off):
  slider reheat → all frames moving after **10.6 s → 89 ms** (round-robin slots; inert frames
  settle at once). Workers: 253 ms.
- **F10** hover-line flicker (30 rebuilds/s): `line.cross-hover` takes no pointer events.

### W3 — culling + level of detail (2026-09-21) — headless Chrome 153
What the probes showed, in order: (1) pan at constant scale was never the problem once frames
are culled (60 fps); the cost is **scale changes**. (2) `display:none` does NOT help there: Blink
still spends ~120 ms per zoom frame on hidden SVG subtrees at 10k (7.6 fps) — **detaching** them
gives 48 fps. So culled frames and dropped LOD layers are removed from the document and
re-inserted in paint order (`frameCull.js`); d3 selections keep working on detached elements,
and everything is re-attached before a re-render (`restoreFrameDom`, integrity-checked in the
bench: re-render while fully parked loses 0 of 3 000 nodes / 3 000 labels / 9 510 links).
(3) At fit-to-view the 1 314 viewport-spanning bundle lines of the 10k fixture cost 45 ms/frame
→ below the links threshold only the 200 strongest bundles are drawn.
LOD thresholds (zoom factor k): labels < `textFadeThreshold` (0.5, the existing slider),
intra-frame links < 0.4, function nodes + slot file names < 0.3 (node Ø < 2 px); folder/file
glyphs and the coloured slots always stay. 8 % hysteresis. Viewport padding 240 px.

| pan/zoom fps (mixed · pan-only / zoom-only) | before W3 | after W3 |
|---|---|---|
| 3k, working view (k = 4, 3 frames on screen) | 14 | **47-56** · 60 / 51-59 |
| 3k, fit-to-view (k = 0.19, 30 frames, slots only, 1 207 el attached of 20 275) | 14 | **60** · 60 / 60 |
| 10k, working view (k = 4, 4 frames) | 4.5 | **41-51** · 60 / 54 |
| 10k, fit-to-view (k = 0.08, 100 frames, 3 027 el of 64 959) | 4.5 | **59** · 56 / 56 |
| nest, working view / fit-to-view (683 frames) | 6.3 / – | **54** / 38 |
| fmt, working view (k = 0.64: 4 giant frames, 16 184 el visible at full detail) | 8.3 | **10.9** (SVG floor) |

Side effects: expand-all settled 1.4 s → **0.75 s** @3k (off-screen frames take no DOM writes),
expand-all to-paint 10k 1.29 s → 0.89-1.0 s. Headless has a ~24 ms compositing floor on scale
changes, so the gate is judged in-editor (next entry). Remaining wall = one viewport full of
full-detail content in a giant frame (fmt) — that is what a Canvas layer (W3b) would address.
Tests: 857 passing, lint 0 errors.

### W3 in-editor gate run (2026-09-21, VS Code 1.116.0, GPU raster on, median (min–max) of 3)
Raw: `.ai/plans/perf-calibration-w3-2026-09-21.json`.

| metric | 3k before (W2) | 3k W3 | 10k before (W2) | 10k W3 |
|---|---|---|---|---|
| pan/zoom fps, static, all expanded (the gate scenario) | 14.0 | **56.6 (51.0–61.4)** — gate ≥ 45 ✔ | 4.7 | **41.9 (38.9–45.3)** — gate ≥ 30 ✔ |
| working view (k = 4): pan-only / zoom-only fps | – | 64.8 / 67.1 | – | 60.3 / 57.3 |
| fit-to-view (k = 0.12 / 0.05): mixed fps | – | 65.2 | – | 56.8 |
| expand all settled (ms) | 1 417 | **779** | 9 177 | **2 441** |
| 4 frames settled (ms) · script ms/frame | 400 · 2.0 | 374 · 2.4 | 434 · 1.7 | 478 · 2.5 |
| frame interval while dragging (ms) | 16.7 | 16.6 | 50 | **16.7** |
| hover / drag handler / keystroke p50 (ms) | 0.3 / 0.1 / 10.5 | 0.5 / 0.2 / 14.2 | 0.4 / 0.1 / 29 | 0.7 / 0.2 / 34.5 |

**Verdict: the W3b Canvas gate passes — no Canvas layer needed for the agreed targets.**

Real-repo worst case **fmt** (4 giant frames; 4 332 functions + 13 800 lines on screen at
k = 0.66), in-editor, 2 reps: after culling + zoom-LOD the working view was still **3.9 fps**
(headless 10.9 — here the editor is *worse* than headless). Added a budget-based **gesture
LOD**: while a pan/zoom gesture runs and more than 1 500 labelled nodes / 5 000 lines are in
the viewport, labels and intra-frame lines are parked; they return 180 ms after the gesture
ends (full detail at rest is unchanged). fmt working view **3.9 → 65 fps**, fit-to-view 58-68.

**Above the SVG floor, numbers only (not a gate item):** giant frames *at rest*: fmt drag =
66 ms frames (15 fps), settle = 22 ms main-thread script per frame — one 1 500-node frame is
one 10-20 ms DOM pass plus a full repaint. That is the exact case a Canvas2D node/link layer
would fix (W3b estimate: 3-4 days incl. quadtree hit-testing for hover/drag/click/context
menu and coordination with annotate's hover card). Cheaper round-2 step first: split a giant
frame's position apply across animation frames and cap visible labels per frame.

**uxtest-visible behaviour of W3 (so scenarios do not flag it):** function labels, intra-frame
lines, function dots and slot file names are *removed from the DOM* (not hidden) by zoom level
(labels < `textFadeThreshold` 0.5, lines < 0.4, dots + slot names < 0.3; only the 200 strongest
cross bundles below 0.4), frames outside the viewport (+240 px) are detached entirely, and
**during a pan/zoom gesture** labels + intra-frame lines additionally park whenever more than
1 500 labelled nodes / 5 000 lines are in the viewport — they return 180 ms after the last zoom
event. `state.svgNodes/svgLabels/svgLinks` always hold ALL elements (attached or not);
`document.querySelector*` only sees what is attached.

### W5 — extension host (items 1-5, 7) + F11 ready handshake (2026-09-21)
| Item | What changed | Effect |
|---|---|---|
| W5-1 | `AnalyzerRunner` hands the merged graph **object** to the provider (`onGraph` sink); the old string callback stays for legacy callers | no `JSON.stringify` → `JSON.parse` round-trip of the whole graph per analysis (≈ 2× 10-20 ms @3k, grows with size) |
| W5-2 | `gitService.applyGitStatusesAsync` (3 git calls in parallel via `execFile`), used by the debounced refresh (every save / `.git/index` change); **delta** `git-update` (only nodes whose status changed; nothing when unchanged); O(n²) sibling lookup → O(n) | hot path no longer blocks the extension host on 3 sync subprocesses; payload from "every node, every save" to typically 0-10 nodes |
| W5-3 | `scheduleCacheWrite` — debounced (250 ms), newest-wins, `fs.promises` (batched `stat`), flushed on `deactivate` | cache write (stat sweep + stringify + write) no longer runs *before* the graph is posted |
| W5-4 | scanner: O(n²) `childFolders.includes` → Set. **Async scan deliberately not wired**: measured 9-47 ms on the corpus, and `show()` is synchronous by contract (tests + annotate's flow) | — |
| W5-5 | Java analyzer: CST cache bounded by source bytes (6 MB ≈ typical repo fully cached; beyond it files are re-parsed); all node analyzers write through `scripts/graphOutput.js` | guava: heap flat, both passes finish (85 s) and the run ends with `graph too large (2 653 296 edges from 59 343 definitions): too many ambiguous call names` + exit 3 instead of a V8 crash. Completing guava needs decision **D6** (ambiguous-name fan-out) |
| W5-7 | d3 vendored (`dist/webview/d3.min.js`), CDN only as unbundled-dev fallback, CSP without external hosts | done in W2 |
| **F11** | `WebviewReadyGate`: `structure`/`graph`/`graph-loaded`/`timeline-data` wait for the webview's `{type:'ready'}` (posted at DOMContentLoaded, when all script listeners exist); 150 ms fallback for webviews that never say ready (old behaviour, keeps all existing tests); a `ready` after a fallback delivery re-sends with the same `__seq`, which the webview de-duplicates before any listener | the "blank graph on cold open" race (2 of 3 cold opens in calibration, 1 of 13 in uxtest) is closed for the main, synthetic and timeline panels |
Tests: 873 passing (W5/F11 add gitAsync, cacheStore async, analyzerRunner sink, graphOutput,
analyzeJava bounded cache, webviewReadyGate, readyHandshake), lint 0 errors.

### Final state vs. acceptance criteria (3k unless noted; in-editor where marked ★)
| Metric | Baseline | Target | Result |
|---|---|---|---|
| Settle script per animation frame, 4 frames, workers on | 9.3 / 26.8 ms (p50/p95) | ≤ 2 / ≤ 4 | **1.7 / 3.3** headless, 2.4 ★ |
| A frame settles (wall) | 10.7 s | ≤ 1 s | **0.37 s** ★ |
| Expand-all settled | > 30 s | ≤ 2 s | **0.78 s** ★ (10k: 2.4 s ★, target ≤ 5 s) |
| Drag handler / drag-to-paint | 53 ms / 150 ms frames | ≤ 2 ms / ≤ 1 frame | **0.2 ms / 1 frame at 60 fps** ★ |
| Hover over / out | 33 / 32 ms | ≤ 2 ms | **0.5 / 0.4 ms** ★ |
| Search keystroke | 78-98 ms | ≤ 10 ms | 10-14 ms ★ (first character = full pass; 10k: 34 ms vs ≤ 25) — **missed by a few ms** |
| Zoom handler | 1.2-7.1 ms | ≤ 0.5 ms | **0.2 ms** ★ |
| Pan/zoom, all expanded | 14 fps | 60 fps / gate ≥ 45 | **56.6 fps** ★ mixed, 65-67 pan/zoom-only (10k: 41.9 ★, gate ≥ 30) |
| Stale positions never paint | — | unit-tested | ✔ (old gen, destroyed, re-created, wrong length) |
| workers off == today | — | identical | ✔ same `localSim` functions by reference |
| Git refresh blocks the host | 3 sync subprocesses | 0 | ✔ on the hot path (analysis-time calls stay sync) |
| guava | V8 OOM @85 s | completes or fails < 30 s | fails **cleanly** but after 88 s (parse time) — completing needs D6 |

### Merge pass (2026-09-21)
`c702c0c` = termi/s178 (final ux + annotate) → `f71d3fe` (+ uxtest + ux F4) → `1f94f61`, `a3ebf10`
(uxtest-only follow-ups). Judgement resolutions: memoised `getCSSVar` keeps ux's body-scoped
read and is self-contained (their test extracts it by source); `updateTextVisibility` gate also
keys on ux's B6 dense-slot threshold; cached cross-link routing adopts ux's tab-based port
rect; annotate's `setBackgroundParsing` kept around the ready gate / `scheduleCacheWrite`.
Post-merge fixes found by the checklist and by uxtest's lab test: (1) the frame facade forwarded
only four force keys on a reheat, so ux's advanced keys never reached a live sim in either
transport → now forwarded opaquely; (2) **W3 bug of mine**: after shelf → global → shelf the
DOM culler re-inserted the previous session's frames before the next render (root glyph
missing at Detail 0) → the culler only re-inserts frames it detached, reset on teardown
(`c400e1f`). Lesson: read a suite's pass/fail line, not its coverage tail. Finding for uxtest:
its Tier-A lab ran the sync path only (stub Uris had no `fsPath`) — fixed on their side.

### D6 — ambiguous call names (commit 55613d5, decision by Bela 2026-09-21)
All five analyzers: a name with > 8 definitions is narrowed to the caller's file → directory →
top-level package, used as soon as ≤ 8 remain, else dropped. ≤ 8: untouched; outputs without an
ambiguous name are byte-identical (identity test per analyzer). Old analyzers (c400e1f) vs new,
same machine, sequential:

| repo (analyzer) | edges before → after | output | time | narrowed / dropped |
|---|---|---|---|---|
| click (py) | 3 752 → 3 653 (−2.6 %) | 1.1 → 1.1 MB | 0.95 → 0.68 s | 8 / 1 |
| django (py) | 119 498 → 76 248 (−36 %) | 34.9 → 25.8 MB | 16.3 → 18.2 s | 1 545 / 965 |
| junit5 (java) | 250 564 → 29 784 (−88 %) | 89.6 → 16.4 MB | 18.0 → 16.9 s | 1 628 / 4 111 |
| **guava (java)** | fails (2 653 296 edges) → **146 602, completes** | – → 63.4 MB | 82 s (fail) → **74 s** | 14 491 / 7 918 |

Analysis time is parse-bound and barely moves; the win is downstream (transport, merge, cache,
layout, cross-folder bundling) and guava going from "fails" to "works". `measure-all.sh` not
re-run (as instructed).

### FINAL — acceptance table, stated misses, round 2 (2026-09-21, final reviewer pass done)
Reviewer pass over my diff vs `shelf-base` (own code + merge resolutions only): no leftovers
(`console.log`, debug markers), 14 new modules all < 200 LOC (bench scripts ≤ 404), no function
> 50 LOC, new-module coverage 99.6 % lines / 92.8 % branches (c8 over the pure mocha suites),
CSP = `default-src 'none'` + nonce scripts + `worker-src blob:` + `connect-src <webview origin>`,
no external host. One fix from the pass: the dev bench server's path check used a bare prefix
(`/repo-evil` would pass `/repo`) → compares against `ROOT + sep`. One nit deferred because
`src/webview` is frozen for uxtest's sweep: the worker Blob URL is never revoked (≈ 56 KB per
panel) → round 2.

| Metric (3k, in-editor ★ unless noted) | Baseline | Target | Final |
|---|---|---|---|
| Settle script / animation frame, 4 frames, workers on | 9.3 ms | ≤ 2 (p95 ≤ 4) | **2.4 ★** (1.7 / 3.3 headless) |
| 4 frames settled · expand-all settled | 10.7 s · > 30 s | ≤ 1 s · ≤ 2 s | **0.37 s · 0.78 s ★** (10k: 0.48 s · 2.4 s) |
| Drag handler · frames while dragging | 53 ms · 150 ms | ≤ 2 ms · 1 frame | **0.2 ms · 16.7 ms ★** (10k too) |
| Hover over / out | 33 / 32 ms | ≤ 2 ms | **0.5 / 0.4 ms ★** |
| Zoom handler | 1.2-7.1 ms | ≤ 0.5 ms | **0.2 ms ★** |
| Pan/zoom, all expanded (W3b gate ≥ 45 @3k, ≥ 30 @10k) | 14 / 4.7 fps | gate | **56.6 / 41.9 fps ★**, pan- or zoom-only 57-67; fmt 3.9 → 65 |
| Slider reheat → all frames moving (F7) | 10.6 s | — | **89 ms** |
| Search keystroke | 78-98 ms | ≤ 10 ms | 10-14 ms ★ (10k 34 vs ≤ 25) — **missed** on the first character |
| Blank graph on cold open (F11) | 2/3 and 1/13 cold opens | 0 | **0 of 10** (f71d3fe) and **0 of 30** (91a65fa) blank cold opens in real VS Code — uxtest acceptance **PASS** |
| guava | V8 OOM / 2.65 M edges | completes or fails < 30 s | **completes**: 146 602 edges in 74 s — time target **missed** (parse-bound) |
| workers off == today · stale positions never paint | — | yes | ✔ same functions by reference · ✔ unit-tested |

**Stated misses:** first-character search keystroke (full pass when > 25 % of nodes flip);
guava's 74 s (needs sharding); `cograph.layout.workers` not live; async structure scan not wired.

**Round 2 (also in `.ai/memory/tech-dept.md`):** (1) W4 global engine in the worker — must carry
`repelRange`, the separation forces AND ux's per-node stability clamp of the drill-down cluster
force (F12's root cause is a numerical runaway from summed nested pulls, not tick cost — a
worker alone would not have fixed it); (2) analyzer sharding
(W5-6) for parse-bound repos; (3) giant-frame apply splitting, then Canvas2D only if needed
(fmt-class repos: drag 15 fps, settle 22 ms/frame at rest); (4) first-character keystroke
(index labels, or apply the big flip in chunks); (5) import-map stage for D6; (6) revoke the
worker Blob URL; live `workers` setting.

### Global+Dynamic "3× slower settle" report — bisect (2026-09-21): **no regression**
uxtest saw Global settle at 50876d2 ≈ 3× af09b87 (click 57 s vs 19 s, express 12.7 vs 3.7 s,
zod never resting). Bench `?probe=globalSettle` (ticks, ms/tick, alpha reheats, re-render /
re-fit counts, sim-end vs visual stillness) run from scratch worktrees of af09b87, a3f7094
(merge #5), 2fb847f (#6), eb09d6a (#7, clamp), identical fixtures, reps interleaved by SHA.

| quiet machine, median (min–max) of 3 | af09b87 | a3f7094 | 2fb847f | eb09d6a |
|---|---|---|---|---|
| click load: sim-end s · ms/tick (282 ticks) | 17.3 (14.9–17.3) · 24.0 | 16.4 · 22.5 | 16.9 · 24.8 | 16.9 (16.3–16.9) · 24.1 |
| click expand-all: sim-end s · ms/tick | 15.7 · 21.0 | 15.9 · 23.0 | 15.5 · 22.4 | 16.1 · 22.7 |
| express load / expand-all: sim-end s (341 ticks) | 5.8 / 5.7 | 5.8 / 5.7 | 5.9 / 5.7 | 5.8 / 5.7 |
| zod expand-all (1 rep): sim-end s · ms/tick | 23.6 · 41 | 22.5 · 38 | 27.7 · 50 | 24.5 · 41 |

Tick counts identical, 0 reheats, identical render/fit call counts, 0 timeouts at every SHA.
Under the afternoon's machine load (load average 11–13: uxtest's parallel sweep pages plus two
orphaned Playwright workers) the SAME SHA measured 2× slower between two reps (af09b87 click
28.8 s → 51.6 s) and all four SHAs 50–57 s: contention inflates ms per tick (a Global tick =
many-body pass + ~1 800 SVG writes + a software repaint), nothing else. Lesson for perf
comparisons: compare in ticks or run one page at a time on an idle machine.
