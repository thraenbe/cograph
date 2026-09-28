# Changelog

All notable changes to CoGraph are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-09-24

The Shelf engine release: nested, non-overlapping folder frames with per-file slots,
simulations off the UI thread, subgraphs, AI summaries on hover, and a UX test suite.
Measured on a 3 000-function repository in VS Code: four open folders settle in 0.4 s
(was 10.7 s), pan/zoom fully expanded runs at ~57 fps (was 14), hovering costs 0.5 ms
(was 33 ms).

### Added
- **Two independent layout toggles — engine and motion.** **Shelf | Global** picks the
  engine: Shelf packs every open folder into a nested, non-overlapping frame with per-file
  slots and its own small force simulation (intra-folder calls only); Global is the classic
  single simulation. **Dynamic | Static** picks the motion on either engine: continuously
  settling, or frozen with nodes pinned where placed. Default: **Shelf + Static** — a
  deterministic, motionless map out of the box. `cograph.layout.defaultEngine`
  (`shelf` | `global`) and `cograph.layout.defaultMode` (`dynamic` | `static`) set the
  startup combination; saved layouts remember both.
- **Layout simulations run off the UI thread.** The Shelf engine's per-folder simulations
  tick in a pool of up to 4 background workers and settle as fast as the CPU allows: four
  open folders settle in ~0.4 s instead of ~10 s, "expand all" on a 3 000-function repo in
  ~1 s instead of >30 s, and the UI stays at 60 fps meanwhile. Dragging stays instant.
  New setting `cograph.layout.workers` (`auto` | `on` | `off`, default `auto`); `off` is
  the previous behaviour, and any worker failure falls back to it automatically.
- **Smooth pan and zoom on large graphs.** Folder frames outside the viewport are taken out
  of the page, and when zoomed out far enough that they carry no information the labels,
  then the call lines inside folders, then the function dots are dropped (coloured file
  slots and folder glyphs stay; only the 200 strongest cross-folder bundles are drawn).
  Zooming in brings everything back. During a pan or zoom over a very dense view, labels
  and intra-folder lines pause and return 180 ms after the gesture ends.
- **Subgraphs and "Only visualize folder"** — partial visualisation as a first-class flow.
  `CoGraph: Only visualize folder…` (command palette) picks one folder and opens the panel
  scoped to it; **⊂ Create new Subgraph** in the sidebar opens an explorer-like picker
  (expand/collapse, tri-state checkboxes, filter, file counts) and saves the chosen
  folders as a subgraph — an ordinary saved graph listed with a ⊂ glyph. Folders left out
  stay listed under FILTERS in the Folder panel, where **Visualize** brings one in; **Show
  whole project** exits; Save keeps the scope with the layout.
- **Hide folder / Hide file hide the folder or file entirely** — its frame or slot leaves
  the layout and the shelf closes the gap (the Global engine drops its box or circle).
  Right-click a file slot (Shelf) or a file circle (Global) for **Hide file** / **Show only
  this file**, mirroring the folder menu. Every hide appears as a chip in the Folder
  panel's FILTERS section and is reversible one by one or with **Show all**; hidden
  folders and files are saved with the layout.
- **Annotate Graph (AI)** — every folder and file gets a one-sentence summary of what it
  is responsible for, shown in a new hover card. Start it from the pinned card in the
  CoGraph sidebar or with `CoGraph: Annotate Graph`. By default only a locally built
  digest is sent (paths, function names with their signature lines, import names, leading
  comments — no function bodies, and with Claude Code the AI cannot open files);
  `cograph.graphIntelligence.annotate.readSource` lets the AI read source files
  (read-only) for better summaries. You confirm an estimate before anything is sent, see
  the running cost, and the run stops at `annotate.maxRunBudgetUsd` (default $2) keeping
  what is done. Editing a file only marks its summary "outdated"; **Update** re-annotates
  just those. Summaries are stored locally in `.cograph/annotations/`. Measured with
  Claude haiku: about $0.09 and 70 s for a 180-path repository.
- **Hover card** for folders and files in both engines: name, path and static facts
  (files · functions · languages), plus the AI summary once generated. Works with AI
  features off.
- **Folder chrome**: open folders draw as manila folders — an empty flap top-left, a
  shallow step, the name inside the body with file/function counts on the same line;
  collapsed folders draw as a closed-folder silhouette with the name on it. Cross-folder
  calls render as one aggregated bundle per folder pair (weight on the stroke, fixed-size
  arrowheads at the flap); hovering a node shows its individual cross links.
- **File slots are draggable**: grab a slot by its label band and place it anywhere inside
  its frame — it pins there (saved with the layout), its functions ride along, and the
  other slots re-pack around it.
- **One Forces box** in the left toolbar replaces the sliders split between two panels. It
  shows only what the current engine uses (Shelf: Repel, Link, "Keep near file"; Global:
  Center, Repel, Link, File Cluster) and an inline **"show more forces"** expander reveals
  the advanced controls (Global: Repel range, Damping, Collision Padding; Shelf: Damping,
  Collision Padding). Under Static motion the box shows a hint instead of dead sliders.
  Reset restores every force.
- **Global guard**: switching to the Global engine with more than 4 000 simulated nodes
  shows a hint first ("lower Detail first, or click Global again to switch anyway"); a
  second click within 6 s switches. Saved Global views always open directly.
- Saved layouts v2: layouts persist the drill-down expansion, detail depth, packed frame
  rectangles, hidden folders/files and the subgraph scope. v1 layouts still open.
- d3 is bundled with the extension instead of loaded from a CDN: the graph opens offline
  and the webview's content-security policy allows no external host.
