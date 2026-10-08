# Plan — UX round 4: more connections in Shelf, function hover card, F26

Session-216 (`UX4`), branch `termi/s216`, base `main` @ 1fc1156. Planner phase. No product code
until Bela approves. Visual drafts: `.termi/briefs/ux-round4-drafts.html` (main checkout).

## Problem

1. **Shelf hides the real call structure between folders.** `crossLinks.js` folds every
   cross-frame edge into one bundle per folder pair (title-bar port to title-bar port).
   Individual cross links exist only for the node under the pointer (`frameRender.js`
   `updateCrossHover`) and vanish on mouseout. You can't see *which* functions make up the
   "37 calls" between `tests/` and `src/`, and you can't keep them on screen.
2. **Hovering a function shows nothing.** Hover cards exist for folders and files only
   (`hoverCard.js`). Function nodes (`circle.regular-node`, `path.cloud-node`) only get the
   glow + hover links. Clicking opens the full, editable source popup (`popups.js:324`).
   Bela wants a hover popup that *shows and explains* the definition.
3. **F26 follow-up.** Using "Show only this file" while zoomed in re-packs the slot somewhere
   off-screen. The scope re-fit (`frameRender.js:168`) is skipped because `state.userZoomed`
   is true, so the canvas looks blank.

## Constraints

- Don't undo rounds 1-3: the Index-tab frames, bundle ports on the tab's right shoulder, the
  hover-card rules (textContent only, one delegated listener, HOVER_TARGETS table, 80 ms leave
  grace), Hide entirely / Filters / subgraph scope, and collapsed names inside the silhouette.
- Performance: cross links are redrawn from the tick path (`tickFrames` / scheduler flush) and on
  frame moves. The Shelf frame budget can't regress (fmt / 10k fixture, `cograph.debug.perfLog`).
- New code goes into new modules. Don't grow `frameRender.js` (1377), `rendering.js` (1029) or
  `graphProvider.ts` beyond small hook-ups.
- Model output and repository text are untrusted: textContent, or DOM built from tokens. Never
  raw `innerHTML` in the hover card.
- Both engines (Shelf, Global) and drill-down, for B and C. A applies to Shelf only, since Global
  draws every edge already.
- Save Layout additions are additive only. Old saves keep loading.

## A. More connections in Shelf — NOT TAKEN (Bela, 2026-10-06)

> **Status: not being built.** Bela answered U1 the other way round: *"only display edges
> within one File (add this as an option in setting with default on)"*. See **U1** below.
> The A1/A2/A3 analysis stays here unchanged in case he changes course; U2 (the caps) and the
> cross-link benchmark fall away with it.


### What "more" means (drafts A1-A3)

| Option | Interaction | Answers |
|---|---|---|
| **A1 Expand a bundle** (recommended primary) | Click a bundle: it splits into its individual calls and **stays** expanded. Click again or press Esc to fold it. The bundle's hit area gets a count badge and a pointer cursor. | "What exactly are these 37 calls between tests/ and src/?" |
| **A2 Pin connections** (recommended secondary) | Context menu on a folder tab, file slot or function: "Pin connections". Every cross link touching it stays drawn in the accent colour, and the rest of the bundles dim to 25 %. A chip in the Filters panel lists the pins, each with ×. | "What does *this* talk to?" This is the hover-only behaviour today, made sticky. |
| **A3 Detail level** (not recommended as primary) | A 3-step segmented control in the Folder panel: Bundles · Strongest · All. "Strongest" draws the top-N edges per pair. | A global dial. It turns the canvas into a hairball on anything mid-size and hides *why* a line is drawn. |

Recommendation: **A1 + A2.** Both are direct manipulation on the thing the user is looking at,
both cost O(expanded) instead of O(all cross edges), and they compose: a pinned file inside an
expanded pair still just shows its links. A3 is drawn for comparison only.

### Legibility and caps

- **Per expanded pair: at most 60 individual lines.** Pick the heaviest by `_count`, with ties
  broken by id so the choice is stable. The remainder stays drawn as a thin residual bundle
  labelled "+N more". Clicking the label raises the cap for that pair to 300, and never further.
- **Globally: at most 600 expanded/pinned lines.** When the limit is hit, the oldest expansion
  folds back to a bundle and a one-line toast says so. Measured: 1 300 viewport-spanning lines
  cost 45 ms per frame (`FR_LOD_MAX_BUNDLES` comment), so 600 translucent lines should stay near
  20 ms. To be verified in the benchmark below.
