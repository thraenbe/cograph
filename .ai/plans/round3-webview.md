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

## W2 — Filters section: keep the existing one, make it complete
(REVISED per Bela 2026-09-24: NO new panel — "just ensure functionality of
the current one".)

The FILTERS section stays where it is: `#toggle-folder-filters` /
`#folder-filters-body` inside `#panel-folder` (ids unchanged — uxtest
selectors keep working). Work is correctness + completeness, not relocation:

1. Every hide shows up as a chip and is reversible one by one: hidden
   folders, hidden files (`.chip-file`), and the active Only state
   (onlyShowFolder/onlyShowFile) — audit updateFolderPanel for gaps (the
   Only chips and folder chips exist; verify file+folder mixes render
   together and un-hide of one kind leaves the other intact).
2. `#btn-folder-show-all` clears all four sets (it already clears file
   filters since R2a — keep) AND triggers the W1 structural re-render so
   frames/slots come back, not just node display.
3. Chips stay in sync with the new hide-entirely behavior: hiding from any
   context menu (frame, slot, glyph, Global bubble/file) updates the panel;
   un-hiding from a chip restores the frame/slot with the W1 re-render.
4. W4 later adds a **Subgraph** block in the same body: subgraph name
   header, one row per `excluded` entry (name + fileCount) with a
   **Visualize** action posting `scope-include`, and an "Exit subgraph" row
   posting `scope-exit`. Show all does NOT touch the scope (product Q3).
5. Verify in BOTH engines and after a saved-view restore (chips render from
   the restored sets before first paint).

Tests: jsdom — chips render from every combination of the four sets, un-hide
one-by-one wiring, Show-all clears + calls the structural update, restore
path renders chips; later: subgraph rows post scope-include/exit.

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

## W4 — Subgraphs (webview side) — protocol AGREED with session-178

(178 proposed, I reviewed, 178 reconciled taking all five of my points;
acked 2026-09-24. Authoritative copy: their plan section 6 on termi/s178.)

**host→webview `subgraph`**: `{ name: string|null (null = unsaved "Only
visualize folder"), root: abs workspace root, include: [workspace-relative
POSIX folders, folder+descendants; [] = no scope → webview clears],
exclude?: [relative carve-outs inside include; always [] unless Bela's Q5
(child excluded under included parent) is a yes] }`. `root` is needed
because relative paths are workspace-relative while tree.root is the files'
common root (same reason annotations carry root). Ordering: `subgraph`
BEFORE `structure` and `graph` on open, all through the ready gate (no flash
of the full project), re-sent on every change. `structure` = FULL tree,
unchanged. `graph` / `graph-patch` / `git-update` arrive already scoped.
Folder leaves: `graph-patch {patch:{nodes:[],edges:[]}, replacedFiles:[its
files]}` (my existing prune path). Folder enters: `subgraph` →
`analysis-state {parsingFolder}` if a parse is needed → `graph-patch
{parsedFolder}` — identical to expand-folder, so the pending spinner row
reuses that UX; cached files skip the spinner.

**webview→host**: `subgraph-include {path}` / `subgraph-exclude {path}`
(relative), `subgraph-exit {}`. `save-graph` unchanged — the HOST writes the
`subgraph` field from its own state (authoritative). The webview never
persists scope and does not reuse hiddenFolders for it (scope = host state,
hidden = view state, both may coexist — exactly the scope.js design: two
separate inputs to one predicate).

My side: `state.scope = null | { name, include: Set<absTreePath>, exclude:
Set }` — mapped once at the message border from root+relative to absolute
tree paths (transient, never saved). Predicate: in scope ⇔ under some
include AND NOT under some exclude; include [] / no message ⇒ everything.
The Filters section derives the top-level excluded folders + fileCounts from
tree + include/exclude (nearest-listed-ancestor rule; StructureFolder
carries fileCount — sum descendants for subtree counts). Optimistic pending
mark on Visualize until the re-sent `subgraph` lands.

Tests: scope.js include/exclude nesting + border mapping (root vs tree.root,
Windows separators); excluded-derivation from a fixture tree; Visualize/Exit
→ postMessage contract; pending-row rendering; scope in the memo inputs +
`visibleKey`; include [] clears.

## Order & commits (one per item, tests + suite green each)

1. **W1a** scope.js + frames/members filtering (Shelf) — biggest user pain.
2. **W1b** Global engine (drilldown boxes/file circles/sim links) + memo input.
3. **W2** Filters section completeness (needs W1 so un-hide restores frames).
4. **W3** glyph name (independent; keyframe after).
5. **W4** subgraph consume + Filters Subgraph block (protocol agreed; webview
   side is testable with synthetic `subgraph` messages before 178's host
   side lands).

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
