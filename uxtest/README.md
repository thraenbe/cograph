# uxtest — CoGraph UX test suite

Drives the **real CoGraph webview** on many repositories, records a self-explaining video,
and stores a keyframe + numeric layout metrics for every step, so a run can be evaluated
afterwards for bugs and for better force values. Nothing here ships in the `.vsix`, runs in
`npm test`, or touches `src/`.

```
npm run uxtest:install                       # once: Playwright Chromium + its own ffmpeg (no sudo)
npm run uxtest -- --repo click --scenario smoke
```

Output: `uxtest/artifacts/<runId>/<repo>/<scenario>-<engine>-<motion>/`

| File | What |
|------|------|
| `video.webm` | 1280×800 recording with a visible cursor and the step caption burnt into the page |
| `steps/NN-<slug>.png` | keyframe after the step settled |
| `steps/NN-<slug>.snapshot.json` | raw geometry (nodes, frames, slots, edges, label boxes) — re-scorable offline |
| `run.json` | steps (status, video offset, settle, fps window, metrics, console errors), every message the webview posted to the host, `perfReport()`, blocked network requests |
| `run.log` | structured JSON-lines log |

## How the lab works (Tier A)

- The page is the **production HTML**: `out/webviewHtmlBuilder.js` is loaded with a stubbed
  `vscode` module (`harness/vscodeStub.ts`), so panel markup, CSP and script order cannot drift.
- d3 is served from the pinned local `d3@7.9.0` by intercepting the cdnjs URL — the HTML is
  unchanged and the lab is fully offline (any other request is aborted and listed in `run.json`).
- `acquireVsCodeApi` is stubbed via `addInitScript`; `harness/fakeHost.ts` plays the extension
  host (`eager`: structure + full graph; `lazy`: structure, then a `graph-patch` per expanded
  folder). It never writes to the repo under test.
- Graph data comes from the real analyzers, cached per repo + commit in `uxtest/.cache/`.
  `synthetic-1k | synthetic-3k | synthetic-10k` use the deterministic test fixture.
- "Settled" is detected from node movement + zoom transform only (`lib/still.ts`), never from
  simulation internals — it keeps working when sims move into a worker.
- Headless fps / settle numbers are only comparable **relative to each other on one machine**.
  Use `--headed` for GPU-backed numbers.

## `openLab()` — programmatic API (used by every scenario; call it from any `*.spec.ts` under `uxtest/`)

```ts
import { openLab } from '../lib/lab';

const lab = await openLab({
  repo: 'click',            // corpus name | absolute path | 'synthetic-3k' | preloaded AnalyzedRepo
  engine: 'shelf',          // 'shelf' | 'global'            (default shelf)
  motion: 'dynamic',        // 'dynamic' | 'static'          (default static)
  hostMode: 'eager',        // 'eager' | 'lazy'
  scenario: 'perf-baseline',// names the output folder
  headed: false, video: true, theme: 'dark', keepSnapshots: true,
  // browser,               // pass Playwright's `browser` fixture inside a test; omit to self-launch
});
await lab.ux.step('Expand everything', async () => { /* drive lab.page with real input */ });
const tick = await lab.page.evaluate('perfReport()');   // webview globals are reachable by name
await lab.post({ type: 'config', defaultEngine: 'global' }); // any host→webview message
const run = await lab.close();                          // writes run.json + video.webm
```

`lab.ux.step(name, action, { settle?, metrics?, stillTimeoutMs? })` returns the `StepRecord`
(`still.ms`/`still.frames` = time-to-still, `fps` = rAF window, `metrics` = layout metrics).
Throw `SkipStep` to mark a step skipped. Helpers with real mouse input live in `lib/actions.ts`
(`clickSel`, `setSlider`, `clickNode`, `dragBy`, `wheelZoom`, `fitToView`). A measurement
example (time-to-still, fps, `perfReport()` per engine → `baseline.json`):
`npm run uxtest -- --project examples --repo synthetic-3k` (`examples/baseline.spec.ts`).

## Layout metrics (per step)