- **Routing (the "port fan"):** an expanded link is one cubic path. It runs node → own frame's
  tab port → other frame's tab port → node, with the ports as control points. The lines leave
  each frame through the same shoulder the bundle used, then fan out to their nodes. This keeps
  the bundle's reading ("this corridor") and needs no pathfinding. The lines go *through* frames,
  not around them: routing around a packed shelf is expensive and unstable while frames drag.
- Opacity 0.55, and 0.9 plus the accent colour when a pin or hover touches the line. Arrows use
  the existing `#arrow-bundle` marker. Pending edges stay dashed.
- **Zoom LOD:** below `FR_LOD_LINKS_AT` (0.4) the expanded lines draw as their bundle again, so
  expansions survive zooming out but cost nothing there.

### Where they attach

- **Visible node:** the node centre (`__fr.byId.get(id).x/y`, the same source `updateCrossHover`
  uses).
- **Node inside a collapsed folder:** the collapsed glyph (its folder-cluster node). Several links
  into one glyph merge into one line with a count, like a bundle.
- **Node in a hidden or out-of-scope folder:** no line. The residual bundle count does *not*
  include it either (same rule as today, where scope drops the frame).
- **Culled (detached) frame:** positions are data, not DOM, so the endpoint is still correct. The
  line is drawn and the frame re-attaches when it scrolls in.

### Cost / implementation shape

- New module `src/webview/crossExpand.js` (pure: expansion set, pins, caps, and path geometry via
  `portFanPath(p1, portA, portB, p2)`). Plus a thin DOM pass in a new `crossExpandRender.js`.
  `frameRender.js` gets ~3 hook lines: `updateCrossLinks`, the scheduler flush when expansions
  exist, and teardown.
- Bundles of expanded pairs are filtered out of `updateCrossBundles` (or drawn as the residual).
- The expanded link list is rebuilt only when the expansion set, pins or `__fr.cross` change.
  Positions are re-read per flush, and only for frames that moved (Dynamic). In Static there are
  zero ticks, so there's no per-frame cost after the first draw.
- Click on a bundle means the bundle line needs `pointer-events: stroke` plus a fatter invisible
  hit line. **Risk:** today bundles take no pointer role in the hover card (`hcIsLink` skips them),
  and that stays.
- **Benchmark:** before/after on fmt and the 10k fixture with `cograph.debug.perfLog`, three
  states each (nothing expanded, 5 pairs expanded, 600-line cap hit), idle and pan. Ask
  session-181 (uxtest) for a lab scenario through session-110.

### Persistence

The Save Layout payload gets `crossExpanded: [pairKey…]` and `crossPinned: [{kind, path|id}…]`.
Both are additive and restored like `hiddenFolders`. Pairs whose frames no longer exist are
dropped silently.

## U1 (decided 2026-10-06). Draw only calls within one file: a setting, default ON

Brief: `.termi/briefs/u1-intra-file-edges.md`. Cleared to plan AND implement.

### What the user sees, stated plainly
With the setting on (the new default), **no call edge between two different files is drawn at
all**: not between files of the same folder, not across folders, not into libraries. The Shelf
cross-folder bundles disappear too. Only calls whose caller and callee are in the same file stay.
That is **most of the call structure in most repos**, measured on the cached corpus graphs
(edges between project functions):

| repo | same-file | cross-file | hidden share | files with outgoing calls but NO drawn edge |
|---|---:|---:|---:|---:|
| express | 6 | 10 | 62 % | 2 of 38 |
| click | 486 | 452 | 48 % | 10 of 74 |
| flask | 223 | 255 | 53 % | 15 of 66 |
| fmt | 3 821 | 5 168 | 57 % | 11 of 70 |
| nest | 220 | 2 892 | 93 % | 339 of 967 |
| junit5 | 6 589 | 16 957 | 72 % | 261 of 1 380 |
| django | 11 766 | 43 785 | 79 % | 781 of 1 732 |
| guava | 29 631 | 98 622 | 77 % | 709 of 3 042 |

**Caveat (2026-10-07):** this table predates session-215's `this.method()` call fix, which adds
mostly same-file edges on JS/TS repos. nest after the fix (measured by session-181): same-file
220 → 1 215, hidden share 92.9 % → 78.2 %. The JS/TS rows above (express, nest, and others)
overstate what U1 hides; the Python rows are unaffected.

