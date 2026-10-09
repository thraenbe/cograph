# Workflow Graph review: keep, rework or remove?

Session-215, 2026-09-29, CoGraph v1.3.0 (`main` @ 1fc1156). This is the planner-phase deliverable.
No product code has been changed, and nothing gets deleted until Bela decides.

## Verdict

**Remove the AI Workflow Graph.** Don't rework it into a static derivation.

Over the last three months it has quietly stopped working. It can't produce a result on any repo
above roughly 300 functions, CoGraph itself included. On the two small repos where it did produce
a result, it damaged the user's graph. The one thing it adds over Shelf is topic clusters, and
those turn out to be folders under new names. The static rework doesn't rescue it either. On real
repos, call depth draws a hairball in columns, not "how the system runs". The question the feature
was meant to answer ("walk me through how this runs") is now better served by the MCP server
(session-214). The user's own agent reads the source and answers in prose, with no requirement to
echo back the whole graph.

## 1. Run it: measured on 6 repos + CoGraph

The runs used the real code path: `ClaudeCodeProvider.run(buildWorkflowPrompt(), …)` from `out/`,
then `normalizeWorkflowModel`, headless, with the product defaults (sonnet, 15 turns, $2 cap,
300 s timeout). Harness: `.termi/briefs/workflow-eval/run-workflow.js`. Raw stream logs and results
are in `.termi/briefs/workflow-eval/runs/`, and keyframes are in `…/shots/`.

| Repo (lang) | fns | request file | latency | cost | outcome |
|---|---:|---:|---:|---:|---|
| express (JS) | 127 | 48 KB | 118 s | $0.48 | "success", but **every node lost `name`/`file`/`line`**, so it rendered as grey unlabeled dots (`express-2-ai-L9.png`). 15 library nodes dropped |
| dayjs (JS) | 160 | 78 KB | 146 s | $0.54 | "success", but **86 of 120 edges deleted (72 %)**. 62 of 160 functions in a date library were labelled `frontend` |
| axios (JS/TS) | 696 | 298 KB | 41 s | $0.32 | **empty graph** |
| requests (Py) | 711 | 401 KB | 41 s | $0.26 | **empty graph** |
| socket.io (TS/JS) | 1 549 | 917 KB | 21 s | $0.16 | **empty graph** |
| CoGraph itself (TS/JS/Py) | 1 517 | 922 KB | 25 s | $0.17 | **empty graph** |
| gson (Java) | 3 437 | 2.25 MB | 20 s | $0.15 | **empty graph** |

**Usable result: 0 of 7.** Total spend was $2.08. All seven calls reported `subtype: success`.

### Why it fails

