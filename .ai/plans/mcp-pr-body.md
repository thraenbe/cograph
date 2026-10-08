# CoGraph as a local MCP server for any agent (find_symbol, get_symbol, callers, callees, impact, overview)

Branch `feat/mcp-server` (= `termi/s214`), rebased onto `version_1.4.0`, which already carries the
Chat removal (#70) and `funcEnd.ts` (#69). This PR adds the MCP server, the slice fix on top of
`funcEnd.ts`, and the plan docs. No new settings. No change to any existing
API, setting or command. The engine floor stays at `^1.75.0`. Decisions M1 (the six tools), M4
(MIT, this repo) and M5 (follow-up release: no npm, no headless re-analysis in v1) are Bela's.

## What it is

A read-only stdio MCP server (`src/mcp/`, bundled by esbuild to `dist/mcp/server.js`, 473 kB
minified, Node 18+). It answers from the workspace's `.cograph/graph-cache.json` and
`.cograph/annotations/`. It opens no network connection, needs no API key and runs no model. It
writes nothing.

| Tool | Answers |
|---|---|
| `find_symbol` | name → ids (exact, then prefix, then substring; `Class.method` works), with caller/callee counts |
| `get_symbol` | location, class, file summary, a best-effort source slice with its range, direct callers and callees |
| `callers` / `callees` | bounded walk by depth (1-5), grouped by distance, `via` for indirect hits |
| `impact` | transitive callers of a function, file or folder: files nearest first, tests reached, entry points |
| `overview` | languages, folder tree with counts and AI summaries, entry points, hot spots; for a file, its functions |

Output contract:
- **Ids:** workspace-relative `file::Class.name`, with `:<line>` only when a name repeats in the
  file. Raw cache ids keep working.
- **Bounded:** limits, depth at most 5, and a hard cap of 20 000 characters with a truncation
  note.
- **Footer:** every result ends with the analysis age and staleness ("STALE: n source files
  changed since").
- **Honest gaps:** an empty `callers` or `impact` result says that static analysis misses dynamic
  dispatch, so it is not proof the function is unused.
- **Errors:** argument errors and a missing cache come back as `isError` results with a readable
  message, never as a crash.

Extension side:
- **VS Code 1.101+:** `vscode.lm.registerMcpServerDefinitionProvider` behind a runtime check, with
  local types. Agent mode finds the server with no setup.
- **Stable copy:** the bundle is copied to `globalStorage` on activation, so client configs
  survive extension updates (the extension folder name carries the version).
- **Setup command:** **CoGraph: Connect an AI Agent (MCP)…**, in the command palette and as a
  plug icon in the sidebar's view title bar. It opens a QuickPick:
  - **Claude Code, just me:** copies a `claude mcp add` line.
  - **Claude Code, whole team:** merges into `.mcp.json` after a confirm; other servers are kept,
    an existing `cograph` entry is replaced only after a second confirm, and invalid JSON is
    never touched.
  - **Cursor** and **Claude Desktop:** copy the matching snippet.
  - The cache age is shown in the QuickPick title.
- README section and CHANGELOG `[Unreleased] / Added`.

## Deviations from the approved plan (a reviewer cannot infer these from the diff)

1. **Text-only results; no `structuredContent` or `outputSchema`.** The spec says a tool that
   returns structured content SHOULD also put its JSON serialisation in a text block. That would
   double every result for clients that all read the text, and spend agent context on a JSON copy
   of what the text already says. This can be added later without breaking anything.
2. **`get_symbol` warns when the file changed since the analysis.** The smoke test against a
   12-day-old cache sliced the wrong code: the lines had moved. When the file's mtime differs from
   the analysis manifest, the source header now says "this file changed since the analysis, so
   the line numbers may have shifted and this slice may not be the function". Separately, the slice
   is always labelled best-effort with its exact range and how it ended: `end detected`,
   `TRUNCATED at maxLines`, or `end NOT found before the end of the file`. The scanner now skips
   strings and comments, since `funcEnd.ts` from #69 is in the base, but it is still a heuristic
   (C++ preprocessor branches, for one). So the label stays, and the agent is told to read the
   file at that range before editing.
3. **Class-less ids resolve.** An agent that guesses `src/graphProvider.ts::invokeProvider` for
   what is really `…::GraphProvider.invokeProvider` gets the method instead of "not found". A
   drifted `:<line>` suffix resolves to the nearest line. A bare name that is ambiguous returns
   the candidate list, never a guess. `find_symbol("MAIN")` never returns the module-level pseudo
   node.
4. **`--workspace` is optional.** Without it, the server walks up from its cwd to the nearest
   `.cograph/graph-cache.json`. The team `.mcp.json` entry uses this, so the file in git carries
   no machine-specific workspace path. It still carries the per-user server path; the confirm
   dialog says so, and "just me" (local scope) is listed first.
5. **`cacheStore.ts`: `readCacheFile()` and `diffManifest()` are extracted from `loadCache()`,
   with unchanged behaviour.** The server parses the 1-7 MB cache once per change and reuses the
   exact staleness diff the extension uses, instead of a second copy of that logic.
   `loadCache()` is now those two calls, and its existing tests pass unchanged.
6. **The source slice goes through a seam, `src/mcp/sourceSlice.ts`.** It returns the subset of
   session-216's `FuncBriefResult` that we use. It calls `funcEnd.ts`'s `scanFuncEnd` (from #69,
   now in the base; it is the scanner `funcBrief` builds on), whose `closed` flag separates a
   real end from an unclosed scan, so `eof` means "no end found". There is **no** next-symbol
   fallback: cutting at the next symbol would truncate every function containing a nested one
   (399 in click alone). When `funcBrief.ts` lands, a follow-up swaps in `readFuncSlice` and
   passes `nextStartLine`, which `funcBrief` applies only when its own scan reaches EOF unclosed.
7. **The activation event is `onMcpCollection:cograph`.** The docs do not name it. I verified it
   in VS Code's source: `mcpConfiguration.ts` `activationEventsGenerator` derives it from the
   `mcpServerDefinitionProviders` contribution. It is also listed explicitly in
   `activationEvents`.
8. **MCP setup can never break activation.** The provider registration and the stable copy are
   try/caught, and failures go to a lazily created "CoGraph MCP" output channel. The setup command
   registers regardless.

## Why it is safe

- **Engine floor:** the whole codebase compiles with **0 errors against `@types/vscode` 1.75.0**.
  The post-1.75 API is reached only in `src/mcp/vscodeRegistration.ts`, through local types, and
  only after `typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function'` (and the
  definition class) are confirmed. vsce's types-vs-engines check passes (`vsce ls`).
- **Path confinement:** every `path`/`id` argument is resolved and refused if it escapes the
  workspace through `..`, an absolute path or a symlink. Source is read only from files inside the
  workspace, even if the cache names a file elsewhere.
- **stdout carries only protocol frames:** logs go to stderr as JSON lines. The stdio test would
  fail the handshake otherwise.
- **Runtime dependencies are bundled** (`@modelcontextprotocol/sdk` 1.31.0 MIT, `zod` 3.25.76 MIT,
  as devDependencies). The `.vsix` still ships no `node_modules`.
- **Annotate and the Workflow Graph are untouched.**

## Measured

| Workspace | Size | Slowest call | Largest result |
|---|---|---|---|
| CoGraph itself | 1 516 functions | 40 ms (`overview`) | 3.9 k chars |
| fmt | 5 171 nodes / 30 152 edges | 83 ms (`overview` depth 4) | 19.97 k chars (`impact` on `include/fmt/base.h`: hit the cap and said so) |

`callers` at depth 5 on fmt's most-called function (186 direct callers) returned 13.5 k
characters in 5 ms.

## Verification

- Full suite on this branch, rebased on `version_1.4.0`: **1 307 passing, 0 failing** (Linux, real VS Code host).
- 31 new tests in three suites:
  - `mcpCore`: index, ids, resolution, reload on cache/annotation change, throttled staleness,
    queries, overview.
  - `mcpServer`: path confinement including a symlink escape, slices, formatting, `runTool` error
    mapping, out-of-workspace source refusal, and **a real stdio round-trip** through the SDK's
    own client against `dist/mcp/server.js`.
  - `mcpSetup`: snippets and quoting, the `.mcp.json` merge, guarded registration with and
    without the API, the stable copy, the manifest entries.
- Coverage of `src/mcp/**` under c8 (these suites also run under plain mocha): about 94 % of
  statements. The rest is tsc's import helpers and `server.ts`'s `main`, which only runs in the
  spawned bundle and is covered by the stdio test.
- Lint: no new warnings.

## Not verified

- **A real Claude Code CLI session.** Only Bela can run this: it uses his account and writes
  `~/.claude.json`. The steps:
  1. In VS Code, run **CoGraph: Connect an AI Agent (MCP)…** and choose **Claude Code: just me**.
  2. Paste the copied line into a terminal in this repo.
  3. Start `claude` and ask "what calls `invokeProvider`?" and "what breaks if I change
     `src/cacheStore.ts`?".
- **VS Code agent mode** picking up the provider in a 1.101+ window. This is unit-tested with a
  fake API; it has not been clicked through.
- **macOS and Windows:** CI covers these. Quoting in the copied `claude mcp add` line is
  unit-tested for both.

## Follow-ups (not in this PR)

- Swap `sourceSlice.ts` to `funcBrief.readFuncSlice` once `funcBrief.ts` lands (it is on session-216's branch), and pass `nextStartLine`.
- Step 6, headless re-analysis, and step 7, an npm package, are deferred by M5. The npm package
  is also blocked on a name: `cograph` and `cograph-mcp` are taken by another project.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
