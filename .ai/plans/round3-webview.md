# Round 3 — webview plan (session-111)

Brief: `.termi/briefs/round3-subgraphs.md`. Motivation: "not useful — can only
visualize the whole project." My scope: hide-entirely (W1), Filters panel (W2),
name on collapsed glyphs (W3), webview side of subgraphs (W4). Host/sidebar/
command/picker = session-178. Planner phase — no code until approval.

## W1 — Hide Folder / Hide File removes the thing entirely

Today `hiddenFolders`/`hiddenFiles`/`onlyShow*` only feed `getVisibleNodeIds`
→ nodes/labels/links get `display:none`; the FRAME (Shelf) / drill-down box
(Global) and the file SLOT stay. Fix at the structural seams, not with more
display toggles:

- **One pure predicate** in a new `scope.js` (new module per round-2 rule):
  `folderInScope(path, {onlyShowFolder, hiddenFolders, subgraphInclude})` and
  `fileInScope(file, folderOk, {onlyShowFile, hiddenFiles})`. Composes AND
  with the existing R2a semantics; a hidden ancestor hides the subtree.
  Subgraph (W4) plugs in here as a third structural input — hide and subgraph
  are ONE mechanism with two UIs.
- **Frames**: filter the folder list in `visiblyOpenFolders(tree, expanded)`
  (frames.js) through `folderInScope` (extra arg; callers pass a scope object
  — no global reads inside frames.js, it stays unit-pure). Hidden frame gone
  → `updateFrames` diff re-packs the parent, existing glide animates the
  shelf closing the gap. Un-hide → folder is "new" in the diff → packFrame +
  seed near its parent (existing path).
- **Collapsed glyphs / members**: filter `collectMembers` input by
  `fileInScope`/`folderInScope` (the folder-cluster node of a hidden folder
  must not occupy a slot in the parent). Hidden file → its slot disappears
  from `packContentSlots` because no members carry that file → frame shrinks
  on the existing re-pack path.
- **Global engine**: drill-down boxes (drilldown.js) and file circles skip
  out-of-scope folders/files with the same predicate; function nodes already
  vanish via `getVisibleNodeIds` (F17 keeps the memo honest — `subgraphInclude`
  must be added to BOTH the memo inputs and `visibleKey`, integration test
  like fileFilterVisibility.test).
- **Links/bundles**: cross-bundles derive from frames → gone for free. Plain
  edges into hidden scope are already display-filtered; additionally exclude
  hidden endpoints from sim links so Global layout doesn't tug on invisible
  nodes (check `stampLinkRefs`/link build — cheap filter at build).