Library calls (e.g. click: 2 715, pandas: 64 197) are hidden as well. With folders or files
collapsed into glyphs, every edge touches a glyph that stands for several files, so the
collapsed overview shows no edges at all.

### Behaviour
- **Setting:** `cograph.display.sameFileEdgesOnly` (boolean, default `true`, appended at the END
  of `contributes.configuration`). Description: "Draw only calls between functions in the same
  file. Calls between files and into libraries are hidden (hover a function to see its own).
  Turn off to draw every call." It is the default for every new graph panel.
- **One-click toggle** in the Settings panel's Display section, directly under Arrows:
  "Only calls within a file" (`#toggle-same-file-edges`). It works per view, at once, with no
  re-layout, and is saved with Save Layout (`payload.settings.sameFileEdgesOnly`). A save from an
  older build has no key and opens with the current setting.
- **Hover (product call, flagged, default YES as session-110 suggested):** hovering a function
  still shows ITS cross-file calls (highlight colour). Global and Shelf in-frame lines reveal
  through the existing hover-highlight class. Shelf cross-folder lines are already drawn only on
  hover (`line.cross-hover`) and stay as they are. Hover is deliberate, so the information stays
  reachable without the clutter.
- **Layout is unchanged:** hidden edges still feed the Global simulation and orphan detection,
  so positions and "Show Orphans" mean the same with the setting on or off. Only drawing changes.
- **Both engines and drill-down:** the same rule everywhere. The Workflow view is exempt (its edges
  are stages, not files).

### Implementation
- Pure helpers in `crossLinks.js`: `fileOfNode(n)` (function → its file; collapsed file glyph →
  its file; folder glyph / library / synthetic → null), `isSameFileLink(l, fileOfId)` (both ends
  non-null and equal; recursion counts), `partitionByFile(links, fileOfId)`.
- `renderLinks` marks cross-file lines with class `xfile` (one Map lookup per line, per render,
  not per tick). Hiding is ONE class on the zoom root (`g.same-file-only`). CSS hides
  `line.xfile:not(.cg-hl)` and `line.cross-bundle`. Toggling flips that class: no re-render, no
  re-layout, nothing in the tick path.
- Shelf: cross-frame bundles are cross-file by definition and hidden by the same root class.
- perf: neutral to positive. No new tick work, and hidden lines are not painted. Spot-checked with
  `perfReport()` on one big repo before and after.

### Evidence for Bela before it ships
Before/after keyframes (setting off vs on, same viewport) on **express** (small), **flask**
(mid) and **django** (big), Shelf + Static (the default), plus one Global pair. They land in
`.termi/briefs/u1-keyframes/` and the paths go to session-110.

### Tests
Unit: the helpers (function/function, file glyph, folder glyph, library, recursion, pending
aggregated edges); renderLinks marks exactly the cross-file lines; the root class follows the
setting; save/restore round-trip incl. a save without the key; the bootConfig default. Lab:
keyframes plus one check that a hovered node's cross-file line becomes visible.

### Report, not a softening: is the default misleading?
Yes, in one specific way, beyond being sparser. A function whose calls all leave its file draws
**no line at all**, so it looks exactly like an uncalled, unconnected function. And a file whose
functions only call out (a typical service, view or controller) looks like a file of isolated
dots. On the corpus that is 781 of 1 732 files in django and 339 of 967 in nest. "Show Orphans"
does not help: it still counts the hidden edges, so these nodes are not orphans and keep
showing, but nothing on screen says they are connected. Hover reveals it, one node at a time.
If Bela wants a cue without the clutter, the cheap option is a subtle marker on nodes that have
hidden cross-file calls (e.g. a small outward tick or a ring). That is a question for him; I am
not building it unasked.

### Marker cue for hidden calls: DESIGNED, NOT BUILT (waiting for Bela, via session-110)
Purpose: with the default on, a function that calls three functions in other files must not
look identical to one that calls nothing.
- **Function nodes (recommended):** while the setting hides edges, a node with at least one
  hidden cross-file or library call gets class `has-xfile`. CSS draws a thin dashed outer ring
  (node colour, ~60 % opacity; no new SVG elements). The node's `<title>` / hover card line
  says "calls 3 functions in other files · called from 2 other files". The ring disappears when
  the setting is off (the lines say it then) and while hovering (the lines are shown).
