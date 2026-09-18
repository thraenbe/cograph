# Plan — Feature 4: UX test suite (`uxtest`)

Session: uxtest (branch `termi/s180-2`, base `shelf-base` 9eda4c8) · Planner phase · 2026-09-18
Status: **awaiting approval — no feature code written.**

## Problem

Bela wants Claude to be able to open CoGraph on many different repositories, use every
feature, and record the session so the recording can be evaluated afterwards — to find bugs
and to find better force values. Today there is only the mocha/jsdom unit suite (no real
browser, no pixels, no layout) and a jsdom timing harness in `~/cograph/test-projects/measure.mjs`.
A video alone is weak evidence for force tuning, so every recorded step must also carry
**numeric layout metrics** and a keyframe.

## Constraints

- I own only: new top-level `uxtest/`, my npm scripts + devDeps in `package.json` (appended at
  the END of the lists), and my lines in `.vscodeignore` / `.gitignore`. **Zero edits under `src/`.**
- No webview test hooks. Everything is read from what already exists: the top-level `state`
  binding (reachable from `page.evaluate`), `window.perfReport`, the DOM/SVG, posted messages.
  Deliberately *not* reading `localSim` / scheduler internals — the perf session is about to move
  sims into a worker, and the ux session is about to change the panel.
- Machine: Wayland (+ XWayland, `DISPLAY=:0`), Node 22.22.1, `google-chrome`, no system
  ffmpeg / xvfb. Both stay optional: Playwright ships its own ffmpeg build for `recordVideo`
  (`npx playwright install chromium ffmpeg`, no sudo); keyframes are Playwright screenshots.
- AI is never called. Artifacts/caches are gitignored. Nothing in `uxtest/` ships in the .vsix.
- Merge order: I merge FIRST, and perf needs my Tier A harness early → thin slice is milestone 1.
- Files < 400 LOC, functions < 50 LOC, explicit async error handling, no `console.log`
  (a tiny structured logger `uxtest/lib/log.ts` writing JSON lines to stderr + `run.log`).

## Findings from exploration (what the design rests on)

1. `getWebviewHtml()` needs only `vscode.Uri.joinPath`, `webview.asWebviewUri`, `webview.cspSource`
   and `workspace.getConfiguration('cograph').get()`. The compiled `out/webviewHtmlBuilder.js`
   can be `require`d outside VS Code by stubbing the `vscode` module (a `Module._load` hook).
   → the lab serves the **real production HTML** (panel markup + script order never drift).
2. d3 comes from cdnjs under a nonce CSP. Instead of rewriting HTML, Playwright
   `page.route('https://cdnjs.cloudflare.com/**')` fulfils it from a local `d3@7.9.0` → HTML stays
   byte-identical, CSP stays valid, runs are offline + deterministic.
3. `acquireVsCodeApi` is stubbed with `page.addInitScript` (CDP-injected, not subject to CSP).
4. Host protocol is small. Webview→host: `navigate, expand-folder, parse-file, get-func-source,
   save-func-source, get-lib-description, save-graph, dirty-state, open-chat, open-docs,
   request-new-file, request-rename-folder, perf-report, retry-analysis, cancel-analysis`.
   Host→webview: `structure, graph, graph-patch, analysis-state, func-source, lib-description,
   git-update, reload-layout, clear-dirty, config, graph-loaded, save-request, timeline-data`.
5. `tsconfig.json` includes only `src/**`, the mocha glob is `out/test/suite/**`, ESLint runs on
   `src` → a top-level `uxtest/` is invisible to compile, `npm test`, lint and (after one
   `.vscodeignore` line) the package. `@playwright/test` transpiles TS itself → no build step.
6. Corpus sizes (from `test-projects/results`): requests 711 fns … django 33 103, pandas 32 764;
   guava = analyzer OOM (0 fns). Analysis takes 0.3–12 s per repo → cache it once.
