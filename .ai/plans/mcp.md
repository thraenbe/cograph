# Task: CoGraph MCP server (replaces the in-extension Chat)

Planner: session-214, 2026-09-29. Base: `main` @ 1fc1156, branch `termi/s214`.
Status: **steps 0-5 implemented (2026-10-07), cache-only v1.** Bela: M1 six tools, M3 remove Chat, M4 MIT, M5 follow-up release (npm and headless deferred). See "Outcome and deviations" at the end.

## Problem

CoGraph hosts its own Chat (`sidebar-chat.js` + chat plumbing in `sidebarProvider.ts` +
`chatStore.ts`). It shells out to the user's Claude Code / Codex CLI, pastes the **whole graph**
into the prompt and gets a whole graph back. That puts CoGraph in the wrong position: it runs a
second, weaker chat window next to the agent the developer already uses, and it pays for every
turn in tokens and in failure modes (write-capable CLI mode, budget caps, JSON repair).

The right shape is the reverse. The agent the developer already works in (Claude Code, Claude
Desktop, Cursor, Copilot agent mode) calls CoGraph as a **tool**. CoGraph answers from the call
graph it already computed, which is exactly what grep cannot give an agent: who calls this, what
does this reach, what breaks if I change it.

## What exists today (verified in this worktree)

| Piece | Where | Used by |
|---|---|---|
| Chat UI | `src/webview/sidebar-chat.js` (613 LOC) | Chat only |
| Chat host plumbing | `sidebarProvider.ts` cases `chat-*` (lines 143-254, 357-377), history push 396-423, HTML/script tag ~713, ~20 more chat references | Chat only |
| Chat persistence | `src/graphIntelligence/chatStore.ts` (158 LOC), files at `.cograph/chats/<key>.json` | Chat only |
| `GraphProvider.runGraphIntelligence()` | `graphProvider.ts:1074` | Chat only |
| `provider.run()` (graph in / graph out, session resume) | `claudeCodeProvider.ts`, `codexCliProvider.ts`, via `invokeProvider()` `graphProvider.ts:1132` | **Chat and Workflow Graph** |
| `provider.runJson()` | same two files | Annotate |
| `cliProcess.ts`, `progressParser.ts`, `jsonRepair.ts` | | all three |
| Settings `graphIntelligence.{model,effort,maxTurns,maxBudgetUsd}` | read in `invokeProvider()` | **Chat and Workflow** |
| `graphIntelligence.{enabled,provider,timeoutMs}` | | all three |

Consequences:
- **No setting becomes dead by removing Chat alone.** `model/effort/maxTurns/maxBudgetUsd` die
  only if session-215 also drops the Workflow Graph. Same for `provider.run()` and the
  `sessionId` resume path: they stay while Workflow uses them.
- `ChatStore` is constructed in `extension.ts:13` and passed into `SidebarProvider`.

Graph data available to the server without VS Code:
- `.cograph/graph-cache.json` (`cacheStore.ts`, no vscode import): `{schemaVersion, savedAt,
  manifest{absPath: mtimeMs}, graph{nodes, edges, files}}`. Measured: click 1968 nodes /
  3752 edges / 1.1 MB; fmt 5171 nodes / 30152 edges / 6.6 MB. JSON.parse of 6.6 MB is well
  under 100 ms, so load-on-start plus an mtime check per call is enough.
- Node ids are `"<absPath>::<name>::<line>"`, library nodes `"library::<lib>::<name>"`. Nodes
  carry `name, file, line, language, className?, classExtends?` but **no end line and no
  signature**.
- `.cograph/annotations/annotations.json` (`annotationStore.ts`, no vscode import): per-file and
  per-folder summaries keyed by workspace-relative POSIX paths.
- `scanStructure(root)` (`structureScanner.ts`, no vscode import) gives the folder tree and the
  file list that `loadCache()` needs to report staleness.
- The analyzers are plain `node scripts/analyze_*.js <root>` / `python analyze.py <root>`
  subprocesses. Only `AnalyzerRunner` couples them to vscode (extension path, Python
  interpreter lookup via the Python extension, config).

## Decisions I recommend (Bela decides the ones marked PRODUCT)

### D1. Tool set: six tools, not nine (PRODUCT: confirm the set)

Principle: every tool must answer something an agent cannot get from grep + reading files in one
step, and every result must be readable as plain text without a picture.

