# Task — UX restructure (Feature 2, session s111)

Brief: `…/scratchpad/briefs/ux.md` (+ `00-common.md`), Bela's decisions of 2026-09-18.
Base: checkpoint `9eda4c8` (= `shelf-base`), 746 tests green. Planner phase — no code yet.

## Problem

Four UX defects accumulated around the Shelf launch: (1) three group-by lenses exist but
only File (drill-down) is the product — Class/Connect confuse and multiply test surface;
(2) folder frames look like grey boxes — Bela picked Draft A "Index tab" as the folder
identity, for BOTH engines; (3) "Lang" label is cryptic; (4) force sliders are split
across two panels, half of them dead depending on engine/motion (Center does nothing in
Shelf, everything is dead in Static), defaults are inconsistent and Reset misses three.

## Constraints

- `main` untouched; work on `termi/s111`; CHANGELOG entries under `[Unreleased]`; version stays 1.3.0.
- File-ownership map in `00-common.md`: I own panel HTML (~230-400), `controls.js`,
  `styles.css` panel rules, frame/folder visuals in `frameRender.js`, `folder.js` colours,
  `clustering.js`, lens code in `main.js`/`fileClusters.js`. **`localSim.js` is perf's** —
  anything crossing that line is flagged below and needs sign-off via session-110.
- No tooltip layer (annotate owns it) — only stable hooks.
- "People keep their saved views": every v1/v2 save, including `clusterGroupBy:
  'class'|'connect'|legacy 'connectivity'|'auto'`, must load silently as File.
- New code in new modules (<400 LOC files); no packer geometry or saved-layout change
  (tab must fit the existing 30 px TITLE reserve).

## Steps

### S1 — Lens removal: only "Group by File" survives
1. `webviewHtmlBuilder.ts` ~266-271: delete the "Group by" section label + the three
   `#btn-group-*` buttons from `#panel-detail` (Detail slider stays).
2. `controls.js` ~176-195: delete the `GROUP_BY_MODES` wiring block.
3. `state.js:16`: keep the field, document it as constant `'file'` (dozens of readers —
   removing the field is churn without benefit). `isDrilldown()` untouched.
4. `main.js` ~259-261: drop the `'connect'` ternary → always
   `computeStructuralClusters(projectData, 'file', …)`. **Verified**: this branch stays
   reachable — `applyComplexity` falls back to it when `clusterGroupBy==='file'` but no
   structure tree exists (autoEngage off), so plain file-clustering must survive.
   `main.js` ~321 (`!== 'connect'` guard): condition becomes always-true → remove guard.
   `main.js:94` (`setLayoutEngine`): `state.clusterGroupBy !== 'file'` clause is now dead
   → simplify to the workflow check only.
5. `clustering.js`: delete `computeClusters` (Connect) and the `'class'` branch of
   `computeStructuralClusters`. KEEP `computeImportanceScores`,
   `buildClusteredElements`, `buildRenderedNodeMap`, and the `'file'` structural path
   (workflow.js and the fallback depend on their shapes).
6. `controls.js` save/restore ~311-348: keep writing `clusterGroupBy: 'file'` (older
   builds can still read new saves); loader maps ANY other value (class, connect,
   legacy connectivity/auto) → `'file'`.
7. `class.js` + `#btn-class-mode` (`#panel-class`): untouched — the OOP class overlay
   stays exactly as is. Only the lenses go.

### S2 — "Lang" → "Language"
`webviewHtmlBuilder.ts` ~299: button text (id stays `btn-language-mode`). One test string
in `webviewControls.test.ts` if asserted.

### S3 — Folder look: Draft A "Index tab", both engines
New pure module `src/webview/frameChrome.js` (+ script tag at END of list, module-exports
guard) with the Draft A maths from `folder-frame-drafts.html` `STYLES.a`:
- `tabWidth(name, frameW)` = `min(frameW*0.62, name.length*6.4 + 40)`;
  `tabChars(tw)` = `floor((tw-34)/6.4)`; `cut(name, chars)` ellipsis.
- `tabBodyPath(rect, th, tw)` / `tabOnlyPath(rect, th, tw)` — rounded frame outline with
  the tab bump (r=7, `c6 0 6 th 12 th` shoulder), tab height **th = 22** (< the 30 px
  the packer reserves — zero `frames.js` change).
