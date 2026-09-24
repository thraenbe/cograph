# uxtest review rubric

Source of the criteria: dev.cograph.co doc 02 (`cograph-web/src/app/dev/testPlanData.ts`) — rendering R1–R6,
performance P1–P7, tasks T1–T6, hypotheses H1–H6. This file maps each one to the **evidence a uxtest run
produces**, so a review can be done from `index.html`, the keyframes (`steps/*.png`) and the JSON — no video
decoding required. Numbers from headless Chromium are comparable only **within one machine and mode**.

Checkpoints: **C1** overview at fit · **C2** largest top-level folder open · **C3** full depth. In `smoke` these are
the steps "Overview after load (C1)", "Expand the largest folder (C2)", "Fit the full-depth layout" (C3).

## Rendering

| id | question | evidence | automatic signal | still needs eyes |
|----|----------|----------|------------------|------------------|
| R1 | Can you name the 3 largest modules and how they relate at C1? | `smoke` C1 keyframe, `detail` 0.00/0.25 keyframes | `offscreenNodeRatio` = 0, finding `graph-overflows-viewport` absent | are frame titles legible at fit zoom? are sizes telling? score 1–5 |
| R2 | Do folders/files overlap? | every step | `frameOverlapPairs`, `slotOverlapPairs`, `nodeOverlapPairs`; findings `frame-overlap`, `slot-overlap`, `static-grid-overlap` | overlaps created by a user drag (canvas step "Drag a folder") are expected — judge whether the product should prevent them |
| R3 | Which functions belong to which file without hovering? | `smoke` C2/C3 keyframes | `nodesOutsideSlot`, `nodesPokingOutOfSlot` = 0 | slot labels readable? score 1–5 |
| R4 | Is the function level readable at C3? | `smoke` C3, `detail` 1.00 | `labelOverlapRatio`, `edgeCrossingsPerEdge`, `nodeOverlapRatio`; finding `label-clutter` (B6) | hairball impression, zoom needed; score 1–5 |
| R5 | Is the picture the same after reload? | `save-roundtrip` + `save-roundtrip-restore` | findings `restore-differs`, `restore-node-count`; step note "restore delta" | compare the two keyframes side by side |
| R6 | Are cross-folder calls visible at C1–C2? | `smoke` C1/C2, `canvas` keyframes | — (bundles are not scored yet) | bundle strokes visible? score 1–5 |

## Performance

| id | metric | evidence |
|----|--------|----------|
| P1 | analysis time | `uxtest/.cache/<repo>-<sha>.json` → `analysisMs` (analyzers only; same for every build) |
| P2 | T_first / T_functions | not measured in Tier A (fake host delivers instantly); Tier B video timestamps |
| P3 | time-to-still | `still.ms` of the step (`+` suffix / finding `did-not-settle` = hit the timeout). Shelf+Static must be ≈ 0 |
| P4 | frame time while settling | step `fps.avgMs`, `fps.p95Ms`, `fps.longFrames`; `perfReport().tick` p50/p95; finding `long-frames` |
| P5 | pan/zoom smoothness | `canvas` steps "Zoom in (wheel)" / "Pan": `fps.minFps` |
| P6 | interaction latency / isolation | `canvas` "Drag one function node" + "Drag a folder by its title": step note `collateral: N node(s) moved`, finding `collateral-movement` (H4 must be 0) |
| P7 | memory / DOM | `metrics.domNodes`, `metrics.heapMB` at C3 |

## Tasks (what the scenarios exercise)

| id | task | scenario · step |
|----|------|-----------------|
| T1 | find a function, open its source | `settings` search steps; `popups` "Click a function → source popup" |
| T2 | biggest file of the largest folder | `smoke` C2 keyframe (slot label carries the count) |
| T3 | rearrange without collateral | `canvas` drag steps (see P6) |
| T4 | save and restore | `save-roundtrip` (R5) |
| T5 | follow a call across folders | not automated — judge bundle legibility on `canvas` keyframes |
| T6 | mode switch without glitches | `engine-motion` (watch `console-error`, `did-not-settle`, NaN errors) |

## Hypotheses to confirm or falsify

H1 (R1/R2 ≥ 4 on every project) → any `frame-overlap` / `slot-overlap` / `static-grid-overlap` finding falsifies.
H2 (time-to-still 0 static, ≤ 5 s dynamic) → `still.ms` on Shelf+Dynamic steps; `did-not-settle`.
H3 (frame time ≥ 3× lower than the old build) → needs a second run with `--ext-root <old checkout>` and `--baseline`.
H4 (no collateral movement) → `collateral-movement`. H5/H6 are human judgements.

## Known bugs the suite watches

| bug | signal |
|-----|--------|
| B1 nodes outside slot/frame | `node-outside-slot`, `node-outside-frame`, `static-grid-overlap` |
| (scoping) | `static-grid-overlap` fires only for grid-born layouts; after Dynamic → Static or a user drag the overlap is `frozen-overlap` (low, legitimate) |
| B2 nodes pinned to the frame wall | `nodes-pinned-to-wall` |
| B6 static-mode label clutter | `label-clutter` |
| B7 panel vanishes after open | Tier B only (`uxtest:vscode`, step "Panel still alive after 15 s") |

## Severity guide for `findings.md`

**high** = wrong picture or broken interaction a user will hit (overlap in a packed layout, nodes outside their
box, console errors, restore differs, collateral movement). **medium** = degrades reading (clutter, pinned
nodes, never settles). **low** = cosmetic / environment-dependent (overflow after load, long frames headless).