- **File slots (recommended, small):** the slot label gets an outgoing count, e.g.
  `auth.py · 6 · ↗14`, when the file's functions have hidden calls out. This is the
  "controller looks like dots" case, readable from the overview without hovering.
- **Folder frames / collapsed glyphs (not recommended):** the frame tab already shows counts,
  and a per-folder number would bring back the bundle information the setting removes. In a
  collapsed overview every edge is hidden, so a glyph badge would mark nearly every glyph.
- **Cost:** one O(E) pass per render. `renderLinks` already classifies every link, so collecting
  the endpoint ids of cross-file links into a Set is free. Then an O(N) class pass on the
  circles, and the count in the slot label at slot render. Nothing in the tick path; toggling
  stays CSS-only. About 40 lines in a new small module plus CSS, and tests: rings only on nodes
  with hidden calls, counts match `partitionByFile`, nothing when the setting is off. Roughly
  half a day including lab keyframes.

## F29 (found by session-181, 2026-10-06): Shelf zoom LOD stuck at full detail after a re-render. COMMITTED 2026-10-07, ships with F27

**Benchmark result (session-181, 2026-10-07): F27 ships, together with F29.** At a working zoom
F27's own cost is real but affordable (django 394 lines painted: pan/zoom 67.9/63.2 fps vs
main 68.8/60.5, CPU 3.9 -> 4.9 ms; fmt 2 801 lines: 72.2/64.0 vs 85.5/66.1, CPU 1.5 -> 3.3 ms).
At fit as users reach it, F29 left the LOD stuck: fmt painted 5 819 lines and pan collapsed
70.5 -> 29.1 fps (CPU 6.3 -> 29.0 ms per frame), back to 96 fps once the LOD was unstuck. So the
whole cliff is F29's. **Correction of an earlier belief:** the gesture LOD was never observed
parking lines while panning. It goes through the same applyLod and is just as stuck. F27 is safe
because F29 restores ZOOM parking, not because the gesture budget catches it.

**F29 trigger, measured 2026-10-07 (django, Shelf/Static):** F29 fires on a re-render while the
view is already zoomed out below the LOD thresholds. Repos that open collapsed fit at a high
zoom (k 2.4) and never start there; after expanding and fitting (k 0.032), a second Detail change
left 14 334 lines and 33 103 nodes attached on an F27-only build, and 0 / 0 with F29. On main it
was invisible (lines display:none from F27, nodes sub-pixel at k 0.03) and cost only CPU. Posted
on PR #71 as a comment by session-110.

**F31 may be a symptom of F29:** its "django at fit, about 10 ms CPU with zero lines on main" is
exactly the stuck state above (about 33k nodes and labels attached). session-181 is re-measuring
on the #71 head; if the cost drops, F31 closes without an owner.

