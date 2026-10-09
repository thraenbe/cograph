# Task: "Open in browser" for the graph view (feature 5, part A)

Planner: session-183, 2026-09-23. Base: `develop` (2747ad3), branch `termi/s183`.
Facts re-checked 2026-09-29 against `main` @ 1fc1156 (v1.3.0, ~1224 tests); the corrections are
listed in `.ai/plans/webview-stale-vs-1fc1156.md`.
Status: **deferred (2026-10-08), not cancelled. No code written.** Decisions and outcome:
`.ai/plans/webview-decisions.md`. P1 answered: "Open in browser". The "Open Chat" button no
longer exists (removed in 1.4.0 work), so step 6 adds a new button instead of renaming one.
Companion decision document: `.ai/plans/webview-private-repo-strategy.md` (part B).

## Problem

The graph view only exists inside the VS Code webview panel. Bela wants it openable in an
external browser (Chrome/Firefox) with the live host behind it: analysis, lazy folder expand,
git colours, function source, save. Today's panel button "Open Chat" (`#btn-open-chat`,
`panel-actions` in `webviewHtmlBuilder.ts`) only focuses the sidebar; it becomes the entry
point for the browser view.

What exists already (verified): `uxtest/harness/` renders the real `getWebviewHtml` with a
stub `webview` object, serves `src/webview` + `dist/webview` on 127.0.0.1, stubs
`acquireVsCodeApi` and answers with a scripted host. The whole 1.3.0 graph (Shelf/Global,
worker pool, hover card, timeline) already runs in plain Chromium with a JSON round trip for
every message. So the webview code needs **no changes**; the work is a real host transport.

## Decisions taken in this plan (defaults, overridable by Bela)

| # | Question | Default in this plan |
|---|----------|----------------------|
| D1 | Panel and browser tab show the same graph? | Yes: **mirror**. Both receive every host message; each keeps its own zoom / expanded folders / layout / hidden folders and files (page state). The subgraph scope (`this.scope`, changed by `subgraph-include/-exclude/-exit` and "Only visualize") is **host state**, so it is shared: re-scoping in the tab re-scopes the panel too. "Save" saves the active view's hides. |
| D2 | Does the tab survive closing the panel? | No. The panel is the source of truth (it owns the analyzer, watchers and cache). The tab shows a "panel closed" banner. |
| D3 | Transport | HTTP + Server-Sent Events (host to browser) + `POST /msg` (browser to host). Zero new dependencies (Node 16 floor of VS Code 1.75 has `http`; the page has `EventSource`/`fetch`). WebSocket would need `ws` and a `.vscodeignore` un-ignore. |
| D4 | Sidebar chat in the browser | Not in v1. The chat is a separate VS Code view (`sidebar-chat.js`, `markdown.js`), not part of the graph webview. |
| D5 | Button label | The brief says **"Open webview"**. Tooltip: "Open this graph in your browser". See product question P1. |
| D6 | Server lifetime | Started lazily on first click; stopped on panel dispose and on `deactivate`. Same token for the panel's lifetime. |

## UX

1. Click **Open webview** (renamed `#btn-open-chat` to `#btn-open-browser`; posts `open-browser`).
2. Host starts the loopback server if needed, then `vscode.env.openExternal(vscode.Uri.parse(url))`
   with `url = http://127.0.0.1:<port>/?token=<64 hex>`. In Remote-SSH / Codespaces the URL is first
   passed through `vscode.env.asExternalUri` so VS Code forwards the port.
3. VS Code information toast: "Graph opened in your browser" with a **Copy URL** action.
4. The `panel-actions` box gets a one-line status under the button: "Browser: 1 tab" /
   "Browser: not connected" (driven by a new host to webview message `browser-status`).
