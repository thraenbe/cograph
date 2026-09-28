# Task: CoGraph MCP server (replaces the in-extension Chat)

Planner: session-214, 2026-09-29. Base: `main` @ 1fc1156, branch `termi/s214`.
Status: **PLANNER PHASE. Waiting for Bela's approval. No product code written.**

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

### D2. Where it runs: (c) both, with (a) as the product (PRODUCT: confirm; npm publishing is new)

- **(a) Standalone stdio server** `dist/mcp/server.js`, built by esbuild as its own self-contained
  CJS bundle (like the analyzer bundles; `@modelcontextprotocol/sdk` + `zod` inlined, no
  `vscode` import). Invocation: `node server.js --workspace <root>` (default: cwd).
  To make it usable without VS Code it needs a stable path, so publish the same bundle to npm as
  a tiny package with a `bin` (name TBD: `cograph-mcp` is simplest; `@cograph/mcp` needs the npm
  org). Then: `npx -y cograph-mcp`. Publishing to npm is outward-facing and new for this project,
  so it is a Bela call. Without npm, (a) still works by pointing at the installed extension's
  `dist/mcp/server.js`, but that path changes with every extension version.
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
  npm: the sidebar card (D4) writes/copies a `.mcp.json` pointing at the extension's bundled
  server.

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

**Recommendation: remove it in the same release that ships the MCP server (1.4.0), with no
deprecation release.** Reasons:
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

What replaces it in the sidebar: the Chat section becomes a small **"Use CoGraph from your
agent"** card:
- status line: "MCP server available · graph analysed 3 min ago" / "no analysis yet";
- buttons: **Add to this workspace** (writes/merges a `.mcp.json` entry, after a confirm, never
  overwrites other servers), **Copy `claude mcp add` command**, **Copy config for Cursor /
  Claude Desktop**; on VS Code with the provider API, a note that Copilot agent mode already sees
  it.

Saved conversations: **left on disk untouched** (`.cograph/chats/*.json`, gitignored). Nothing
deletes user data. Once, if that folder exists, the sidebar shows "Chat was replaced by the
CoGraph MCP server. Your old chats are still in `.cograph/chats/`." with a Dismiss. No viewer for
old chats.

Removed code (this plan names the files, so it counts as the instruction required by the hard
constraints; still listed here for Bela to confirm):
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

What the README and the sidebar card say:
- **Local only.** The server is a local process on stdio. It reads `.cograph/graph-cache.json`,
  `.cograph/annotations/annotations.json` and, for `get_symbol` source slices, the workspace's
  source files. It opens no network connection, needs no API key, and never runs an LLM. It writes
  nothing (except the cache, and only with `reanalyze=true` if step 6 ships).
- **Path confinement.** Every `path`/`id` argument is resolved and must stay inside the workspace
  root (no `..`, no symlink escape); source slices only come from files listed in the graph.
- Snippets (checked against code.claude.com/docs/en/mcp, cursor.com/docs/context/mcp,
  modelcontextprotocol.io):
  - Claude Code: `claude mcp add --scope project cograph -- npx -y cograph-mcp`. Everything after
    `--` is passed to the server. `local` is the default scope and is stored in `~/.claude.json`;
    `project` writes `.mcp.json` in the repo root; `user` applies globally. Without npm, point at
    the extension-bundled path instead.
  - Project `.mcp.json`: `{"mcpServers": {"cograph": {"command": "npx", "args": ["-y", "cograph-mcp"]}}}`.
    `${VAR}` expansion is supported.
  - Cursor (`.cursor/mcp.json`) uses the same `mcpServers` shape and can pass
    `--workspace ${workspaceFolder}`.
  - Claude Desktop (`claude_desktop_config.json`) uses the same shape, but needs an absolute
    `--workspace` path because it has no project cwd.
  - Hint: `.mcp.json` is shared through git, so the sidebar "Add to this workspace" button asks
    whether to write it (team-shared) or run the `local`-scope command (just me).

### D6. Licensing: flag only (PRODUCT: Bela decides)