7. Synthetic fixture is compiled to `out/test/fixtures/syntheticGraph.js` → 1k/3k/10k for free.
8. Rubric source: R1–R6, P1–P7, T1–T6, H1–H6 in `cograph-web/src/app/dev/testPlanData.ts`.

## Architecture

```
uxtest/
  README.md                 how to run, what each artifact is, Wayland/headed notes
  playwright.config.ts      projects: lab (chromium, video on), vscode (electron, workers=1)
  tsconfig.json             noEmit type-check only (npm run uxtest:typecheck)
  uxtest.config.json        corpus path, default repo set, viewport 1280x800, caps, score weights
  selectors.ts              THE one selector/param map (optional:true for ids ux will remove)
  harness/
    vscodeStub.ts           fake `vscode` module + fake webview → real getWebviewHtml()
    server.ts               127.0.0.1:<random> — /, /?timeline=1, /ext/src/webview/*, /vendor/d3
    hostBridge.ts           in-page acquireVsCodeApi stub (message log) + exposeBinding to node
    fakeHost.ts             scripted host replies (eager | lazy mode), save store, git fixture
  lib/
    analyze.ts              scanStructure + 5 analyzers + mergeGraph → .cache/<repo>-<sha>.json
    corpus.ts               repo resolution, size classes, synthetic 1k/3k/10k
    lab.ts                  openLab({repo, engine, motion, hostMode, headed}) → {page, host, ux}
    step.ts                 ux.step(caption, fn): caption → act → wait-still → png → metrics
    overlay.ts              visible cursor + click ripple + caption bar (pointer-events:none)
    still.ts                engine-agnostic settle detector (max node displacement per frame)
    fps.ts                  rAF-delta trace, long-frame count, DOM count, JS heap
    actions.ts              drag / wheel-zoom / slider-set / context-menu helpers (real mouse)
    log.ts                  structured logger
  metrics/
    collect.ts              in-page geometry snapshot (nodes, frames, slots, links, labels)
    compute.ts              PURE snapshot → metrics (unit-tested)
    score.ts                composite score + findings (invariant violations)
  scenarios/                one file per feature area (see checklist)
  sweep/
    sampler.ts              seeded latin-hypercube + grid (pure)
    run.ts                  force sweep driver
    analyze.ts              ranking, Spearman sensitivity, recommendation draft (pure)
    spaces/default.json     per-engine parameter ranges
  report/
    build.ts                run.json → static index.html (no deps, inline SVG sparklines)
    contactSheet.ts         sweep end-state grid
    rubric.md               R1–R6 / P1–P7 / T1–T6 → which step + metric is the evidence
    review-prompt.md        instructions for the reviewing Claude session
  vscode/                   Tier B (electron) fixtures + scenarios
  unit/                     node:test unit tests for every pure module
  .cache/  artifacts/       gitignored
```

### Tier A — webview lab

- **Page** = real HTML from `getWebviewHtml` served over localhost; d3 via route interception;
  `COGRAPH_CONFIG` comes from the stubbed `getConfiguration` (engine, motion, `perf:true`).
  Fallback if the stub ever breaks: regex-derive the script list from the builder source
  (still not hardcoded).
- **Fake host**: every posted message is logged (`run.json`), scripted replies:
  `get-func-source` → real file slice from the repo; `save-func-source` → in-memory ack (never
  writes to the corpus); `expand-folder`/`parse-file` → `analysis-state` + delayed `graph-patch`
  cut from the cached full graph; `save-graph` → stored payload + `clear-dirty`;
  `get-lib-description` → canned; the rest record-only. Two modes: **eager** (structure + full
  graph, like measure.mjs) and **lazy** (structure, patch per expand, then background graph) —
  lazy mirrors the real open flow incl. the spinner path.
