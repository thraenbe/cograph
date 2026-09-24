# Task: Round 3 — subgraphs and "Only visualize folder" (host + sidebar side)

Planner: session-178, 2026-09-24. Base: `develop` @ 7d91c5d merged into `termi/s178`.
Status: **plan only, no code. Waiting for approval.** Webview side: session-111 (`round3-webview`).

## Problem

CoGraph can only show the whole project. The review verdict was "not useful". Bela wants
partial visualisation as a first-class flow:

- **Command** `CoGraph: Only visualize folder…` — pick one folder, see only that.
- **Subgraph** — a persisted selection of folders, created from the sidebar with an explorer-like
  picker, listed next to the saved graphs, opened like one.
- Folders left out of a subgraph stay listed in the panel's Filters, one click brings one in.

Today the host has no notion of scope: `show()` scans the whole workspace, sends the full
structure and the full (cached) graph, every `expand-folder` and on-save re-parse is unscoped,
and a saved layout is positions + view settings only.

## Ownership (from the brief)

Mine: subgraph model and file format, the command, the sidebar button and picker, host-side
scoping of graph / patch / git data, the scope protocol (proposed here, reviewed by session-111).
Session-111: everything the graph webview does with the scope (remove excluded frames, Filters
panel with "Visualize", root handling), hide-entirely, collapsed-glyph names.

## Decisions to confirm (product questions, with my recommended default)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Picker: sidebar webview tree, or VS Code QuickPick (`canPickMany`)? | **Sidebar tree picker.** QuickPick is a flat list: no expand/collapse, no tri-state parents, no per-row counts beyond a description string, and 500+ rows on a real repo. The command keeps a QuickPick because it picks exactly one folder. |
| Q2 | Is a subgraph a saved-graph file with an additive `subgraph` field? | **Yes.** One list, one open path, delete / export / timeline / rename work unchanged; the card gets a distinct glyph. No second file type. |
| Q3 | Save inside a scoped view? | **Save writes the scope into the file** (`subgraph.include`) together with the layout, so "Visualize" changes made in the panel persist on Save. Unsaved scoped view → Save behaves as Save-As with the folder name suggested; the result is a subgraph. |
| Q4 | Does "Only visualize folder" create a subgraph? | **No file until Save.** It opens an unsaved scoped view (title `<folder> · scoped`). Creating a file for every quick look would litter the list. |
| Q5 | Can a child be included while its parent is excluded? | **Yes** (tri-state: parent partially checked). Include means folder + all descendants unless a descendant is explicitly excluded. |
| Q6 | "Visualize" on an excluded folder of a saved subgraph: edit the subgraph or a temporary view? | **Edits the scope in memory and marks the graph dirty**; Save persists it. That is what the brief's "can there be visualized" implies, and it avoids a second state. |

## Design

### 1. Scope model — new `src/subgraphScope.ts` (pure, no vscode import)

```ts
interface ScopeSpec { include: string[]; exclude?: string[] }   // workspace-relative POSIX folder paths, '.' = root
interface Scope { spec: ScopeSpec; source: 'none' | 'folder' | 'subgraph'; name: string | null }
```

- `isIncluded(spec, relFolder)`: the nearest ancestor (or self) listed in `include` / `exclude`
  decides; nothing listed → included only when `include` is empty (whole project).
- `fileInScope(spec, relFile)` = `isIncluded(dirname)`.
- `excludedTops(spec, tree)`: the maximal excluded subtrees, each `{ path, fileCount }`, so the
  Filters list stays short (excluding `src` lists `src`, not its 40 children).
- `filterGraph(graph, spec, root)`: nodes whose file is in scope, library nodes only when still
  referenced, edges with both ends kept, `files` filtered.
- `filterFileStatuses(statuses, spec, root)`.
- `normalize(spec)`: sort, dedupe, drop entries shadowed by an ancestor with the same verdict.
  Saved form is always normalized.

All paths cross the host boundary as workspace-relative POSIX (same rule as annotations); the
webview works with absolute paths, so the `scope` message carries both `root` and absolute
`include`/`excluded` so session-111 needs no path code.

### 2. File format — additive

```json
{ "version": 2, "name": "backend", "description": "", "savedAt": "…",
  "subgraph": { "include": ["src/server", "src/db"], "exclude": ["src/server/tests"] },
  "settings": {…}, "nodePositions": {…}, "frames": {…}, … }
```

- A subgraph created by the picker is written with `subgraph` and no layout fields; the first
  Save adds them. Loading tolerates both.
- `_listCographFiles` reads `subgraph` → `SavedGraphMeta.isSubgraph = true`, the card shows `⊂`
  and "N folders" instead of the date. Annotations stay in their subfolder; nothing changes there.
