# Task: Pull requests analysed at their head (N2 option b)

Planner: session-262, 2026-10-07. Base: `termi/s262` @ 8389035 (step (a) shipped there).
Status: **approved by session-110 on 2026-10-07, building.** Three points settled below ("Settled
at approval"). Commissioned by Bela (N2 = analyse the PR head);
(b′) the checkout action is not wanted. Architectural requirement from session-183, relayed
2026-10-07: the engine — fetch a ref, analyse it, diff two graphs — is vscode-free, like `funcBrief.ts`.

## Problem

Step (a) shows a pull request in the graph of **the current checkout**: the PR only supplies which
files changed and their colours, and function-level colours exist only where the checkout's file is
byte-identical to the PR's. Bela wants the graph of **the PR itself**: the tree as it is at the PR's
head, every changed function coloured, and — the real payoff — what the PR adds, removes and changes
structurally: functions gone, call edges gone, who calls the changed code.

## Where the single-workspace-root assumption lives (the risk, named)

`graphProvider.ts` has 84 references to a workspace root. They come from **six lookups** of
`vscode.workspace.workspaceFolders[0]` (`show()` 199, `openTimeline` 694, `showWorkflowGraph` 1120,
`invokeProvider` 1144, `workspaceRoot()` 1387, and the annotation host's `getRoot` 145); the other
78 are locals that carry one of those values into:

| Use | Sites | What it does with the root |
|---|---|---|
| Analysis | `analyzerRunner.run / scheduleReanalysis / runSubset`, `scanStructure` | the directory the analyzers walk; subset parses take absolute file paths under it |
| Disk reads and writes | `getFuncSource`, `saveFuncSource`, `relocateFuncSource`, `navigateTo`, `request-rename-folder`, `request-new-file` | absolute paths from the graph are opened, edited, renamed |
| Persistence | `loadCache` / `scheduleCacheWrite` (`<root>/.cograph/cache`), `save-graph` (`<root>/.cograph/<name>.json`), annotations (`<root>/.cograph/annotations`) | written under the root |
| Git | `gitService.*` (cwd), the `.git/index` watcher, `onDidSaveTextDocument` + `getWorkspaceFolder(doc.uri)` | status, diffs, blame; what triggers a re-parse |
| Scope | `toRel` / `toAbs`, the `subgraph` message's `root` | workspace-relative keys for include lists |
| AI | `invokeProvider`, `libraryDescriber` | cwd for the CLI; the python interpreter is found by venv under the root |

Outside the provider: `extension.ts` (commands), `sidebarProvider.ts` (the saved-graph list),
`analyzerRunner.resolvePythonBin` (venv lookup — correctly the workspace's, even for a head tree),
`annotationService` (`getRoot`), `cacheStore` (`root/.cograph`).

Threading a *second* root through those 84 sites, or teaching each one "which tree am I on", is the
4–6 day estimate and the regression risk: every site is a chance to read the wrong tree, and the
save path writes.

## Design: a second analysis context, not a threaded root

**The PR head is shown by a second `GraphProvider` instance whose root IS the materialised head
tree, in its own panel.** One root per provider, as today; nothing inside the provider learns about
two trees. The head provider is read-only.

```
  sidebar click ─► PrController.openHead(pr)              (vscode, thin)
                      │  progress UI, storage dir, AnalyzerRunner-backed analyzer
                      ▼
  ┌─ src/vcs/engine/ (NO vscode import) ───────────────────────────────────────┐
  │ headTree.ts    fetch refs/pull/N/head → materialise the ANALYSABLE files   │
  │                of that commit into <storage>/<repo>/<sha>/ (git only, no   │
  │                tar, no worktree, the user's index untouched)               │
  │ treeAnalysis.ts  AnalyzedTree = { root, tree, graph } for a directory,     │
  │                through an injected analyzer function                       │
  │ graphDiff.ts   pure: two AnalyzedTrees → StructuralDiff (functions added / │
  │                removed / changed, edges added / removed, callers of what   │
  │                changed), keyed by repo-relative path + name, never by id   │
  │ diffStatuses.ts  pure: StructuralDiff → the GitStatusOverride the graph    │
  │                already colours from                                        │
  └────────────────────────────────────────────────────────────────────────────┘
                      │
                      ▼
  new GraphProvider(context, { root: headDir, readOnly: true })  ← own panel, own cache,
       gitService.setOverride(diff statuses)                        own (empty) annotations
```

Why a second instance and not a mode: the provider already does everything right for *one* root —
structure, lazy parses, cache, scope, hover, popups, Shelf frames. Pointing a fresh instance at the
head directory reuses all of it with a one-method change, and the main panel is never touched, so
"getting back out" is closing a tab. It also matches how a PR reads: a document of its own, next to
the project.

**What two live trees mean, concretely:**

- **Cache.** Each provider writes under its own root: the workspace cache as today; the head
  provider under `<storage>/<repo>/<sha>/.cograph/cache`. A head sha is immutable, so that cache is
  valid forever — reopening the same PR head paints instantly. The workspace cache is never written
  by the head provider (different root, by construction).
- **Annotations.** The head provider's annotation host resolves to the head directory, finds no
  `annotations` file, and shows nothing: no AI summaries on a PR head in this step, and nothing is
  written. (Mapping the workspace's summaries onto unchanged files by relative path is a later
  nicety.) The Annotate command stays bound to the main provider in `extension.ts`.
- **Git service.** The head provider has its own `GitService`; the materialised directory has no
  `.git`, so `git status` fails there and the colours come from the override, which is set before
  the panel opens. The `.git/index` watcher never fires for it. The on-save listener is skipped for a
  read-only provider — otherwise saving a workspace file would re-analyse the head tree.
- **Memory / CPU.** One extra graph in memory and one full analysis per head sha (1.4 s on this
  repository's 1 600 functions in the lab; tens of seconds on a large one — behind a progress
  notification, cancellable, and then cached).

**Materialisation** (`headTree.ts`): `git fetch origin +refs/pull/N/head:refs/cograph/pr/N`
(GitHub serves that ref for fork PRs too; the ref is namespaced so the objects are kept and nothing
of the user's is touched), `git ls-tree -r` to list the commit, keep only analysable paths
(`isAnalyzablePath`), then `GIT_INDEX_FILE=<tmp> git read-tree <sha>` + `git checkout-index
--prefix=<dir>/ --stdin` for those paths. No tar, no `git worktree` entry, the user's index never
changes. A marker file makes a half-written directory restartable. Size guard: above 50 000 analysable
files it refuses with a sentence. Kept within the budget below (6 trees / 400 MB, LRU).

**Colours.** Step 1 colours the head tree from the PR's file list and patches (what (a) does) — but
now exact for every file, because the tree *is* the head. Step 3 replaces that with the structural
diff: added / removed / changed **functions**, decided by comparing each function's source between
base and head, not by line numbers.

**Base for the diff**: the **merge base** of the head and the base branch (`git fetch origin
<baseRef>`, `git merge-base`), materialised and analysed the same way. That is what GitHub diffs
against. If the base cannot be fetched, the diff falls back to the workspace's own graph with the
banner saying so — the same honesty rule as (a).

**Step (a) stays** as the fallback the sidebar offers when the head cannot be fetched (offline, no
git, too large, no access): "Show in the current checkout instead".

**Removed functions** exist in the base graph only. Step 3 lists them in the sidebar with their
former callers; drawing them as ghost nodes in the head graph is a later step, not this plan.

## The vscode-free boundary (session-183's requirement)

- `src/vcs/engine/*.ts` import `fs`, `path`, `child_process` (through the injected `Exec`) and the
  **types** `GraphData` / `StructureTree`. No `vscode`, no `GraphProvider`, no `AnalyzerRunner`.
- The analyzer is injected: `type TreeAnalyzer = (dir: string) => Promise<GraphData>`. The VS Code
  caller wraps `AnalyzerRunner`. A CLI or the MCP server passes its own (the analyzers are plain
  scripts under `scripts/`; a vscode-free `spawnAnalyzers(dir, { scriptsDir, pythonBin })` can be
  lifted out of `AnalyzerRunner.runOnce` when that consumer exists — noted, not part of this plan).
- `StructuralDiff` is keyed by repository-relative POSIX path and function name, so it is
  meaningful without either tree on disk and can be serialised (an MCP answer, a CI comment).
- The thin caller (`src/vcs/headRun.ts`, vscode): progress notification with cancel, the storage
  directory from `context.globalStorageUri`, the second provider, the sidebar messages.

## GraphProvider changes (the only shared-file edits)

| Change | Size |
|---|---|
| constructor `opts?: { root?: string; readOnly?: boolean }`; `workspaceRoot()` returns the override; the five inline `workspaceFolders[0]` lookups and the annotation host's `getRoot` call `this.workspaceRoot()` | ~10 lines |
| `readOnly`: skip the save listener and the index watcher; refuse `save-func-source`, `request-rename-folder`, `request-new-file`, `save-graph` with one sentence each | ~8 lines |
| `navigateTo` on a read-only provider opens the file and marks the editor read-only for the session | 2 lines |

Nothing else in the provider changes. The PR-view enter/exit code from (a) is untouched and keeps
serving the fallback.

## Cheaper 80 % — and what it costs

**Changed files only at head**: fetch just the PR's files at the head blob, run the subset analyzer
on them, splice them into the workspace graph the way an on-save re-parse does. ~1 day. **Not
recommended**, and here is the exact cost: subset analysis resolves calls only against definitions
in the files it parsed (`collectCalls(files, definitions)` in every analyzer), and `spliceFiles` drops
every edge touching a replaced node. So every call edge between a changed file and an unchanged
one is lost in both directions — which is precisely "who calls the changed code", the thing a
reviewer looks at. It also shows the workspace's version of every unchanged file, so a PR branched
from an older main gets a tree that never existed. The same limitation already makes the on-save
incremental path lossy; building the PR view on it would make the loss the headline.

**Full head analysis, workspace as the diff base** (skip the merge-base materialisation): saves
about a day. Correct only when the checkout sits at the merge base; otherwise functions the
workspace has moved on from show as "changed by the PR". Kept as the automatic fallback when the
base cannot be fetched, with the banner saying so, not as the design.

## Steps

| # | Step | Effort |
|---|---|---|
| 1 | `engine/headTree.ts`: fetch, list, materialise analysable files, marker, size guard, keep-3. Tests on a real temporary git repository with a fake "origin" (no network) | 1 d |
| 2 | `GraphProvider` root / read-only option; `headRun.ts` thin caller with progress and cancel; `PrController.openHead`; sidebar states (fetching, analysing, open, failed → "Show in the current checkout instead"); colours from the PR's files, exact | 1 d |
| 3 | `engine/graphDiff.ts` + `diffStatuses.ts`: keys, added / removed / changed functions by source text, edges, callers of changed. Pure tests on two fixture trees | 1 d |
| 4 | merge-base fetch + analysis; diff-driven colours; sidebar: removed functions with former callers, changed-function counts; banner says base + head shas | 1 d |
| 5 | Reviewer pass, lab run on PR #68 / #69, real VS Code click-through request to 181, docs, CHANGELOG | 0.5 d |

4.5 days. Steps 1 and 3 are pure and can be reviewed on their own; 2 needs 1; 4 needs 1–3.

## Risks

- **Analyzers on a partial tree.** Only analysable files are materialised; the TypeScript analyzer
  parses files one by one (no `tsconfig`, no `node_modules` resolution), Python and Java likewise,
  so a source-only copy analyses the same as a full checkout. Verified by reading `analyze_ts.js`;
  the step-1 tests compare a materialised analysis against the full checkout's on this repository.
- **Fork PRs / GHE / no `origin`.** `refs/pull/N/head` is GitHub's; the remote is whatever `gh`
  resolved. A repository whose GitHub remote is not called `origin` is read from `git remote`.
- **Windows.** `checkout-index --prefix` with forward slashes; paths from `ls-tree` are POSIX and
  are joined with `path.join`. The step-1 tests run on CI's three OSes.
- **Disk.** Source-only copies are small (this repository: ~2 MB); three per repository are kept.
- **Two panels.** `cograph.saveGraph` and the sidebar act on the main provider only, by design;
  the head panel's title says `PR #69 · head` so the two are not confused.
- **Time.** Fetch is network-bound; analysis is CPU-bound; both are behind one cancellable
  progress notification, and a cancelled run leaves nothing half-shown.

## Settled at approval (session-110, 2026-10-07)

1. **Is a source-only copy enough for the analyzers?** Checked in every analyzer: `analyze_ts.js`
   and `analyze_js.js` call `createSourceFile` per file and never `createProgram`, read no
   `tsconfig.json` / `package.json` and resolve no modules; `analyze.py` parses each file's AST and
   touches no `sys.path`; `analyze_java.js` and `analyze_cpp.js` read each file and follow no
   classpath or `#include`. So the copy needs exactly the files the structure tree shows, and
   nothing else. Measured on this repository's HEAD: the copy (249 of 335 files, 2.7 MB) analyses to
   1 639 nodes / 2 500 edges, identical to the full checkout, zero differences either way. Step 1's
   tests repeat that comparison on a temporary repository with Python, Java and C++ files next to
   TypeScript, and fail if a single node differs. Known, accepted difference: source under a folder
   the structure scanner skips (`build/`, `target/`) is not copied; it is not in the graph's tree in
   the workspace either.
2. **Disk budget.** `<globalStorage>/pr-heads/<repo>/<sha>/`, each with a marker carrying size and
   last use. Kept: at most **6 trees** and **400 MB** across all repositories, least recently used
   evicted first; evicted on activation and after every materialisation. A command **CoGraph: Clear
   pull-request trees** empties it. A single tree above **50 000 analysable files** is refused.
3. **How (a) and (b) relate.** One click = (b): the PR's head opens in its own read-only panel titled
   `PR #69 · head 23834be` with a banner `PR #69 · head 23834be · base 1fc1156`. When the head
   cannot be fetched (offline, no git, too large, no access) the row explains why and offers one
   button, **Show in the current checkout instead**, which is (a); (a)'s banner now reads
   `PR #69 · in your checkout (branch …)` so a graph is never of uncertain origin. No setting, no
   choice up front.

## Step 1 outcome (2026-10-07) — why the source-only copy generalises

**The analyzers never resolve modules.** `analyze_ts.js` / `analyze_js.js` call `createSourceFile`
per file and never `createProgram`; calls are linked by name against the definitions collected from
the walked files (`collectCalls(files, definitions)`). So `tsconfig.json` (`paths`, project
references), `package.json` workspaces and `node_modules` cannot change the graph: there is no
resolution step for them to feed. Python parses each file's AST with no `sys.path`; Java and C++
read each file with no classpath or `#include` following. A copy that holds every file an analyzer
would walk therefore analyses identically to the full checkout — the only way to get a different
graph is to copy a different set of files, which is what the regression test guards.

Measured, copy vs full checkout at HEAD, nodes and edges, zero differences either way: this
repository (1 639 / 2 500); excalidraw, `tsconfig` `paths` + `package.json` workspaces (3 091 /
6 597, 652 files, 7.3 MB, 70 ms to copy); nest, monorepo (4 347 / 4 049); flask (1 623 / 1 184);
gson (3 601 / 3 926); fmt (5 171 / 11 555).

## Finding for session-110 (not mine to fix): the structure scanner and the analyzers disagree about what is in the project

Found by step 1's regression test on its first run: a copy made by the structure scanner's rule
(`isAnalyzablePath`) lacked `build/gen.ts`, which the full checkout's analysis contained. The
scanner (`structureScanner.ts`) skips `node_modules`, `out`, `dist`, `target`, `build`,
`CMakeFiles`, `cmake-build-*` and dot-directories for **every** language. Each analyzer has its own,
smaller skip list:

| Language | Analyzer walks but the scanner does not | Scanner shows but the analyzer does not |
|---|---|---|
| TypeScript, JavaScript | `build/`, `target/`, `CMakeFiles/`, `cmake-build-*/` | — |
| Python | `build/`, `target/`, `CMakeFiles/`, `cmake-build-*/` | `__pycache__/` (scanner shows `.py` there; analyzer skips it) |
| Java | `CMakeFiles/`, `cmake-build-*/` | — |
| C++ | — (`analyze_cpp.js` skips `cmake-build-*` too, lines 100-102: it matches the scanner exactly) | — |

Consequence in the shipped product: a `.ts` file under `build/` has functions in the graph but no
place in the Folder panel's tree, so it is not drawn in the drill-down, cannot be hidden, scoped or
included in a subgraph (all expressed in scanner terms), and its nodes only appear in the flat
Global graph. The reverse case (`__pycache__`) shows a file in the tree with no functions ever
arriving. One rule, in one place, used by both, would end it. Example to reproduce: `build/gen.ts`
with one function; `analyze_ts.js <root>` lists it, `scanStructure(root)` does not.

The PR head copy is unaffected (it copies by the analyzers' rule, `analyzerKeepsPath`). This is
**F30**, owned by session-215, whose fix makes the scanner own one rule and the analyzers consume
its file list; `analyzerKeepsPath` then becomes a call into that rule, and the head-vs-checkout
regression test is the thing that will say when the two have drifted.

## Outcome (2026-10-07) — steps 1–4 built

Built as designed. Measured on PR #69 of this repository, real `gh`, git and analyzers: first open
6.0 s (fetch the head 1.3 s, copy 236 files, analyse 1.2 s, fetch the base 1.4 s, analyse 1.4 s,
diff), second open 3.3 s (both analyses from the copies' caches; the two fetches stay, a PR head
moves). Diff of #69 against its merge base 1fc1156: 35 functions added, 13 changed, 0 removed, 56
call edges added, 10 removed, 31 callers affected — the changed list names `GraphProvider.
saveFuncSource` and `sourceEditor.getFuncSource`, which is what that PR did.

Full suite in VS Code 1.116: 1 368 passing. Not verified: a click-through in a real VS Code window
(session-181), Windows and macOS (CI), a GitHub Enterprise host, a fork PR whose base repository
is not the fetch remote.

Review notes for the engine boundary: `src/vcs/engine/*` imports `fs`, `path`, `crypto`, the
`cacheStore` and `structureScanner` modules (both vscode-free) and types; `headAnalyzer.ts` and
`extension.ts` are the only files that know about `AnalyzerRunner` and `vscode.window.withProgress`.

## What the user's `.git` looks like after fifty pull requests (settled in step 5)

Each opened PR fetches into `refs/cograph/pr/N` and each base branch into
`refs/cograph/base/<branch>`; the fetched objects are reachable only through those refs. A tree's
marker records the refs that brought it, with their values at the time. **Eviction deletes the
ref with the tree**, as `git update-ref -d <ref> <value>` — which refuses when the ref has since
been re-pointed (the same PR re-pushed and reopened), so a newer tree never loses its ref to an
older one's eviction. **Clear** deletes every tree's refs and then sweeps `refs/cograph/*`.

So after fifty PRs with the 6-tree budget: at most six trees under global storage, at most six
`refs/cograph/pr/*` plus the base refs those six trees name (typically one, `base/main`), and the
objects of the forty-four evicted heads unreachable — `git gc --auto`, which git runs on its own
during normal use, reclaims them. Nothing under `refs/heads`, no worktree entries, the index never
written. The only trace of an evicted PR is in the reflog-free `refs/cograph` namespace, which is
empty for it.

## After session-181's click-through (2026-10-07)

- **B, data integrity.** A copy's files now open as documents of the `cograph-pr` scheme through
  a `TextDocumentContentProvider`: read-only by construction (lock on the tab, no edit accepted,
  no click or command makes them writable), served only from under the copies' storage, with the
  panel title in the URI path so the tab's hover and description read `PR #69 · head 23834be`.
  The earlier `setActiveEditorReadonlyInSession` was a race on whichever editor was active and is
  gone. And the question that mattered: **yes, a save into the copy would have been reused** —
  reuse only checked for a marker, and the analysis cache is keyed by mtime, so an edited copy
  would have been re-analysed into a "PR head" graph that was not the head. Every copy now
  carries a fingerprint (path, size, mtime of every file) in its marker; a copy whose fingerprint
  no longer matches is discarded and copied afresh, and a marker without one never passes. The
  copy is not made unwritable on disk: `fs.rm` on a read-only file is unreliable on Windows, and
  the two measures above cover both ways in (CoGraph's own navigation, and anyone else's editor).
- **A, layout** (second round: opening one of the PR's files squeezes the panel to ~396 px, and
  shrinking cannot go below content). The banner is two rows: name and chip on the first (the
  chip goes below 300 px of banner width — the name already says which tree), the summary or
  warning **always on its own row**, so it can never render at 0 px; a warning leads its sentence
  and wraps instead of ellipsizing; Leave has a fixed slot at the right edge, and below 300 px a
  row of its own at the bottom. Measured in the lab: at 396 px Leave at 281–329 inside the banner,
  the amber line fully readable over four lines; at 561 px over two lines; nothing over the
  Engine row at either.
- **C.** The function popups of a head panel take no edits (textarea read-only, with the reason as
  tooltip), and a read-only panel never shows a dirty dot.
- **Cancel wording.** A cancel after the copy says "Cancelled. The copied files are kept, so the
  next open is faster." Correction to the earlier answer: a cancel during the *base* analysis keeps
  **two** copies, head and base. Clear now reports trees, MB and refs.
- **GitHub Enterprise.** The sign-in message and the Sign in… button use
  `gh auth login --hostname <host>` when the remote is not github.com.

## Panel consistency (session-110's ruling, 2026-10-07)

Clicking a pull request always opens a panel of its own; the user's graph is never taken over.
The checkout fallback is now a second provider on the workspace root — read-only in the panel
(a PR view is transient; editing belongs to the main panel), navigation opening the user's real
files — titled `PR #73 · your checkout`. Leave, from the banner or the sidebar, closes a PR panel
(`closeOnLeave`); there is nothing to go back to. The in-place PR view on the main panel remains
as the mechanism every PR panel uses internally, and as the behaviour on hosts without a panel
factory (tests without global storage). Cost: under half a day.

## Reviewer pass over (a) + (b) as one diff (2026-10-07)

Read cold by a second reader with no stake in the code, then fixed. What would have been rejected:

1. **Windows was broken.** `defaultExec` ran git and gh through cmd.exe, which eats the `^` in
   `rev-parse <ref>^{commit}` (every head open: "does not exist on the remote") and splits
   `--prefix=C:/Users/John Doe/…` at the space. No shell any more: both are real executables.
2. **A regression from the same day:** since both panel kinds opened labelled documents, the
   checkout panel's refusal read "shows a copy of a commit" — false — and the branch meant for it
   was dead. The caller now supplies the sentence per kind.
3. **Host and webview disagreed on the checkout panel:** the host refused edits, the webview's
   popups accepted them (read-only was inferred from the tree kind). The host now puts `readOnly`
   on the `pr-view` message; the kind is only the fallback.
4. **A chip tooltip promised editable files** one commit after they became labelled read-only
   views. Rewritten.
5. **An analyzer crash yielded an empty graph that was diffed**, painting every function as added
   or removed with a confident summary. Empty plus a failed analyzer is now a failure.
6. **The head view died on a second `gh` round-trip** (the file list) after git and the engine had
   already done their work. With a diff in hand the list is derived from the diff instead.
7. One "CoGraph" output channel per PR panel, a provider retained after its tab was closed, a base
   dir carried from a failed open into the next panel, a closed panel's debounced cache write
   racing eviction, an unbounded map of fetched texts, an unvalidated host name typed into a
   terminal, `%` rejected in file names, head-panel wording that mentioned a checkout, the open
   PR's card vanishing from the sidebar after a filter change — all fixed; `analyzeTree` and
   `HeadTreeDeps.budget` removed as dead.
8. **Engine independence at the type level:** `graphDiff`, `diffStatuses` and `treeAnalysis` took
   their types from `graphProvider.ts` / `gitService.ts`. They now have `engine/types.ts`. One link
   remains through `cacheStore.ts`, which types its graph from `graphProvider.ts`; moving
   `GraphData` into a vscode-free module is a shared-file change for its owner.

Not fixed, written down: cross-window eviction (a second VS Code window can evict a tree the first
is showing; the budget is global), `createTreeAnalyzer` relies on the runner reaching a sink (it
does today), case-sensitive path comparison in `prDocumentFile`, `marker.bytes` not counting the
analysis cache written later.

## Not in this plan

Ghost nodes for removed functions, workspace annotations mapped onto the head, a vscode-free
`spawnAnalyzers`, the CI comment tool and the MCP impact query (both consumers of the engine, not
part of it), the (b′) checkout action.
