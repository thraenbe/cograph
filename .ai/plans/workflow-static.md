# Static Workflow Graph: plan (planner phase)

> **Status 2026-10-08: stopped by Bela (X5), not built. Keep this file as the starting point if
> the work resumes.** The AI Workflow Graph therefore stays in the product **parked, not fixed**:
> on most real repositories (request file over the CLI's 256KB Read limit, roughly 160–700
> functions and up) it still returns an empty model. Since 1.4.0, the guard from 26b7d3e
> (`generateWorkflow` validates the reply and merges only annotations) makes it fail visibly with
> an error, rather than replacing the user's graph.

Session-215, 2026-10-07. Bela chose **"Rework statically (new feature)"** for W1 and **"Fold into
1.4.0"** for W2. This plan rests on new measurements, taken across 11 corpus repos plus CoGraph.
Scripts, data and keyframes are in `.termi/briefs/workflow-eval/` (`diagnose.py`,
`static-v2.py`, `runs/`, `shots-v2/`, `shots-flow/`).

## Bottom line

**A static Workflow view can beat Shelf, but not as a whole-repo picture.** Two spikes laid out
every function in left-to-right columns, and both came out no better than Shelf. What does work
is a **flow rooted at one entry point**: "what runs when `requests.get` is called". It's a
layered call tree of 9–88 functions that reads left to right and matches the real runtime chain.
Shelf can't show this, and CoGraph has no transitive or trace view today.

There is one prerequisite, worth shipping on its own. **The JS/TS analyzers never resolve
`this.method()` calls.** Fixing one dead condition adds 11–77% internal edges to JS/TS graphs.
That improves Shelf for every JS/TS user, not just this view.

## 1. The spike was degenerate. Why

**Spike v1** (`static-derive.py`, 2026-09-29):
- entries = functions nobody calls
- stage = longest path on the SCC-condensed call graph
- cluster = folder
- tier = path regex
- every function placed in up to 8 columns

Results: express had 112 of 127 functions isolated, requests had 305 "entries", and CoGraph was
a 1 500-node hairball in columns.

I measured the causes (`diagnose.py`). It isn't the formula; it's the input and the framing.

| Cause | Evidence |
|---|---|
| **Tests dominate the graph.** v1 treated them as product code, so tests became the "entries" and most of the edges | Tests are 56–76% of all functions in 7 of 11 repos (express 72%, flask 71%, fastapi 76%, gson 67%) |
| **The product call graph is thin** | 0.2–1.3 internal edges per product function. 18–57% of product functions have no internal edge at all (express 79%) |
| **TS/JS `this.method()` is never resolved.** `scripts/analyze_ts.js:214` and `analyze_js.js:252` test `ts.isIdentifier(callee.expression) && text === 'this'`. In the TS AST `this` is a `ThisKeyword` token, so the condition is always false | `AnalyzerRunner.run → runWithRetry → runOnce → spawnAnalyzerProcess`: 0 of 3 links present. The one-token fix (scratch copy, not committed) gives axios +11%, CoGraph +12%, zod +24%, dayjs +58%, socket.io +77% internal edges, and that chain becomes 3/3 linked |
| **Runtime hops are function references, not calls** | axios `Axios.request → dispatchRequest` goes through `.call(this, …)`, `.bind(this)` and `promise.then(fn)`. CoGraph `activate → show` goes through a `registerCommand` callback. These are exactly the "dynamic edges" the AI was asked to invent |
| **"Uncalled" ≠ entry** | in-degree 0 picks up dunder hooks (`__exit__`, `__repr__`), callbacks and benchmarks' `main` |
| **A whole repo in columns is a hairball regardless of quality** | Even spike v2 (below) puts 250+ nodes in a column on CoGraph and socket.io (`shots-v2/cograph-L3.png`). The existing view also collapses unrevealed nodes into giant folder blobs (`shots-v2/flask-L0.png`) |
| Express is a special case | Its `app.handle = function` style is not captured as functions at all (19 product functions). That's an analyzer coverage gap, out of scope here |

**Spike v2** (`static-v2.py`):
- tests and examples excluded
- entries = `::MAIN::` targets + `main`/`activate` + a greedy set cover of drivers by downstream reach
- stage = BFS distance from the entries
- unreached functions inherit their file's median stage

Results:
- **Correct spine on Python and Java.** Golden runtime chains, written from knowledge of each
  project and not from the graph: flask 4/4 links, click 3/3, gson 2/2, requests 5/6.