- No `SAVED_LAYOUT_VERSION` bump: a v2 reader without the feature ignores the field.

### 3. Host scoping — `GraphProvider` keeps one `scope`

Thin additions in `graphProvider.ts`, logic in `subgraphScope.ts`:

- `setScope(scope)`: store; post `scope`; then send the graph delta so the panel does not reload:
  - newly excluded folders → `graph-patch { patch: {nodes:[],edges:[]}, replacedFiles: <their files> }`
    (the existing prune path removes their nodes);
  - newly included folders → `graph-patch` with the cached nodes for their files; files not in
    the cache yet go through `analyzerRunner.runSubset` (same as `expand-folder`).
- Every outgoing `graph` / `graph-patch` / `git-update` is passed through `filterGraph` /
  `filterFileStatuses` when a scope is active. `cachedGraph` stays the FULL graph (the cache file
  is unscoped, so other scopes open instantly); only what is posted is filtered.
- `expand-folder` / `parse-file` / on-save re-parse: files outside the scope are dropped before
  `runSubset`, so a scoped view never spends analyzer time outside its scope.
- `structure` stays the full tree. Reason: it is paths only, the Filters list needs the excluded
  folders with counts, and `expand-folder` keeps working unchanged when a folder is brought in.
  Pruning the frame tree to the scope is the webview's call (see protocol).
- Ordering on open: `structure` → `scope` → `graph` (all through the ready gate). `graph-loaded`
  after those, as today.
- Webview → host: `scope-include { path }` / `scope-exclude { path }` (absolute folder) → update
  spec (normalize), `setScope`, `markDirty`.
- Save: host merges `subgraph: scope.spec` into the payload when `scope.source !== 'none'`.
- `loadGraph(data)`: if `data.subgraph` → `setScope({ spec, source: 'subgraph', name })` before
  `graph-loaded`; a plain layout → `setScope(none)` first, so opening a layout after a subgraph
  shows the whole project again.
- Panel title: `<name>` for a subgraph, `<folder> · scoped` for the command's view, dirty prefix
  as today.

### 4. Command — `cograph.visualizeFolder` ("CoGraph: Only visualize folder…")

`extension.ts`: QuickPick over `scanStructure(root).folders` sorted by path, label = relative path,
description = `N files`, `matchOnDescription`. Picks one → `provider.showScoped({ include: [rel] },
'folder')`: opens the panel if needed (through the same show path, scope set before the first
messages), else `setScope`. Also offered from the sidebar card context menu later? No (out of scope).

### 5. Sidebar — "Create new Subgraph" and the picker

- Button `#btn-new-subgraph` directly under `+ New Graph` (`sidebarProvider.ts` markup is one
  line; styles reuse the existing button rule).
- Picker lives in the sidebar webview, in a new module pair (same pattern as the annotate card):
  `src/subgraphPicker.ts` (markup + CSS + client script as strings, exported for tests) loaded
  into the sidebar HTML; **no** growth of `sidebarProvider.ts` beyond the message cases.
- Flow: click → host posts `subgraph-picker { root, folders: [{ path, rel, depth, parent,
  fileCount, name }] }` (from `scanStructure`, cheap) → the picker replaces the saved-graph list
  area with: name input (default `Subgraph N`), search box (filters rows, keeps ancestors of
  matches, expands them), tree rows with ▸/▾, tri-state checkbox (checked / unchecked /
  indeterminate from the descendants), file counts, "Create" / "Cancel". Keyboard: arrows,
  space toggles, Enter creates.
- Tri-state → spec: walk the tree, emit an `include` entry for every checked folder whose parent
  is not checked, an `exclude` entry for every unchecked folder whose parent is checked (that is
  exactly `normalize`). Root checked with nothing unchecked = whole project = refused with a hint.
- "Create" → `subgraph-create { name, spec }` → host validates (non-empty, name sanitized like
  layouts, no clobber without confirm), writes the file, refreshes the list, then opens it via
  `loadGraph` (→ `setScope`).

### 6. Protocol proposal (host ↔ graph webview) — for session-111's review

host → webview

```jsonc
{ "type": "scope",
  "source": "subgraph" | "folder" | "none",
  "name": "backend" | null,
  "root": "/abs/workspace",
  "include": ["/abs/src/server", "/abs/src/db"],        // absolute; folder + descendants
  "exclude": ["/abs/src/server/tests"],                  // absolute; carve-outs inside include
  "excluded": [{ "path": "/abs/src/ui", "fileCount": 41 }, …]  // maximal excluded subtrees, for the Filters list
}
```
- Sent after `structure`, before `graph`; re-sent whenever the scope changes. `source: "none"`
  (empty `include`) means whole project — the webview clears any scope state.