- `countsText(files, fns, freeW)` → `"34 files · 410 fns"` or short `"34 · 410"` when
  `len*5.5 > freeW` (free = w − tw − 22); folder glyph path constant.
Apply in:
- `frameRender.js` (Shelf): frame join renders `<path class="folder-bubble-shape">` from
  `tabBodyPath` + a `.frame-tab` group (tab path, glyph at (9,6) scale .85, label at
  x+26/y+15) + right-aligned counts text in the free strip. The whole 30 px strip keeps
  the existing title-drag behaviour (`createFrameTitleDrag` target = tab group + an
  invisible full-width strip rect). Root frame keeps its dashed outline.
- Cross-folder bundle ports: `frameRender` passes the TAB rect (not the full-width bar)
  as `titleRect` into `buildCrossLinks` → `portOn` clamps into the tab, i.e. ports sit on
  the tab's right shoulder. `crossLinks.js` itself unchanged (pure).
- Global engine: `drilldown.js` `renderDrilldownBoxes`/`tickDrilldownBoxes` and the
  collapsed-folder glyphs get the same tab look via the same frameChrome helpers, so
  both engines match. `folder.js` colour fn: **+14 saturation** on the path-hash hue
  (one constant, shared by both engines).
- Collapsed folders (proposal, per orchestrator recommendation — OPTIONAL, Bela to
  confirm): compact closed-folder shape (Draft A collapsed variant: tab + counts line
  below) and a chevron ▸/▾ in the tab as expand/collapse affordance.

### S4 — Forces: one box, engine-specific, "show more forces"
Proposed design (Bela to confirm):
1. Single Forces box = `#forces-section` in the gear settings panel. Remove the three
   quick sliders from `#panel-folder`; `#btn-more-forces` becomes label "forces ⚙" and
   keeps opening the gear panel (scrolled to the box).
2. New small module `src/webview/forcesPanel.js` (owns visibility logic, replaces
   `setFrameSliderNoops` in frameRender — that helper is removed):
   - Shelf+Dynamic: Repel, Link, "Keep near file" (= fileClusterForce/slot pull).
   - Global+Dynamic: Center, Repel, Link, File Cluster, Folder Repel, File Repel.
   - Any+Static: sliders hidden, one hint line "Static layout — forces are off.
     Switch Motion to Dynamic."
   - Called from `updateLayoutButtons` / `setLayoutEngine` / `setLayoutMode`.
3. "Show more forces" = inline expander inside the box revealing advanced forces:
   `linkDistance` (default 30 shelf / 40 global), `velocityDecay` (0.3), `collidePad`
   (1.5), and in Shelf `slotPad` (10). New settings keys flow through the existing
   settings patch (`applyDisplaySettings` → facade `applySettings`, frameInteract ~51-54).
   **Perf boundary**: I define keys + defaults + ranges here; the mapping inside
   `localSim.js` (`applySettings`/`buildD3Sim`) is perf-owned — either perf applies my
   spec or I patch those ~10 lines with sign-off. Same for dropping the dead Center
   plumbing in Shelf (`localSim.js:162-164` calls `sim.force('x')` which never exists) —
   recommendation: **drop** (no frame-centre pull; slots already anchor nodes).
4. Fixes: `slider-center-force` HTML default 0.05 vs `main.js:41` 0.025 → align HTML to
   0.025 (state is the authority; saves already carry explicit values). Reset
   (`controls.js` ~96-126) additionally resets fileClusterForce / folderRepelForce /
   fileRepelForce + the new advanced keys.

