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

- A settle detector started AFTER the action misses reactions that are over in milliseconds (worker sims of small
  folders). Arm it before the action (`armBefore`) and judge "no effect" by measured node displacement, never by
  "the detector saw nothing". The first integrated sweep mislabelled express/Shelf as inert for this reason; the
  guess "tiny slots leave no room" was wrong (median free play 32 px, 121 of 127 nodes move on a repel change).
- A metric must follow the product's own geometry parameters: `nodesPinnedToWall` tested the UNPADDED slot wall, so
  every sample with slot pad ≥ 2 px looked wall-free (click: 94 → 0 exactly at slot pad 2). Caught while re-ranking;
  the interior now moves inward with `settings.slotPad`.
- Measurement runs must not depend on gestures that can miss: on a never-settling layout the double-click "fit"
  landed on drifting nodes and opened source popups (17 of 22 zod/Global samples), so "at fit" metrics were taken
  un-fitted behind a popup. Sweeps now call the product's `fitToView()` directly and assert that no click reached the
  graph. Found only by opening the keyframes — always look at the pictures before trusting a ranking.
- Wall-clock settle times measure the MACHINE, not the code, as soon as several software-rendering pages share it:
  a '3x slower settle' I reported was pure load (perf's bisect: identical tick counts on four SHAs, ms per tick varying
  41 -> 74 for the same SHA). Report settle in simulation TICKS (alpha schedule) and keep wall-clock comparisons to
  `--workers 1` on an idle machine.
- Killing the Playwright RUNNER does not kill its workers or their Chromium pages: two orphans from aborted sweeps
  span for 8 h 45 min and 5 h 55 min (47 % + 25 % CPU) under everybody's measurements. After any aborted run check
  `ps` for `workerProcessEntry` / `chrome-headless-shell` with your worktree as cwd and end exactly those trees.
- A picture score needs a term for every quality the eye judges: without folder separation the Global ranking
  rewarded layouts that merged `tests/` into `src/`. `folderOverlapRatio` (non-nested folder boxes) is now part of it.
- Controls inside a collapsed expander are "hidden", not "absent": open `#forces-advanced` before deciding a slider
  does not exist — otherwise a sweep silently drops exactly the parameters it was run for.

- A per-frame movement threshold calls slow settling "still". The detector now measures drift across the whole
  quiet window and, for actions that must move something, refuses stillness until motion was seen.
- A sweep must not put settle time into the ranking score: the defaults start at their own equilibrium. Rank the
  picture, list settle time next to it, and reheat the baseline like every sample.
- `static-grid-overlap` right after Dynamic → Static is the frozen dynamic picture, not B1.
- Ctrl+S (layout) is a VS Code keybinding → `save-request`; only Tier B can press the real key.
- With an eager host every file is parsed, so collapsed *files* only exist in the lazy-host scenario.
- The `vscode` stub must mirror every property the builder PROBES, not only what it prints: without `Uri.fsPath` the
  builder's `fs.existsSync(dist/webview/…)` check failed silently and the lab ran sync sims only — a whole transport
  went untested until perf noticed the settle times. `run.json.simTransport` now records what really ran.
- This machine's Node 22 has no TypeScript support → everything TypeScript runs under the Playwright runner.

## First force sweep (shelf-base UI, 12 LHS samples + defaults per repo × engine, Dynamic, headless)

Global: the best swept sample beats the defaults on click (33.8 %), express (21.6 %), zod (21 %). One sample wins
click and zod: center 0.18 · repel 719 · link 0.8 · fileCluster 0.07 · folderRepel 2.57 · fileRepel 0.2.
Spearman: File Cluster Force ↑ → worse picture (+0.57 / +0.69); Repel ↑ → less overlap (−0.75); folderRepel and
fileRepel have no measurable effect. 12 samples per group: a direction, not final numbers.
Shelf: both runs are invalid on shelf-base — the sweep set Detail first and thereby triggered F13 (click/express: 0 px
movement in every sample incl. the reheated defaults; zod moved but within noise). The sweep no longer touches
Detail when it is already at the target; the real Shelf sweep runs on the integrated branch after F7/F13.

## Final force sweeps on the integrated branch (termi/s180 50876d2 = F12 clamp, D6 graphs; 2026-09-21)

Shelf (63 samples, 7 sliders, wall metric aware of slot pad): keep the defaults - with nodes-on-a-wall weighted like node
overlap they rank 2nd / 3rd / 1st of 21 (click / express / zod). Slot pad is the one harmful slider (more overlap AND more
nodes on walls) -> cap at ~3 px or remove; link distance has no effect under Shelf -> drop; collide pad trades overlap for
wall contacts -> leave at 1.5. Only consistent lever on wall contacts: File Cluster Force up (rho -0.48 / -0.58 / -0.57).

Global (2 x 64 LHS samples + a 42-run candidate pass scored WITH folder separation + a quiet single-page run):
- Repel range is the lever: unlimited (default) leaves nodes at 1.2-1.5 px radius at fit on click / zod whatever the
  center force; a finite range of 850-1200 px doubles that. 500 px is too tight on larger repos (zod: folders merge, -9 %).
- Center force alone pulls FOLDERS together (folder overlap up); it only pays together with more repel + file cluster.
- Recommended defaults: center 0.08 · repel 450 · file cluster 0.36 · repel range 850 px; link 1, link distance 40,
  damping 0.3, collide pad 1.5 unchanged. Quiet run vs shipped defaults: click score -21 % (node 1.46 -> 2.94 px, folder
  boxes < 40 px 37 % -> 21 %, folder overlap 0.09 -> 0.02), express -10 % (3.6 -> 5.8 px, 70 % -> 0 %), zod -11 %
  (1.27 -> 2.94 px, 71 % -> 41 %). Settle is ~300 ticks for every tuple (fixed alpha schedule); quiet wall-clock 33 / 7 /
  47 s for the defaults and 37 / 8 / 46 s for the recommendation in headless software rendering.
- Runner-up (one slider): repel range 850 px only: -12 % / -12 % / -8 %.
- Remove from the Global box: folder repel + file repel (no effect in three sweeps), link distance (no score benefit, makes
  nodes smaller at fit, rho -0.38 .. -0.49). Damping and collide pad: no consistent effect - keep them advanced.
- The previously top-ranked compact samples (13, 18, 19) fall BELOW the defaults on click and zod once folder separation
  is scored (folder overlap 0.21 - 1.0) - ranking and eye agree now.
- F12 regression tuple on zod: responsive, settles, max |coordinate| 1 723 - 2 120 px (two runs).