- **JS/TS fails until the analyzer is fixed.** CoGraph 0/4 → 3/4 with the fix; axios 0/2.
- **The whole-repo picture is still not legible.** Only 13–68% of product functions are placed
  by reachability, and 17–59% of edges are same-column.

## 2. What works instead: a flow rooted at an entry

From one entry, do a BFS over product call edges. stage = hop distance, detail level = depth,
cluster = file. Measured reachable size (`shots-flow/`):

| Entry | ≤ 1 hop | ≤ 3 hops | all |
|---|---:|---:|---:|
| requests `get@api.py` | 3 | 28 | 66 |
| flask `wsgi_app@app.py` | 6 | 29 | 29 |
| click `main@core.py` | 12 | 70 | 88 |
| CoGraph `show@graphProvider.ts` (with the fix) | 28 | 75 | 82 |
| CoGraph `run@analyzerRunner.ts` (with the fix) | 2 | 13 | 14 |
| axios `request@Axios.js` (with the fix) | 2 | 9 | 22 |
| gson `toJson`, socket.io `emit`, zod `parse`, dayjs `format` | 3–9 | 9–11 | 9–11 |

Every flow fits on one screen. `shots-flow/requests-L9.png` reads as the actual sequence
`get → request → Session.request → prepare_request / send → resolve_redirects / get_adapter /
build_response → …`. `shots-flow/flask-L9.png` is flask's real dispatch chain. This is the
question "how does it run", answered from a starting point. Shelf answers "what is where".

### The design

- **Entry list.** Each candidate is ranked by downstream reach (how many functions it reaches):
  - `::MAIN::` targets
  - `main`/`activate`/CLI functions
  - `package.json` `main`/`bin`/`exports` files and Python `console_scripts` / `__main__.py`
  - the top drivers by reach

  Excluded: tests, examples, benchmarks and dunder hooks.
- **"Show flow from here"** on any function's context menu, plus the entry list when the view
  opens. The flow can start from any function, not just from entries.
- **Reference edges in the analyzers.** A function passed as an argument (`then(fn)`,
  `registerCommand(x, fn)`, `addEventListener(e, fn)`), or called via `.call`/`.apply`/`.bind`,
  becomes an edge. It's marked so the view can draw it dashed. Statically this is exact (the name
  resolves), and it replaces the AI's guessed "dynamic edges".

### How we'll know it's good before building it all (phase-1 gate, on the corpus)

| Gate | Today | Target |
|---|---|---|
| G1 golden-chain links present (22 links, 7 repos; express excluded as an analyzer gap) | 17/22 = 77% (with the `this` fix) | ≥ 20/22 after reference edges |
| G2 canonical entry among the top 10 detected entries | ~7/11 (misses: gson, axios, zod, socket.io partial) | ≥ 9/11 |
| G3 flow from the canonical entry at default depth (3) | 9–75 nodes | ≤ 80 everywhere |
| G4 task check: Bela, 10 min, Shelf vs flow on "what runs after `requests.get` calls `Session.request`?" and two others | — | flow faster or tied on all 3 |

If G1 or G2 miss after phase 1, I stop and report rather than build the view.

## 3. Same view, same 10 levels: what changes in the render path

This is a new derivation behind the existing Workflow view, not a new view. `deriveWorkflowView`
already takes `{stage, rank, cluster}` per node:
- stage = depth
- rank = BFS order
- cluster = file

The 10 slider levels become "reveal by depth". The spike rendered through the unchanged path.

Required fixes, all small:
- Hide the backend/frontend divider when there's no tier split (it is still drawn today,
  `shots-flow/requests-L9.png`).
- `Class.method` labels: `send` appears 4 times.
- Fit-to-view: the right column clips.
- Cap the size of collapsed file bubbles (`shots-flow/cograph-L4.png`).

The layout stays as it is (pinned columns + vertical force). One optional extra: order nodes
within a column by the average position of their parents (barycenter) to cut edge crossings,
~30 LOC in `startWorkflowSimulation`. That function is in `rendering.js`, a UX4-owned file, so it
needs coordinating.

## 4. What dies

- **The AI round trip:** `generateWorkflow`'s `invokeProvider` call. The whole graph is no longer
  written to `.cograph/.intelligence-request.json`, so the **256KB Read ceiling** and the
  **`maxTurns` / `maxBudgetUsd` / `timeoutMs` caps on this path** go too. Cost per use drops from
  $0.15–0.54 and 20–146 s to **0 and ~2 ms** (BFS over ≤ 1 500 product functions, measured).