| Tool | Input | Returns | Why it earns a slot |
|---|---|---|---|
| `find_symbol` | `query` (name, `Class.method`, or `path:name`), `path?` (folder filter), `limit=20` | matching functions: id, `file:line`, class, language, caller/callee counts | entry point: turns a name the agent saw into stable ids. Replaces both `list_functions` and `get_function` lookup. |
| `get_symbol` | `id`, `includeSource=true`, `maxLines=80` | location, class/extends, signature + leading docstring + capped source slice (via session-216's `src/funcBrief.ts`), direct callers and callees (names + ids, capped at 25 each) | one call gives the agent the function plus its immediate neighbourhood |
| `callers` | `id`, `depth=1` (max 5), `limit=50` | tree of who calls it, grouped by depth, with `file:line` | the core thing grep cannot do reliably (dynamic names, same-name methods) |
| `callees` | `id`, `depth=1` (max 5), `limit=50`, `includeLibraries=false` | tree of what it calls | "what does this reach" |
| `impact` | `id` **or** `path` (file / folder), `limit=100` | transitive callers of everything in scope, grouped by file, with counts, plus which entry points / tests are hit | "what breaks if I change this". Highest-value tool for an agent about to edit. |
| `overview` | `path?` (default root), `depth=2` | languages + counts, folder tree with per-folder function counts and **the annotation summary if one exists**, entry points (no callers), hot spots (most callers), cache age + staleness | orientation; folds `folder_summary` and `project_overview` into one |

Dropped from the brief's list, and why:
- `path_between(a, b)`: niche, expensive on dense graphs (fmt has 30k edges), and an agent gets
  90 % of it from `callees(a, depth=3)`. Easy to add in a later release if people ask.
- `list_functions`: an unbounded list is useless to an agent; `find_symbol` + `overview` cover it.
- `folder_summary`: folded into `overview(path)`.

Output contract (all tools):
- **Stable, agent-friendly ids.** The cache ids contain absolute paths and line numbers, which
  shift on every edit. The server exposes `<relPath>::<Class.>name` and only appends `:<line>` when
  that is ambiguous in the file. Lookup also accepts the raw cache id. Ids are resolved against the
  current cache on every call, so an id from a previous call keeps working after the file changes,
  as long as the function still exists under that name.
- **Bounded.** Every list has `limit` (default shown above, hard max 200) and says
  `"… 143 more, raise limit or narrow path"` when truncated. Hard cap ~20 kB text per result.
- **Text first.** Each result is compact Markdown-ish text an agent can read directly
  (`src/a.ts:42  parseConfig  ← 3 callers`). Also returned as `structuredContent` with an
  `outputSchema` for clients that use it (the spec says a tool with structured output SHOULD also return the text block).
- **Honest about gaps.** Every result ends with a one-line footer: cache age, and
  `"stale: 4 files changed since analysis"` when the manifest says so. Calls through dynamic
  dispatch / reflection are invisible to static analysis; the tool descriptions say so, so the
  agent does not over-trust an empty `callers` result.
- **Read-only.** No tool writes anything. Tool annotations: `readOnlyHint: true`,
  `openWorldHint: false`.

### D2. Where it runs: (c) both, with (a) as the product (PRODUCT: confirm; npm is BLOCKED, see below)

- **(a) Standalone stdio server** `dist/mcp/server.js`, built by esbuild as its own self-contained
  CJS bundle (like the analyzer bundles; `@modelcontextprotocol/sdk` + `zod` inlined, no
  `vscode` import). Invocation: `node server.js --workspace <root>` (default: cwd).
  - **Bundled path, which works without npm and is the v1 default.** The installed extension's
    `dist/mcp/server.js` changes path with every extension version
    (`…/extensions/thraenbe.cograph-<version>/`). So on every activation the extension copies the
    bundle to a stable per-user location under its `globalStorageUri`
    (`<globalStorage>/thraenbe.cograph/mcp/server.js`). Every snippet below points there, and
    an extension update refreshes the file in place.
  - **npm package: BLOCKED on a name (M2), not just on Bela's permission.** Session-183 found the
    conflict and session-110 checked it against the registry on 2026-10-06:
    - npm `cograph` is taken by another project ("Cograph SDK and CLI").
    - npm `cograph-mcp` is taken by "Onta (formerly Cograph) MCP server", which is another
      project's MCP server for AI agents.
    - `github.com/cograph` is an existing user account, so an `@cograph` scope cannot be backed
      by a matching GitHub org.

    A README line telling users to run that package by name would download and run **their**
    server. The name is Bela's call, and it is a positioning question as much as a packaging one.
    This plan proposes no name. Until one exists, (a) ships only as the bundled path.
- **(b) VS Code registration** via the MCP server definition provider API: one-click for VS Code
  users (Copilot agent mode picks it up with no config). It needs VS Code **1.101+**; our floor is
  `^1.75.0`. **I recommend a guarded optional registration, not a floor bump.** The **runtime
  guard** is what actually protects the floor:
  `typeof (vscode as any).lm?.registerMcpServerDefinitionProvider === 'function'`, and a no-op on
  older hosts.

  *Typings (corrected by session-110, then measured).* `package.json` declares
  `@types/vscode ^1.64.0`, but the caret resolves to **1.109.0**, which already contains the MCP
  API. So today the compiler checks against 1.109, while the extension claims to run on 1.75.
  Nothing catches a post-1.75 API used by accident. That hazard predates this plan. vsce compares
  the *declared* range (`package.js:960`, then `validation.js:115`), so declaring `^1.101.0`
  against engines `^1.75.0` would fail packaging.

  *Measurement, 2026-09-29.* I ran `npm i -D --no-save @types/vscode@1.75.0` and then
  `tsc -p ./` in this worktree:
  - It produced **0 errors in 0 files**. The whole codebase is already 1.75-clean.
  - Negative control: with 1.75 typings, a probe `vscode.lm.registerMcpServerDefinitionProvider`
    fails with `TS2339: Property 'lm' does not exist`. So pinning really does enforce the floor.

  I restored the typings with `npm ci`; `package.json` is unchanged.

  *Recommendation.* Pin `@types/vscode` to `~1.75.0` (session-110 to take to Bela). Then the
  compiler enforces the floor. The small local interface for the three API shapes in
  `src/mcp/vscodeRegistration.ts` becomes genuinely necessary: it is the one sanctioned place
  that reaches past 1.75, always behind the runtime guard. The server runs on VS Code's own Node (`process.execPath` +
  `ELECTRON_RUN_AS_NODE=1`), so the user needs no Node install. API facts are below.

  **VS Code API (checked 2026-09-29 against code.visualstudio.com/api/extension-guides/ai/mcp,
  the 1.101 release notes and the `@types/vscode` 1.100/1.101/1.138 typings):**
  - The call is `vscode.lm.registerMcpServerDefinitionProvider(id, provider): Disposable`.
  - The provider has `provideMcpServerDefinitions(token)`, plus optional
    `resolveMcpServerDefinition(server, token)` and `onDidChangeMcpServerDefinitions`.
  - The manifest contribution is `contributes.mcpServerDefinitionProviders: [{ id, label }]`, and
    its `id` must match the one passed to register. Older hosts should ignore an unknown
    contribution point. That is unverified, so a 1.75 activation test covers it.
  - The constructor is `new vscode.McpStdioServerDefinition(label, command, args?, env?, version?)`,
    and `cwd` is set as a property afterwards.
  - The API first appears in stable `@types/vscode@1.101.0` and is absent from 1.100.0. The
    release notes never say "finalized", so 1.101 is inferred from the typings.
  - We use `onDidChangeMcpServerDefinitions` to re-offer the server when the workspace folder
    changes.

  **SDK:** `@modelcontextprotocol/sdk` 1.31.0 (MIT, Node >= 18, peer `zod ^3.25 || ^4`). It ships
  a CJS build, so esbuild can bundle it to CJS. An SDK v2 exists as split packages at 2.2.0 and
  needs Node >= 20. I plan to use v1.31 (`McpServer` + `StdioServerTransport`, `registerTool` with
  raw zod shapes, `outputSchema` + `structuredContent` + a text block per the spec) because it
  runs on older Node too. The MCP spec is at 2026-07-28, while SDK 1.31 negotiates up to
  2025-11-25. That is fine for tools-only.

  **Result size:** Claude Code warns at 10k tokens and caps MCP results at 25k tokens by default
  (`MAX_MCP_OUTPUT_TOKENS`). Our ~20 kB hard cap (~5k tokens) stays well inside that.