- `graph`, `graph-patch`, `git-update` arrive already filtered to the scope. A folder leaving the
  scope arrives as `graph-patch { patch: {nodes:[],edges:[]}, replacedFiles: [...] }`, a folder
  entering as a normal `graph-patch` (plus `analysis-state parsingFolder` while it parses).
- `structure` is unchanged (full tree). The webview removes frames/slots/glyphs of excluded
  folders the same way "hide entirely" does, and lists `excluded` under Filters › Subgraph with
  a "Visualize" action. Root: when exactly one top-level folder is included, promoting it to
  the frame root is the webview's decision (I have no opinion, the host does not care).

webview → host

```jsonc
{ "type": "scope-include", "path": "/abs/src/ui" }
{ "type": "scope-exclude", "path": "/abs/src/db" }      // e.g. Filters › "Exclude from subgraph"
```
- `save-graph` unchanged; the host adds `subgraph`. `expand-folder` unchanged.
- The webview must not persist scope itself (no `hiddenFolders` reuse for it): scope is host
  state, hidden is view state; both may coexist.

### 7. Files

New: `src/subgraphScope.ts`, `src/subgraphPicker.ts`, `src/test/suite/subgraphScope.test.ts`,
`subgraphPicker.test.ts` (jsdom, like annotationCard.test.ts), `graphProviderScope.test.ts`.
Edited: `graphProvider.ts` (scope field, `setScope`, `showScoped`, filters at the post sites,
`scope-include/exclude`, save/load — target < 120 added lines), `sidebarProvider.ts` (button
line, 3 message cases, `isSubgraph` in the list, card glyph), `extension.ts` (command),
`package.json` (command + activation event, appended), `CHANGELOG.md`, `README.md`.
Not edited: any webview graph module (session-111), analyzers, structureScanner.

## Steps (one commit each)

1. `subgraphScope.ts` + tests (pure).
2. `GraphProvider.setScope` + filtered posting + `scope-include/exclude` + tests (fake panel,
   assert what is posted and that `runSubset` never sees out-of-scope files).
3. Save/load with `subgraph`; sidebar list glyph + `isSubgraph`; tests.
4. Command `cograph.visualizeFolder` + `showScoped` + tests.
5. Sidebar button + picker module + `subgraph-create` + jsdom tests (tri-state, search, keyboard,
   spec output, refuse whole-project).
6. Docs; reviewer pass; full suite; uxtest smoke + hover-card unchanged; a scoped uxtest step if
   session-181 wants one (selectors listed on request).

## Risks

| Risk | Mitigation |
|---|---|
| Webview and host disagree on what "in scope" means | One pure function (`isIncluded`) on the host; the webview only consumes `include`/`exclude`/`excluded` lists it is given and never re-derives |
| A scoped patch reaches the webview before `scope` | `setScope` posts `scope` first; on open all three go through the ready gate in order |
| Save from a scoped view silently drops the scope | Host adds `subgraph` at save time from its own state, not from the payload |
| Two `scope` sources fight (command view open, then a subgraph card clicked) | `loadGraph` always calls `setScope` (none or the file's), so the last open wins, like today for layouts |
| Picker on a 5 000-folder repo | Rows rendered lazily per expanded level; search caps visible rows; counts precomputed by `scanStructure` |
| `sidebarProvider.ts` grows again | Picker strings live in `subgraphPicker.ts`; the sidebar only routes messages |

## Test strategy

Pure: scope verdicts (nested include/exclude, root), `excludedTops`, `filterGraph` (library
nodes, cross-scope edges), `normalize` idempotence. Host: fake panel captures posts — open with a
scope posts `structure, scope, graph(filtered)`; `scope-exclude` posts prune patch; `scope-include`
of cached files posts nodes without spawning; of uncached files spawns `runSubset` with only
those files; on-save re-parse of an out-of-scope file posts nothing; Save carries `subgraph`;
loading a plain layout clears scope. Sidebar: button present, `subgraph-create` writes a valid
file and opens it, name collision confirm, list marks `isSubgraph`. Picker (jsdom): tri-state
propagation both directions, search keeps ancestors, keyboard, spec output equals `normalize`.
Command: QuickPick stub returns a folder → `showScoped` called with the relative path.

## Out of scope

Everything in the graph webview (session-111), hide-entirely, Filters panel UI, glyph names,
scoping the AI features (annotations already work per path; chat/workflow keep the full graph —
noted as a follow-up), multi-root workspaces.