- **Step DSL**: each `ux.step('Expand folder src/', …)` sets the on-page caption, performs the
  action with a real mouse, waits for stillness (bounded), takes `NN-slug.png`, collects a
  geometry snapshot + metrics, fps window, new console/page errors, and the video timestamp of
  the step (so the report can seek the video = "frame refs"). All into `run.json`.
- **Video**: Playwright `recordVideo` 1280×800 `.webm`, injected cursor + caption so the video
  explains itself. `--headed` for real-GPU fps numbers (headless numbers are only relative).
- **Layout metrics per step** (`compute.ts`, pure): node–node overlap count/ratio · nodes
  outside their slot · nodes outside their frame (B1) · nodes pinned to a frame wall (within ε,
  B2) · frame–frame and slot–slot overlap count (R2, must be 0) · intra-frame edge length
  mean / CV · sampled edge crossings (seeded, ≤ 2 000 edges) · visible-label overlap ratio (B6,
  R4) · bbox aspect + whitespace ratio · settle time ms + frames · collateral movement on drag
  (H4/T3: max displacement of nodes outside the dragged frame) · save→reload position delta (R5).
  Snapshots are stored too, so metrics can be recomputed later without re-running.
- **Assertion policy (needs a decision, see Q1)**: scenarios are *observational*. Hard fail only
  on page error / crash / missing non-optional selector / step timeout. Layout-invariant
  violations become **findings** with severity in `run.json`, not red tests — otherwise the
  known bugs B1/B2/B6 would make the suite permanently red. `--strict` turns findings into fails.

**Scenario files = the brief's checklist**
`00-smoke` (load → expand largest folder → engine × motion matrix) · `10-engine-motion`
(+`#layout-hint`, `config` message) · `20-detail` (`#slider-complexity` sweep 0→1) · `30-git-language`
(git fixture statuses, legend toggle, language swatches) · `40-folder-panel` (folder mode, 3
sliders, `#btn-more-forces`, folder filters) · `50-class-groupby` (class mode; File/Class/Connect
marked `optional` — skipped with a note once ux removes them) · `60-settings` (search + clear +
count, 5 toggles, display sliders, 3 global forces, reset layout) · `70-canvas` (pan, wheel zoom,
drag node, drag frame title, resize frame, expand/collapse folder + file, 3 context menus) ·
`80-popups` (func popup edit/save/resize/drag, library popup, Ctrl+F, Ctrl+S) · `90-timeline`
(timeline HTML + scripted `timeline-data`, transport) · `95-workflow` (levels 0–9, fixture from
the existing workflow tests) · `99-save-roundtrip` (v2 save → fresh page → `graph-loaded` →
delta; v1 payload → migration).

### Force sweep (`npm run uxtest:sweep`)
Seeded latin-hypercube (default 24 samples; grid for ≤ 2 params) over the force sliders ×
engine × repo, motion = dynamic (static is grid-placed, forces are no-ops). Values are set
**through the real sliders** (`input` events) so the production code path runs. Fresh page per
sample, sample 0 = current defaults (baseline), wait-still cap 20 s, metrics + end-state PNG, no
video unless `--video`. Default 2 workers (settle/fps get noisy when parallel; settle is also
reported in frames). Output: `sweep.csv`, `sweep.json`, `contact-sheet.html` (thumbnails ranked
by score), `force-recommendations.md` draft = top-3 per engine and repo size class, delta vs
defaults, per-parameter Spearman sensitivity. Weights live in `uxtest.config.json`.

