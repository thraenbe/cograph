# Task: AI "Annotate Graph" (feature 3 of the four-feature push)

Planner: session-178, 2026-09-18. Base: `shelf-base` (9eda4c8), branch `termi/s178`.
Status: **approved 2026-09-18, implemented. See "Outcome and deviations" at the end.**

## Problem

Folders and files in the graph carry only a name. To learn what `src/graphIntelligence/` or
`frameScheduler.js` is responsible for, the user has to open it. Bela wants every folder and
file to get a short AI summary of its responsibility, shown when hovering it.

Two things do not exist today and have to be built:

1. **No tooltip layer.** Hover only restyles nodes (`rendering.js` `onNodeMouseOver`,
   `onCloudMouseOver`) or sets a cursor (`folder.js` `onFileHoverMove` / `onFolderHoverMove`).
2. **No narrow AI call.** The only provider call is `run()`: whole graph in, whole graph out,
   with a write-capable CLI mode (`--permission-mode dontAsk` / `codex --full-auto`). That is the
   main cost and failure source and is the wrong tool for "give me 40 one-line summaries".

## Decisions already taken (Bela, relayed by session-110)

- Digest by default, source reading opt-in (`cograph.graphIntelligence.annotate.readSource`,
  default `false`). The setting text says what leaves the machine in each mode.

## Assumed, please confirm

- English summaries.
- Annotations are local only (`.cograph/` is gitignored), not committed.
- v1 covers files and folders only, no classes or functions.
- Own model setting with a cheap default (`haiku`; Codex: `gpt-5-mini`).
- A new third feature next to Chat and Workflow; Workflow is unchanged.
- Chat does not consume annotations in v1.
- (mine) Hover targets are headers, labels and collapsed glyphs at 300 ms, and the empty
  background of a file slot / file circle at 600 ms. Frame and folder-box bodies do not trigger
  a card, otherwise a card would pop up wherever the pointer rests. See "Hover UI".
- (mine) When a run stops at the budget, shallow paths were annotated first, so the top of the
  tree is always covered.

## Constraints

- Gate `cograph.graphIntelligence.enabled` on all three layers (webview, sidebar guard, host).
  Nothing reaches a provider before the user enables AI. The card must stay useful with AI off.
- Never auto-spend. File changes only mark summaries stale; the user clicks "Update (N stale)".
- Annotate never uses a write-capable CLI mode. Digest mode runs with no tools at all.
  readSource mode gets read-only tools (Claude: `Read`, `Grep`, `Glob`; Codex:
  `--sandbox read-only`). This is stricter than Chat and Workflow today.
- File ownership from `00-common.md`: I own `src/webview/hoverCard.js`,
  `src/graphIntelligence/annotat*.ts`, the annotation card in `sidebarProvider.ts`, the
  annotation messages in `graphProvider.ts`. I do not edit `rendering.js`, `frameRender.js`,
  `folder.js`, `drilldown.js`, `main.js`, `controls.js`, `analyzerRunner.ts`,
  `structureScanner.ts`. Shared files (`package.json`, `CHANGELOG.md`, script list in
  `webviewHtmlBuilder.ts`, `styles.css`) get small appends at the END of lists only.
- Repo standards: new code in new modules under 400 LOC, functions under 50 LOC, explicit async
  error handling, no `console.log`, structured logs to the output channel, 80 % coverage on new
  code, providers mocked.
- No schema change to `GraphData`, the graph cache or saved layouts.

## Design

### 1. Provider: a narrow JSON call

`GraphIntelligenceProvider` gets a second, optional method next to `run()`:

```ts
runJson?(req: JsonRequest, signal?: AbortSignal): Promise<JsonResult>;
// JsonRequest: { prompt, schema, workspaceRoot, model, maxTurns, maxBudgetUsd, tools: 'none' | 'read-only', onProgress? }
// JsonResult:  { data: unknown, usage?: { inputTokens, outputTokens, costUsd } }
```

- New `src/graphIntelligence/cliProcess.ts`: the spawn / timeout / abort (SIGTERM then SIGKILL) /
  `MAX_OUTPUT_BYTES` guard that both providers duplicate today. `runJson` uses it from the start.
  Moving the existing `run()` onto it is a **separate commit** guarded by the existing provider
  tests, so a regression there is easy to bisect and to drop.
- Claude: `-p <prompt> --output-format stream-json --verbose --model M --json-schema S
  --max-turns N --max-budget-usd B --no-session-persistence`, tools off in digest mode.
  The result comes from `structured_output`, with `tryParseWithRepair` as fallback.
  The prompt goes on the command line, so no request file is written for annotate.
