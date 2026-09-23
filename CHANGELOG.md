# Changelog

All notable changes to CoGraph are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - Unreleased

### Changed (UX)
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

### Fixed
- Collapsing a folder whose descendants were still individually expanded could feed
  the renderer edges pointing at nodes that were never drawn (a d3 "node not found"
  crash in the classic layout). The visible-frontier mapping now checks the whole
  ancestor chain.

### Changed
- Large graphs (> 500 nodes) on the global engine: dragging pins the dragged node
  instead of re-agitating the whole graph, ticks coalesce to animation frames, the
  per-node glow is dropped, re-renders reuse the existing simulation, and the
  overlay visibility pass runs once per tick instead of three times.
- The drill-down box code moved from `folder.js` into `drilldown.js` (file-size split).

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
