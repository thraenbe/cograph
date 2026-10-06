# Task: Version Control view — pull requests that open as a scoped, coloured graph

Planner: session-262, 2026-10-06. Base: `main` @ e7103a6 (`termi/s262`).
Status: **plan sent; building the parts no open question blocks** (Bela: "plan and implement").
Brief: `.termi/briefs/vcs-pr-graph.md`. Decision behind it: M3 on the decision board, 2026-10-06.

## Problem

The sidebar's main surface was the Chat, which is being removed (session-214). Bela wants a
Version Control view in its place:

- it lists the repository's pull requests;
- clicking one opens that PR's changed files in the call graph;
- folders without changes are collapsed, folders with changes are expanded down to the changed
  files;
- changed files are marked green (added), orange (modified) or red (deleted).

Nothing in CoGraph knows about pull requests today. The pieces it would be built from exist:
host-side scope (`subgraphScope.ts`, `GraphProvider.setScope`), drill-down expansion
(`state.expandedFolders`), and git colouring (`gitService.ts` → `gitStatus` / `fileGitStatus` →
`colors.js`, the slot and file-circle strokes).

## What I found that changes the brief's assumptions

1. **A subgraph does not collapse what is out of scope — it removes it.** `frameFolderVisible` /
   `memberInScope` (`scope.js`) drop every folder that does not touch an include; the folder then
   appears under FILTERS with a "Visualize" button. "Collapsed" in Bela's sentence is a different
   thing: the folder stays in the picture as a closed glyph. That is `state.expandedFolders`, not
   scope. Both are cheap; which one he means is question **N4**.
2. **Scope is folder-granular.** An include is a folder and all its descendants. A PR that touches
   `src/a.ts` puts every file of `src/` in view, changed or not. (Excludes cannot fix this nested:
   the host resolves "nearest listed entry wins", the webview's `frameFolderVisible` lets any
   exclude above kill an include below. v1 never writes excludes, so nobody noticed. I do not rely
   on it and do not fix it here.)
3. **An open, parsed folder shows every file's functions.** There is no "collapsed file" state after
   parsing. So "expanded down to the changed files" means: the path of folders is open, the changed
   files carry the colour, their unchanged siblings sit next to them uncoloured. That is how the
   working-tree git colours already look.
4. **The structure tree only holds source files** (py / ts / js / java / cpp). A PR's `README.md`,
   `package.json` or `.css` changes cannot appear in the graph. The sidebar says how many of a PR's
   files are in the graph and how many are not, instead of silently dropping them.
5. **"Deleted" is grey today** (`--cograph-git-deleted: #777`), not red. The PR view sets it red.
6. `gh` gives everything in two calls and no token of ours: `gh pr list --json …` and
   `gh api --paginate repos/{owner}/{repo}/pulls/N/files` (path, status, previous name, blob sha,
   patch). Verified here against PR #68 / #69 with gh 2.46.

## Design

**Rule the view applies: everything on a path to a changed file is open, everything else is
closed, and only the PR's diff decides the colours.**

```
sidebar-vcs.js ──vcs-*──▶ VcsSidebar (host) ──▶ PullRequestSource (gh)      N1 lives behind this
                               │
                               ▼ files of PR #n
                          buildPrView()  pure: files + structure tree + blob hashes
                               │   → scope spec, folders to open, file statuses, hunks, counts
                               ▼
                    GraphProvider.showPullRequest()
                      gitService.setOverride(statuses)      colours come from the PR, not `git status`
                      setScope({source:'pr', name:'PR #n …'})   existing subgraph path, existing exit
                      post `pr-view`                         webview opens the folders, shows the banner
```

- **One narrow source interface** (`src/vcs/types.ts`): `list(root, {state, limit})` and
  `files(root, number)`, both returning `{ok:true,…} | {ok:false, problem}`. `GhCliSource` is the
  only implementation; a token-based one can be added without touching the view (N1).
- **Every failure is a state, not an exception**: `not-a-repo`, `no-remote`, `not-github`,
  `gh-missing`, `gh-unauthenticated`, `no-access`, `offline`, `error`. Each has one readable row and,
  where it helps, one action (Install GitHub CLI / Sign in / Retry).
- **Hundreds of PRs**: 50 per fetch, "Show more" raises the limit, a filter box narrows what is
  loaded. Check status comes in the same call; if that query fails it is retried without checks.
- **Colours** reuse the existing pipeline unchanged. `GitService` gets an *override*: while a PR
  view is open, `applyGitStatuses*` annotate from the PR's file statuses and hunks instead of
  running `git`. Every existing call site keeps working, including lazy folder parses and the
  on-save refresh.
- **Function-level colours only where they are true** (N2a). The files endpoint returns each file's
  blob sha at the PR head. If the file in the checkout hashes to the same blob, the patch's line
  numbers are exact and functions are coloured individually. If not, only the file is coloured and
  the banner says so. No guessing with shifted line numbers.