**F31 (from session-181's benchmark, NOT fixed, not scheduled):** django at fit-to-view runs near
60 fps on main too, about 10 ms CPU per frame with zero lines painted. That is node and label
cost, pre-existing, independent of F27/F29/U1.

(original planning notes, kept:)

**Hold:** session-110 asked to hold the fix until 181's F27 benchmark is done, so the
before/after is not corrupted. F27 and F29 are to ship together, because F27 alone would carry
a cost that is F29's.
- **Cause (confirmed in code):** `applyFrameCulling`'s re-render branch
  (`__cull.frameSelFor !== __fr.frameSel`) calls `dom.reset(...)`, which leaves every fresh
  `<g>` at FULL detail. If the zoom did not change, `wantChanged` is false. If no frame flipped,
  `hidden`/`shown` are empty. So the re-apply loop never runs, and the LOD stays at full detail
  until the zoom crosses a threshold the other way. Before F27 the unparked in-frame lines were
  `display:none`, so this cost little. After F27 they are painted.
- **Fix (written and tested, held as a patch):** `.ai/plans/patches/f29-lod-after-rerender.patch`.
  `const freshDom = __cull.frameSelFor !== __fr.frameSel`, and the re-apply condition becomes
  `freshDom || wantChanged || hidden.length || shown.length`. Regression test in
  `frameRenderCullDrop.test.ts`: at k 0.2 links are parked; after a simulated re-render (fresh
  `<g>`s, same zoom) they are parked again. It fails without the fix and passes with it.
- **Ship:** as its own commit, applied after the benchmark, then together with F27 in one PR.

## Hover pin in Global + Dynamic: DESIGNED, NOT COMMITTED (waiting for Bela, via session-110)

This is not something the function card introduced. While a Dynamic layout settles, a resting
pointer loses ANY hover target: folder and file cards drift out from under it the same way, and
have since the engine shipped. The card only made that visible.
- **What:** when a function card's dwell starts on a node, set `d.fx = d.x; d.fy = d.y`, and
  release (`null`) on mouseout. This is the standard d3 idiom. Never touch a node the user
  pinned by dragging (remember whether fx/fy were already set, and leave those alone). Only in
  Global with Dynamic motion. Static and Shelf need nothing.
- **Upside:** hovering stabilises the thing you are trying to read, which in a live simulation
  is what people want.
- **Measured (lab, 3 s hover, 1-hop neighbours, while the layout settles):** click (degree 26):
  the node moves 5.6 px -> 0, neighbours mean 6.7 -> 2.9 px (max 11.8 -> 5.7). flask (degree 16):
  node 8.2 -> 0, neighbours 6.5 -> 1.5 px (max 8.9 -> 1.8). After rest: 0 vs 0 either way.
  Pinning calms the neighbourhood rather than perturbing it.
- **Does Global/Dynamic rest at all?** Yes (measured over 40 s): alphaDecay 0.02 reaches
  alphaMin 0.001 after 13-16 s on click/flask, then 0 ticks/s and an idle 60 fps. The pin
  matters during that settle and after reheats (drag, sliders).

**F32 (unowned, unscheduled; numbered by session-110; widened 2026-10-07):** Global/Dynamic
takes TENS of seconds to settle, scaling with graph size, saturating the main thread throughout,
and this repeats after every Detail change or other reheat.
- My measurement in the real webview (single page): click and flask settle in 13-16 s at about
  20 ticks/s, with 40-60 ms of main thread per tick.
- session-181's lab timing across the release matrix (two parallel workers, so the absolute
  numbers run high, but the SHAPE holds): time to rest is express 11 s, synthetic-1k 26 s,
  flask 27 s, click 39 s, zod 50 s, gson 81 s. Shelf/Dynamic: 9-33 s.
- So on a mid-size repo Dynamic is not a few seconds of motion: the user watches a moving,
  CPU-consuming picture for the better part of a minute after every Detail change.
- It does come to rest (0 ticks, idle 60 fps afterwards). This is not a perpetual-agitation
  defect; it is the cost and length of each settle.

## B. Function hover card

### Division of surfaces (all options)

- **Hover = small, read-only card.** It reuses the existing `.hover-card` element and a new
  `kind: 'function'`, so there is one tooltip layer and one set of hide rules.
- **Click = the existing editable source popup,** unchanged.
- **Rest, then click:** mousedown already hides the card (capture listener), and the popup opens
  as today. The card stays suppressed for that node until the pointer leaves it. It is also
  suppressed while a func popup for that node is open.
- **Delay: 450 ms of *dwell*.** The timer restarts when the pointer moves more than 4 px, so
  sweeping across a dense cluster never strobes. Labels stay at 300 ms and backgrounds at 600 ms.

### Content options (drafts B1-B3)

| Option | Shows | Source | Cost |
|---|---|---|---|
| **B1 Brief** | name(signature), `file.py:120`, leading docstring/comment (≤ 3 lines), "called by 4 · calls 7" + top-3 names each, LOC | Host: new `get-func-brief` message (reuses `getFuncSource` + comment extraction from `annotationDigest.ts`). Counts from graph data in the webview. | Free, ~5 ms, cached per id+mtime |
| **B2 Peek** (recommended) | B1 plus the **first 8 lines** of the body, highlighted and faded out, then "… 34 more lines · click to edit" | Same message, returns the head of the source. Highlighting is built as DOM spans from `highlightCode` tokens (no `innerHTML`); `highlightCode`'s own `esc()` gets a unit test either way. | Free |
| **B3 Explained** (add-on to B1 or B2) | An AI one-liner "What it does", marked ✦ and "outdated" when the file changed | **On demand only:** an "Explain ✦" button in the *click* popup header (the hover card is pointer-events:none). The result is cached in `annotations.json` under a new additive `functions` map and then shows in every hover. | ~$0.005 fixed CLI overhead + tokens per function ≈ **$0.006 each**. See the cost note. |