- **Claude Code in the integrated terminal is the most common case** and needs neither (b) nor
  npm. The setup command (D4) writes or copies a config that points at the bundled server.

### D3. Freshness: trust the cache, report its age, re-analyze on request (PRODUCT: confirm)

- On every call: `stat` the cache file; reload if its mtime changed (the extension rewrites it
  after every analysis and incremental re-parse, so an open VS Code keeps the server fresh for
  free).
- Staleness: run `loadCache(root, scanStructure(root))` (already diffs the mtime manifest), at
  most once every 5 s, and put `changed/removed` counts in the result footer.
- No cache at all: v1 answers `"No CoGraph analysis for this workspace yet. Open it in VS Code
  with CoGraph, or call overview with reanalyze=true"`.
- `reanalyze=true` on `overview` (step 6, optional in v1): runs the analyzer scripts headlessly
  and writes the cache. Needs a vscode-free core split out of `AnalyzerRunner`. That file is not
  in my ownership list, so I would ask first; it is also the riskiest step, which is why it is
  last and separable. Without it, standalone users outside VS Code get nothing until they have
  opened the project in CoGraph once.
- No file watcher: a watcher in a short-lived stdio process buys little over mtime checks and
  adds platform edge cases.

### D4. Retiring the Chat: remove outright in the MCP release, do not deprecate (PRODUCT: confirm)

