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

`nodeOverlapPairs/Ratio` · `nodesOutsideSlot` / `nodesPokingOutOfSlot` / `nodesOutsideFrame` (B1)
· `nodesPinnedToWall` (B2) · `frameOverlapPairs` / `slotOverlapPairs` (R2, must be 0) ·
`edgeLenMean` / `edgeLenCv` · `edgeCrossingsPerEdge` (seeded sample) · `labelOverlapRatio`
(B6, R4) · `bboxAspect` · `inkRatio` · `viewportCoverage` · `domNodes` / `heapMB` (P7).
Pure functions in `metrics/compute.ts`, unit-tested in `unit/`.

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
  --no-compile        skip the automatic `npm run compile`
npm run uxtest:unit        pure-module unit tests (Playwright runner, no browser)
npm run uxtest:typecheck   tsc --noEmit over uxtest/
```

## Notes

- Wayland: Tier A is headless by default; `--headed` opens a Chromium window.
- Artifacts are never pruned automatically.