- Codex: prompt-enforced JSON plus `jsonRepair`, `--sandbox read-only`. Codex reports no cost.
- **To verify in the executor phase before relying on it:** the exact flag that disables tools
  (`--tools ""` vs `--disallowedTools`), and whether `--system-prompt` cuts the fixed per-call
  overhead of the Claude Code default prompt. `codex` is not installed on this machine, so the
  Codex path is covered by mocked tests only; I will say so in the report.

### 2. Storage and staleness

`.cograph/annotations/annotations.json` — a subdirectory, because `_listCographFiles()` lists
every root `*.json` as a saved graph.

```json
{ "version": 1, "provider": "claude-code", "model": "haiku", "generatedAt": "...",
  "files":   { "src/cacheStore.ts": { "summary": "...", "role": "...", "hash": "<sha1>", "size": 3120, "mtimeMs": 1.7e12, "at": "..." } },
  "folders": { "src/graphIntelligence": { "summary": "...", "role": "...", "childrenHash": "<sha1>", "at": "..." } } }
```

- Keys are workspace-relative POSIX paths (`path.relative` then `split(path.sep).join('/')`),
  the root folder is `.`. The webview works with absolute paths; mapping happens in one place on
  each side.
- Atomic write (tmp + rename) like `cacheStore.writeCache`. Corrupt or wrong-version file is
  treated as empty, never thrown to the user.
- **Stale = content hash differs.** `size` + `mtimeMs` are stored only as a shortcut, the way the
  git index does it: if both match, skip hashing; if either differs, hash the bytes and compare.
  So a branch switch that flips mtimes costs one re-hash, not a re-annotation.
- Folder `childrenHash` = sha1 of the sorted `name + summary` of its direct children. A folder is
  stale iff a child summary changed or a child was added or removed.
- Hooks: `reparseAndPatch` already has the changed file list → re-check only those files and
  their ancestors, then re-post `annotations`. A full reconcile runs once after the graph is
  posted, off the critical path, so opening the panel is not slowed down.

### 3. Digest builder (what leaves the machine by default)

`GraphNode` has only `id, name, file, line, language, className`. There are no signatures,
imports or docstrings in the graph, and I may not touch the analyzers. So the digest is built
locally from the cached graph plus one read of each file:

- path, language, LOC
- functions and classes: names from the graph, signature = the source line at `node.line`,
  trimmed and clamped to 160 chars
- imports: library names from the file's `isLibraryEdge` edges, plus the internal files it calls
- leading comment or docstring: the first comment block, clamped to 300 chars
- never function bodies and never string literals

Clamped to ~1.2 kB per file. Files with no parsed functions still get a digest (path, LOC,
leading comment).

### 4. Generation

New `annotationRunner.ts`, pure planning separated from I/O:

- `planRun()` → which files and folders are missing or stale, batch count, rough token estimate.
  Used for the card's "before" state and for the confirm dialog.
- Files first, in batches of 40 digests (10 in readSource mode) → `{ relPath: {summary, role} }`.
  Ordered by depth then path. Up to 3 CLI calls in parallel.
- Then folders, deepest level first, batched per level, from child summaries and child names
  only. No source reads, in either mode. Levels are sequential because a parent needs its
  children's summaries.
- Persist after every batch, so a cancelled or crashed run resumes where it stopped.
- `normalizeAnnotations()` (pattern: `normalizeWorkflowModel`): drop paths that were not asked
  for, trim, collapse whitespace, clamp to 200 chars, strip control characters. A missing path
  stays "pending" and is retried once in the next batch, then left pending.
- Summary: one sentence, at most 25 words, "Responsible for ..." style. Optional `role` tag of
  3 to 5 words.
- Cancel via `AbortController` (pattern: `invokeProvider`).

