# F30: the scanner and the analyzers disagree about what is in the project

Session-215, 2026-10-07. Planner phase only: nothing is changed. Reported by session-262
(`s262/.ai/plans/vcs-pr-head.md`, "Finding"). The script is
`.termi/briefs/workflow-eval/f30-measure.py`.

## The mismatch

There are six lists, and the scanner's comment calling itself the "union of the analyzers" is
wrong:

| Side | Skips |
|---|---|
| Scanner (`structureScanner.ts:45`) | `node_modules out dist target build CMakeFiles cmake-build-*` + dot-dirs |
| `analyze_ts.js` / `analyze_js.js` | `node_modules out dist` + dot-dirs |
| `analyze.py` | `node_modules out dist __pycache__` + dot-dirs |
| `analyze_java.js` | `node_modules out dist target build` + dot-dirs |
| `analyze_cpp.js` | `node_modules out dist target build CMakeFiles cmake-build-*` + dot-dirs: **matches the scanner**. 262's table lists C++ as walking `cmake-build-*`; the code at `analyze_cpp.js:100-102` skips it |

## How much it matters (measured)

- **Clean clones (20 corpus repos + CoGraph): almost nothing.**
  - 10 functions are stranded in total: dayjs `build/` (3, its rollup scripts) and zod
    `packages/bench/typia-case/build` (7).
  - 0 `.py` files under `__pycache__`.
  - None of this machine's working directories hold build output with source files either.
- **After a normal build: a lot.** I ran `pip wheel --no-deps .` on a scratch copy of requests.
  setuptools writes `build/lib/requests/*.py` into the project:
  - **+268 functions**, a duplicate of every one of requests' 268 product functions. All of them
    are stranded: no folder, so they can't be hidden, scoped or put in a subgraph.
  - **Edges 1 126 → 2 004.** **326 edges run from real source into the build copies**, because
    bare-name calls now find two same-named definitions and link both.

  So build output doesn't sit quietly outside the tree. It **distorts the visible graph**.
  Expected equivalents: TS projects compiling to `build/` (CRA, many Node libraries),
  `cmake-build-*/` generated sources in CLion projects.

## The decision: which way should they agree?

The two obvious answers are both wrong somewhere, on the evidence:
- **Exclude `build/` everywhere** drops dayjs's and zod's hand-written `build/` scripts. They are
  **tracked in git**, so they're source.
- **Include it everywhere** keeps requests' `build/lib` copy and its 326 bogus edges, and grows the
  Folder panel by artefact directories. It's **gitignored** (`requests/.gitignore:10 build/`).

Git already draws the line correctly in every case I measured.

## Proposal: one rule, one owner

1. **The rule.** A path is part of the project unless it lies under a directory in the shared
   skip-set **and** that directory holds no git-tracked file. The skip-set is the scanner's
   current set + `__pycache__`:
   `node_modules out dist target build CMakeFiles cmake-build-* __pycache__` + dot-dirs.
   - Tracked always means source.
   - With no git (or git unavailable), the skip-set alone applies, which is today's scanner
     behaviour.
2. **The scanner owns it. The analyzers stop deciding.**
   - A full analysis passes the scanner's file list to every analyzer through the existing
     `--files` mode (`AnalyzerRunner.runSubset` already writes such a list).
   - The rule then exists once, in TypeScript, and the two sides can't drift again.
   - Each analyzer's own walk stays only for CLI and test use, reading the same set from one
     `scripts/skipDirs.json`.
3. **Session-262's `analyzerKeepsPath` (PR head copy) becomes the same function.**

### Effect, measured

| Case | Change |
|---|---|
| Corpus, clean | 0 functions lost. dayjs's and zod's tracked `build/` files gain a place in the Folder tree (fixed, not dropped) |
| requests after `pip wheel` | −268 duplicate functions, −326 bogus edges, graph identical to the clean clone |
| `__pycache__` | gone from the tree (0 files on the corpus) |

### Cost

About 1–1.5 days:
- scanner rule + tracked-dirs check (one `git ls-files --directory`-style call per scan; the host
  already runs git for statuses)
- full run via `--files`
- `skipDirs.json` read by 5 analyzers
- one **agreement test**: a fixture with tracked `build/`, untracked `build/lib`,
  `cmake-build-debug/`, `__pycache__/x.py`. It asserts that the scanner's file set equals the
  analyzers' `graph.files`.

Files: `structureScanner.ts`, `analyzerRunner.ts`, `scripts/analyze*.{js,py}`. They're shared,
and 262 is in the same area, so this needs sequencing.

### Risks

- Large repos: the file list goes through a list file (no argv limit), already proven by subset
  mode.
- A user who wants an *untracked* `build/` in the graph loses nothing they could see today: it
  was never in the tree.
- First scan of a non-git folder: unchanged behaviour.

## For Bela

**Exclude build output, but let git decide what "build output" means: ignored or untracked
artefact directories go, tracked ones stay.** Yes or no?

The fallback, if he wants no git dependency: exclude the skip-set on both sides unconditionally.
That costs dayjs's and zod's 10 hand-written build-script functions on the corpus.
