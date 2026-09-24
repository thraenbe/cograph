# Changelog

All notable changes to CoGraph are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - Unreleased

### Changed (UX)
- **Manila-folder silhouette**: the flap sits top-left as before, but the
  body's top edge right of it is only a shallow step below the flap top; the
  folder NAME moved out of the flap into the body (top-left, counts on the
  same line), and open and collapsed folders share one silhouette. The
  content area reserves the name line, so slots never collide with it.
- **Cross-folder bundle arrowheads are a fixed ~9 units** and sit at the
  flap's port, instead of scaling with the bundle stroke into ~100px
  triangles.
- The editor-title command is named **"CoGraph: Open or Reset Layout"** (was
  "Open or Reload Layout" — it opens a fresh layout rather than loading a
  saved graph). The command id is unchanged, existing keybindings keep working.
- The language-colours toggle is labelled **Language** (was "Lang").
- **One Forces box** in the left toolbar replaces the sliders split between the
  folder panel and the gear settings panel. It shows only what the current
  engine consumes (Shelf: Repel, Link, "Keep near file"; Global: those plus
  Center, Folder Repel, File Repel), an inline **"show more forces"** expander
  reveals advanced controls (Link Distance, Damping, Collision Padding and, in
  Shelf, Slot Padding), and under Static motion the box shows a hint instead of
  dead sliders. Reset now restores every force; the Center Force default is
  0.025 everywhere (the gear panel used to show 0.05).
- **Folder chrome redesign (Draft A "index tab")**, applied to both engines:
  every open folder shows its name in a tab at the top-left (folder glyph,
  ellipsis past 62 % of the frame width) with file/function counts in the free
  strip right of the tab (compact "N · M" when narrow); collapsed folders draw
  as a small closed-folder silhouette instead of a cloud; cross-folder bundles
  attach at the tab's shoulder; folder colours gain ~14 points of saturation.
  The whole top strip stays the drag hit-area.

### Added
- **Subgraphs and "Only visualize folder"** — partial visualisation as a first-class
  flow. `CoGraph: Only visualize folder…` picks one folder (QuickPick) and opens the
  panel scoped to it; `⊂ Create new Subgraph` in the sidebar opens an explorer-like
  picker (expand/collapse, tri-state checkboxes, filter, file counts) and saves the
  chosen folders as a subgraph, an ordinary saved graph with an additive `subgraph`
  field (listed with a ⊂ glyph). The host keeps the full cached graph and only sends
  the scoped part; excluded folders can be brought in from the Folder panel's FILTERS
  section ("Visualize"), which marks the graph dirty, and Save writes the scope with
  the layout. Protocol: `subgraph {name, root, include, exclude}` before `structure`
  and `graph`; `subgraph-include` / `subgraph-exclude` / `subgraph-exit`.
- **File slots are draggable**: grab a slot by its label band and place it
  anywhere inside its frame — it pins there (saved with the layout), its
  functions ride along, and the other slots re-pack around it. Node drags,
  double-click-to-open and the context menu on the slot body keep working.
- **File-level filters**: right-click a file slot (Shelf) or a file circle
  (Global) to **Hide file** or **Show only this file** — with "Show all" once
  anything is hidden, mirroring the folder menu. Hidden files appear as chips
  in the Folder panel's filter list and are saved with the layout (older
  saves load unchanged). Empty folders no longer show a "0 files · 0 fns"
  count.