My view: **MIT repo.** The MCP server is the adoption wedge. It is how CoGraph gets into agent
workflows that never open the graph view, and agents are the product thesis. Its code is a thin
query layer over data the MIT extension already produces; putting it in a private repo would not
protect much, but would block the `npx` path and community clients. If there is a premium angle,
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
| 1 | **Graph index**: load cache + annotations, build lookup maps (id ↔ agent id, callers/callees adjacency, per-file symbol order, i.e. start line + next symbol's line, which is the input `funcBrief` takes), staleness check. Pure functions, no MCP. | `src/mcp/graphIndex.ts`, `src/mcp/ids.ts`, `src/mcp/paths.ts` | ~330 | 0.5 d |
| 2 | **Queries**: find, get, bounded BFS callers/callees, impact by id/file/folder, overview. Pure functions over the index. `get_symbol`'s signature/docstring/source slice **imports `src/funcBrief.ts`** (owned by session-216, vscode-free per session-110's ruling); no slicer of our own. | `src/mcp/queries.ts`, `src/mcp/overview.ts` | ~350 | 1 d |
| 3 | **Formatting**: text + structured output, truncation notes, footer. | `src/mcp/format.ts` | ~180 | 0.5 d |
| 4 | **Server**: SDK stdio server, six tool definitions (zod schemas, descriptions written for an agent), argv parsing, stderr logging, error mapping. esbuild entry `dist/mcp/server.js`. | `src/mcp/server.ts`, `src/mcp/tools.ts`, `esbuild.js`, `package.json` | ~250 | 0.5 d |
| 5 | **Extension integration**: guarded VS Code MCP provider registration; sidebar "Use CoGraph from your agent" card (status, write `.mcp.json` after confirm, copy commands); remove Chat (D4 list); one-time "your chats are still on disk" note; setting text; CHANGELOG (the removal entry says why: Chat returned empty answers on repos above ~300 functions because the graph no longer fit the CLI's Read limit; the MCP server replaces it) + README section. | `src/mcp/vscodeRegistration.ts`, `src/mcp/setupSnippets.ts`, new `src/webview/sidebar-agent.js`, `sidebarProvider.ts` (net shrink), `graphProvider.ts` (−1 method), `extension.ts`, `package.json`, docs | +~350 / −~1,100 | 1 d |
| 6 | *(optional, separable)* **Headless re-analysis** `reanalyze=true`: vscode-free analyzer core out of `AnalyzerRunner` (ask owner first). | `src/analyzerCore.ts` (new), `analyzerRunner.ts` (delegates), `src/mcp/reanalyze.ts` | ~250 | 1 d |
| 7 | *(PRODUCT gate)* **npm package** `cograph-mcp`: `package.json` with `bin`, publish workflow. | `mcp-package/` or a script | ~60 | 0.5 d + Bela's npm account |

**Dependency:** step 2's `get_symbol` source output needs session-216's `src/funcBrief.ts`
committed (session-110 relays when). Steps 1, 3, 4 and the rest of step 2 do not wait on it; until
it lands, `get_symbol` is built and tested with `includeSource` stubbed. If `funcBrief` lacks
something we need (candidates: a caller-supplied `maxLines` cap, working from a file path the MCP
server has already confined to the workspace, not throwing on an unreadable file), we ask
session-110 to have 216 widen it. We do not fork it.

Total for 1–5: ~3.5 dev days, net −300 LOC across the repo. With 6 and 7: ~5 days.

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
  called with the right definition when present; the sidebar card writes/merges `.mcp.json`
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
- Claude Code with the `.mcp.json` from the sidebar card answers caller/callee/impact questions
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
2. **Where it runs**: both (standalone = product, VS Code registration = one-click)? And may we
   **publish an npm package** (`cograph-mcp`) for the `npx` path, or bundled-in-extension only
   for now?
3. **Chat**: remove outright in 1.4.0 (my recommendation) or keep hidden for one release?
4. **Licensing**: MCP server in the MIT repo (my view) or the private one?
5. **Headless re-analysis** (step 6) in v1, or v1 = cache-only and 6 follows?
