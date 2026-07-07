# Changelog

All notable changes to CoGraph are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Large graphs (≥800 rendered nodes) now settle and freeze instead of simulating indefinitely; dragging a node moves it directly without reheating the whole graph.
- Force defaults now scale with repository size, and the Reset Layout button restores size-appropriate values.
- Workflow view detail is clamped so huge repositories never render an unbounded node count.
- The CoGraph output channel now logs per-analyzer wall time, payload size, and webview layout settle time.

### Fixed
- The initial center force (0.025) now matches the slider and reset default (0.05).

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