**Recommendation (adopted by Bela): remove it outright, with no deprecation release, and ahead
of the MCP server.** Reasons:
1. Chat is opt-in (`graphIntelligence.enabled` defaults to `false`) and CLI-dependent, so the user
   base is small and already has Claude Code or Codex installed, i.e. exactly the tools the MCP
   server plugs into. The replacement is one `claude mcp add` line away for every Chat user.
2. The MCP path is strictly better for them: their real agent, their real session, no second
   budget cap, no whole-graph prompt, no API key or spend on CoGraph's side.
3. A deprecation release means keeping ~1,000 LOC of chat code plus the `chat-*` test suites
   alive and merge-conflicting with 183's sidebar and button work for another cycle.
4. It unblocks session-183's removal step now.
5. **Chat is already broken on most real repos** (measured by session-215, 2026-09-29, evidence
   in `.termi/briefs/workflow-eval/runs/`). `provider.run()` writes the whole graph as one-line
   JSON to `.cograph/.intelligence-request.json` and asks the model to Read it. Above roughly
   300 functions, Claude Code's Read tool refuses the file. The axios log says "exceeds maximum
   allowed size (256KB). Use offset and limit…". `--permission-mode dontAsk` denies the Bash
   fallback, so the model answers that it "couldn't read the request" and returns an empty graph.
   All of these came back empty: axios (696 fns), requests (711), CoGraph itself (1517),
   socket.io (1549) and gson (3437). So removing Chat does **not take away a working feature**.
   This is also the case for the MCP design: bounded, tool-shaped answers (our ~20 kB cap per
   result) are the fix for exactly the ceiling that paste-the-graph hits.

**DECIDED (Bela, 2026-10-06, M3): removed outright, no deprecation release.** The removal ships
on its own, ahead of any MCP work: branch `termi/s214-chat-removal`, commit e9d8206. **What
replaces Chat in the sidebar is session-262's Version Control view** (clickable PR graphs), not
an MCP card. The removal leaves an empty, hidden `#pane-primary` slot above Saved Graphs for 262
to fill.

**MCP setup affordance (compact, my call):** a command, **CoGraph: Connect an AI Agent (MCP)…**.
It sits in the command palette and also as a single icon in the sidebar's view title bar
(`contributes.menus["view/title"]`, which is VS Code-native chrome, not webview content), so it
never competes with the PR list. It opens a QuickPick:
- **Claude Code, just me**, which copies a `claude mcp add` line (default `local` scope);
- **Claude Code, whole team**, which merges an entry into `.mcp.json` after a confirm and never
  overwrites other servers;
- **Cursor / Claude Desktop**, which copies the JSON snippet.

