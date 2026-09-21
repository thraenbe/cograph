# Findings log — first uxtest campaign (2026-09-18 … 21)

Durable copy of what the suite found while it was being built (the evidence — videos, keyframes, snapshots —
lives under the gitignored `uxtest/artifacts/` of the session that ran it). Base unless noted: `shelf-base` 9eda4c8.
Status as reported by the owning sessions; "verified" = re-run by uxtest via `--ext-root`.

(F11 is perf's "graph message lost on cold open → ready handshake"; it was not found by uxtest.)

| id | finding | how the suite sees it | owner | status |
|----|---------|-----------------------|-------|--------|
| F1 | Shelf+Static first load: a large file slot renders as an overlapping blob (click `tests/test_options.py`: 180 of 196 nodes keep their seed position, 503 overlapping pairs). Cause: `placeMembersInSlots()` only grids members that are *outside* the slot; a seed cloud inside a big slot counts as placed. Likely the source of B1/B2. | `static-grid-overlap` at smoke step 1 | ux | fixed, verified (0 pairs) |
| F2 | Fit-to-view runs on the structure skeleton and is not repeated when the graph is ingested → graph overflows the viewport (k 0.49 instead of 0.23). | `graph-overflows-viewport`, `offscreenNodeRatio` | ux | fixed, verified |
| F3 | Engine Global → Shelf while Global is still settling: 5 808 console errors `<line> attribute x1: Expected length, "NaN"`. | `console-error` in `engine-motion` step 4 | ux | fixed, verified (0 errors) |
| F4 | Booting with `defaultEngine=global` + `defaultMode=static`: no layout ever runs; first screen is one opaque colour wash, nodes at seed spread. | `canvas` global/static keyframe 1, skips "no folder frame…tooSmall" | ux | fit fixed; still unreadable (needs a settle before freezing) |
| F5 | "Show Libraries" is a silent no-op under Shelf (`frameRender` clears the library layer). | `popups` libraries step | ux | fixed: toggle disabled + hint, verified |
| F6 | (ux branch) Detail 0 + fit: the single closed-folder glyph fills the whole viewport (fit scale cap 4 × r 115). | smoke step 5 skipped, keyframe 4 | ux | fixed, verified |
| F7 | Shelf+Dynamic reheat latency: after a force change nothing moves for ~6 s on 12 folders (longer with more). The scheduler ticks `maxActive = 4` frames in **path order**, so member-less parent frames burn ~300 ticks each before a frame with visible nodes is reached; `state.simulation.alpha()` stays 1.0 meanwhile. Makes the force sliders feel dead and made the first Shelf sweep measure nothing. | `reheat-latency` in `force-reheat` (first motion > 2 s) | perf | fixed on termi/s180 0107663; verified 28–84 ms to first motion. Note: my original 6 s figure was measured after a Detail change and was mostly F13 |
| F8 | (ux branch) Detail 0.3 on click: collapsed-folder glyphs overlap file slots and stick out of the frame. | keyframe of hover-card step 7 | ux | fixed (glyph constrained) |
| F9 | (annotate) No hover card when resting on click's collapsed `src/click` glyph. | `hover-card-missing` | annotate | fixed, verified by owner |
| F10 | Cross-hover lines are torn down and rebuilt ~30×/s under a resting pointer (2 970 lines added + removed per second on click's collapsed glyph at Detail 0.3). Present on shelf-base already. | `hover-churn` in `canvas` | perf | fixed on termi/s180 02aefc8, verified (13–27 → ≤ 2 rebuilds/s) |
| F12 | Global engine, repo **zod**, forces center 0.075 · repel 191 · link 4.8 · fileCluster 0.98 · folderRepel 0.26 · fileRepel 2.12: the page freezes for 13+ min (same values settle in 21 s on click). Several other zod/global samples never settle within 45 s. | sweep sample never returns; `did-not-settle` | ux/perf | open |
| F13 | Shelf+Dynamic: after ANY Detail-slider change the force sliders are dead. click, fresh page: repel 250 → 600 moves 1 677 nodes (54 px) within 2 s; the same change after `Detail → 1` moves 0 nodes in 12 s although the scheduler keeps picking frames and marks them settled (16 → 12 → 8 unsettled) and `alpha()` stays 1. The frame sims apparently keep ticking on node objects that the re-render replaced. Cured by an engine round-trip. This, not only F7, made the Shelf sweeps inert. | `force-slider-dead` in `force-reheat` | perf | fixed on termi/s180 e35c553, verified (8 → 1 740 of 1 778 nodes move) |

## Harness lessons (so the next campaign does not repeat them)

- A per-frame movement threshold calls slow settling "still". The detector now measures drift across the whole
  quiet window and, for actions that must move something, refuses stillness until motion was seen.
- A sweep must not put settle time into the ranking score: the defaults start at their own equilibrium. Rank the
  picture, list settle time next to it, and reheat the baseline like every sample.
- `static-grid-overlap` right after Dynamic → Static is the frozen dynamic picture, not B1.
- Ctrl+S (layout) is a VS Code keybinding → `save-request`; only Tier B can press the real key.
- With an eager host every file is parsed, so collapsed *files* only exist in the lazy-host scenario.
- This machine's Node 22 has no TypeScript support → everything TypeScript runs under the Playwright runner.

## First force sweep (shelf-base UI, 12 LHS samples + defaults per repo × engine, Dynamic, headless)

Global: the best swept sample beats the defaults on click (33.8 %), express (21.6 %), zod (21 %). One sample wins
click and zod: center 0.18 · repel 719 · link 0.8 · fileCluster 0.07 · folderRepel 2.57 · fileRepel 0.2.
Spearman: File Cluster Force ↑ → worse picture (+0.57 / +0.69); Repel ↑ → less overlap (−0.75); folderRepel and
fileRepel have no measurable effect. 12 samples per group: a direction, not final numbers.
Shelf: both runs are invalid on shelf-base — the sweep set Detail first and thereby triggered F13 (click/express: 0 px
movement in every sample incl. the reheated defaults; zod moved but within noise). The sweep no longer touches
Detail when it is already at the target; the real Shelf sweep runs on the integrated branch after F7/F13.