5. Closing: close the tab. Closing the panel disconnects every tab (banner with "Reopen CoGraph in
   VS Code"). No stop button in v1 (P3).
6. In the browser the same button is hidden (it would open a second tab of itself); "Save Layout"
   works (host side). `navigate` opens the file in the VS Code window without raising it (OS
   limitation, documented in the banner tooltip).

## Architecture

```
VS Code panel  <-- postMessage -->  ViewHub  <-- SSE / POST -->  Browser tab(s)
                                      |
                              GraphProvider (unchanged logic)
```

| Piece | New/changed | Responsibility |
|-------|-------------|----------------|
| `src/browserView/viewHub.ts` (new, ~150 LOC) | new | Fan-out of host to view messages to the panel gate and every SSE client; inbound messages from any view go to one handler with a `viewId`; tracks the *active* view (last inbound message) for `save-request`. Owns the `WebviewReadyGate` for the panel; each browser client gets its own gate + `__seq` space. |
| `src/browserView/browserServer.ts` (new, ~250 LOC) | new | `http.createServer` on `127.0.0.1:0`. Routes (all require `?token=`): `GET /` HTML, `GET /ext/src/webview/*` and `/ext/dist/webview/*` static (allow-list of the two roots, no traversal), `GET /events` SSE, `POST /msg` JSON (1 MB cap). Rejects unknown token (401), wrong `Host` (DNS rebinding) and cross-site `Origin`/`Sec-Fetch-Site` on POST (403). |
| `src/browserView/browserHtml.ts` (new, ~80 LOC) | new | Calls `getWebviewHtml` with a shim `webview` (`asWebviewUri` maps to `/ext/<path>?token=`, `cspSource` = origin) and `{ transport: 'browser', theme }`. Serves a `<style>` block with the `--vscode-*` values of Dark+/Light+ chosen from `vscode.window.activeColorTheme.kind` and sets `body.vscode-dark|light`, so `styles.css` (118 `var(--vscode-*)` reads) renders as in the panel. Values copied from `uxtest/lib/theme.ts` (uxtest stays untouched; duplication noted as tech debt to be removed at the private-repo split). |
| `src/webview/browserBridge.js` (new, ~90 LOC) | new | Loaded **before** `state.js` only in browser mode. Defines `window.acquireVsCodeApi` (`postMessage` = `fetch POST /msg` with JSON, `getState/setState` = `sessionStorage`), opens `EventSource('/events?token=')` and re-dispatches each event as `window.postMessage(msg, location.origin)`, so the existing `message` listeners in `main.js`, `controls.js`, `readyHandshake.js`, `hoverCard.js` run unchanged. Shows the disconnect banner after 3 failed reconnects. |
| `src/webviewHtmlBuilder.ts` | small edit | `opts.transport?: 'vscode' \| 'browser'`; in browser mode adds the bridge script tag first and hides `#btn-open-browser`; CSP becomes `script-src 'nonce-…'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; worker-src blob:; connect-src 'self'` (no `vscode-webview://`); `https://cdnjs.cloudflare.com` is added to `script-src` under the same condition the panel CSP already uses (`d3.min.js` missing from `dist/webview`). Button rename in `panel-actions` + status line. |
| `src/graphProvider.ts` | mechanical edit | The 30 `webview.postMessage(x)` sites (including the ones in `setScope()` that post the `subgraph` message and the scope prune/add `graph-patch`es) become `this.views.post(x)`; `onDidReceiveMessage` closure is moved (not changed) into `private onViewMessage(message, viewId)` so the hub can call it for browser messages; new branch `open-browser`; `open-chat` branch removed with the button (P1; see step 6); snapshot replay `replayFor(viewId)` uses the same order as `loadGraphHtml`: **`subgraph` first** (`subgraphMessage(root)`), then `structure`, `graph` (from `cachedGraph`), `config`, git status, each through `this.scoped()`. Without that order a late-joining tab builds the whole project and then prunes it (flash). `save-request` goes through `views.postToActive`. |
| `src/webview/controls.js` | 3-line edit | Button handler posts `open-browser`; renders `browser-status`. |
| `package.json` | no new deps | Optional setting `cograph.browserView.enabled` (default true) so admins can switch the loopback server off. |

Notes:
- Worker + d3: `simPool.js` fetches `workerUri` and boots it from a Blob; in browser mode the URI is
  `/ext/dist/webview/simWorker.js?token=…`, allowed by `connect-src 'self'`. `d3.min.js` is served the
  same way; the CDN fallback is only for checkouts that never ran `npm run bundle`.
- Message payloads must be JSON (the panel uses structured clone). The lab already JSON-round-trips
  every message of the 16 scenarios, including `save-graph` and `graph-patch`, so the current
  protocol is JSON-safe. The hub logs and drops a message that fails `JSON.stringify` instead of
  throwing.
- Request/response pairs (`get-func-source`, `get-lib-description`, `get-annotations`) are
  answered by broadcast; the non-requesting view ignores them because the `reqId` does not match
  its pending request (`main.js` already does this). Only `save-request` is routed.
- `ready` from a browser client triggers `replayFor(viewId)`; the panel keeps today's gate path.
- Panel title: `showScoped()` sets the panel title to the scope name (`scopeTitle()`). In this plan
  the tab `<title>` is static; keeping it in sync would take one extra host to view message.
- Protocol additions since 2747ad3 that the bridge carries unchanged and the parity test and
  `docs/protocol.md` must list: host to view `subgraph`; view to host `subgraph-include`,
  `subgraph-exclude`, `subgraph-exit`.
- Reconnect: `EventSource` reconnects on its own; the bridge re-sends `ready`, the host replays the
  snapshot, `readyHandshake.js` drops duplicate `__seq`. When the extension host dies the retries
  fail and the banner appears; the tab is inert until the panel is reopened (new token, new URL).
- Security: loopback bind only, no config for the bind address; 32 random bytes per server start;
  the token is in the query string (the page needs it for static assets and SSE), so it is visible
  in the address bar and in the browser history; the CSP forbids any other origin, so no third-party
  script can read it. The toast never prints the token. Logs redact it.

## Alternatives considered

| Option | Live host | Effort | Verdict |
|--------|-----------|--------|---------|
| (1) `vscode.env.asExternalUri` + Simple Browser | yes | small, but Simple Browser is itself a webview inside VS Code | Not "external". Used only for the port-forwarding step in remotes. |
| (2) Static export (HTML + graph JSON, no host) | no | small | No navigate, expand, git, save. Good later "share a snapshot" feature; out of scope here. |
| (3) Local loopback server (this plan) | yes | medium | Recommended. Same HTML, same protocol, zero webview changes. |

## Steps (Executor)

1. `viewHub.ts` + unit tests (fan-out, active-view routing, JSON guard, per-client gates).
2. `browserServer.ts` + tests (token 401, `Host` check, path allow-list, SSE framing, POST cap).
3. `browserHtml.ts` + builder `transport` option + tests (bridge tag first, no `vscode-webview`, CSP).
4. `browserBridge.js` + jsdom tests (shim installed, SSE event to `window.postMessage`, `ready` on
   open, banner after failures).
5. `graphProvider.ts`: `views.post` replacement (all 30 sites, scope code included),
   `onViewMessage` extraction, `open-browser`, `replayFor` (`subgraph` first, then scoped messages;
   test: a tab joining while a scope is active never receives an unscoped `graph`). Existing provider tests keep passing (the hub delegates to the panel's `postMessage`).
6. Button rename in HTML + `controls.js`; update `webviewControls.test.ts` (Open Chat suite) and
   `graphProvider.test.ts` (`open-chat` suite becomes `open-browser`).
   **Conditional on session-214's Chat decision** (ownership agreed 2026-09-29, session-110: 183
   owns the button, the `open-chat` host branch and those two suites; 214 owns chatStore, the
   provider layer and `sidebar-chat.js`):
   - Chat **removed**: rename the button and delete the `open-chat` branch + its tests as above.
   - Chat **deprecated for one release**: keep the `open-chat` branch and its tests unchanged
     (Chat stays reachable via the `cograph.savedGraphs.focus` command); add `open-browser` as a
     new branch and give the panel button to it. The branch is deleted in the release that removes
     Chat, by 183 or whoever holds the button then.
7. Lifecycle: start on click, stop on dispose/deactivate, `browser-status` message, toast.
8. End-to-end: Playwright spec against the real server (see tests). CHANGELOG under `[Unreleased]`,
   README section "Open in browser".

## Test strategy

| Layer | Test | Where |
|-------|------|-------|
| Host unit | hub fan-out, server auth/static/SSE/POST, HTML mode | `src/test/suite/browserView*.test.ts` (mocha, `http` against a real port on 127.0.0.1) |
| Webview unit | bridge shim, controls rename | `src/test/suite/browserBridge.test.ts`, `webviewControls.test.ts` |
| Protocol parity | start `BrowserServer` with a `FakeHost`-like handler, open the page in Chromium, run the lab's smoke + expand + save steps, assert the set of posted message types equals the panel run's (`uxtest` `hostLog`), including the `subgraph*` messages; plus a scope step: "Only visualize" in the tab re-scopes the panel | new `test/browser/parity.spec.ts` (Playwright, own dir; uxtest scenarios untouched, `lab.ts` reused read-only) |
| Manual | Chrome + Firefox on Linux; Remote-SSH port forward | checklist in the PR |

Coverage target 80 % on the new modules (`c8` through the uxtest unit config or mocha's runner).

## Files touched

New: `src/browserView/viewHub.ts`, `browserServer.ts`, `browserHtml.ts`, `src/webview/browserBridge.js`,
tests above, `test/browser/parity.spec.ts`.
Edited: `src/webviewHtmlBuilder.ts` (button, status line, transport option, CSP), `src/graphProvider.ts`
(mechanical), `src/webview/controls.js`, `src/extension.ts` (deactivate hook), `package.json` (setting),
`CHANGELOG.md`, `README.md`, `src/test/suite/webviewControls.test.ts`, `graphProvider.test.ts`.
Nothing deleted. `uxtest/` not modified.

## Risks

| Risk | Mitigation |
|------|------------|
| `graphProvider.ts` is 1386 LOC; the mechanical replacement touches 30 lines across ux/perf/annotate/scope areas | Do it as one commit after every feature branch has merged (develop is that point); no logic changes; provider tests unchanged. |
| Another local process could hit the server | Token + loopback + `Host` check; unknown token gets a blank 401, no HTML. |
| Firefox `EventSource` buffering on large `graph` messages (several MB) | SSE supports arbitrary sizes; test with the 10k synthetic fixture. Fallback: chunked base64 is not needed unless measured. |
| Theme drift: browser shows Dark+ colours even under a custom VS Code theme | v1 uses kind (dark/light) only; exact theme colours are not available to extensions. Documented. |
| Users expect the tab to keep working after closing the panel (D2) | Banner wording; revisit if requested. |
| The private-repo split (part B) moves `src/webview/*` | The bridge and `browserHtml` are webview-side and move with it; the hub and server are host-side transport and can move too (see strategy doc, "host entry"). Plan so both modules have no imports from `graphProvider.ts`. |

## Out of scope

Static export, sharing links beyond localhost, remote (non-loopback) access, chat in the browser,
authentication beyond the token, licence gating (part B), multi-workspace, editing the webview
scripts.

## Product questions for Bela (relayed by session-110)

- **P1** Label: the brief says "Open webview". "Open in browser" is what users will understand;
  which one? And is the sidebar chat losing its toolbar button acceptable (it stays reachable
  via the activity bar)?
- **P2** Mirror (D1) or an independent view that loads its own copy of the graph?
  (Corrected fact: the subgraph scope is host state, so under mirror the tab and panel always
  share one scope; an independent view would additionally need per-view scope on the host.)
- **P3** Should the tab survive closing the panel (D2), or should the server outlive the panel?
- **P4** Is a `cograph.browserView.enabled` setting wanted, or always on?
- **P5** Should this feature ship free in 1.3.x, or only after the premium split (strategy doc)?