Each entry points at the stable bundled path (D2). On VS Code 1.101+ the QuickPick's first line
says Copilot agent mode already sees the server, so no setup is needed there. The status ("graph
analysed 3 min ago / no analysis yet") moves into the QuickPick's title. That is about 120 LOC in
`src/mcp/setupCommand.ts`, with no webview code and nothing in `sidebarProvider.ts`.

Saved conversations: **left on disk untouched** (`.cograph/chats/*.json`, gitignored). Nothing
deletes user data. Once per workspace, if that folder (or the legacy `chat.json`) exists, a VS Code
notification says "Chat has been removed. Your saved conversations are still on disk in
`.cograph/chats/`." It deliberately does not mention MCP, so the removal can land first. There is
no viewer for old chats.

Removed code (done in e9d8206):
- delete `src/webview/sidebar-chat.js`, `src/graphIntelligence/chatStore.ts`;
- remove the `chat-*` message cases and chat HTML from `sidebarProvider.ts`,
  `runGraphIntelligence()` from `graphProvider.ts`, the `ChatStore` wiring in `extension.ts`;
- remove the chat tests: `ChatStore` and `Sidebar chat handler` suites in
  `graphIntelligence.test.ts`, the chat bits of `sidebarProvider.test.ts`;
- **kept**: `provider.run()`, `sessionId` in the request type, `cliProcess`, `progressParser`,
  `jsonRepair`, both providers and all settings, because Workflow and Annotate use them. If
  session-215 drops Workflow, a follow-up removes `run()`, the session resume path and the four
  Workflow/Chat-only settings.
- **not mine**: the "Open Chat" button, the `open-chat` host branch (`graphProvider.ts:411`) and
  their tests (`graphProvider.test.ts:1221`, `webviewControls.test.ts:644`) belong to session-183,
  which renames the button to "Open webview".

Settings text: `graphIntelligence.enabled` description drops "Chat". No setting is removed by this
plan (see "What exists today").

### D5. Install and trust story

What the README and the setup command say:
- **Local only.** The server is a local process on stdio. It reads `.cograph/graph-cache.json`,
  `.cograph/annotations/annotations.json` and, for `get_symbol` source slices, the workspace's
  source files. It opens no network connection, needs no API key, and never runs an LLM. It writes
  nothing (except the cache, and only with `reanalyze=true` if step 6 ships).
- **Path confinement.** Every `path`/`id` argument is resolved and must stay inside the workspace
  root (no `..`, no symlink escape); source slices only come from files listed in the graph.
- Snippets (checked against code.claude.com/docs/en/mcp, cursor.com/docs/context/mcp,
  modelcontextprotocol.io):
  `<server>` below stands for the stable bundled path from D2,
  `<globalStorage>/thraenbe.cograph/mcp/server.js`, which the setup command fills in.
  - Claude Code: `claude mcp add cograph -- node <server> --workspace .`. Everything after `--`
    is passed to the server. `local` is the default scope and is stored in `~/.claude.json`;
    `project` writes `.mcp.json` in the repo root; `user` applies globally.
  - Project `.mcp.json`:
    `{"mcpServers": {"cograph": {"command": "node", "args": ["<server>", "--workspace", "."]}}}`.
    `${VAR}` expansion is supported. Caveat: `<server>` is an absolute per-user path, so a
    team-shared `.mcp.json` only works for teammates whose path matches. That is why the setup
    command defaults to the `local` scope.
  - `node` must be on PATH. Claude Code's native installer does not guarantee that, so the setup
    command checks first and otherwise falls back to VS Code's own Node (`process.execPath` with
    `ELECTRON_RUN_AS_NODE=1` in `env`).
  - Cursor (`.cursor/mcp.json`) uses the same `mcpServers` shape and can pass
    `--workspace ${workspaceFolder}`.
  - Claude Desktop (`claude_desktop_config.json`) uses the same shape, but needs an absolute
    `--workspace` path because it has no project cwd.
  - The QuickPick (D4) offers the two Claude Code scopes as separate entries, so the user picks
    "just me" (`local`) or "whole team" (`.mcp.json`) knowingly.

### D6. Licensing: flag only (PRODUCT: Bela decides)

My view: **MIT repo.** The MCP server is the adoption wedge. It is how CoGraph gets into agent
workflows that never open the graph view, and agents are the product thesis. Its code is a thin
query layer over data the MIT extension already produces; putting it in a private repo would not
protect much, but would block a future npm path and community clients. If there is a premium angle,
it is in heavier tools later (cross-repo graphs, history-aware impact, hosted team graphs), not
in callers/callees. This is Bela's decision.

## Constraints

- Planner rules from `01-common-r2.md`: PR-only, own branch, no pushes, CHANGELOG under
  `[Unreleased]`, version stays 1.3.0.
- `engines.vscode` stays `^1.75.0`; the extension bundle keeps `target: node16`. The MCP bundle
  gets its own esbuild entry with `target: node18` (SDK 1.31 requires Node >= 18); that is fine because (a) runs
  on the user's Node and (b) only registers on VS Code versions whose Node is new enough.
- New code in new modules under `src/mcp/**`; files < 400 LOC, functions < 50 LOC; no
  `console.log` (stdout is the MCP channel, so logs go to **stderr** as structured JSON lines);
  explicit error handling: a tool error becomes an MCP `isError` result with a readable message,
  never a crash of the server.