- **Perf constraints honored**: frame removal goes through the existing
  updateFrames diff (culling's `restoreFrameDom` path untouched);
  `syncFrameSims` already handles member-set changes; no perf-owned file
  edited — scope arrives via call-site args.
- **Save/restore**: payload fields already exist (hiddenFolders, onlyShowFolder,
  hiddenFiles, onlyShowFile — additive since R2a). Restore must apply BEFORE
  the first frames build (applySavedFileFilters timing is already pre-render;
  verify for folders, else move both ahead of `applyFileClusters`).
- **Menus**: existing Hide/Show-only items just work (they mutate the same
  sets); they additionally trigger the frames update instead of only
  `applyFilters`.

Tests: frames unit (hidden folder absent, parent re-packed, un-hide returns
it; hidden file's slot gone); scope.js pure tests; Global drilldown skip;
memo-inputs contract + jsdom end-to-end via real getVisibleNodeIds.

Risk: hiding the folder a drag/pin/sim currently references → guard
tickFrame/sim sync against removed paths (updateFrames diff already yields
`changed`; add a removal sweep for `__fr.members`/scheduler entries).

## W2 — Filters panel (first-class, left toolbar)

New `#panel-filters` `.tl-panel` in `#top-left-controls` (webviewHtmlBuilder),
replacing the collapsible chips block currently inside `#panel-folder`
(`#toggle-folder-filters` / `#folder-filters-body` move here; keep ids or
alias — uxtest selectors coordinated before merge). Sections, each entry one
row with name + action:

1. **Hidden folders** — chip per folder, ✕ un-hides (existing behavior, new home).
2. **Hidden files** — same (`.chip-file` today).
3. **Only** — the active onlyShowFolder/onlyShowFile with a clear action.
4. **Subgraph** (W4) — subgraph name + excluded folders, each with
   **Visualize** (posts `subgraph-include`), entry shows fileCount; plus
   "Exit subgraph" (show whole project).
5. **Show all** button (clears 1–3; does NOT exit the subgraph — separate
   action, see product Q3).

Header shows a count badge (e.g. "Filters · 3") so hidden state is visible
even collapsed. All rendering in controls.js `updateFiltersPanel()` (rename of
updateFolderPanel's chips part), pure DOM, no innerHTML for names
(textContent — file names are repo text).

Tests: jsdom panel render from state (sections, counts, unhide wiring),
Show-all semantics, subgraph section renders excluded list + posts include.

## W3 — Name ON the collapsed folder glyph

Today: `generateNodeShapePath` → `closedFolderPath(R)` silhouette; the label
pass draws the name BELOW (`y + nodeRadius + 6`, hanging, centered) in both
engines (rendering.js ticked/renderLabels + frameRender tickFrame label loop).

Change (shared, both engines):
- Label for `isFolderCluster` moves inside the BODY of the silhouette:
  centered horizontally, vertically at the body's optical middle (below the
  flap step — `closedFolderDims` already returns `{w,h,tw,th,step}`; add a
  `closedFolderLabelPos(R)` helper in frameChrome.js next to the dims so both
  engines and tests share the geometry).
- Fit: ellipsize with the existing `cutLabel` against the body width at the
  label's font size; font size stays `9 * textSize` but clamps DOWN to fit
  min 4 chars + …; the dim `_sub` count line ("23 files") stays as a second
  tspan inside the body if `h` allows (R >= ~14), otherwise dropped (name
  wins; count is in the hover card anyway).
- Position sites: rendering.js `ticked()` label branch + label join
  (`dominant-baseline` middle for folder clusters now) and frameRender
  `tickFrame` label loop — same formula via the helper.
- B6 dense-slot/zoom gating (`updateTextVisibility`) untouched — the name
  simply moves; contrast: white/theme label over the folder fill needs a
  fill swap (use the tab-glyph muted color logic from tickFrame).

Tests: pure `closedFolderLabelPos` geometry (inside body box for a range of
R); cutLabel fit contract; keyframe for Bela (closed glyphs, both engines).

## W4 — Subgraphs (webview side) + protocol review

Webview consumes a scope and renders ONLY included folders; excluded ones are
recoverable from the Filters panel. Mechanism = the same `scope.js` predicate
as W1 (subgraphInclude set), so frames/slots/boxes/nodes all obey it with no
second code path.

State: `state.subgraph = null | { name, include: Set<absPath>, pending: Set }`.
`pending` = folders whose include was requested but whose patch hasn't landed
(panel shows a spinner row — same UX as parsingFolders).

Protocol (session-178 proposes, I review — my requirements):
1. **Structure**: host keeps sending the FULL structure tree; scope is a
   separate `subgraph` message. The panel needs the full folder inventory
   anyway (excluded list + fileCounts), and drill-down inside included
   folders needs the tree. Excluded-list derivation: top-level excluded
   folders only (not every descendant) — webview derives it from tree +
   include; `allFolders` in the message is then unnecessary (leaner).
2. **Graph data**: host sends the graph SCOPED to include (perf: a 1-folder
   subgraph of a 100k-node repo must not ship the world). Including a folder
   later = host reuses the `expand-folder`/`parseSubset` lazy path and sends
   a `graph-patch` + an updated `subgraph` message; webview marks the folder
   pending meanwhile.
3. **Messages** (shape to agree): host→webview
   `subgraph { name: string|null, include: string[] }` (null name = unsaved
   scope, e.g. from "Only visualize folder"); webview→host
   `subgraph-include { path }`, `subgraph-exclude { path }` (context-menu
   "Exclude from subgraph" — cheap once the mechanism exists),
   `subgraph-exit {}`; `save-graph` payload carries the scope additively.
4. **Path convention**: ONE convention on the wire — workspace-relative POSIX
   (matches annotations); webview maps to absolute tree paths at the border.
5. **Ordering**: `subgraph` must arrive before or with `structure`/`graph`
   (WebviewReadyGate) so the first frames build is already scoped — no flash
   of the full project.

Save payload: additive `subgraph: { name, include: [relPaths] }` in
buildSavePayload; restore applies scope pre-render like W1 filters.

Tests: scope.js with include-sets; panel Visualize→postMessage contract;
pending-row rendering; save round-trip; memo/visibleKey integration.

## Order & commits (one per item, tests + suite green each)

1. **W1a** scope.js + frames/members filtering (Shelf) — biggest user pain.
2. **W1b** Global engine (drilldown boxes/file circles/sim links) + memo input.
3. **W2** Filters panel (needs W1 so un-hide restores frames).
4. **W3** glyph name (independent; keyframe after).
5. **W4** subgraph consume + panel section + save fields (after the protocol
   is agreed and 178's host side exists behind the gate; webview side is
   testable with synthetic `subgraph` messages before that).

Keyframes for Bela after W2 (hide→panel→un-hide sequence) and W3.

## Product questions (recommended defaults first)

1. **Hide semantics**: make "Hide" ALWAYS remove frame/slot entirely
   (recommended — one behavior, panel is the recovery path), or keep a
   dimmed placeholder option? Recommend: entirely; no setting.
2. **Cross-links to hidden scope**: drop entirely (recommended, matches the
   old overlay) vs. stub arrows hinting at hidden callers.
3. **Show all vs subgraph**: "Show all" clears hides/only but does NOT exit
   the subgraph (recommended — the subgraph is the workspace, hides are
   within it); "Exit subgraph" is its own action in the panel.
4. **Collapsed count line**: keep "23 files" inside the glyph when it fits,
   drop when small (recommended) vs. always drop (name only).