- Local-only performance instrumentation behind `cograph.debug.perfLog`, plus
  `CoGraph: Load Synthetic Repo (Perf Dev)` to reproduce large-repo numbers.

### Changed
- **Global engine defaults retuned** from a force sweep over three repositories: Center
  0.08 (was 0.025), Repel 450 (was 250), File Cluster 0.36 (was 0.2) and a new **Repel
  range** of 850 px (was unlimited), so a whole repository fits the viewport with readable
  file clusters instead of specks. Saved layouts keep their positions and their own
  values; the Folder Repel, File Repel and Link distance sliders are gone from the Global
  box and Slot padding and Link distance from the Shelf box (they had no measurable effect).
- **Call resolution on large repositories changes.** A call by bare name (`get()`,
  `this.size()`) used to be linked to *every* function with that name in the workspace.
  When a name has more than 8 definitions, the candidates are now narrowed to the caller's
  file, then its directory, then its top-level package; if more than 8 remain the call is
  left unresolved. Repositories where no name has more than 8 definitions produce
  byte-identical graphs; large ones lose their "hairball" edges (guava now analyses at all:
  146 602 edges instead of a 2.65 M-edge crash; junit5 250 564 → 29 784). The output
  channel reports `N ambiguous calls narrowed, M dropped` per language.
- **Interaction cost no longer grows with graph size.** Hovering highlights only the node's
  own links (33 ms → 0.5 ms at 3 000 nodes), dragging re-draws only its folder frame
  (53 ms → 0.2 ms per mouse move), typing in the search box touches only the elements
  whose visibility flipped (78 ms → 10 ms), and zooming no longer rewrites every label.
- Saving a file no longer blocks the extension host on git subprocesses; only functions
  whose git status changed are sent to the graph; the analysis cache is written in the
  background; the analysis result is no longer serialised and re-parsed on its way to the
  panel.
- The editor-title command is named **"CoGraph: Open or Reset Layout"** (it opens a fresh
  layout rather than loading a saved graph; the command id is unchanged).
- The language-colours toggle is labelled **Language**; folder colours gain ~14 points of
  saturation; re-packs animate (~200 ms glide) instead of jumping.
- AI provider calls share one process helper (timeout, output cap, cancel); Annotate Graph
  uses a narrow call that never runs a write-capable CLI mode and skips the CLI's default
  context (a small haiku call: about $0.19 → $0.005).

### Fixed
- **Blank graph on first open.** The graph data was sent to the panel on a timer and was
  silently lost when the panel's scripts were still loading. The panel now tells the
  extension when it is ready and the data waits for that (0 of 40 cold opens blank, was
  1 of 13).
- **Saved views now come back under the Global engine** (since v1 saves, the restore
  landed on the fresh panel's default expansion). Shelf layouts restore deterministically
  from the saved payload alone.
- **Dragging a folder frame no longer makes it leap around**: the drag is measured against
  the stable canvas; frames stay inside their parent on all four sides, the drop stays
  exactly where released, only siblings that intersect it shift, and cross-folder bundles
  hide while dragging.
- **Shelf + Static first load rendered big file slots as overlapping blobs** (the true
  mechanism behind the earlier "nodes outside their slot" reports): placement is now an
  explicit per-node stamp; unstamped nodes always grid.
- The first load fitted the viewport to the folder skeleton, not the final graph; the view
  now re-fits when the layout outgrows or shrinks below the automatic fit — never after the
  user has zoomed. A single collapsed glyph no longer fills the viewport at Detail 0.
- The Global layout could run away on deeply nested repositories and freeze the page for
  minutes at extreme force values: the nested folder cluster pull is now capped at a stable
  bound (invisible on shallow repositories).
- Shelf + Dynamic: force sliders and drag reheats did nothing after a Detail change; only
  four folders moved at a time after a slider change; a function node dropped outside its
  file slot now snaps back.
- Hovering a folder glyph with many cross-folder calls no longer flickers; hovering a file
  slot label opens its card; Node Size changes re-pack the static grid; collapsed glyphs
  stay inside their frame; switching Global → Shelf mid-settle no longer floods the console
  with NaN errors, and neither does hiding a folder in the Global engine.
- Booting with Global + Static no longer shows an un-fitted first screen; "Show Libraries"
  is disabled with a hint under Shelf instead of silently doing nothing; light themes reach
  JS-painted colours; static-mode label clutter in dense slots is tamed.
- Huge Java repositories no longer crash the analyzer out of memory; an oversized result
  ends with a readable "graph too large" message.
- Chat checks the AI-features setting on the host side as well as in the sidebar.
- Collapsing a folder whose descendants were still expanded could crash the classic layout
  ("node not found"); the visible-frontier mapping now checks the whole ancestor chain.

### Removed
- The **Class** and **Connect** group-by lenses. Group-by-File is the only lens; saved
  views carrying the old values load silently as File. The separate OOP **Class overlay**
  button is unchanged.

### Development tooling (not shipped in the .vsix)
- `uxtest/` — UX test suite: drives the real webview HTML in Chromium against a scripted
  host on any repository (`npm run uxtest`), records a captioned video, a keyframe and
  layout metrics per step, reports invariant findings, runs force sweeps with a ranked
  contact sheet (`uxtest:sweep`), builds an HTML report with a review rubric
  (`uxtest:report`) and drives real VS Code via Playwright Electron (`uxtest:vscode`).
  `--ext-root` runs the suite against another checkout. It found 25 defects during this
  release, all fixed above.
- `scripts/perf/` — headless-Chrome and in-editor benches (`npm run perf:bench`).

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