**Cost note (for B3, honest):** the measured Annotate cost is about $0.0005 per path in batches
of 40 (express: 182 paths, $0.092). A *bulk* function run is a different scale: 10k functions ×
~400 input tokens (body clamped) + ~50 output tokens with haiku comes to **about $6.5**. That is 3×
the default `annotate.maxRunBudgetUsd` ($2). A 1.5k-function repo is about $1. So: no bulk
function run in this round. Explanation is on demand per function, with an optional "Explain all
functions in this file" (≤ 1 request of 40) from the slot context menu. The bodies leave the
machine only if `annotate.readSource` is on. Otherwise the explanation is built from signature,
docstring and caller/callee names, which gives a weaker but digest-only result. The confirm dialog
says which mode applies.

Recommendation: **B2 now, B3 as a second step** gated on Bela's answer to Q4.

### Engines

The hit rows are `circle.regular-node` and `path.cloud-node` inside `g.nodes`, which are the
same classes in Shelf, Global and drill-down. The datum carries `id/file/line`. One resolver branch
in `hcResolveTarget` handles them (cluster/library nodes excluded). Library nodes keep today's
`lib-description` path and get no card.

## C. F26 — Show only while zoomed leaves a blank canvas

- **Repro (uxtest lab):** open fmt, zoom into a slot, then use slot menu → "Show only this file".
  The frame re-packs to the top-left and the viewport shows nothing.
- **Fix:** after the scope re-pack glide (the existing 230 ms timer), refit when
  `!state.userZoomed` (as today) **or** when the viewport intersects no frame that has visible
  members. New pure helper `viewportEmpty(frames, transform, vw, vh)` goes in `frameCull.js`
  (it already has `viewportRect`). The Global engine gets the same check through
  `applyStructuralFilters` → `fitToView` with the node bounds. The user's zoom level is otherwise
  respected: we only refit when they'd see nothing.
- **Test:** unit test for `viewportEmpty` plus a webviewControls test that sets `userZoomed`,
  applies `onlyShowFile` and asserts `fitToView` ran.

## Steps (executor, after approval)

1. C (F26): helper, hook, tests. Small and independent, so it ships first.
2. A: `crossExpand.js` pure helpers + tests (caps, stable top-N, port-fan geometry,
   collapsed/hidden endpoints).
3. A: render pass + bundle click / Esc / context-menu "Pin connections" + Filters-panel chips +
   save/restore.
4. A: benchmark (fmt, 10k) before/after, then set the caps from the numbers.
5. B: host `get-func-brief` (tests with fixture files: py/ts/java/cpp, docstring above vs inside).
   **Shared with session-214 (MCP), ruling by session-110 2026-09-29:** `src/funcBrief.ts` is
   owned here and must be **vscode-free** (pure functions over file text + a symbol list, no
   `vscode` import, no fs). It gets bundled into MCP's standalone Node process. The thin caller
   (`graphProvider.ts` message case, reading the file) stays outside it. Exported API:
   `funcSlice(text: string, startLine: number, nextStartLine: number | null, lang: string,
   maxLines?: number): { signature: string; doc: string; body: string; endLine: number; truncated: boolean }`
   plus `orderSymbols(symbols: {line: number}[])`. session-110 is told the commit when it lands.
   **Built ON `src/sourceEditor.ts` (session-110, 2026-09-29), not a third implementation.**
   `sourceEditor.ts` (47 LOC, imports only `fs`) already owns end-of-function detection
   (`findPythonFuncEnd`, `findJsFuncEnd`). `funcBrief.ts` imports those pure finders and adds
   only what is missing: docstring extraction, the caller-supplied `maxLines`, the
   `{ok:false,error}` return and the injected `readText`. The real work is the language
   delta. Everything that isn't `.py` goes through `findJsFuncEnd` today, which ignores braces
   inside strings, char literals and comments, and has no notion of a body-less declaration.
   A Java abstract/interface method or a C++ prototype ending in `;` therefore runs on into
   the NEXT method's braces. That is wrong in the click popup today, and `saveFuncSource` uses
   the same finder, so saving such a popup would overwrite the following method. Fix: a brace
   scanner that skips string/char/template literals and line/block comments, and ends at `;`
   when no `{` came first. It is tested on py/ts/js/java/cpp fixtures, including those cases, and
   `getFuncSource`/`saveFuncSource` pick it up unchanged.
   **One message, not two (proposal to session-110):** `get-func-brief` would be a superset of
   `get-func-source`, so extend the existing message additively instead. The request gets an
   optional `maxLines`; the reply `func-source` gets `signature`, `doc`, `truncated` and
   `totalLines` next to `source`/`endLine`. The request/reply keep the `reqId` idiom. The hover
   card uses its own `reqId` namespace (`hc-<n>`), which the popup handler in `main.js`
   already ignores (no matching popup). The host skips `colorize` when `maxLines` is set: the
   card tokenises with `highlightCode`.
   **Check 85 rule change CONFIRMED by session-110:** one fetch per function, on dwell, cached.
   Requirements from session-214 (via session-110, 2026-09-29):
   - `maxLines` is **caller-supplied** (hover peek passes 8, MCP `get_symbol` passes 80). There
     is no baked-in constant beyond a default.
   - **No path resolution inside the module:** no `path.join/resolve`, no symlink following. A
     file-level entry point `readFuncSlice(filePath, readText, startLine, nextStartLine, lang,
     maxLines)` takes an already-confined path and an injected `readText(path) => string`, and
     passes the path through untouched.
   - **Never throws for I/O:** an unreadable or vanished file returns
     `{ ok: false, error: string }`. Success returns `{ ok: true, ...slice }`.
   - `startLine` / `nextStartLine` are always parameters (MCP supplies them from its own index).
     The module never derives them by re-parsing.
   - Written against `@types/vscode ~1.75.0` (session-110 is pinning it on main). Merge main and
     run `npm ci` before writing host code.
