# PR Tour: the contract between the public extension and the private tour package

Version 1. Written by session-110 on 2026-10-23 from the approved plan (`.ai/plans/pr-tour.html`,
https://claude.ai/artifact/DNRUPVREVqq9qwuGPozQnw). Both repositories carry a copy of this file;
the public one (`thraenbe/cograph`, `docs/tour-protocol.md`) is the original. A change to a
versioned surface is made here first, in both copies, in the same day.

Two repositories:

- **public, MIT** `thraenbe/cograph`: the extension. Owns the doorway (button, commands, loopback
  server, stage hooks, the engine, the `TourHostApi` it injects).
- **private, commercial** `thraenbe/cograph-pr-tour`, npm package `@thraenbe/pr-tour`: the tour.
  Owns the tour builder, chapters, security rules, prompts, routes, cache, config, and the browser
  layer. Two entries: `host` (CommonJS, Node 18 and up, loaded by the extension host) and `web`
  (one IIFE bundle `tour.js` plus `tour.css`, loaded by the browser page).

Nothing that is MIT today moves. The split runs along the three surfaces below, not along the
host-to-webview message protocol.

## 0. Versions and loading

| Surface | Constant | Where checked |
|---|---|---|
| `TourHostApi` and `TourHost` | `tourApiVersion = 1` | `createTour(api)` throws `TourApiMismatch` when `api.version !== 1`; the public resolver catches it and falls back to the stub |
| `stageApi` | `window.stageApi.version === 1` | the web layer refuses to start and shows one sentence when it differs |
| `TourScript` | `script.version === 1` | the web layer, same |

Additions within a version are optional fields and new optional members. Removing or renaming
anything bumps the version in both repositories.

**Resolution of the private package by the public extension** (`src/tour/tourModule.ts`), in
this order; the first that exists wins:

1. `<extensionRoot>/dist/tour/host/index.js` with `<extensionRoot>/dist/tour/web/` (the packaged
   Marketplace build; esbuild copies the package's `dist/` there when the package is installed).
2. The directory named by the environment variable `COGRAPH_TOUR_PACKAGE` (development: the
   private checkout, after `npm run build` there). Its `dist/host/index.js` and `dist/web/`.
3. `require.resolve('@thraenbe/pr-tour/host')` from the extension's `node_modules`.
4. None: the stub. `loadTourHost()` returns `null`; every tour entry point hides or says
   "The PR tour is part of the Marketplace build of CoGraph."

The public `package.json` never lists the private package. The release workflow installs it with
`npm install --no-save @thraenbe/pr-tour@<version>` from GitHub Packages before bundling; the
version pin lives in `package.json` under `"cograph": { "tourPackage": "0.1.0" }`.

## 1. Terms

- **Target**: what is toured. A pull request (`kind: 'pr'`, by number) or the current branch
  (`kind: 'branch'`): HEAD against the merge base with the base branch.
- **Trees**: the materialised head and base copies under `<globalStorage>/pr-trees/<repo>/<sha>/`,
  as 1.4.0 makes them (`src/vcs/engine/headTree.ts`), plus both graphs and the structural diff.
- **TourScript**: the JSON the private host builds from the trees; the web layer plays it.
- **Stage**: the MIT graph view, served to the browser by the public loopback server, driven only
  through `window.stageApi`.
- **Tour layer**: the private web bundle: rail, cards, progress, camera director, effects.

## 2. `TourHostApi` (public injects, private consumes)

TypeScript, as the public side exports it from `src/tour/tourApi.ts`. The private package keeps
an identical copy in `src/host/types.ts`; there is no build-time dependency between the repositories.
`EngineGraph`, `StructuralDiff`, `PullRequest`, `PrFile`, `ImpactResult`, `FuncBriefResult`,
`JsonRequest`, `JsonResult` are the shapes of `src/vcs/engine/types.ts`, `src/vcs/engine/graphDiff.ts`,
`src/vcs/types.ts`, `src/mcp/queries.ts`, `src/funcBrief.ts` and `src/graphIntelligence/provider.ts`
at 1.4.0, copied verbatim into the private `types.ts`.

```ts
export interface TourTarget {
  kind: 'pr' | 'branch';
  /** kind 'pr' */
  number?: number;
  /** kind 'branch': the local branch (HEAD). Resolved by the host when absent. */
  branch?: string;
  /** kind 'branch': the base branch name, e.g. 'main'. Resolved by the host when absent
   *  (origin/HEAD, else the repository's default branch from gh, else 'main'). */
  baseRef?: string;
}

export interface TourTree {
  sha: string;
  /** The materialised copy (analysable files only). */
  dir: string;
  graph: EngineGraph;
  /** Repo-relative POSIX paths of every file of the commit (not only the copied ones). */
  files: string[];
}

export interface TourCommit { sha: string; subject: string; body: string; author: string; date: string }

export interface TourChangedPath {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string;
  /** True when the structure scanner would show the file (so it can be in the graph). */
  analysable: boolean;
}

export interface TourTrees {
  repoRoot: string;
  target: TourTarget;
  head: TourTree;
  /** null when the base could not be fetched; then diff is null and the tour says so. */
  base: TourTree | null;
  diff: StructuralDiff | null;
  /** The pull request, kind 'pr' only. */
  pr: PullRequest | null;
  /** gh's file list with hunks, kind 'pr' only; null when the list could not be fetched. */
  prFiles: PrFile[] | null;
  /** base..head, oldest first. For a PR: the PR's commits. */
  commits: TourCommit[];
  /** `git diff --name-status base head`, every file, source or not. */
  changedPaths: TourChangedPath[];
  /** The checkout's branch, when the workspace is a checkout of this repository. */
  checkoutBranch: string | null;
  /** The working tree has uncommitted changes (branch targets only; false for a PR). */
  dirty: boolean;
}

export interface TourProgress { (message: string): void }

/** The engine's shell-free runner, exactly src/vcs/ghCliSource.ts: an argument array, never a shell. */
export interface ExecResult { code: number | null; stdout: string; stderr: string }
export interface ExecOptions { env?: Record<string, string>; stdin?: string; timeoutMs?: number; signal?: AbortSignal }
export type Exec = (command: string, args: string[], cwd: string, opts?: ExecOptions) => Promise<ExecResult>;

export interface TourGitActions {
  /** Each one shows a native VS Code confirmation first (the exact command and text) and
   *  resolves { ok: false, reason: 'cancelled' } when declined. The private side never confirms
   *  on its own and never runs gh or git for these. */
  push(branch: string): Promise<{ ok: true; remote: string } | { ok: false; reason: string }>;
  createPr(opts: { title: string; body: string; base: string; head: string; draft: boolean }): Promise<{ ok: true; number: number; url: string } | { ok: false; reason: string }>;
  editPrBody(number: number, body: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  commentPr(number: number, body: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }>;
}

export interface TourAi {
  enabled(): boolean;
  providerId(): 'claude-code' | 'codex';
  /** The model alias the tour should pass (resolved from cograph.tour.ai.model / annotate.model). */
  model(): string | undefined;
  /** The opt-in gate: a modal that describes what will be sent and costs; true = go. */
  confirmGate(description: string): Promise<boolean>;
  runJson(req: JsonRequest, signal?: AbortSignal): Promise<JsonResult>;
}

export interface TourHostApi {
  version: 1;
  repoRoot: string;
  /** <globalStorage>/pr-trees */
  storageDir: string;
  /** Appends to the "CoGraph Version Control" output channel with a [tour] tag. */
  log(line: string): void;
  /** Reads `cograph.<key>` (key without the prefix, e.g. 'tour.chapters'); fallback when unset. */
  settings<T>(key: string, fallback: T): T;
  exec: Exec;
  /** Materialises and analyses head and base, diffs them, lists commits and changed paths. */
  prepareTrees(target: TourTarget, progress: TourProgress, signal: AbortSignal): Promise<TourTrees>;
  /** `git show <sha>:<path>` from the fetched objects; null when absent or above maxBytes. */
  readFileAtRef(sha: string, path: string, maxBytes: number): Promise<string | null>;
  /** The MCP impact query over any graph (the head graph). Seeds are node ids of that graph. */
  impact(graph: EngineGraph, seeds: string[]): ImpactResult;
  /** Signature, doc, first lines of a function in a file on disk (a copy's file). */
  funcBrief(absPath: string, line: number, maxLines: number): FuncBriefResult;
  /** The workspace's Annotate summaries, keyed by repo-relative POSIX path; null when none. */
  annotations(): { files: Record<string, { summary: string }>; folders: Record<string, { summary: string }> } | null;
  /** null when cograph.graphIntelligence.enabled is false. */
  ai: TourAi | null;
  git: TourGitActions;
  /** Opens a file of a tree copy read-only (cograph-pr scheme) or the user's own file for a branch target. */
  navigate(absPath: string, line: number): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** A native information message with one button; no side effect. */
  notify(message: string): void;
}
```

`settings()` is the only way the private side reads configuration; it never touches
`vscode.workspace`. The keys it may read are the `cograph.tour.*` keys of section 7 and
`graphIntelligence.annotate.model`, `graphIntelligence.annotate.codex.model`,
`graphIntelligence.annotate.readSource`.

## 3. `TourHost` (private exports, public mounts)

```ts
export interface TourRouteRequest {
  method: 'GET' | 'POST';
  /** Path without query, e.g. '/tour/abc/script'. */
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  /** Parsed JSON body for POST (the server caps it at 1 MB), undefined for GET. */
  body?: unknown;
}
export interface TourRouteResponse {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}
export interface TourRoute {
  method: 'GET' | 'POST';
  /** Express-style pattern with :params, matched by the public server, e.g. '/tour/:id/script'. */
  pattern: string;
  handler(req: TourRouteRequest): Promise<TourRouteResponse>;
}

export interface TourPrepared {
  tourId: string;
  script: TourScript;
  /** Absolute path of the materialised head copy: the public side roots the stage provider there. */
  headDir: string;
  /** Statuses for the stage colours, the shape GitService.setOverride takes (EngineStatusOverride
   *  serialised: files as [path, status][], hunks as [path, hunks][]). */
  statuses: { files: [string, { unstaged: 'added' | 'modified' | 'deleted' | null; staged: null }][]; hunks: [string, { start: number; end: number; isNew: boolean }[]][] };
  /** What the stage's pr-view message needs: name, title, refs, expand list (ancestor folders of changed files). */
  view: { name: string; title: string; headRef: string; baseRef: string; expand: string[]; counts: { total: number; inGraph: number; other: number } };
}

export interface TourHost {
  version: 1;
  /** Builds the script (or loads it from the cache). Shows the AI gate through api.ai when AI is on. */
  prepare(target: TourTarget, progress: TourProgress, signal: AbortSignal): Promise<TourPrepared>;
  /** Routes the public server mounts (token, Host and Origin are enforced before any of them run). */
  routes: TourRoute[];
  /** Directory holding tour.js and tour.css, served by the public server at /tour-assets/. */
  webAssetsDir: string;
  dispose(): void;
}

/** The package's host entry. */
export function createTour(api: TourHostApi): TourHost;
```

The private host owns these routes (all under the public server's token check):

| Route | Returns |
|---|---|
| `GET /tour/:id/script` | the `TourScript` JSON |
| `POST /tour/:id/action` | body `{ action, payload }`; actions: `open-editor { file, line }` (via `api.navigate`), `create-pr { title, body, draft }`, `update-pr { body }`, `comment-pr { body }`, `rerun-ai {}`; returns `{ ok: true, result }` or `{ ok: false, reason }`. The three git actions call `api.git.*`, which confirm natively. |

The public server owns `GET /tour/:id` (the page), `GET /tour/:id/graph` (the replay), `/events`,
`/msg`, `/ext/*`, `/tour-assets/*` (section 4).

**Cache**: `<headDir>/.cograph/tour/<baseSha>-<configHash>.json` (a copy's `.cograph/` already
holds its graph cache). `configHash` is sha1 over the merged configuration. `prepare` reuses a
cached script when present; `rerun-ai` rebuilds the AI parts and rewrites it.

## 4. The browser page and the public server

From `.ai/plans/webview.md`, built by the public side: `src/browserView/viewHub.ts` (fan-out of
host-to-view messages to the panel and every browser client, one `WebviewReadyGate` per client),
`browserServer.ts` (`http.createServer` on `127.0.0.1:0`, 32-byte token, `?token=` on every
request, `Host` check, cross-site `Origin` rejected on POST, static allow-list, SSE, POST cap 1 MB),
`browserHtml.ts` (the stage HTML through `getWebviewHtml` with a shim `webview`, `transport:
'browser'`, theme variables for Dark+ and Light+ chosen from the active theme kind),
`src/webview/browserBridge.js` (defines `acquireVsCodeApi` over `fetch POST /msg` and
`EventSource /events`, re-dispatches events as `window.postMessage`).

Pages and routes the public server serves:

| Route | What |
|---|---|
| `GET /?token=` | the stage of the main panel, mirror mode ("Open in browser", free) |
| `GET /tour/:id?token=` | the stage of the tour's provider, plus the tour layer: `<link rel="stylesheet" href="/tour-assets/tour.css?token=">`, `<script src="/tour-assets/tour.js?token=">` after every stage script, and before them an inline `window.COGRAPH_TOUR = { tourId, scriptUrl, graphUrl, actionUrl, eventsUrl, msgUrl, theme: 'dark' | 'light', stageRoot, version: 1 }` (`stageRoot` = the absolute directory the stage's graph is rooted at, the head copy; every URL carries `?token=`) |
| `GET /tour/:id/graph?token=` | `{ messages: [...] }`: the provider's replay in panel order: `subgraph`, `pr-view`, `structure`, `graph`, `git-update`, `config`, each the exact object the panel would receive |
| `GET /events?token=&view=<id>` | SSE of host-to-view messages for that view (after the replay) |
| `POST /msg?token=&view=<id>` | one view-to-host message as JSON |
| `GET /ext/src/webview/*`, `GET /ext/dist/webview/*` | the stage's scripts and styles |
| `GET /tour-assets/*` | `TourHost.webAssetsDir`, files only, no traversal |

Every provider the server mirrors has a view id; the tour page's provider is the PR panel's
provider (Q11: the panel opens in VS Code as a pull-request click does today, and the tab mirrors
it). The CSP of the page: `default-src 'none'; script-src 'nonce-…' 'self'; style-src
'unsafe-inline' 'self'; img-src 'self' data:; worker-src blob:; connect-src 'self'`.

**Internal seams the two public sessions agree on** (not part of the private contract):

```ts
// src/browserView/browserServer.ts
export class BrowserServer {
  static start(deps): Promise<BrowserServer>;        // lazily, once per extension host
  url(path: string, query?: Record<string, string>): string;  // adds the token
  registerView(id: string, provider: GraphProvider): void;    // a mirrored provider
  mount(routes: TourRoute[]): void;                   // private routes, after the auth gate
  serveStatic(prefix: string, dir: string): void;     // '/tour-assets', webAssetsDir
  serveTourPage(tourId: string, viewId: string, opts: { assets: boolean }): void;  // GET /tour/:id and /tour/:id/graph
  dispose(): void;
}
// src/graphProvider.ts
provider.postToViews(msg)            // replaces the 30 panel.webview.postMessage sites
provider.replayMessages(): object[]  // the ordered replay (section 4) for a late view
provider.onViewMessage(msg, viewId)  // the existing handler, reachable for browser views
provider.onTourStart(cb: () => void) // the pill's tour-start
```

## 5. `window.stageApi` (public stage, private layer)

Defined by `src/webview/stageApi.js`, loaded after every other stage script. Node ids are the
stage's own (`<absFile>::<name>::<line>` for functions, `file::<absPath>`, `folder::<absPath>`).
The script references functions by repo-relative key and line; `resolve` maps them.

```js
stageApi.version                                   // 1
stageApi.ready()                                   // Promise<void>: after the first graph is ingested and laid out
stageApi.nodes()                                   // [{ id, kind: 'function'|'file'|'folder', name, file, line, className, gitStatus }]
stageApi.resolve({ file, name, line })             // string|null; file repo-relative POSIX or absolute; line optional, nearest wins
stageApi.fit(ids, { padding = 80, ms = 600, inset }) // Promise<void>; camera onto the nodes' bounding box (frames for folders); inset = { top, right, bottom, left } pixels of the viewport covered by the layer's overlays, so the box is centred in the visible region (default 0)
stageApi.fitAll({ ms, inset })                     // Promise<void>; same inset
stageApi.spotlight(ids | null, { edges = true })   // dims everything else to 0.25; null clears
stageApi.pulse(id | null)                          // one ring animation on the node; null stops
stageApi.ghost(list | null)                        // [{ id, file, name, line, callers: [ids] }]; id any unique string, file absolute or repo-relative POSIX (resolved like resolve()); dashed nodes in the file's slot, or the folder's margin when the file is gone
stageApi.edges(list | null)                        // [{ source, target, kind: 'added'|'removed'|'path' }] on an overlay layer, independent of bundling
stageApi.expand(folderPaths)                       // Promise<void>; absolute tree paths; posts expand-folder through the host when needed
stageApi.chrome(visible)                           // hides/shows toolbar, forces box, PR banner, panel actions
stageApi.theme()                                   // 'dark'|'light'
stageApi.on(event, fn)                             // 'ready' | 'node-click' { id } | 'graph' (re-ingest) ; returns unsubscribe
```

Rules: every call is safe before `ready()` (queued or ignored, never throws); ids unknown to the
stage are ignored; reduced motion (`prefers-reduced-motion`) makes `fit` cut instead of glide and
`pulse` a no-op. The stage keeps working as a normal graph view underneath: hover card, click to
navigate, expand.

## 6. `TourScript` (private host writes, private web reads, public never parses)

```jsonc
{
  "version": 1,
  "tourId": "pr-104-3f1c2a9-866b815",
  "target": { "kind": "pr", "number": 104, "title": "…", "headRef": "feat/x", "baseRef": "main", "url": "https://…" },
  // or { "kind": "branch", "branch": "feat/x", "baseRef": "main", "dirty": false }
  "trees": { "headSha": "3f1c2a9", "baseSha": "866b815", "repoRoot": "/abs/path" },   // baseSha null when the base is missing
  "summary": {
    "filesChanged": 12, "nonSourceFiles": 4, "commits": 3,
    "functions": { "added": 35, "changed": 13, "removed": 2, "moved": 0 },
    "edges": { "added": 56, "removed": 10 }, "callersAffected": 31
  },
  "generatedAt": "2026-10-23T10:00:00Z",
  "ai": { "used": true, "provider": "claude-code", "model": "haiku", "costUsd": 0.04, "notes": [] },  // costUsd null when unknown; used false → text fields come from templates
  "security": {
    "verdict": "findings",                 // "clean" | "findings"
    "counts": { "high": 1, "medium": 1, "low": 0, "info": 0 },
    "rulesRan": ["secrets", "shell-string", "eval-family", "html-sink", "sql-concat", "tls-off", "auth-surface", "deps", "ci-change", "reach", "binaries"],
    "filesScanned": 12, "modelReview": true, "blockCreate": false
  },
  "chapters": [ { "id": "overview", "title": "Overview", "always": false, "steps": [ /* Step */ ] } ],
  "description": { "title": "…", "body": "markdown", "source": "model" },  // source "model" | "template"
  "playback": { "autoplay": false, "seconds": 8 }     // optional, from cograph.tour.autoplay / autoplaySeconds; absent = off, 8 s
}
```

Chapter ids, in default order: `overview`, `map`, `changes`, `blastRadius`, `removed`, `tests`,
`security`, `description`. `overview` is first and `description` last, always; `security` is
always present. A chapter with no content (no removals, no tests) is omitted, except `security`.

```jsonc
// Step
{
  "id": "changes-4", "chapter": "changes", "title": "parseHunkRange", "subtitle": "added · src/vcs/prPatch.ts:12",
  "focus": {
    "nodes": [ { "key": "src/vcs/prPatch.ts::parseHunkRange#1", "file": "src/vcs/prPatch.ts", "name": "parseHunkRange", "line": 12, "kind": "added" } ],
    "folders": ["src/vcs"],              // repo-relative; the layer expands them before the camera moves
    "files": ["src/vcs/prPatch.ts"]
  },
  "camera": { "mode": "fit", "padding": 80 },     // "fit" the focus nodes | "fitAll" | "folders" (the focus folders' frames)
  "effects": {
    "spotlight": true,
    "pulse": "src/vcs/prPatch.ts::parseHunkRange#1",   // a focus key, or null
    "ghosts": [ { "key": "…", "file": "…", "name": "…", "line": 40, "callers": [ "key", "key" ] } ],
    "edges": [ { "source": "key", "target": "key", "kind": "added" } ]   // kinds: added | removed | path
  },
  "card": {
    "kind": "function",      // overview | folder | function | impact | removed | tests | security | description
    "text": "parseHunkRange is new in src/vcs/prPatch.ts. Two functions call it; one test reaches it.",
    "ai": { "text": "Reading order: after openTour, because that is the first caller a reviewer meets.", "risk": "medium", "reason": "…" },   // or null
    "signature": "export function parseHunkRange(h: string)",
    "doc": "…",
    "hunk": { "header": "@@ -0,0 +12,6 @@", "lines": [ { "t": "+", "s": "export function parseHunkRange(h: string) {" } ] },   // t: "+" | "-" | " " ; or null
    "facts": [ { "label": "called by", "value": "2" }, { "label": "tests reaching", "value": "1" } ],
    "findings": null,        // security steps: [ Finding ]
    "list": null,            // impact / removed / tests steps: [ { "key", "file", "name", "line", "note" } ]
    "actions": [ { "id": "open-editor", "label": "Open in editor", "payload": { "file": "src/vcs/prPatch.ts", "line": 12 } } ]
  }
}
// Finding
{
  "id": "f1", "source": "rule", "rule": "shell-string", "severity": "high", "status": "open",
  "title": "Shell command built from a string",
  "path": "src/tour/openTour.ts", "line": 41,
  "evidence": "exec(`git push -u origin ${branch}`)",       // secret values already masked as ••••
  "why": "…", "fix": "…",
  "reach": ["cograph.tourBranch", "prepare", "push"],        // entry point first; [] when none
  "node": { "key": "…", "file": "…", "name": "…", "line": 41 },   // or null for non-source files
  "dismissReason": null                                       // set when status is "dismissed" (model)
}
```

Keys: `relFile::Class.name#n` as `graphDiff.ts` makes them; the layer calls `stageApi.resolve`
with `{ file, name, line }` from the same object.

## 7. Messages and settings on the public side

**Host to panel** `tour-availability`:
`{ type: 'tour-availability', state: 'none' | 'branch' | 'pr' | 'not-bundled' | 'disabled', label?: 'feat/x vs main · 3 commits · 7 files', number?: 104, branch?: 'feat/x', baseRef?: 'main', counts?: { commits: number, files: number } }`.
The pill shows for `branch` and `pr`; `not-bundled` and `disabled` and `none` hide it. Never shown
inside a PR panel (that graph is a pull request; its banner gets a Tour action instead).

**Panel to host** `tour-start {}` (the pill), `tour-dismiss {}` (the ×, for the session).

**Sidebar to host** `vcs-tour { number }` (the Tour button on a pull-request row or card).

**Commands** `cograph.tourPullRequest` (QuickPick of open PRs plus "Your branch vs base"),
`cograph.tourBranch`, `cograph.openInBrowser`.

**Settings** (all `cograph.`): `tour.button` (`auto` | `always` | `never`, `auto`),
`tour.chapters` (string[], the eight in order), `tour.maxStepsPerChapter` (12),
`tour.ai` (`ask` | `on` | `off`, `ask`), `tour.ai.model` (`inherit` | `default` | `opus` |
`sonnet` | `haiku` | `gpt-5-codex` | `gpt-5` | `gpt-5-mini`, `inherit`), `tour.ai.maxBudgetUsd`
(0.5), `tour.ai.readSource` (false), `tour.security.rules` (array, []), `tour.security.allow`
(glob[], []), `tour.security.blockCreateOnHigh` (false), `tour.autoplay` (false),
`tour.autoplaySeconds` (8), `browserView.enabled` (true).

**Team file** `.cograph/tour.json` (private host reads it through `fs` under `api.repoRoot`;
validated with zod, unknown keys ignored, a bad file is one sentence on the overview card):
`{ "version": 1, "chapters": [...], "maxStepsPerChapter": 8, "security": { "rules": [ { "id", "language", "pattern", "severity", "message" } ], "allow": [...], "blockCreateOnHigh": true }, "ai": { "mode": "on", "maxBudgetUsd": 0.25 } }`.
Precedence: `tour.json` > workspace settings > user settings > defaults. `tour.json` cannot set
`ai.mode` to `on` when `cograph.graphIntelligence.enabled` is false (the api's `ai` is null then).

## 8. Fixtures shared by the test suites

- `fixtures/trees/<name>.json`: a recorded `TourTrees` (graphs, diff, commits, changed paths, with
  `dir` paths rewritten to `fixtures/trees/<name>/head` and `/base`, which hold the copied source
  files). Recorded by the public script `scripts/tour-fixture.mjs <pr-number|branch> <outDir>`
  (public session A2 delivers it on day one), from this repository's own pull requests.
- `fixtures/tours/<name>.json`: `TourScript` samples for the web layer; `sample-tour.json` is
  hand-written from section 6 and ships with the skeleton.
- The private end-to-end tests serve the stage from a public checkout given by
  `COGRAPH_PUBLIC_CHECKOUT` (default `../cograph`): `src/webview/*` and `dist/webview/*` after
  `npm run bundle` there.

## 9. Ownership while building (2026-10-23)

| Session | Repository | Owns | Must not edit |
|---|---|---|---|
| A1 `tour-doorway` | public | `src/browserView/*`, `src/webview/browserBridge.js`, `src/graphProvider.ts`, `src/webviewHtmlBuilder.ts`, `src/webview/controls.js` (pill, Open in browser, browser status), `src/extension.ts` (server lifetime), `uxtest/harness` PR fixture for the fake host, `docs/tour-protocol.md` section 4 seams | `src/tour/*`, `src/vcs/*`, `src/webview/stageApi.js` |
| A2 `tour-entry` | public | `src/tour/*`, `src/vcs/*` (prepareDiff, localBranch, Tour button), `src/webview/sidebar-vcs.js`, `src/webview/stageApi.js` (+ its one script tag in `webviewHtmlBuilder.ts`), `src/mcp/graphIndex.ts` adapter, `scripts/tour-fixture.mjs`, `package.json` commands and settings, `src/extension.ts` (command registration) | everything A1 owns except the one script tag and distinct hunks in `extension.ts` |
| B `tour-host` | private | `src/host/**`, `test/host/**`, `fixtures/**`, `README.md` host section | `src/web/**` |
| C `tour-web` | private | `src/web/**`, `test/web/**`, `test/e2e/**`, `README.md` web section | `src/host/**` |

Shared files in the private repository (`package.json`, `tsconfig.json`, `esbuild.mjs`,
`.github/workflows/ci.yml`) belong to the orchestrator; ask by message.