- Do not touch the "Open Chat" button / `open-chat` branch / its two test suites (session-183).
- Do not break Annotate or Workflow: `annotationRunner.ts`, `workflowPrompt.ts` untouched.
- Shared files (`package.json`, `CHANGELOG.md`, `esbuild.js`): small edits appended at the end.
- New runtime deps (`@modelcontextprotocol/sdk`, `zod`) are **bundled**, as devDependencies of
  the extension, so the `.vsix` stays node_modules-free.

## Steps (with rough effort)

| # | Step | Files | New/changed LOC | Effort |
|---|---|---|---|---|
| 1 | **Graph index**: load cache + annotations, build lookup maps (id ↔ agent id, callers/callees adjacency, per-file symbol order: start line, plus the next symbol's line as a *fallback* bound only, see the step-2 note), staleness check. Pure functions, no MCP. | `src/mcp/graphIndex.ts`, `src/mcp/ids.ts`, `src/mcp/paths.ts` | ~330 | 0.5 d |
| 2 | **Queries**: find, get, bounded BFS callers/callees, impact by id/file/folder, overview. Pure functions over the index. `get_symbol`'s signature/docstring/source slice **imports `src/funcBrief.ts`** (owned by session-216, vscode-free per session-110's ruling); no slicer of our own. | `src/mcp/queries.ts`, `src/mcp/overview.ts` | ~350 | 1 d |
| 3 | **Formatting**: text + structured output, truncation notes, footer. | `src/mcp/format.ts` | ~180 | 0.5 d |
| 4 | **Server**: SDK stdio server, six tool definitions (zod schemas, descriptions written for an agent), argv parsing, stderr logging, error mapping. esbuild entry `dist/mcp/server.js`. | `src/mcp/server.ts`, `src/mcp/tools.ts`, `esbuild.js`, `package.json` | ~250 | 0.5 d |
| 0 | **Chat removal (DONE, own branch and PR, no MCP code):** delete `sidebar-chat.js` and `chatStore.ts`, the `chat-*` cases, `runGraphIntelligence()` and the `ChatStore` wiring; add an empty `#pane-primary` slot for session-262; one-time notice about the chats left on disk; CHANGELOG `[Unreleased] / Removed`; tests. | branch `termi/s214-chat-removal`, e9d8206 | +~150 / −~2,430 | done |
| 5 | **Extension integration**: guarded VS Code MCP provider registration; stable copy of the bundle into `globalStorageUri` on activation; the **Connect an AI Agent (MCP)…** command with its view-title icon and QuickPick (D4); README section; CHANGELOG `Added`. | `src/mcp/vscodeRegistration.ts`, `src/mcp/setupCommand.ts`, `src/mcp/setupSnippets.ts`, `extension.ts`, `package.json` | ~300 | 1 d |
| 6 | *(optional, separable)* **Headless re-analysis** `reanalyze=true`: vscode-free analyzer core out of `AnalyzerRunner` (ask owner first). | `src/analyzerCore.ts` (new), `analyzerRunner.ts` (delegates), `src/mcp/reanalyze.ts` | ~250 | 1 d |
| 7 | *(BLOCKED: needs a name, M2)* **npm package**: `package.json` with `bin`, publish workflow. | `mcp-package/` or a script | ~60 | 0.5 d after a name exists |

**Slice bounds (corrected 2026-09-29).** `funcBrief` sits on the shipped `src/sourceEditor.ts`
(fs only). That module finds a function's end by indentation for Python and by brace counting
otherwise; Java and C++ also go through the brace path. My first draft bounded slices by the next
symbol's start line. That is **wrong as a hard bound**. In the click cache, **399** Python
functions have a nested function as their next symbol (e.g. `tests/test_termui.py:44` contains
`cli`), so a next-symbol cap would cut them off after a few lines. The rules are:
1. The language end detection gives the end.
2. `maxLines` is the hard cap. It is always safe, and it also catches brace runaways from `{`
   inside strings, comments and regexes.
3. The next-symbol line is used **only when detection fails** (reaches EOF without closing).
The result reports which rule ended the slice, so `get_symbol` can tell the agent when a slice
was truncated.

**What `get_symbol` promises (per session-110 / 216).** A stray `}` inside a string can end the
brace scan early at a balanced but wrong point, and that result still reports `detected`. 216 is
making the scanner aware of strings, chars, comments and regexes, but `detected` will only ever
mean "balanced parse", never "complete function". So:
- the tool description calls the source a **best-effort slice**;
- every source block is headed with its exact range (`src/a.ts:42-97, best-effort; ended by:
  detected|maxLines|fallback|eof`);