1. **It can't read its own input.** The provider writes the whole graph as a single-line JSON file
   (`.cograph/.intelligence-request.json`) and asks the model to `Read` it. From about 25k tokens
   (roughly 300 functions) the CLI's Read tool refuses the file, and `--permission-mode dontAsk`
   denies Bash. The model says so in its `text` ("I couldn't read the request, so I haven't done
   it") and returns `{nodes:[],edges:[]}`. This is the same pipeline Chat uses, so **Chat has the
   same ceiling.** That's worth telling session-214.
2. **The output contract doesn't scale.** The model has to echo every node and edge back. That
   cost about 170 output tokens per function (express 21.4k, dayjs 29.1k), so 1 500 functions would
   need about 250k output tokens in one reply. Fixing (1) alone would still fail on any mid-size
   repo.
3. **Nothing checks the result.** `validateWorkflowModel` exists and is unit-tested, but no
   production code calls it. `generateWorkflow` normalizes whatever comes back and **replaces
   `cachedGraph` with it**. It posts the result to the panel and persists it as a "ready" card, and
   the sidebar says "Workflow graph generated." On a real repo the user pays, waits, and gets a
   **blank canvas that also replaces their main graph** (`requests-2-ai-L9.png`) until the next
   reanalysis. On small repos the echo drops fields or edges, and that damaged graph is what's
   shown and saved.

### Does the picture teach anything that Shelf doesn't?

I compared the two successful runs (express, dayjs) against the Shelf view of the same repo
(`*-1-shelf-default.png`):

- **Topic clusters are folders.** 93 % (express) and 82 % (dayjs) of functions sit in an AI
  cluster that one folder dominates. Shelf's folder frames already show that grouping, with real
  names and no cost.
- **The tier split (backend/frontend) is either a path regex or wrong.** On express the AI tier
  matches a one-line path regex for 92 % of functions. On dayjs, a date library with no UI, the
  model labelled 62 of 160 functions `frontend` to fit the prompt's backend→frontend frame. 16 of
  the 20 corpus repos are libraries or servers where that frame means nothing.
- **Stages are not grounded in the code.** Their rank correlation with call depth is ρ = −0.04
  (express) and 0.19 (dayjs). On express, 112 of 127 functions have no internal edge at all, so
  the stages are narrative rather than structure.
- **The genuine extra:** the markdown summary (`runs/express.result.json` `text`) is a decent
  3-paragraph "how requests flow" walkthrough, and 7 dynamic edges were plausible (e.g.
  `tryRender → View`). That value is prose, and the view never shows it: `text` is saved to
  `__workflow__.json` and never displayed. Issue #59, filed by us, already lists
  tier/label/dynamic/isEntry as generated but never rendered.

## 2. The tax: code that exists only for this feature

| Area | Files | LOC (approx.) |
|---|---|---:|
| Prompt, validation, normalization | `graphIntelligence/workflowPrompt.ts` | 190 |
| Webview derivation (10 levels, columns) | `webview/workflow.js` | 139 |
| Sidebar: pinned card (3 states + locked), generate/open/persist, progress labels, CSS, card script | `sidebarProvider.ts` | ~230 |
| Host: `Workflow*Meta` types, `generateWorkflow`, `showWorkflowGraph` | `graphProvider.ts` | ~75 |
| Webview wiring: view-mode state machine branch, slider reinterpretation, fixed-column sim, divider layer, payload routing | `main.js` ~50, `rendering.js` ~55, `fileClusters.js` ~12, `controls.js` 6, `state.js` 5, `webviewHtmlBuilder.ts` 2 | ~130 |
| **Product total** | **10 files** | **~765** |
| Dedicated tests | `workflowModel`, `workflowDerive`, `graphProviderWorkflow` (34 tests) | 468 |
| Tests embedded in shared suites | `sidebarProvider.test.ts` (6 tests), `drilldown.test.ts` (5 tests) | ~160 |
| uxtest | `scenarios/95-workflow.spec.ts` + `workflowGraph` fixture | ~50 |
| **Test total** | | **~680** |

The recurring cost is structural, and it's larger than the LOC count suggests:

- **It's the only view that bypasses Shelf.** Workflow mode renders through the legacy global
  force path (`startWorkflowSimulation`), with its own `viewMode` branch in the state machine.
  Every Shelf or drill-down change has to keep the `viewMode !== 'workflow'` guards right. The git
  history has fixes for exactly that: `5c0ecc5` "route workflow graphs past the drill-down",
  `773978f` detail-slider state sync, and uxtest `fb0a89d` "workflow view not scored against stale
  frames".
- It repurposes the Detail slider (0..1 → 10 levels), a special case in `controls.js` and `main.js`.
- Chat is being replaced by MCP (session-214). The workflow graph would then be the **last user of
  the full-graph `provider.run` + echo contract** (`WRAPPER_PROMPT`, `COGRAPH_SCHEMA`,
  `extractCographResult`, `invokeProvider`), so keeping it means keeping that pipeline alive too.
- With Chat removed (session-214, 2026-10), the markdown `text` that the provider prompt still asks
  the model to write is **rendered nowhere** (`markdown.js` is deleted as dead code). Every run pays
  output tokens for a summary no one sees.

## 3. Overlap

| Workflow promise | Already covered by |
|---|---|
| "Make a big repo legible" | Shelf + folder frames + detail depth (1.2/1.3) |
| Topic grouping | Folder frames (the AI clusters match folders 82–93 % of the time) |
| "Show me one part" | Subgraphs (round 3) |
| "What does this function or file do" | Annotate (1.3), which is cached, incremental and shows its cost upfront |
| "How does this system run" | Nothing in the view. **MCP (session-214)** lets the user's own agent answer it with source access, in prose or mermaid |

## 4. Outward evidence

- **Usage:** we have **no telemetry** by design, so there is no usage data. GitHub: #22 (the
  original request, ours, closed when shipped) and #59 (ours, "metadata generated but unused").
  I found no external issue and no Marketplace review that mentions it.
- **Competitors** (from my knowledge, not verified in this session): repo-to-diagram AI tools
  (DeepWiki, GitDiagram, CodeViz and similar) and general agents that produce a mermaid flow on
  request have made "AI draws your architecture" a commodity. CoGraph's differentiator is the
  static, zero-config, exact graph. An AI view that silently returns empty or wrong graphs works
  against that pitch.