- **The prompt:** `WORKFLOW_PROMPT`, `WORKFLOW_TASK`, `buildWorkflowPrompt`.
- **The markdown `text` the prompt asks for,** which is rendered nowhere since Chat's removal.
- **The reply handling:** `validateWorkflowModel`, `normalizeWorkflowModel`, and my own
  `mergeWorkflowAnnotations` / 26b7d3e guard. The guard only exists to survive an untrustworthy
  reply; with no reply, it has nothing to guard.
- **The persistence and the generating card:** `__workflow__.json` (derivation is instant, so
  there's nothing to persist), the "Generate / Generating… / Update" card states, and
  `workflowProgressDetail`.
- **The AI gate on this view.** It no longer needs `graphIntelligence.enabled`.
- **The AI-only metadata:** `isOutput`, edge `label`/`confidence`, `tier` + the divider (unless
  Bela wants a static tier; I recommend no, since it was a path regex or wrong), and issue #59.
- With Chat gone and this gone, the graph-echo provider pipeline (`WRAPPER_PROMPT`,
  `COGRAPH_SCHEMA`, `extractCographResult`, `invokeProvider`, `ClaudeCodeProvider.run`) has
  **zero users** and can be deleted. That's 214's call, as it owns the provider files. Annotate
  keeps its own `runJson` path.

## 5. Cost

| Phase | Work | Files (owner) | Estimate |
|---|---|---|---|
| 0 | `this` fix in both analyzers + tests; re-run `test-projects/measure-all.sh` to confirm Shelf perf with +11–77% edges; spot-check 30 new edges for precision | `scripts/analyze_ts.js`, `analyze_js.js` (shared, not in the ownership table) | 0.5–1 d. **Ships on its own** |
| 1 | Reference edges in the analyzers; entry detection (manifest + main + reach); derivation as a pure module; corpus gate G1–G3 | `scripts/*`, new `src/webview/workflowFlow.js` (mine) | 2 d, **then gate** |
| 2 | View wiring: entry list, "Show flow from here" context-menu item, depth = level, cluster = file, no divider, `Class.method` labels, fit fix; G4 with Bela | `workflow.js`, `main.js`, `controls.js`; the node context menu is in `rendering.js:632` / `frameRender.js:1320`, and the barycenter also lives in `rendering.js` (both **UX4**) | 2–3 d |
| 3 | Delete the AI path (§4), sidebar card → "Workflow" (opens the entry list), README/CHANGELOG | `graphProvider.ts`, `workflowPrompt.ts`, `sidebarProvider.ts` (shares the file with **214**) | 1 d |
| **Total** | | | **5.5–7 days**; net LOC roughly −450 / +400 |

Tests:
- unit tests for entry detection, BFS/depth, and reference edges, with fixtures per language
- the corpus gate as a script (not in `npm test`)
- uxtest scenario 95 rewritten to rooted flows (**181**)

## Risks

- **JS/TS recall stays the bottleneck.** If reference edges don't lift axios and CoGraph past
  G1, the view will mislead on exactly the stacks most users have. The gate is there to catch
  that.
- **The `this` fix changes every JS/TS user's Shelf graph** (more edges, possibly a few wrong
  ones from name narrowing), and with them the layout and perf. Phase 0 measures this before
  shipping.
- **Ownership:** the node context menu (`rendering.js`, `frameRender.js`) is UX4's, and
  `sidebarProvider.ts` is shared with 214. These need sequencing through 110, like the removal
  did.

## Out of scope

Express-style `obj.prop = function` capture (an analyzer coverage gap, worth its own ticket),
import-graph extraction (not needed: reference edges are the cheaper signal), a whole-repo
Workflow picture, and any AI labelling.

## Open product questions for Bela

1. **Rooted flow instead of a whole-repo picture?** The measurements say the whole-repo version
   is no better than Shelf. The rooted one answers "what runs when X is called".
2. **Ship the analyzer `this` fix first, on its own?** It changes JS/TS graphs in Shelf for
   everyone: +11–77% edges.
3. **Drop the backend/frontend divider and tier?** I recommend dropping them, since statically
   they were a path regex or wrong.
4. **Entry UX:** open on the top-ranked entry automatically, or always show the entry list first?