### Tier B — real VS Code smoke (`npm run uxtest:vscode`)
Playwright `_electron.launch` on the `.vscode-test` VS Code 1.116.0 (path resolved with the
already-present `@vscode/test-electron`), args `--extensionDevelopmentPath`, fresh
`--user-data-dir` + `--extensions-dir`, `--disable-workspace-trust --skip-welcome
--skip-release-notes --disable-updates --disable-telemetry --password-store=basic`, pre-seeded
`settings.json` (`debug.perfLog:true`, AI gate off), `recordVideo`. Opens a **temp copy** of the
repo (the on-save test edits a file). 3 repos: click, express, zod. Serial, headed (windows pop
up on Wayland — documented; headless only if `xvfb-run` exists).
Why Playwright: it is what VS Code's own smoke tests use, gives video + trace + the same step
DSL/report as Tier A, and adds no second toolchain. `vscode-extension-tester` (Selenium,
ChromeDriver version pinning, no video) and `wdio-vscode-service` (WDIO stack, no native video)
are rejected; ExTester stays the documented fallback if webview frames turn out unreachable.
Drives: command palette (Visualize, Open/Reload, Save, Save As, Load Synthetic), activity-bar
sidebar (saved graphs, chat pane, AI-gate locked state, workflow card), webview via
`frameLocator('iframe.webview') → ('#active-frame')`, QuickPick/InputBox, editor navigation on
node click, on-save incremental re-parse. Bug hunts: B7 (poll panel alive for 15 s after open +
keep the CoGraph output-channel log from the user-data-dir), B1/B2 (Tier A metrics run inside
the real webview frame), B6.

### Evaluation (`npm run uxtest:report`)
One static `artifacts/<runId>/index.html`: per repo × scenario the video with a clickable step
list (seeks to the step), keyframes, metric table with deltas vs `--baseline <runId>`, findings,
console errors, `perfReport`, fps sparkline. `rubric.md` maps R1–R6 / P1–P7 / T1–T6 / H1–H6 to the
steps + metrics that evidence them; `review-prompt.md` tells a reviewing Claude session what to
read (PNG keyframes + JSON — no video decoding) and to emit `findings.md` (bug, severity, repo,
step + video timestamp, repro) and `force-recommendations.md`.

## Steps (milestones — each ends in a commit)

| # | Deliverable | Notes |
|---|-------------|-------|
| M0 | devDeps `@playwright/test`, `d3@7.9.0` (exact); scripts `uxtest`, `uxtest:sweep`, `uxtest:vscode`, `uxtest:report`, `uxtest:unit`, `uxtest:typecheck`, `uxtest:install`; `.vscodeignore` `uxtest/**`; `.gitignore` `uxtest/.cache/ uxtest/artifacts/ uxtest/test-results/` | lockfile changes; appended at end of lists |
| **M1** | **Thin slice for perf**: vscodeStub + server + hostBridge/fakeHost (eager) + analyze cache + lab.ts + step/overlay/still/fps + core metrics + `00-smoke` with video → `npm run uxtest -- --repo click --scenario smoke`. Then `msg` session-110: harness usable, `openLab()` API documented in README | target: first thing delivered |
| M2 | Full metric set + `score.ts` + unit tests (hand-built snapshots with known answers) | |
| M3 | Scenario breadth 10–99, lazy host mode, git/workflow/timeline/v1 fixtures, synthetic 1k/3k/10k | one commit per 2–3 scenarios |
| M4 | Sweep: sampler, driver, analysis, contact sheet | |
| M5 | Report builder, rubric, review prompt | |
| M6 | Tier B electron smoke (3 repos) + B7/B1/B2 hunts | highest technical risk, isolated last |
| M7 | Reviewer pass on my diff, `git merge main` (+ branches session-110 names), `npm test` green, CHANGELOG `[Unreleased]` entry, final report | |

## Test strategy

- **Unit** (`npm run uxtest:unit` = `node --test --experimental-test-coverage uxtest/unit`, Node
  ≥ 22.18 type-stripping, zero extra deps; ≥ 80 % on pure modules): `compute.ts` geometry
  (overlap, containment, crossings, label overlap with known answers), `score.ts`, `sampler.ts`
  (determinism, stratification), `sweep/analyze.ts` (ranking, Spearman), `report/build.ts`
  (fixture `run.json` → HTML contains steps/links), `vscodeStub` (HTML has every script the
  builder emits), **selector drift check** (every non-optional selector in `selectors.ts` exists
  in the real HTML, parsed with the existing jsdom devDep — runs in seconds, no browser).