- **Files that are not in the checkout** (added in the PR while you are on the base, or deleted
  while you are on the head) cannot be drawn. They are counted and listed in the sidebar; the graph
  is unaffected.
- **Scope carries the PR view's identity.** `Scope.source` gains `'pr'`. With N4 = collapse the spec
  is `include: ['.']` (nothing filtered, but the Folder panel shows "Subgraph: PR #69 …" and its
  "Show whole project" button is the exit). With N4 = hide the spec is the folders that contain
  changed files. Same code, one branch.
- **Getting back out** goes through the existing `subgraph-exit`. `exitScope()` sees `source ===
  'pr'` and hands over to the controller, which drops the override, restores the scope that was
  active before (also a saved subgraph), the panel title and the saved-graph path, and re-sends
  working-tree statuses. The webview restores the expansion, detail depth and frame rects it
  snapshotted on entry through the saved-layout path (`applyPendingLayout`).
- **Transient** (brief point 4 — I agree). A PR moves; a saved PR view would be a stale snapshot
  with working-tree colours. Save inside a PR view is refused with one sentence. Nothing is written
  to `.cograph/`.
- **No credentials of ours.** `gh` is run with an argument array, never through a shell; the only
  values that reach it are an integer PR number, an integer limit and an enum state — never a string
  from the webview. PR titles and author names are remote text: the sidebar builds rows with
  `textContent`, the graph banner escapes.

## N2 — which tree is analysed

**(a), step one, built now:** the current checkout is analysed; the PR supplies the file set and the
colours. Cheap, offline once the list is loaded, and honest because of the blob-hash check above:
when the checkout *is* the PR (or already contains it, e.g. after the merge) you get exact
function-level colours; otherwise you get file-level colours and a line saying which branch you are
looking at.

