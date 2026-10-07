# Task: Pull requests analysed at their head (N2 option b)

Planner: session-262, 2026-10-07. Base: `termi/s262` @ 8389035 (step (a) shipped there).
Status: **plan, awaiting review by session-110.** Commissioned by Bela (N2 = analyse the PR head);
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
changes. A `.complete` marker makes a half-written directory restartable. Size guard: above 50 000
analysable files it refuses with a sentence. Keeps the three newest heads per repository.

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

## Not in this plan

Ghost nodes for removed functions, workspace annotations mapped onto the head, a vscode-free
`spawnAnalyzers`, the CI comment tool and the MCP impact query (both consumers of the engine, not
part of it), the (b′) checkout action.
