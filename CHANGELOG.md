# Changelog

All notable changes to CoGraph are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - Unreleased

### Changed (UX)
- The language-colours toggle is labelled **Language** (was "Lang").

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