**Per-run cost semantics** (today's caps are per request):

1. Estimate: "412 files, 58 folders, about 14 requests with haiku. Sends names and signatures
   only." → modal confirm. Nothing is sent before this.
2. Running total from `usage.costUsd` of every batch, shown on the card.
3. Stop before starting a batch once the total reaches `annotate.maxRunBudgetUsd` (default 2).
   What is done stays saved; the card shows "stopped at budget, N pending".
4. Each single call also gets a small `--max-budget-usd` so one runaway batch cannot eat the run.
5. Codex reports no cost: the run is capped by request count from the estimate and the card
   says "cost not reported by Codex".

New settings, appended at the end of `configuration.properties`:
`annotate.readSource` (false), `annotate.model` (haiku), `annotate.codex.model` (gpt-5-mini),
`annotate.maxRunBudgetUsd` (2). Setting text for `readSource`:
"Off: CoGraph sends file paths, function and class names with their signature lines, import
names and the leading comment of each file. On: the AI may additionally open and read your
source files (read-only) for better summaries."

### 5. Host wiring

- New `src/graphIntelligence/annotationService.ts` owns store + runner. `GraphProvider` holds one
  instance and gets only thin delegates: `annotate()`, `cancelAnnotate()`, `annotationStatus()`,
  one new webview message case `get-annotations`, and one call in `reparseAndPatch`.
- Message to the panel: `{ type: 'annotations', root, files, folders, stale: string[] }`.
  Sent on `get-annotations` (the webview asks when `hoverCard.js` loads, which removes any
  ordering race with `graph` / `structure`), after every batch, and after a staleness change.
  Annotations stay out of `GraphData` and out of `graph-patch`.
- Host gate like `graphProvider.ts` `generateWorkflow`: throw if AI is off.
- New command `cograph.annotateGraph` ("CoGraph: Annotate Graph") for discoverability.

### 6. Sidebar card

Pinned under the Workflow card, same lifecycle:

- locked: "Enable AI Features to annotate" → opens AI settings
- before: "Annotate graph · 412 files, 58 folders"
- generating: "120 / 412 files · $0.08 · Cancel", progress bar
- ready: "470 summaries" and, when needed, "12 stale → Update"

`sidebarProvider.ts` is already 1847 lines. The card's markup, CSS and client script live in a new
`src/graphIntelligence/annotationCard.ts` as exported strings; `sidebarProvider.ts` gets only the
interpolation points, three message cases (`annotate-generate`, `annotate-update`,
`annotate-cancel`) with the `_aiEnabled()` guard, and the status post.

### 7. Hover UI: `src/webview/hoverCard.js`

- **Event delegation, no edits in other sessions' files.** One `mouseover` / `mouseout` /
  `mousemove` listener on the `#graph` svg. The target is resolved with `closest()` and the d3
  datum of that element. This also survives the `ux` session's header change, because a new
  class is one more selector in one table:

  | Target | Selector | Path from datum |
  |---|---|---|
  | Shelf frame header | `.frame-tab`, `g.frame > .folder-bubble-titlebar`, `.folder-bubble-label` | `path` |
  | Shelf file slot | `g.file-slot` label, empty `rect.file-slot-shape` | `file` |
  | Collapsed glyphs (both engines) | node datum with `isFolderCluster` / `isFileCluster` | `_folderPath` / `_filePath` |
  | Global drill-down box, folder bubble | `g.folder-bubble` title bar and label | `folderPath` |
  | Global file circle | `.file-circle-label`, `.file-circle-subtitle`, empty `.file-circle-shape` | `filePath` |

- One HTML card element, created once. Opens after 300 ms (600 ms on backgrounds) if the pointer
  is still on the same target. Hides on mouse-out, `mousedown`, `wheel`, and Escape. Positioned
  with `transform`, clamped to the viewport, size read once per open, nothing read or written in
  tick paths. `pointer-events: none`, so it can never block a click or a drag.
- Content: name, relative path, summary, `role` tag, "outdated" badge when stale, static facts
  ("12 files · 85 functions · TypeScript, JavaScript") from `state.structureTree` and a lazily
  built per-file function count that is invalidated on `graph` / `graph-patch`.
- **Without annotations** the card shows the static facts plus "Generate AI summaries in the
  CoGraph sidebar". With AI off it shows the facts only. So the card is useful on its own and the
  gate stays honest.
- Summaries are model output and the digest contains repo text, so they are untrusted: rendered
  with `textContent` only, never `innerHTML`.
- Own `message` listener for `annotations`; `main.js` is not edited. Script added at the END of
  the list in `webviewHtmlBuilder.ts`; CSS as one delimited block at the END of `styles.css`
  using the existing theme tokens.

## Steps (one commit each)

1. `cliProcess.ts` + `runJson()` on both providers + tests.
2. Move existing `run()` onto `cliProcess.ts` (separate commit, existing tests must stay green).
3. `annotationTypes.ts`, `annotationStore.ts` (load, atomic save, hash, staleness) + tests.
4. `annotationDigest.ts` + tests.
5. `annotationPrompt.ts` (prompts, schemas, `normalizeAnnotations`) + tests.
6. `annotationRunner.ts` (plan, batch, concurrency, budget, resume, cancel) + tests.
7. `annotationService.ts`, `GraphProvider` delegates and messages, settings, command + tests.
8. `annotationCard.ts` + sidebar message cases + tests.
9. `hoverCard.js`, CSS block, script list entry + jsdom tests.
10. README ("Coming soon (Premium)" is wrong today) and CHANGELOG under `[Unreleased]`.
11. Reviewer pass on my own diff, `git merge main` plus the branches session-110 names,
    full `npm test`, then report.

## Files touched

New: `src/graphIntelligence/cliProcess.ts`, `annotationTypes.ts`, `annotationStore.ts`,
`annotationDigest.ts`, `annotationPrompt.ts`, `annotationRunner.ts`, `annotationService.ts`,
`annotationCard.ts`; `src/webview/hoverCard.js`; test suites `annotationStore`, `annotationDigest`,
`annotationPrompt`, `annotationRunner`, `annotationService`, `hoverCard`, `cliProcess`.

Edited, small: `provider.ts`, `claudeCodeProvider.ts`, `codexCliProvider.ts`, `graphProvider.ts`,
`sidebarProvider.ts`, `extension.ts` (command), `webviewHtmlBuilder.ts` (one script line),
`styles.css` (one block at the end), `package.json` (4 settings, 1 command, 1 activation event,
all appended), `README.md`, `CHANGELOG.md`, `sidebarProvider.test.ts`, `graphIntelligence.test.ts`.

No files deleted.

## Risks

| Risk | Mitigation |
|---|---|
| Fixed per-call overhead of the Claude Code CLI makes many small batches expensive | Batches of 40; verify `--system-prompt` and tools-off early in step 1; measure real cost on 2 corpus repos before finalising batch size and report the numbers |
| `ux` and `perf` change the DOM under the hover targets | Delegation plus one selector table; jsdom tests per target; re-check after merging `ux` |
| Hover card adds work to hot paths | No listeners in tick code, no layout reads outside card open, `pointer-events: none` |
| Refactoring `run()` onto the shared helper breaks Chat or Workflow | Separate commit, existing tests, droppable without affecting the feature |
| Model returns wrong or invented paths, or over-long text | `normalizeAnnotations`, schema, one retry, then "pending" |
| Prompt injection through comments in the digest | No tools in digest mode; read-only tools in readSource mode; output rendered as text and clamped |
| Hashing a very large repo on load | size + mtime shortcut, async after first paint, only changed files on re-parse |
| Codex path cannot be run here (`codex` not installed) | Mocked tests; stated plainly in the final report, not claimed as verified |
| Two sessions editing `package.json` / `CHANGELOG.md` | Appends at the end only |

## Test strategy

- Pure unit tests: digest builder (clamps, no bodies, files without functions), hash and
  staleness (mtime flip with same content is not stale; content change is; folder goes stale
  when a child summary changes; removed files are pruned), `normalizeAnnotations`, run planning,
  batching, resume after a partial run, budget stop, cancel.
- Provider tests with a fake `cliProcess`: argument lists per mode (no write-capable flag ever,
  tools off in digest mode), structured output, repair fallback, error and timeout.
- Service tests through `setProviderFactoryForTesting`: gate off → throws and nothing is spawned;
  `annotations` message posted after each batch; store written atomically.
- Sidebar tests: four card states, guard on all three annotate messages.
- jsdom tests for `hoverCard.js`: every row of the target table resolves to the right path, open
  delay, hide on mousedown / wheel / mouse-out, viewport clamp, stale badge, no-annotation and
  AI-off content, summary containing HTML is shown as text.
- Manual: generate on this repo and one corpus repo with haiku, note real cost and duration,
  check both engines, switch branch and back to confirm nothing goes stale.

## Acceptance criteria

- Hovering a folder or file in Shelf and in Global shows a card with name, path, static facts and,
  once generated, the AI summary. It never blocks clicks, drags or zoom.
- With AI disabled, no process is spawned from any entry point; the card still shows facts.
- Default mode sends no source bodies. `readSource` is off by default and its text says what
  leaves the machine.
- The user sees an estimate before anything is sent, a running cost during the run, and the run
  stops at the budget with partial results kept.
- Editing a file marks its summary and its ancestors' summaries "outdated" without spending.
  "Update" re-annotates only the stale paths.
- Deleting `.cograph/graph-cache.json` or saving a layout does not lose annotations.
- `npm test` green, 80 % coverage on new modules, new files under 400 LOC.

## Open questions for Bela

1. Free or Premium? The README still positions Graph Intelligence as Premium.
2. Should summaries follow the UI or repo language later, or stay English?
3. Share annotations through git later (saves teams the cost, but adds a merge surface)?
4. Should Chat get annotations as context in v2?
5. Function and class level annotations in v2?
6. Hover on empty file backgrounds at 600 ms: wanted, or labels and glyphs only?
7. May I add the missing host-side AI gate to `runGraphIntelligence` (Chat) while I am there?
   It is a two-line fix but it is outside this feature, so I will not do it unasked.

## Out of scope

Perf work, panel or forces restructure, folder visuals, Workflow changes, Chat changes, analyzer
changes, function and class annotations, sharing annotations, release and version bump.

---

## Outcome and deviations from the plan (executor + reviewer, 2026-09-19)

Decisions relayed after approval: Q1 free, Q6 yes (file backgrounds at 600 ms), Q7 yes as a
separate commit (`0fed4e4`). Q2 to Q5 are v2.

Deviations, all deliberate:

- **Prompt over stdin, not argv.** A 40-file batch is ~25 kB; Windows caps a command line at
  32 k characters. Nothing is written to disk either way.
- **The CLI's default context is dropped** (`--system-prompt`, `--strict-mcp-config`,
  `--disable-slash-commands`). Measured: the default prompt plus the user's MCP servers and
  skills cost $0.195 for one tiny haiku call; the lean call costs $0.005.
