# Task — UX round 2 (session s111, planner phase)

Bela's three findings from testing `develop` in the Extension Development Host
(2026-09-23). Evidence: `.termi/briefs/cast-drag-1/2.png`, `cast-arrow.png`.
Base: `termi/s111` @ c805ddd. No code until approval.

## Investigation results (all verified in code)

**(1) Folder drag — THE JUMPING (traced in the lab, Shelf+Static, click,
zoom k = 0.233).** Root cause: `createFrameTitleDrag` (frameInteract.js) has
**no `.container()`**, so d3-drag measures `event.x/y` against
`this.parentNode` — the dragged frame's own `<g>`, whose transform we rewrite
on every move. The pointer is expressed in a coordinate system that moves
with the dragged element → feedback loop. Trace: a smooth, monotonic +90 px
screen drag (expected ≈ +386 graph px, ~+43/step) produced `moveFrameTo`
x-targets **249 → 209 → 378** (−40, then +169) — non-monotonic leaps, exactly
Bela's video. P1 fixed this very bug for node drags with
`.container(() => g.node())`; the title drag never got it.
Candidates excluded by the same trace: zero `updateFrames` /
`applyPendingLayout` / `fitToView` / zoom-transform changes fired during the
drag (b, c out); perf's culling/worker don't exist on this branch and the bug
fully reproduces (d, e out as primary). Bonus finding: the drag ENGAGED A
DIFFERENT FRAME than the one under the pointer (`_dragStart` landed on
`examples/complex/complex` while mousedown hit `tests/test_utils`' strip) —
overlapping sibling frames stack their transparent strips and the topmost
(deepest) wins. And the original static symptoms stand: `pinFrame` grows the
parent on right/bottom but `moveFrameTo` re-ticks only the dragged subtree,
so the grown parent never reaches the DOM; nothing re-packs siblings.
For uxtest: `locateFrame`'s grip selector matches my pointer-events-none
`.frame-tab` group first and validates hits against the whole frame
(`grp.contains(top)`), so its drag steps can silently miss or grab the wrong
frame — worth a locator fix on their side.

**(2) File filters.** No `hiddenFiles`/`onlyShowFile` exists anywhere. On
`develop`, perf rewrote `getVisibleNodeIds` as a memo (`visibility.js`
`createVisibleMemo`) keyed on the JSON of `[query, toggles, node count,
onlyShowFolder, [...hiddenFolders]]` — new file filters must join that key or
the memo returns stale sets. My branch still has the plain function; the key
extension is a 3-line handoff to perf at merge. Slot dragging: `shelfPack`
already supports `fixed` obstacles (built for pinned frames in P2), so pinned
slots are the same mechanism one level down.

**(3) Arrows.** `frameRender.updateCrossLinks` puts `marker-end: url(#arrow)`
on cross-bundle lines. `#arrow` has `markerWidth 4` with the default
`markerUnits=strokeWidth`; bundle stroke = linkThickness(4) ×
edgeWeightScale(count) (up to ~6) ⇒ ~24 px stroke ⇒ ~96 px triangles
(`cast-arrow.png`). The Global engine's per-edge arrows use thin strokes and
are fine.

## Proposals

### R1 — Folder drag in Shelf (do NOW, one commit)
0. **FIX THE JUMPING (item 1 by Bela's correction)**: configure the title
   drag with `.container(() => g.node())` — set at MY call site in
   frameRender on the behavior returned by `createFrameTitleDrag`
   (a behavior config, not a listener; frameInteract.js stays untouched).
   Same fix P1 shipped for node drags. Also `.filter()` nothing — but the
   wrong-frame grabs shrink as containment (R1.1) and drop re-pack (R1.3)
   remove strip overlaps; if uxtest still sees cross-grabs after that, a
   topmost-under-pointer subject check is the follow-up.
1. **Containment on all four sides** while dragging AND on drop: new pure
   `clampFrameLocal(fs, path, pos)` in frames.js (right/bottom clamp against
   the parent's inner rect; falls back to grow only when the child is larger
   than the parent). Wired via `frameDragDeps` in frameRender
   (`deps.pin` passes the clamped position) — **zero frameInteract.js
   changes**, the perf boundary stays untouched.
   Chosen over grow-on-drop: children live inside parents — that is the shelf
   thesis; growing invites sprawl and the empty-parent look Bela filmed.
2. **Live ancestor tick**: `frameDragDeps.onMoved` additionally calls the
   existing `tickFrame` for the parent chain up to root (calling a tick
   function from the interaction path; not modifying it).
3. **Sibling re-pack on drop**: a namespaced `end.repack` handler on the title
   drag (same pattern as `end.fitguard`) triggers one re-render; `updateFrames`
   already treats the pinned drop rect as an obstacle, so unpinned siblings
   re-pack around it with the existing 200 ms glide.
4. **Hover affordance**: `.folder-bubble-titlebar:hover` brightens the tab
   (CSS `:hover` + a `data-` hook; cursor is already `grab`).
5. **Bundles during drag**: while `state._frameInteracting`, hide
   `line.cross-bundle`/`line.cross-hover` (one class toggle on `linkG`);
   rebuilt on drop. Kills the riding arrowhead independently of R3.
6. DEFER: a drop ghost/outline — with the live clamp + ancestor tick the drag
   is already truthful; revisit if Bela still wants it after trying this.

### R2 — File-level filters + slot dragging (do NOW, two commits)
**R2a — context menus, filters, save (commit 1)**
- `state.hiddenFiles: Set`, `state.onlyShowFile: string|null`; predicate added
  to the visibility scan mirroring the folder logic (fn nodes by `n.file`,
  collapsed `file::` nodes by `_filePath`; composes with folder filters by
  AND). On my branch that is the plain `getVisibleNodeIds`; **handoff to
  perf**: extend `visibleKey` + the memo inputs with
  `onlyShowFile, [...hiddenFiles]` (3 lines in their visibility.js).
- Menus: Shelf file-slot context menu (renderFrameSlots) and the Global file
  circle context menu get `Hide file`, `Show only this file`, and `Show all`
  when any file/folder filter is active — mirroring the folder items.
- Folder panel: hidden files listed as chips next to hidden folders
  (`#folder-filters-body`), click to unhide.
- Save payload (additive): top-level `hiddenFiles: [...]`,
  `onlyShowFile` — old builds ignore them; loader defaults to none.
**R2b — draggable file slots (commit 2)**
- Interaction: drag starts on the slot's LABEL BAND (top `SLOT.LABEL_H` strip,
  new invisible `rect.file-slot-handle`, cursor `grab`) — the slot body keeps
  node drags, dblclick-navigate and the context menu untouched.
- Mechanics: `f.slotPins = Map<slotKey, {x,y}>` (content-local);
  `packContentSlots(members, pins)` passes pinned slots as `fixed` obstacles
  to `shelfPack` (existing capability) and packs the rest around them. Drag
  moves the slot rect clamped to the frame's content block; member nodes
  translate with it (data delta, pins follow) and `updateSlots` re-targets the
  frame's sim; drop keeps the pin.
- Persistence (additive frames-v2 field): per-frame `sp: {slotKey: [x,y]}` in
  the serialized frame entry; old saves without it behave as today.
- Static motion: the moved slot's members ride along; other slots re-grid via
  the existing rect-change re-grid (F1 machinery) — no new placement code.

### R3 — Cross-bundle arrows (do NOW, one commit)
- New `#arrow-bundle` marker (defs block, rendering.js, ~6 lines):
  `markerUnits="userSpaceOnUse"`, ~9 px, refX so the tip sits exactly on the
  tab port; cross-bundle lines use it, everything else keeps `#arrow`.
  User-space units scale with the zoom like the graph itself, so at fit zoom
  the head is proportionally small — no separate LOD switch needed.
- Arrowheads suppressed entirely while a frame drags (R1.5 covers it).
- OPTION (not now): direction as a subtle taper instead of a marker — needs a
  custom path per bundle (they are `<line>`s today); propose only if Bela
  dislikes the fixed heads. Keyframes: after implementation I can shoot
  before/after from the uxtest lab (smoke scenario, click) — at plan time
  there is nothing to photograph.

### R4 — Manila-folder silhouette + name into the body (with R3, one commit)
Bela's two sketches (2026-09-23): the tab becomes an EMPTY flap on the
top-left (shape + small folder glyph only), the body's top edge right of the
flap sits a SHALLOW STEP below the flap top (~`th·0.35` ≈ 8 px at th 22, new
`TAB.STEP` constant) instead of a full tab-height lower, and the folder NAME
moves out of the flap INTO the body: drawn top-left inside the body just
below the flap, same font, ellipsis at frame width, counts on the same line
(right-aligned). Whole strip incl. flap stays the drag handle; hover-card
target rect and the cross-bundle port follow the flap; `TAB.H`/packer reserve
unchanged (the shape just fills more of the reserved strip).
- frameChrome.js: `tabBodyPath` gains the step (right top edge at
  `y + TAB.STEP`), `closedFolderPath` gets the same silhouette (name
  below/inside as space allows) so open and closed folders match; pure path
  tests on the strings (step present, both engines' callers unchanged).
- Because the name line now sits at the top of the body: the packer reserves
  one label height above the first slot row — bump the frame's content-area
  top inset by `SLOT.LABEL_H` when the frame has members (frames.js,
  geometry-additive; saved layouts unaffected since rects are stored
  outer-local). Verified by a packer test: first slot row's y ≥ name line.
- Keyframe for Bela from the uxtest lab (smoke, click) after implementation.

## Ownership / boundaries
- frames.js, frameRender render+interaction paths, folder.js, controls.js,
  styles.css, main.js filter scan: mine. frameInteract.js and frameRender
  tick/cull functions: untouched (all wiring via `frameDragDeps` +
  namespaced drag handlers). visibility.js `visibleKey` extension: perf
  sign-off at merge (3 lines, spec in R2a).
- New module: `slotDrag.js` (R2b drag + pin bookkeeping) to respect the
  new-code-in-new-modules rule; R1's clamp lives beside `pinFrame`.

## Tests
- R1: `clampFrameLocal` pure tests (4-side clamp, oversized-child fallback);
  drag-deps wiring source-contract; bundle-hidden-while-interacting jsdom.
- R2a: predicate tests (file hidden / only-file / composition with folder
  filters); menu wiring jsdom; payload round-trip incl. old-save default.
- R2b: `packContentSlots` with pins (pinned kept, no overlap, determinism,
  pin outside content block clamped); slot-drag member-translation unit;
  serialize round-trip of `sp`.
- R3: marker-attr assertions (bundles use `#arrow-bundle`, others `#arrow`);
  defs source-contract for userSpaceOnUse.

## Selectors for uxtest
NEW: `#arrow-bundle` (marker), `rect.file-slot-handle`,
`.folder-bubble-titlebar[data-drag-hover]` (hover affordance),
context-menu items labelled `Hide file`, `Show only this file`, `Show all`,
file filter chips inside `#folder-filters-body` (`.chip-file`),
`linkG` class `bundles-hidden` during frame drags.
CHANGED: cross-bundle `marker-end` value.

## Commit plan (after approval)
1. R1 folder drag (container fix FIRST, then clamp + ancestor tick + drop
   re-pack + hover + bundle hide)
2. R3 bundle marker + R4 manila silhouette (one visual commit, keyframe after)
3. R2a file filters + menus + save
4. R2b slot dragging + persistence