Layout invariants are computed from webview STATE (`state.currentNodes` ∩ `getVisibleNodeIds()`, `state.frames`, the
engines' link lists — the perf branch detaches culled frames / LOD layers from the DOM); legibility is measured on the DOM.

`nodeOverlapPairs/Ratio` · `nodesOutsideSlot` / `nodesPokingOutOfSlot` / `nodesOutsideFrame` (B1)
· `nodesPinnedToWall` (B2) · `frameOverlapPairs` / `slotOverlapPairs` (R2, must be 0) ·
`edgeLenMean` / `edgeLenCv` · `edgeCrossingsPerEdge` (seeded sample) · `labelOverlapRatio`
(B6, R4) · `bboxAspect` · `inkRatio` · `viewportCoverage` · `nodePxMedian` / `labelPxMedian` / `smallBoxShare` (legibility at the
current zoom — meaningful on fitted steps) · `domNodes` / `heapMB` (P7). Per step also `still.firstMoveMs` (time to first motion).
Pure functions in `metrics/compute.ts`, unit-tested in `unit/`.

## Scenarios (Tier A, `uxtest/scenarios/`)

| file | covers |
|------|--------|
| `00-smoke` | C1/C2/C3 checkpoints, engine × motion walk (the harness self-check and the F1/F2 regression) |
| `10-engine-motion` | every toggle, `#layout-hint`, live `config` message, switching engines mid-settle (F3) |
| `20-detail` | Detail slider 0 → 1 → 0 |
| `30-git-language` | git panel + `git-update`, legend, language swatches |
| `40-folder-panel` | folder mode, every force slider incl. the ux "show more forces" set, folder filters via context menu |
| `45-force-reheat` | Shelf+Dynamic: a force change must move the layout, promptly, also after a Detail re-render (F13 / F7) |
| `50-class-groupby` | class overlay; group-by lens (optional — removed by ux) |
| `60-settings` | search / Ctrl+F / clear / count, filter toggles, display sliders, global forces, reset |
| `70-canvas` | pan, zoom, drag node, drag folder, resize frame, context menus — with collateral-movement check (H4) and hover-overlay churn under a resting pointer (F10) |
| `75-lazy-expand` | lazy host: skeleton → `expand-folder` → `graph-patch` → background graph keeps the drill-down |
| `80-popups` | function popup (drag, resize, edit + Ctrl+S, close, Escape), navigate fallback, libraries (F5), `save-request` |
| `85-hover-card` | annotate's hover card (optional; canned `annotations`, AI off) |
| `90-timeline` | timeline HTML + `timeline-data`, transport |
| `95-workflow` | workflow graph, levels 0–9, back to folders |
| `99-save-roundtrip` | v2 save → fresh panel → `graph-loaded` delta (R5), v1 payload migration |

Policy: **observational**. Only a failed step fails the test. Product problems become *findings* in `run.json`
(`findings[]` per step: rule, severity, ref to B1/B2/B6/R2/H4…); a scenario reports its own with `StepFinding`.
`--strict` makes high-severity findings fail the run.

## Force sweep

```
npm run uxtest:sweep                                  # spaces/default.json: click, express, zod × both engines × 12 LHS samples + defaults
npm run uxtest:sweep -- --repo flask --engine shelf --samples 24 --space my-space.json [--video]
```
Forces are set through the real sliders in Dynamic motion from a fresh page; sample 0 is always the shipped
defaults. Sliders that do not exist / are hidden in the UI under test are dropped and listed. Output in the run
folder: `sweep.csv`, `sweep.json`, `contact-sheet.html` (end states ranked by score), `force-recommendations.md`
(top 5 per repo, consensus candidate per engine, Spearman sensitivity per force). Score = `metrics/score.ts`.

## Report

```
npm run uxtest:report                                 # newest run
npm run uxtest:report -- --run-id <id> --baseline <olderRunId>
node uxtest/report/summary.mjs [runId]                # terminal summary
```
`index.html`: findings by rule, repo × scenario matrix, per recording the video with **clickable steps that seek
the video**, keyframes, metrics (with deltas against the baseline run), console errors, `perfReport()`.
`findings.json` + `report/rubric.md` + `report/review-prompt.md` are the inputs for a reviewing Claude session,
which writes `findings.md` and `force-recommendations.md`.

## Other checkouts

`--ext-root <dir>` runs the identical suite against another CoGraph worktree/branch (its `out/` + `src/webview`),
read-only with `--no-compile`. That is how a feature branch is regression-checked before it merges.

## Tier B — real VS Code (`npm run uxtest:vscode -- --repo click`)

Playwright `_electron` launches the pinned test build (VS Code 1.116.0 from `.vscode-test`, a sibling worktree's
copy, `$UXTEST_VSCODE`, or a download) with `--extensionDevelopmentPath`, a throw-away user-data dir
(`cograph.debug.perfLog` on, AI gate off) and a **temp copy** of the repo. Headed: a window opens and takes focus
(Wayland/XWayland; no xvfb needed) — do not run it while someone works on the display. Steps: command palette →
Visualize (T_first / T_functions), panel alive after 15 s (B7), metrics inside the real webview frame, engine /
motion toggles, source popup from the real host, Ctrl+S keybinding + InputBox, sidebar view, on-save incremental
re-parse, Open or Reload Layout. The CoGraph output channel + exthost log are saved as `vscode-output.log`.
`--scenario cold-open` (`vscode/cold-open.spec.ts`) launches N fresh profiles (`UXTEST_COLD_ATTEMPTS`, default 5), runs
Visualize immediately and flags `blank-graph-on-cold-open` (F11) / `panel-vanished` (B7) on video.
Gotchas baked into the driver: Electron pages get an explicit default timeout; `frame.evaluate` on a webview hidden behind
another editor tab never answers, so every frame probe is time-boxed; a stuck quit is killed after 20 s.

## Selectors

Every id lives in `selectors.ts`. `optional: true` entries are skipped (not failed) when absent,
which is how the suite stays green across the ux panel restructure.

## CLI

```
npm run uxtest -- [flags]
  --repo a,b,c        repos (corpus names, paths, synthetic-1k|3k|10k); default set in uxtest.config.json
  --all-repos         default + large repos
  --scenario <name>   file-name filter, e.g. smoke
  --engine shelf|global     --motion static|dynamic      narrow the matrix
  --headed            show the browser (real GPU fps)
  --strict            findings fail the run (default: observational)
  --workers N         parallel workers (default 2)
  --corpus <dir>      corpus root (default ~/cograph/test-projects)
  --ext-root <dir>    run against ANOTHER CoGraph checkout/worktree (its out/ + src/webview)
  --reanalyze         ignore the analyzer cache
  --run-id <id>       artifacts folder name (default: timestamp)
  --no-compile        skip the automatic `npm run compile` (and `bundle` for Tier B)
  --project <name>    lab (default) | sweep | report | vscode | examples | unit
  --samples N --space <json> --video      sweep options
  --baseline <runId>  report: show metric deltas against another run
npm run uxtest:unit        pure-module unit tests (Playwright runner, no browser)
npm run uxtest:typecheck   tsc --noEmit over uxtest/
```

## Notes

- Wayland: Tier A is headless by default; `--headed` opens a Chromium window.
- Artifacts are never pruned automatically.