- the tool description tells the agent to read the file at that range itself when it is about
  to edit the function.

Tests: a fixture with `"}"` in a string and one with `{` in a regex, asserting the header states
the range and the reason.

**Dependency:** step 2's `get_symbol` source output needs session-216's `src/funcBrief.ts`
committed (session-110 relays when). Steps 1, 3, 4 and the rest of step 2 do not wait on it; until
it lands, `get_symbol` is built and tested with `includeSource` stubbed. If `funcBrief` lacks
something we need (candidates: a caller-supplied `maxLines` cap, working from a file path the MCP
server has already confined to the workspace, not throwing on an unreadable file), we ask
session-110 to have 216 widen it. We do not fork it.

Total for 1–5: ~3.5 dev days (the Chat removal, step 0, is already done). With 6: ~4.5 days; 7 waits for a name.

## Risks

1. **Agents over-trust static analysis.** Empty `callers` for a function only reached through
   dynamic dispatch reads as "safe to delete". Mitigation: tool descriptions and the footer state
   the limit; `impact` lists "possible dynamic callers: 0 known" rather than "no callers".
2. **Stale cache.** Users who edit with the graph panel closed get old answers. Mitigation: the
   staleness footer is on every result; step 6 closes it fully.
3. **Result size on dense graphs** (fmt: 30k edges, hot spots with hundreds of callers).
   Mitigation: hard limits + per-file grouping; tests on the fmt cache with a byte budget.
4. **Id stability.** Name-based ids collide for overloads (C++, Java). Mitigation: `:line`
   suffix only when ambiguous; lookups report ambiguity with a candidate list instead of
   guessing.
5. **Removing Chat angers a Chat user.** Mitigation: the card offers a one-click replacement, the
   old chats stay on disk, the CHANGELOG says so. If Bela prefers, D4 can become "hide behind a
   setting for one release" at +0.25 d.
6. **SDK and MCP spec churn.** Pin the SDK version; the server uses only tools (no resources,
   prompts or sampling), the most stable part of the protocol.
7. **Electron as Node** for (b): `process.execPath` + `ELECTRON_RUN_AS_NODE=1` is what the
   analyzers already rely on implicitly; test it on all three CI OSes.
8. **Path traversal via tool arguments.** Mitigation: `paths.ts` confines everything to the root;
   unit tests with `..`, absolute paths, symlinks.

## Test strategy

- **Unit (mocha, no VS Code needed for `src/mcp/**` except the registration)**: index building,
  id round-trips, ambiguity handling, BFS depth/limit/cycles, impact grouping, overview with and
  without annotations, truncation text, path confinement, staleness footer. Fixtures: a small
  hand-made graph plus a trimmed real cache. Target ≥ 90 % line coverage on `src/mcp/**` (c8).
- **Protocol test**: spawn `dist/mcp/server.js` with the SDK's client over stdio against a
  fixture workspace: `tools/list` returns the six tools with schemas; each tool returns text and
  structured content; bad input gives `isError`, not a crash; nothing is written to stdout except
  protocol frames.
- **Size test**: run every tool against the fmt cache in `~/cograph/test-projects` (local only,
  skipped on CI) and assert results stay under the byte budget; record timings.
- **Extension tests**: registration is skipped when the API is missing (stub `vscode.lm`) and
  called with the right definition when present; the setup command writes/merges `.mcp.json`
  without clobbering other servers; chat message types are gone and no longer handled; the
  "old chats" note shows only when `.cograph/chats/` exists.
- **Manual**: `claude mcp add` against this repo, ask Claude Code "what calls
  `invokeProvider`?" and "what breaks if I change `cacheStore.ts`?"; VS Code Copilot agent mode
  sees the server; Claude Desktop with `--workspace`.
- **Regression**: Annotate and Workflow suites stay green untouched; full suite on the three CI
  OSes via the PR.

## Acceptance criteria

- `node dist/mcp/server.js --workspace <repo>` serves six read-only tools over stdio; every
  result is bounded, text-first and carries cache age / staleness.
- Claude Code with the config from the setup command answers caller/callee/impact questions
  about this repo from CoGraph's graph.
- On VS Code versions with the MCP provider API, the server shows up with no config; on 1.75 the
  extension activates as before with no error.
- Chat is gone from the sidebar and the codebase; Annotate and Workflow behave exactly as in
  1.3.0; old chat files are still on disk.