- **Global guard**: switching to the Global engine with more than 4,000
  simulated nodes no longer freezes the page by surprise — the first click
  shows a hint ("Global is slow above 4,000 nodes — lower Detail first, or
  click Global again to switch anyway"); a second click within 6 s switches.
  A Global boot config over a huge first graph starts in Shelf with the same
  hint, and raising Detail past the threshold while already in Global hints
  without blocking. Saved Global views and setting changes always apply.
- **Repel range** (Global engine, under "show more forces"): caps how far the
  charge force reaches (d3 `distanceMax`). The slider's max position means
  unlimited (∞) — the classic behaviour and the default, so existing Global
  layouts are unchanged. Saved with the view (older saves load as unlimited).

### Fixed
- Dropping a dragged frame keeps it EXACTLY where it was released: only
  siblings whose rect intersects the drop shift (minimally, along the shelf
  row), everything else stays put — no more whole-shelf re-flow on drop.
- Frame drags are contained and truthful: a child frame stays inside its
  parent on all four sides while dragging, the parent chain's outline updates
  live, siblings re-pack around the drop position (with the glide), hovering
  the title strip brightens the flap so the drag handle is discoverable, and
  cross-folder bundles hide while a frame is dragged instead of riding along.
- **Dragging a folder frame by its title strip no longer makes it leap around
  the window**: the drag measured the pointer against the dragged frame's own
  moving coordinate system; it is now measured against the stable canvas
  (the same fix node drags received in 1.2's performance pass).
- The Global layout could run away on deeply nested repos and freeze the page
  for minutes (zod at extreme force sliders): folder cluster pulls are nested,
  so deep nodes received a summed pull far past the integrator's stability
  limit and coordinates exploded. The per-node sum is now capped at 1.5 —
  measurably invisible on shallow repos, and deep repos keep their look
  (~11% looser file clumps on zod).
- **Saved views now come back under the Global engine** (pre-existing since
  v1 saves): the restore consumes the saved detail depth and expanded folders
  and re-renders BEFORE applying node positions — they used to land on the
  fresh panel's default expansion — and afterwards the view repaints and
  re-fits instead of re-running the simulation over the restored layout.
- Shelf layouts restore deterministically from the saved payload alone: the
  content block's offset inside each frame (which depends on how the layout
  grew — detail changes, parse patches) is now saved with the frame rects, so
  a reload after a detail-slider history reproduces the exact slot geometry
  and node placement. Older saves without the field load as before.
- Changing **Node Size** under Shelf+Static re-packs the grid: slots resize
  for the new radii and members re-place, instead of thousands of nodes
  overlapping at their old spots.
- Collapsed-folder glyphs no longer overlap file slots or poke out of their
  frame: the closed-folder silhouette now stays inside the node's collision
  radius, which is exactly what the packer, the collide force and the slot
  clamp budget for.
- "Show Libraries" is disabled with a hint under the Shelf engine ("Libraries
  are shown in the Global engine") instead of being a silent no-op — the
  shelf does not render library nodes yet.
- Switching **Global → Shelf while the Global simulation is still settling**
  no longer floods the console with thousands of NaN line-attribute errors
  (and the dropped frames they cost): the engine switch detaches the old
  simulation's handlers before re-rendering, frame link data carries resolved
  node objects, and a repair pass is queued behind any straggling coalesced
  tick.
- Booting with **Global + Static** as the configured default no longer shows
  an unusable un-fitted first screen: the static boot now fits the view after
  the synchronous settle has produced real positions (a static simulation
  never ticks again, so the old async auto-fit either ran too early or not at
  all).
- Fit-to-view no longer blows a single collapsed-folder glyph up to fill the
  viewport (Detail 0 on a repo with one root folder): the fit scale is capped
  so the largest node stays under ~35% of the shorter viewport side.
- Light themes now reach JS-painted colours: theme variables are read from
  `<body>` (where VS Code sets `vscode-light`), so nodes, links and labels no
  longer keep the dark palette in a light theme.
- **Shelf+Static first load rendered big file slots as overlapping blobs**
  (the true B1/B2 mechanism, found by the UX test harness on click's
  tests/test_options.py): the slot placer treated a node's random seed
  position as deliberate whenever it happened to fall inside the slot.
  Placement is now an explicit per-id stamp (grid, settled simulation, drag or
  saved layout); unstamped nodes always grid, and in Static motion a slot
  whose rect moved, resized or gained members re-grids as a whole.
- **The first load fitted the viewport to the folder skeleton, not the final
  graph**: ingesting the functions grew the frames far past the fitted view,
  leaving much of the graph off-screen until a manual double-click. The view
  now re-fits automatically when the layout outgrows the last fit by >30% -
  but only while the viewport is still automatic: never after the user zooms
  or pans (Reset Layout and an engine switch re-arm it), and never during a
  frame drag or resize.
- Re-packs animate: when expanding a folder forces siblings to move, the moved
  frames glide (~200 ms) to their new spot instead of jumping. Drags and
  simulation motion stay instant.
- Static-mode label clutter in dense file slots: slot labels ellipsize to their
  slot's width (the function count is always kept), and function labels inside
  slots holding more than 12 functions stay hidden until you zoom in past 1.5x.

### Removed
- The **Class** and **Connect** group-by lenses. Group-by-File (the folder
  drill-down) is the only lens; saved views that carry `class`, `connect` or the
  older `connectivity`/`auto` values load silently as File. The separate OOP
  **Class overlay** button is unchanged.

### Added
- **Two independent layout toggles** — engine and motion. **Shelf | Global** picks
  the engine: Shelf packs every open folder into a nested, non-overlapping frame with
  per-file slots and its own small force simulation (intra-folder calls only, at most
  4 simulating at a time; dragging a node reheats only its folder; frames drag by the
  title bar and resize from the border; selecting Shelf outside the File lens switches
  to the File lens) — Global is the classic single simulation, unchanged.
  **Dynamic | Static** picks the motion on either engine: continuously settling, or
  frozen with nodes pinned where placed. Defaults: **Shelf + Static** — a
  deterministic, motionless map out of the box; switch to Dynamic to let it breathe.
  `cograph.layout.defaultEngine` (`shelf` | `global`) and `cograph.layout.defaultMode`
  (`dynamic` | `static`) set the startup combination; saved layouts remember both.
- Cross-folder calls render as one aggregated bundle per folder pair (weight on the
  stroke, ports on the title bars); hovering a node shows its individual cross links.
- Saved layouts v2: layouts now persist the drill-down expansion, detail depth and
  the packed frame rectangles. v1 layouts still open (frames are derived from the
  saved node positions and pinned).
- Local-only performance instrumentation behind `cograph.debug.perfLog`, plus
  `CoGraph: Load Synthetic Repo (Perf Dev)` to reproduce large-repo numbers.
- **Layout simulations run off the UI thread.** The Shelf engine's per-folder
  simulations now tick in a pool of background workers (up to 4) and settle as fast as
  the CPU allows instead of one step per animation frame: four open folders settle in
  ~0.4 s instead of ~10 s, "expand all" on a 3 000-function repo in ~1.5 s instead of
  >30 s, and the UI stays at 60 fps meanwhile. Dragging stays instant (the dragged node
  moves on the UI thread; its neighbours follow from the worker). New setting
  `cograph.layout.workers` (`auto` | `on` | `off`, default `auto`); `off` is the
  previous behaviour, and any worker failure falls back to it automatically.
- **Smooth pan and zoom on large graphs.** Folder frames outside the viewport are taken
  out of the page, and when zoomed out far enough that they carry no information the
  labels, then the call lines inside folders, then the function dots themselves are
  dropped (the coloured file slots and folder glyphs stay; only the 200 strongest
  cross-folder bundles are drawn). Zooming in brings everything back. 3 000 functions
  fully expanded: 14 → 50-60 fps; 10 000: 4.5 → 40-59 fps.
- d3 is now bundled with the extension instead of loaded from a CDN: the graph opens
  offline and the webview's content-security policy no longer allows any external host.
- `cograph.debug.perfLog` now covers the Shelf engine too: per-frame main-thread time
  and settle time of the frame scheduler, plus hover, drag, filter and cross-link
  timings in the `[perf]` report. Dev-only `npm run perf:bench` measures the real
  webview page in headless Chrome (`scripts/perf/`).
- **Annotate Graph (AI)** — every folder and file gets a one-sentence summary of what it
  is responsible for, shown in a new hover card. Start it from the pinned card in the
  CoGraph sidebar or with `CoGraph: Annotate Graph`. By default only a locally built
  digest is sent (paths, function names with their signature lines, import names, leading
  comments — no function bodies, and with Claude Code the AI cannot open files);
  `cograph.graphIntelligence.annotate.readSource` lets the AI read source files
  (read-only) for better summaries. You confirm an estimate before anything is sent, see
  the running cost, and the run stops at `annotate.maxRunBudgetUsd` (default $2) keeping
  what is done. A run started while the code analysis is still going waits for it, so
  every summary is written from the complete graph. Editing a file only marks its summary
  and its parent folders "outdated";
  **Update** re-annotates just those. Summaries are stored locally in
  `.cograph/annotations/`. Measured with Claude haiku: about $0.09 and 70 s for a
  180-path repository.
- **Hover card** for folders and files in both layout engines: name, path and static
  facts (files · functions · languages), plus the AI summary once generated. It works
  with AI features off.

### Fixed
- **Blank graph on first open.** The graph data was sent to the panel on a timer; when the
  panel's scripts were still loading (cold start) it was silently lost. The panel now tells
  the extension when it is ready and the data waits for that.
- Huge Java repos (e.g. guava) no longer crash the analyzer with an out-of-memory or
  "Invalid string length" error: memory stays flat and an oversized result ends with a
  readable "graph too large" message.
- Shelf + Dynamic: after moving the Detail slider (or any re-render) the force sliders and
  drag reheats did nothing until the engine was toggled — simulations kept writing into
  discarded node objects.
- Shelf + Dynamic: after a force-slider change only four folders moved at a time, the
  rest stood still for seconds (10 s with 10 open folders). All open folders now start
  moving at once.
- Hovering a folder glyph with many cross-folder calls no longer flickers: its hover
  lines were stealing the pointer ~30 times per second.
- Chat now checks the AI-features setting on the host side as well, not only in the
  sidebar, so no code path can reach an AI provider while AI features are off.
- Collapsing a folder whose descendants were still individually expanded could feed
  the renderer edges pointing at nodes that were never drawn (a d3 "node not found"
  crash in the classic layout). The visible-frontier mapping now checks the whole
  ancestor chain.

### Changed
- **Call resolution on large repositories changes.** A call by bare name (`get()`,
  `this.size()`) used to be linked to *every* function with that name in the workspace. When
  a name has more than 8 definitions, the candidates are now narrowed to the caller's file,
  then its directory, then its top-level package; if more than 8 remain the call is left
  unresolved. Repositories where no name has more than 8 definitions produce byte-identical
  graphs. Large repositories lose their "hairball" edges and analyze and render faster; the
  CoGraph output channel reports `N ambiguous calls narrowed, M dropped` per language.
- Saving a file no longer blocks the extension host on three `git` subprocesses, and only
  functions whose git status actually changed are sent to the graph; the analysis cache is
  written in the background after the graph is shown; the analysis result is no longer
  serialised and re-parsed on its way to the panel.
- **Interaction cost no longer grows with graph size.** Hovering a node highlights only
  its own links (was three passes over every link: 33 ms → 0.2 ms at 3 000 nodes,
  100 ms → 0.5 ms at 10 000); dragging a node re-draws only its own folder frame
  (53 ms → 0.1 ms per mouse move, 60 fps while dragging); typing in the search box
  touches only the elements whose visibility flipped (78 ms → 10 ms); zooming no longer
  rewrites every label's opacity. Cross-folder bundles are re-routed only when a frame
  moves, and theme colours are read once per render instead of once per element.
- Large graphs (> 500 nodes) on the global engine: dragging pins the dragged node
  instead of re-agitating the whole graph, ticks coalesce to animation frames, the
  per-node glow is dropped, re-renders reuse the existing simulation, and the
  overlay visibility pass runs once per tick instead of three times.
- The drill-down box code moved from `folder.js` into `drilldown.js` (file-size split).
- AI provider calls share one process helper (timeout, output cap, cancel). Annotate
  Graph uses a new narrow call that never runs a write-capable CLI mode and skips the
  CLI's default context, which cut a small haiku call from about $0.19 to $0.005.

### Development tooling (not shipped in the .vsix)
- `uxtest/` — UX test suite: drives the real webview HTML in Chromium against a scripted host on any
  repo (`npm run uxtest`), records a captioned video, a keyframe and layout metrics per step, reports
  invariant findings (overlaps, nodes outside slots, label clutter, console errors), runs force sweeps
  with a ranked contact sheet (`uxtest:sweep`), builds a static HTML report with a review rubric
  (`uxtest:report`) and a real-VS-Code smoke via Playwright Electron (`uxtest:vscode`). `--ext-root`
  runs the same suite against another checkout.

## [1.2.0] - 2026-08-28

### Added
- Live match count under the function filter box, red when nothing matches.
- Escape unwinds one level at a time: function popup, then filter query, then settings panel.

### Fixed
- Ctrl+F / Cmd+F opens the settings panel before focusing the filter box (the box is hidden with the panel, so the shortcut did nothing while it was closed).

## [1.1.1] - 2026-07-03

### Fixed
- The AI Workflow Graph renders while the folder drill-down is active (previously the payload was silently folded into the drill-down skeleton and never displayed).
- Leaving the Workflow view restores the drill-down's folder expansion and detail slider instead of resetting them.
- Folder drill-down boxes, file circles, and repel forces work in saved layouts where the legacy folder overlay was toggled off.
- Aggregated drill-down edges are marked provisional if any of their underlying calls touches an un-parsed subtree (previously only the first call was considered).
- Failures when opening the AI settings page are surfaced instead of silently ignored.

### Changed
- Build fixed for TypeScript 6 (`types: ["node"]` in tsconfig); dependency updates (TypeScript 6.0.3, glob 13, CI actions).

## [1.1.0] - 2026-06-26

### Added
- Folder navigation overhaul: the File lens is now a drill-down with folder boxes, file circles, and a detail slider.
- Opt-in enablement gate for AI features — nothing runs against an AI provider until you explicitly enable it (transparency).
- Folder Repel Force slider and a "view more forces" shortcut in the settings panel.
- Distinct folder / file / function glyphs for large repositories.

### Changed
- Unified clustering into a single `viewMode` state machine with shared edge aggregation.
- Large-repository handling: instant folder skeleton, lazy per-folder subset parsing, aggregated edge weights, a background indicator with cancel, incremental on-save re-parse, and a lower auto-engage threshold.

### Fixed
- Empty graph on first analysis — analyzer failures are surfaced instead of swallowed.

## [1.0.5] - 2026-06-13

### Added
- C++ language support via `web-tree-sitter` (pure WASM grammar).
- AI Workflow Graph view (backend → frontend, 10 detail levels).

### Changed
- Java and C++ analyzers cache the parse tree for a single-pass analysis.
- C++ call resolution is now receiver-aware.

## [1.0.4] - 2026-05-20

### Added
- Java language support via the pure-JS `java-parser`.
- "Open Chat" button in the graph view.
- Settings panel search with a clear button and a reset-layout option.

### Changed
- More robust analyzer subprocess management and error handling.

## [1.0.3] - 2026-05-16

### Added
- Graph Intelligence foundation: chat panel, activity-bar view, and Claude Code provider wiring.

## [1.0.2] - 2026-04-16

### Added
- Copy button on the function source popup.
- `Ctrl+F` / `Cmd+F` shortcut to focus the search bar.

## [1.0.1] - 2026-04-16

### Added
- Timeline feature (frontend and supporting analysis).

## [1.0.0] - 2026-03-17

### Added
- TypeScript and JavaScript call graph analysis.
- OOP class structure overlay (class hierarchy, fields, methods).
- Folder/file structure overlay with drag/resize support.
- Function source popup with syntax highlighting (draggable, resizable, multi-instance).
- Getter/setter detection in TypeScript and JavaScript.

### Changed
- Cross-platform Python binary resolution (Windows venv, VS Code Python extension API).

## [0.1.3] - 2026-03-17

### Fixed
- Bug fixes and stability improvements.

## [0.1.0] - 2026-03-08

### Added
- Initial release: Python call graph visualization.
- Interactive force-directed graph with node filtering.
- Git blame / language coloring modes.
- Library node clustering.
- Click-to-navigate to function definitions.

[Unreleased]: https://github.com/thraenbe/cograph/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/thraenbe/cograph/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/thraenbe/cograph/compare/v1.0.5...v1.1.0
[1.0.5]: https://github.com/thraenbe/cograph/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/thraenbe/cograph/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/thraenbe/cograph/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/thraenbe/cograph/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/thraenbe/cograph/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/thraenbe/cograph/compare/v0.1.3...v1.0.0
[0.1.3]: https://github.com/thraenbe/cograph/compare/v0.1.0...v0.1.3
[0.1.0]: https://github.com/thraenbe/cograph/releases/tag/v0.1.0