6. B: hover-card `function` kind, dwell timer, suppression with the open popup, token-DOM preview.
7. B3 (if approved): Explain button, the `functions` map in annotations, cost confirm, mocks.
8. CHANGELOG `[Unreleased]`, selectors to uxtest (new: `.cross-expanded`, `.cross-residual`,
   `.hc-sig`, `.hc-doc`, `.hc-calls`, `.hc-code`, `.hc-more`), then self-review.

### Asks from session-181 (uxtest), accepted 2026-09-29
- A read-only hook `crossPairsForTest()` returning `[{key, a, b, weight}]` from
  `aggregateCrossPairs`, sorted by weight descending (pairKey uses a `\x01` separator, so
  tests must not rebuild keys).
- `CROSS_CAP_PER_PAIR`, `CROSS_CAP_PAIR_MAX`, `CROSS_CAP_TOTAL`, `HOVER_FN_DELAY_MS` and
  `HOVER_FN_DWELL_PX` declared as top-level `const` in classic scripts, so `page.evaluate`
  reads them.

## Files touched

New: `src/webview/crossExpand.js`, `src/webview/crossExpandRender.js`,
`src/webview/funcBrief.js` (card content for functions), `src/funcBrief.ts` (host extraction), tests.
Small edits: `frameRender.js` (hooks), `hoverCard.js` (function kind + dwell),
`frameCull.js` (viewportEmpty), `controls.js` (save/restore, Filters chips), `graphProvider.ts`
(one message case), `webviewHtmlBuilder.ts` (append 3 scripts at the END), `styles.css`,
`CHANGELOG.md`.

## Risks

- Bundle clicks compete with the frame drag (title-bar strip) and the background pan. The hit line
  is only on the bundle stroke, so a drag that starts on a bundle pans as today (threshold 3 px).
- The hover card on dense clusters could feel noisy. The dwell timer handles this, and the lab
  will confirm it.
- Docstring position differs per language (Python inside, the rest above). Covered by tests on
  4 languages.
- The 600-line cap is a guess until step 4 measures it.

## Test strategy

Unit (mocha + jsdom): crossExpand helpers, save/restore round-trip, hoverCard function resolve +
dwell + suppression, funcBrief host extraction, viewportEmpty. Coverage ≥ 80 % on new modules.
Lab (uxtest, via session-181): bundle expand/collapse, pin, function hover on Shelf/Global/
drill-down, F26 repro. Perf: step 4 numbers in the report.

## Out of scope

Bulk function annotation, routing links around frames, the Global engine's edge drawing, the chat
sidebar, MCP, Workflow, browser/webview-in-browser.

## Open questions for Bela (defaults in bold)

1. A: **A1 expand-a-bundle as primary + A2 pin as secondary**, or another pick from the drafts?
2. A: are the caps ok: **60 per pair (up to 300 via "+N more"), 600 total**?
3. B: **B2 Peek (8 lines of code)** or B1 Brief (no code)?
4. B3: do we want AI explanations at all this round? If yes: **on demand from the click popup,
   cached, no bulk run**, and must it respect `annotate.readSource` (**yes**)?
