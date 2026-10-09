# Webview plans vs main @ 1fc1156 (v1.3.0): what is stale

session-183, 2026-09-29. Both plans were written against develop 2747ad3. Nothing here changes
a recommendation. Session-110 approved this note on 2026-09-29. This file is now the changelog of
what was corrected in the plans:
- webview.md (2026-09-29, second pass): A1, A2, A3, A4 (fact only, tab title stays static), A5, A6
  and A7 folded in; A9 recorded as a conditional step 6. D1 gained the shared-scope fact, P2 one
  sentence on it; no recommendation, option or open question changed.
- webview-private-repo-strategy.md: B3 branch point marked under the ownership table. B1, B2, B4
  not folded in (recount and ordering happen at split time).

## webview.md (part A, "Open in browser")

| # | Stale item | Now | Effect on the plan |
|---|------------|-----|--------------------|
| A1 | `graphProvider.ts` 1230 LOC, "~25 postMessage sites" | 1386 LOC, 30 sites. `setScope()` posts subgraph prune/add patches straight to `this.panel.webview` | The `views.post` sweep must cover the scope code too. Still mechanical. |
| A2 | Snapshot replay `replayFor(viewId)` = structure, graph, config, git | Host now sends **`subgraph` first**, then everything through `this.scoped()` | Replay must post `subgraph` first and send scoped graph/git. Otherwise a late tab flashes the whole project. |
| A3 | D1 "mirror, each view keeps its own page state" | **Subgraph scope is host state** (`this.scope`, `subgraph-include/-exclude/-exit`). Hides (`hiddenFolders/Files`) are webview state. | Scope is shared: "Only visualize" in the tab re-scopes the panel too. Hides stay per view; Save saves the active view's hides. Add a line to D1 and to P2. |
| A4 | Panel title and the `cograph.visualizeFolder` command | `showScoped()` sets the panel title to the scope name | The tab `<title>` should follow it: one extra `panel-title` message, or leave it static. Small; I would add it. |
| A5 | Protocol list | New host to view: `subgraph`. New view to host: `subgraph-include`, `subgraph-exclude`, `subgraph-exit` | Parity test and `docs/protocol.md` must list them. |
| A6 | Browser CSP drops the CDN | Builder already puts cdnjs in the CSP only when `d3.min.js` is missing (d3 vendored) | Browser CSP should use the same condition. Minor. |
| A7 | Test counts "1108" | ~1224 `test()` calls | Numbers only. |
| A8 | Forces box / removed sliders (D2/D3) | Only the DOM rows are affected | No impact: the bridge carries no DOM and no settings. |
| A9 | Step 6 removes the `open-chat` branch + its tests (`graphProvider.test.ts:1221`, `webviewControls.test.ts:644`) | session-214 (MCP) retires Chat and may remove the same code | **Agreed (session-110, 2026-09-29):** 183 owns the button + `open-chat` host branch + those two test suites; 214 owns chatStore, the provider layer, `sidebar-chat.js`. Step 6 is conditional: if 214 deprecates Chat for one release instead of removing it, the branch stays. Recorded in webview.md step 6. |

## webview-private-repo-strategy.md (part B)

| # | Stale item | Now | Effect |
|---|------------|-----|--------|
| B1 | "When: after 1.3.0 and the four feature sessions close" | 1.3.0 is shipped. But ux4 and workflow now own `src/webview/*` files | The split waits until round 2 is merged too. Step 0 = "release the round-2 version". |
| B2 | Files that move: "36 files minus 2", "37 suites / 621 tests", "470 public" | 41 webview scripts (+`scope.js`, `slotDrag.js`), 42 suites `require` webview files | Recount at split time. New host modules `subgraphScope.ts` and `folderPicker.ts` **stay public** (host side). |
| B3 | P6 "does the webview include the sidebar chat?" and "chat stays free" in the ownership table | MCP replaces the Chat | If Chat is removed, `sidebar-chat.js`/`markdown.js` are deleted by 214 and P6 is moot. The public column gets "MCP server" **unless** Bela makes MCP premium. Then the strategy needs a second private package or a `mcp` entry in the same one. That is Bela's call (214's P-question), not mine. Branch point marked in the strategy doc under the ownership table; no second private entry written. |
| B4 | If workflow review drops the Workflow Graph | `workflow.js` would leave the move list | Only the list changes. |
| B5 | Rollback anchor `v1.3.0` "everything MIT" | Still true, now also includes subgraphs, hides and the forces box | No change. |
| B6 | `.vscodeignore` | 1.3.0 added `.termi/**`, `coverage/**` | Unrelated; the esbuild-copy approach still needs no un-ignore. |

## Does MCP replacing Chat change part A's design?

No. The browser view carries only the graph webview protocol, never the chat. D4 ("no chat in the
browser") becomes permanent. P1's second half ("is the sidebar chat losing its toolbar button
acceptable?") is moot if Chat is retired.