- Suite green on ubuntu / macos / windows; ≥ 80 % coverage on new code.

## Out of scope

- The "Open Chat" button and its host branch (session-183), webview-in-browser / private repo
  (session-183), Workflow Graph (session-215), webview rendering (session-216).
- MCP resources, prompts, sampling, HTTP/SSE transport, remote/hosted servers.
- `path_between`, cross-repo graphs, git-history-aware impact.
- Deleting old chat files, or a viewer for them.
- Floor bump of `engines.vscode`.

## Open product questions (for Bela, via session-110)

1. **Tool set**: the six in D1 (`find_symbol, get_symbol, callers, callees, impact, overview`)?
2. **Where it runs**: both (standalone = product, VS Code registration = one-click)? The **npm
   package is blocked on a name**, because `cograph` and `cograph-mcp` are taken on npm by another
   "Cograph" project. Until a name exists, v1 ships the bundled path only.
3. ~~Chat~~: **decided 2026-10-06**, removed outright; the Version Control view (session-262)
   takes its place.
4. **Licensing**: MCP server in the MIT repo (my view) or the private one?
5. **Headless re-analysis** (step 6) in v1, or v1 = cache-only and 6 follows?

## Outcome and deviations (executor + reviewer, 2026-10-07)

Built on `termi/s214`: dca6e2b, on top of the Chat removal (PR #70, merged in here). Full suite:
1243 passing, 0 failing. The 31 new tests sit in `mcpCore`, `mcpServer` (including a real stdio
round-trip through the SDK client against `dist/mcp/server.js`) and `mcpSetup`. Coverage of
`src/mcp/**` under c8 is about 94 % of statements; the rest is tsc's import helpers and
`server.ts`'s `main`, which only runs in the spawned bundle. The compile is clean against
`@types/vscode` 1.75. `vsce ls` passes and ships `dist/mcp/server.js` (473 kB minified).

Measured on real caches:
- CoGraph itself (1516 functions) and fmt (5171 nodes, 30152 edges): every call took under 100 ms.
- `impact` on fmt's `include/fmt/base.h` hit the 20 k-character cap and said so.
- `callers` at depth 5 on fmt's most-called function returned 13.5 k characters.

Deviations from the plan:
1. **Text only, no `structuredContent`/`outputSchema`.** The spec says structured output SHOULD
   also be serialised into a text block, which would double every result for clients that all
   read the text anyway. This can be added later without breaking anything.
2. **Source slices go through `src/mcp/sourceSlice.ts`**, an adapter over the end-finders already
   shipped in `sourceEditor.ts`. Its result shape is the subset of session-216's
   `FuncBriefResult` that we use, so swapping in `readFuncSlice` once PR #69 lands is a one-file
   change. The adapter deliberately applies **no** next-symbol fallback. From outside the scanner,
   "the function ends at EOF" and "detection never closed" look the same, so cutting at the next
   symbol would truncate functions that contain nested ones. `funcBrief` decides this inside the
   scanner, so its fallback is safe to use after the swap.
3. **The `get_symbol` source header warns when the file changed since the analysis.** The smoke
   test on a 12-day-old cache showed drifted lines slicing the wrong code.
4. **Id resolution also accepts the guessed `file::method` without its class**, and a drifted
   `:line` resolves to the nearest line. `find_symbol("MAIN")` never returns the module-level
   pseudo node.
5. **`--workspace` is optional.** Without it, the server walks up from its cwd to the nearest
   `.cograph/graph-cache.json`. The team `.mcp.json` entry relies on this, so it carries no
   machine-specific workspace path, only the server path.
6. **`cacheStore.ts`: `readCacheFile()` and `diffManifest()` are extracted from `loadCache()`**
   with unchanged behaviour, so the server parses the cache once and reuses the staleness diff.
7. **Activation:** `onMcpCollection:cograph`. The docs do not name it, so I verified it in VS
   Code's source: `mcpConfiguration.ts` `activationEventsGenerator` derives it from the
   contribution. It is also listed explicitly in `activationEvents`.
8. **MCP setup is wrapped in try/catch inside `activateMcp`.** A failure there is logged to a lazy
   "CoGraph MCP" output channel and never breaks extension activation.

Not done:
- No manual run with the real Claude Code CLI. That would use Bela's account and edit
  `~/.claude.json`. The SDK client round-trip covers the protocol.
- Steps 6 (headless re-analysis) and 7 (npm, blocked on a name) are deferred per M5.