**(b), separate later step — what it costs.** Analysing the PR's head means fetching it
(`git fetch origin pull/N/head` — network, and objects written into the user's repository),
materialising a tree that is not checked out (a detached `git worktree` or an archive extracted
under the extension's storage: a full copy per PR, to be cleaned up), running the whole analyzer on
it (tens of seconds on a large repo, cacheable per head sha), and then teaching `GraphProvider` that
the graph's root is not the workspace: every absolute path in the graph points into the copy, so
navigate, the function popup's edit/save, on-save re-parse, the `.git/index` watcher, the graph
cache and annotations all need a "virtual root, read-only" mode. That is the expensive part — the
provider assumes one workspace root in ~40 places. Estimate **4–6 days** plus a real risk of
regressions in the save path. Its true payoff is not seeing the head's files (a checkout does that)
but diffing base graph against head graph: removed functions and removed calls. I would only build
it if Bela wants to review without switching branches.

**(b′), the cheap bridge, ~0.5 day, needs Bela's yes:** a "Check out this PR" action
(`gh pr checkout N`, refused on a dirty tree, confirmed first). After it the checkout is the head
and (a) is exact. It changes the working tree, so it is not something I add unasked.

## Open questions

| # | Question | My default (built unless told otherwise) |
|---|---|---|
| N1 | PR list from `gh` or from the GitHub API with a token? | **`gh`**, behind `PullRequestSource`. |
| N2 | Current checkout (a) or the PR's head (b)? | **(a)** now. Wants (b′) "Check out this PR"? Wants (b) at all? |
| N4 | Folders without changes: still visible but **collapsed**, or **removed** from the view (listed under FILTERS, like a subgraph)? | **Collapsed** — it is the word Bela used, and the closed folders keep the edges that show who else calls the changed code. Switchable with `cograph.pullRequests.unchangedFolders` (`collapse` / `hide`) until he rules; then the setting goes. |
| N5 | Which PRs: open only, or also merged / closed? | **Open**, with an Open / All switch in the header. |
| N6 | Pane title | **"Pull Requests"** inside a pane the brief calls Version Control — tell me if it should read "Version Control". |

Not mine: N3 (MIT or premium). Everything is in `src/vcs/**` plus two webview modules, so a later
split is mechanical.

## Steps

| # | Step | Blocked by | Effort |
|---|---|---|---|
| 1 | `src/vcs/types.ts`, `prPatch.ts` (patch → changed line ranges), `ghCliSource.ts` (list, files, problem classification), tests with a fake exec | — | 0.5 d |
| 2 | `src/vcs/prView.ts` — pure `buildPrView()`: statuses, exactness by blob hash, folders to open, scope spec, counts. `GitService.setOverride`. Tests | — | 0.5 d |
| 3 | `GraphProvider.showPullRequest` / exit / transient save, `src/vcs/prController.ts`, `ScopeSource 'pr'`. Tests in the style of `graphProviderScope.test.ts` | — | 0.5 d |
| 4 | `src/webview/prView.js` — `pr-view` message: open the folders, snapshot / restore, banner with Exit, red for deleted. Tests (jsdom) | — | 0.5 d |
| 5 | `src/vcs/vcsSidebar.ts` + `src/webview/sidebar-vcs.js` — the pane, every empty / error state, filter, Show more, active-PR detail. Tests | N5 / N6 cosmetic only | 0.75 d |
| 6 | Reviewer pass, `git merge main`, full suite, CHANGELOG `[Unreleased]`, README paragraph | s214's Chat removal for the final sidebar slot | 0.25 d |
| later | (b′) checkout action | N2 | 0.5 d |
| later | (b) head-ref analysis | N2 | 4–6 d |

Nothing in 1–5 depends on N1/N2 beyond the defaults; N4 is one branch in `buildPrView`.

## Files touched

New (mine): `src/vcs/{types,prPatch,ghCliSource,prView,prController,vcsSidebar}.ts`,
`src/webview/prView.js`, `src/webview/sidebar-vcs.js`, `src/test/suite/vcs*.test.ts`.

Small edits to shared files:

| File | Change | Size |
|---|---|---|
| `src/gitService.ts` | `setOverride()`; the two `applyGitStatuses*` use it | ~20 LOC |
| `src/subgraphScope.ts` | `ScopeSource` gains `'pr'` | 1 line |
| `src/graphProvider.ts` | `showPullRequest`, `exitPullRequest`, three one-line hooks (exit, dispose, save guard), `pr-view` after `subgraph` in `loadGraphHtml` | ~35 LOC, logic lives in `prController.ts` |
| `src/sidebarProvider.ts` | a mount `<div>`, a `<script>` tag, forward `vcs-*` messages | ~10 LOC |
| `src/extension.ts` | construct and wire `VcsSidebar` | ~6 LOC |
| `src/webviewHtmlBuilder.ts` | `prView.js` appended to the script list | 2 lines |
| `src/webview/main.js` | one `pr-view` branch in the message handler | 3 lines |
| `src/webview/fileClusters.js` | `setInitialDetailDepth` yields to an active PR view | 2 lines |
| `package.json` | the N4 setting, appended at the end of `configuration` | 1 entry |
| `CHANGELOG.md` | `[Unreleased]` | — |

Deliberately **not** touched: `frameRender.js`, `rendering.js`, `styles.css`, `popups.js`,
`hoverCard.js`, `crossLinks.js` (session-216), the chat code (session-214), the "Open Chat" button
(session-183). The banner and the red "deleted" colour are set from `prView.js` (an injected style
element and a CSS variable), not from `styles.css`.

One thing I would like from session-216 later, not needed for this to work: the file-slot stroke in
`frameRender.js:1290` and the file circle in `folder.js:339` colour `added` and `modified` but not
`deleted`. A deleted file that still exists in the checkout shows red function nodes inside an
uncoloured slot. One `else if` each.

## Merge with session-214

214's working copy replaces the Chat pane with `<div class="pane pane--primary" id="pane-primary"
hidden>`. My pane mounts into an element by id and builds its own DOM and styles, so the merge is:
put my mount inside `#pane-primary` and drop `hidden`. Until 214 lands, my branch shows the pane
above the Chat.

## Risks

- **`gh` output drift.** Only documented `--json` fields and the REST files endpoint are used;
  parsing is tolerant (unknown status → `modified`, missing patch → file-level colour).
- **Large PRs.** The files endpoint stops at 3000 files and omits patches for big files. Both
  degrade to file-level colour; the sidebar says when a list is truncated.
- **Renames.** Coloured `modified` at the new path; at the old path when only that one exists in the
  checkout.
- **Line endings.** A CRLF checkout does not hash to the PR's blob → file-level colour. Correct, if
  conservative.
- **Exact restore on exit.** Expansion, depth and frame rects are restored through the saved-layout
  path; a user who switches the layout engine *inside* the PR view gets the engine they switched to.
- **Stale list.** No polling. The list is as fresh as the last Refresh; the header shows when.

## Test strategy

Unit, no network, no real `gh`: patch parser (pure insert, pure delete, mixed, multiple hunks, no
newline marker); `GhCliSource` with a fake exec for every problem state and the checks fallback;
`buildPrView` over a temp tree (collapse / hide, renames, missing files, non-source files, exact
versus file-level by blob hash, Windows separators); `GitService` override; `GraphProvider` enter →
exit restores scope, title and statuses, and Save is refused; `prView.js` and `sidebar-vcs.js` under
jsdom (expansion set, snapshot / restore, every list state, escaping of a hostile PR title).
Manually: this repository's own PRs #68 / #69 in a real VS Code window.

## Out of scope

Reviewing (comments, approvals, merging), GitLab / Bitbucket / Gitea, a diff viewer, PR creation,
(b) and (b′) until N2 is answered, the MCP server, the Chat removal, the hover card.