## 5. Options, costed

| Option | Work | Result | Per use | Keeps the tax? | Risk |
|---|---|---|---|---|---|
| **Keep as-is** | 0 | Broken above ~300 fns (all 5 of 5 tested), corrupts small ones | $0.15–0.54, 20–150 s | yes, all of it | ships a feature that wipes the user's graph; review risk |
| **Keep + fix** (send a compact id/name/file/edge list in chunks, return only an annotation map and merge it into the cached graph, call `validateWorkflowModel` and show the model's text on failure, render #59's fields) | ~3–4 days | Works on mid-size repos. The picture is still folders + a guessed tier split | ≥ $0.5, ≥ 2 min, scaling with size | yes, plus new chunking code | output quality stays arbitrary; frame doesn't fit libraries |
| **Rework to static** (spike: `static-derive.py`: entries = in-deg 0, stage = longest path on the SCC DAG, cluster = folder, tier = path regex) | spike 0.5 d; product ~4–6 d (new layered layout inside Shelf, entry heuristics, test filtering) | Runs in 2–70 ms, free, deterministic. **But** express: 112/127 functions isolated, 2 columns; requests: 305 "entries" (mostly tests); CoGraph: a 1 500-node hairball in 8 columns (`cograph-3-static-L9.png`) | free | yes, and the view grows | a new feature under an old name; call depth ≠ "how it runs" |
| **Remove** ✅ | ~0.5–1 day | −~765 product LOC, −~680 test LOC, one fewer `viewMode`, Detail slider back to one meaning | — | **no** | loses a README bullet and one of three AI features. Mitigated by MCP |

## 6. Removal plan (executes only after Bela approves)

**Delete:** `src/graphIntelligence/workflowPrompt.ts`, `src/webview/workflow.js`,
`src/test/suite/workflowModel.test.ts`, `workflowDerive.test.ts`, `graphProviderWorkflow.test.ts`.

**Edit:**
- `graphProvider.ts`: drop the `Workflow*Meta` types, the `workflow?` fields on
  node/edge/graph, `generateWorkflow` and `showWorkflowGraph`.
- `sidebarProvider.ts`: drop `WORKFLOW_FILE`, `workflowProgressDetail`, the
  `workflow-generate/update/open` cases, `_workflowMeta`, `_generateWorkflow`, `_postWorkflowStatus`,
  the card script and CSS, and the `workflow-status` handler. Keep a one-line filter so an existing
  `.cograph/__workflow__.json` is never listed as a saved graph.
- Webview: remove the `viewMode === 'workflow'` branches (`main.js`, `rendering.js`
  `startWorkflowSimulation`/divider layer, `fileClusters.js` `isWorkflowPayload`, `controls.js`,
  `state.js` fields) and the `workflow.js` script tag in `webviewHtmlBuilder.ts`.
- Tests: remove the workflow cases in `sidebarProvider.test.ts` and `drilldown.test.ts`.
  uxtest scenario 95 and its fixture belong to **uxtest (session-181)**, so ask them.
- **These files are owned by other sessions, so coordinate the edits:** `graphProvider.ts`,
  `sidebarProvider.ts` (MCP owns its chat parts), `rendering.js`, `main.js` (UX4).
- Docs: README feature bullet + the caps sentence ("Chat and the Workflow Graph…"), `package.json`
  `graphIntelligence.enabled` description, CHANGELOG `[Unreleased]` → "Removed: AI Workflow Graph
  (did not work above ~300 functions; superseded by Shelf + subgraphs and the MCP server)". No
  setting is retired; it had none of its own.
- Existing users: a stale `__workflow__.json` stays on disk, ignored and harmless. No migration.

**Acceptance:** full `npm test` green, `npm run uxtest -- --scenario smoke` green on 3 repos,
`grep -ri workflow src/` returns only the CI badge and the file filter, and the card is gone from
the sidebar.

## Open product questions for Bela

1. Remove (recommended), or keep and fix for about 3–4 days?
2. Should the **"how does it run"** walkthrough become an explicit MCP prompt/recipe (session-214),
   so the idea survives as an agent capability instead of a view?
3. The Chat ceiling in §1 (can't read its request above ~300 functions) is the same bug. Fix it,
   or leave it since Chat is going away?