### S5 — OPTIONAL (agreed follow-ups, separate commits): B6 + animated re-pack
- B6: truncate slot labels to slot width (`frameChrome.cut` on measured chars); hide
  function labels in slots denser than N until zoom > threshold (read the zoom transform
  in `tickFrame`'s label pass).
- Animated re-pack: when `updateFrames` reports `repacked`, add a class enabling a
  ~200 ms CSS transform transition on moved frame `<g>`s; remove on transitionend
  (drag/zoom stay untransitioned).

### S6 — Hooks + handoff
- Keep `g.frame` bound with `path`, slot rects with `filePath`; new `.frame-tab` class —
  documented for annotate's `hoverCard.js`.
- Selector changes for uxtest (msg to session-110): REMOVED ids `btn-group-file`,
  `btn-group-class`, `btn-group-connect`; sliders `slider-file-cluster`,
  `slider-folder-repel`, `slider-file-repel` MOVE into `#forces-section`;
  `btn-more-forces` text changes; `btn-language-mode` text "Language"; NEW
  `.frame-tab`, `#forces-hint`, `#btn-show-more-forces`, advanced-force slider ids
  (`slider-link-distance`, `slider-velocity-decay`, `slider-collide-pad`,
  `slider-slot-pad`).

## Test strategy

- Rewrite: `webviewControls.test.ts` (group-by wiring 434-475 → removal asserts +
  legacy-save remap cases; forces visibility per engine×motion; reset covers all),
  `clustering.test.ts` 187-617 (drop class/connect suites; keep file + importance +
  workflow-shape), `drilldown.test.ts` 209-265/405-415 (box render → tab assertions),
  `graphProvider.test.ts` 815-842 (save payload).
- New: `frameChrome.test.ts` (pure: tab width/ellipsis bounds, path strings start/close,
  counts short-form switch, th=22 < TITLE), `forcesPanel.test.ts` (jsdom visibility).
- jsdom smoke harness re-run (all four engine×motion combos still boot, drag isolation).
- Full `npm test` green before reporting done, after `git merge main` + any finished
  feature branch session-110 names.

## Risks

- `clustering.js` removal breaking Workflow view → only delete `computeClusters` +
  `'class'` branch; workflow tests + shape assertions guard.
- Old saves (class/connect) misloading → explicit remap tests both save versions.
- Tab look regressing saved layouts / packer → geometry untouched (th 22 < 30); frame
  serialize round-trip test stays green.
- Port move breaking ancestor/descendant bundle routing → crossLinks unchanged, only the
  rect input narrows; existing crossLinks tests + one new port-on-tab test.
- Merge friction with perf (`webviewHtmlBuilder.ts`, `package.json`) → my edits stay in
  panel HTML region + END of script list; no CSP/script-order changes.
- localSim boundary (advanced keys, Center drop) → blocked on perf sign-off, tracked as
  explicit checklist item, not silently patched.

## Files touched

`webviewHtmlBuilder.ts` (panel HTML + 1 script tag), `controls.js`, `styles.css`,
`main.js` (lens branches, updateLayoutButtons call), `clustering.js`, `fileClusters.js`
(comment only), `frameRender.js` (frame join, slot labels, remove setFrameSliderNoops),
`drilldown.js`, `folder.js` (colour saturation), NEW `frameChrome.js`, NEW
`forcesPanel.js`, tests as above, `CHANGELOG.md` `[Unreleased]`.
Perf-owned, needs sign-off: ~10 lines in `localSim.js` (settings mapping + dead Center).

## Acceptance criteria

1. Only "File" grouping exists; Class/Connect buttons and code paths gone; every legacy
   save (v1/v2, any lens value) loads silently as File; OOP Class overlay unchanged.
2. Both engines draw Draft A tabs: name in a top-left tab (ellipsis at ≤62 % width),
   glyph, counts in the free strip (short form when narrow), +14 sat, whole strip drags,
   bundle ports on the tab shoulder; no saved-layout or packer change.
3. Language button reads "Language".
4. One Forces box; contents match engine; Static shows the hint; "show more forces"
   expander works; Reset restores every force; Center default consistent (0.025).
5. Full suite green (≥746 + new); new modules ≥80 % covered; no console.log.

## Out of scope

Worker pool / perf work, hover tooltips (annotate), uxtest tooling, release/tagging,
`frames.js` geometry, saved-layout format changes.

## Open decisions for Bela

a) Forces box location = gear panel (my proposal) vs. left toolbar?
b) Drop dead Center force in Shelf (recommended) vs. implement real frame-centre pull?
c) Optional S5 items (B6, animated re-pack) in this feature or deferred?
d) Optional chevron + compact closed-folder shape (orchestrator's Draft A additions)?
e) Advanced-force set OK (linkDistance, velocityDecay, collidePad, slotPad)?