- **Extended thinking is off** for the narrow call (`MAX_THINKING_TOKENS=0`). It was ~4x the
  output tokens with no visible quality difference. Not an A/B on the same repo: this repo ran
  with thinking, express without.
- **`annotate-cancel` is not gated** on the AI setting: stopping a run must always work.
  Switching AI off mid-run cancels the run instead.
- **Digest fix found by a test:** a one-line function sent its body, because the digest took
  the whole declaration line. The line is now cut where the body starts (`11ddc28`).
- **Codex caveat, stated in the setting and the confirm dialog:** Codex has no tools-off
  switch, so even in digest mode the Codex CLI itself can read workspace files (read-only
  sandbox). Digest-only is a hard guarantee with Claude Code only.
- **Shelf file slots always use the 600 ms delay.** Their labels are `pointer-events: none`, so
  the pointer lands on the slot background. Folder headers and collapsed glyphs use 300 ms.

Real-cost test (haiku, total spend about $0.54, batch size 40 kept):

| Repo | Paths | Cost | Time | Pending | Thinking |
|---|---|---|---|---|---|
| this repo | 105 files + 8 folders | $0.248 | 181 s | 0 | on |
| express | 141 files + 41 folders | $0.092 | 69 s | 0 | off |

Coverage of the new modules under plain mocha + c8: 95.5 % lines, 88 % branches.