- **Integration**: `00-smoke` on synthetic-1k is the harness self-test: known frame/slot
  geometry → frame overlap 0, all nodes inside slots in shelf+static. In-page `collect.ts`
  cannot be node-covered; it is validated here.
- **No external APIs** are touched (network fully blocked by `page.route` except localhost).
- `npm test` (mocha, 746) must stay untouched and green; uxtest is not added to CI (CI is
  Node 20 + no browsers) — noted as follow-up.

## Risks

| Risk | Mitigation |
|------|------------|
| ux/annotate/perf change ids and internals under me | single `selectors.ts` with `optional`; drift check; metrics read only `state.currentNodes`, `state.frames` rects and the DOM; stillness detector instead of sim alphas |
| `state.frames` shape changes (perf worker) | `collect.ts` has a DOM fallback (`.frame`, `.file-slot` bboxes + zoom transform) |
| Electron webview iframes not reachable / flaky on Wayland | M6 last + isolated; fallback = keyboard-driven run + screenshots + output log; ExTester documented |
| Headless fps/settle numbers not representative | report them as relative; `--headed`; settle also in frames; perf session can run headed |
| django/pandas (33k fns) too slow for full scenarios | size classes: large repos get smoke + canvas only, step timeouts, caps in config; guava reported as analyzer failure, not a crash |
| Artifact size (videos ≈ 5–20 MB each; full run maybe 0.5 GB) | default set = 5 repos; sweep without video; pruning is opt-in (`--keep N`) because of the never-delete rule |
| Playwright + d3 add to `package-lock.json` (shared file) | one early commit (M0) so others merge over it once |
| Sweep optimum overfits one repo | recommendations per size class across ≥ 3 repos + sensitivity table; final call stays human/Claude review |

## Files touched

New: everything under `uxtest/`, `.ai/plans/uxtest.md`.
Edited (small, appended): `package.json` (7 scripts, 2 devDeps), `package-lock.json`,
`.vscodeignore` (+1 line), `.gitignore` (+3 lines), `CHANGELOG.md` (`[Unreleased]`, 1 entry).
Not touched: `src/**`, `esbuild.js`, `tsconfig.json`, CI.

## Acceptance criteria

1. `npm run uxtest -- --repo click --scenario smoke` produces video, per-step PNG + metrics JSON
   and exits 0 on a machine without ffmpeg/xvfb (M1).
2. `npm run uxtest` runs the default 5 repos × all scenarios × both engines; every checklist
   item from the brief is exercised by a named step or reported as `skipped (selector absent)`.
3. `npm run uxtest:sweep` yields a ranked table, contact sheet and recommendation draft.
4. `npm run uxtest:vscode` opens real VS Code on 3 repos with video and drives the listed flows.
5. `npm run uxtest:report` yields one self-contained HTML per run + rubric + review prompt.
6. `npm test` still 746+ passing; `.vsix` contents unchanged (`vsce ls` has no `uxtest/`).

## Out of scope

- Any change under `src/` (incl. test hooks), fixing the bugs the suite finds, choosing the final
  force defaults (the suite recommends; ux/Bela decide).
- CI integration, visual-regression pixel diffing, cross-browser (Firefox/WebKit), Windows/macOS.
- Real AI calls; the opt-in fake-provider AI run is a later follow-up (needs a provider seam
  owned by annotate).
- Installing system packages (ffmpeg, xvfb).

## Open questions for Bela (via session-110)

- **Q1** Assertion policy: observational + findings, `--strict` opt-in (recommended) — or should
  invariant violations fail the run from day one?
- **Q2** OK to add `d3@7.9.0` as an exact-pinned devDependency (served locally in place of cdnjs)?
- **Q3** Artifact retention: keep everything (default, recommended) or auto-prune to the last N runs?