Left open, consciously:

- **Codex path is mock-tested only**; `codex` is not installed on this machine.
- ~~Partial graph.~~ **Closed 2026-09-19** (orchestrator follow-up): `GraphProvider` tracks its own
  background-parse state (first full pass and cache reconcile; cleared on result, failure,
  cancel and panel close). A run requested meanwhile waits ("Waiting for the code analysis to
  finish…", cancellable) and only then plans, shows the estimate and sends, so every digest has
  its symbols and the estimate is exact. No change to `analyzerRunner.ts`.
- ~~Not verified live.~~ **Closed 2026-09-21** after merging `termi/s111` (ux final, `895de09`):
  checked in real Chromium through the uxtest lab (`click`, Shelf, AI off). Frame tab → card
  after 300 ms ("src/ · src · 17 files · 579 functions · python"); file slot background → nothing
  at 350 ms, card after 600 ms ("test_arguments.py · tests/test_arguments.py · 78 functions ·
  python"); collapsed closed-folder glyph → card ("click/ · . · 79 files · 1773 functions ·
  python"). Card is `pointer-events: none`, stays inside the viewport, hides on mousedown and
  wheel, no console errors, webview posts `get-annotations` once. As built, `g.frame-tab` is
  `pointer-events: none` and the titlebar strip over it takes the hit, so the selector table
  needed no change. `uxtest --scenario smoke` on `click`: 1 passed, 0 errors. Still not seen
  inside an actual VS Code window (the lab serves the same webview HTML to Chromium).
- No timeout escalation to SIGKILL (SIGTERM only), as before the refactor.
