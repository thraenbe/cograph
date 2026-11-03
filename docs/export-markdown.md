# Export Markdown: plan

Status: plan, waiting for Bela's go (2026-11-03). Branch `feat/export-markdown`, off `main` at 6241ae7.

## Why

Bela's research project (TU Dresden, Sprint 1, CWE-199 on ApoGames) uses CoGraph's Markdown as the
deterministic, non-AI context for LLM experiments. Today that Markdown only exists as MCP tool
replies (`overview`, `get_symbol`, `callers`, `callees`, `impact` in `src/mcp/format.ts`), and only
after VS Code wrote `.cograph/graph-cache.json`. There is no way to write it to files for a whole repo.

## What gets built

A command line tool, no VS Code, no network, no model:

```
node dist/export/cli.js <repo> --out <dir> [options]
  --lang java,python      analysers to run (default: all six)
  --symbols <list|@file>  only these symbols get a symbol file (ids or unique names)
  --features <file.json>  {"<feature>": ["<entry symbol>", ...]} -> one file per feature
  --depth <1-5>           callers/callees depth in symbol and feature files (default 2)
  --source                add the source slice to symbol files (default off)
  --python <bin>          Python for analyze.py (default python3)
  --clean                 replace <dir> if it holds an earlier export (never anything else)
```

It runs the analysers itself (same scripts the extension spawns, given a sorted file list), builds the
same `GraphIndex` the MCP server uses, and renders with the same formatters. So the files say exactly
what the MCP tools say, minus the parts that are not deterministic.

No MCP tool: the MCP server is read-only by design (`readOnlyHint`), and a tool that writes files
would change that. A VS Code command can come later; it is not needed for the research.

## Output layout

```
<out>/
  README.md                  what this is, options, CoGraph version, the analyser limits below
  manifest.json              inputs (every analysed file with sha256), options, every output file with sha256
  overview.md                workspace overview: languages, folder tree, entry points, hot spots
  edges.md                   edge-count report: per language and per file
  edges.tsv                  every resolved edge, one per line: caller id <TAB> callee id <TAB> kind
  files/<rel path>.md        per source file: its functions, then per function callers and callees (depth 1)
  symbols/<rel path>/<Class.method>.md          per symbol: card, callers and callees (--depth), impact
  symbols/<rel path>/<Class.method>-L<line>.md  same, when the name repeats in that file (overloads)
  features/<feature>.md      per feature: each entry's card, callees and callers (--depth), combined impact
```

Symbol files exist for every function unless `--symbols` narrows them. Names follow the MCP ids
(`src/game/Score.java::Score.save` -> `symbols/src/game/Score.java/Score.save.md`). Characters that
Windows forbids are escaped. If two output paths differ only in case, the export stops with an error
that names both, so nothing gets overwritten on macOS or Windows.

## Determinism rules

Two runs on the same code must give byte-identical directories, also from another clone path and
on another machine.

1. Nothing time- or machine-dependent: no timestamps, no "analysed N min ago" footer, no durations,
   no absolute paths, no user or host names, no staleness or git status.
2. No AI content: the AI summaries from Annotate Graph (`.cograph/annotations.json`) are left out.
3. Every list is sorted by an ordinal (code unit) comparison, never `localeCompare` (locale
   dependent) and never by analyser output order (Set and Map insertion order).
4. Analysers get the file list sorted the same way, so their own resolution sees one input order.
5. No silent truncation: the MCP caps (60 functions, 50 files, 25 tests, 25 neighbours) are lifted
   in the export; the formatters take the caps as a parameter, MCP defaults unchanged.
6. UTF-8 without BOM, LF line endings, exactly one trailing newline.
7. The output is written to a temporary folder next to `<dir>` and renamed into place, so a failed
   run leaves no half export, and no stale file from an earlier run survives.

Changes to shared code: `src/mcp/queries.ts` and `src/mcp/overview.ts` switch their tie-breaks to the
ordinal compare, and `formatSymbol` sorts its neighbour lists (today they are in Set order). MCP
replies only change in the order of ties, which also makes them stable.

## The Java analyser limit (important for the research)

Checked today on a three-class sample: `scripts/analyze_java.js` links only calls by bare name or on
`this` inside the project, and calls on an imported library type. It drops every call on another
object or class of the project and on library objects held in variables:

| Call in `Game.tick()` | Edge today |
|---|---|
| `update()`, `this.render()` | yes |
| `player.move(1)` (field of a project type) | no |
| `Score.save(3)` (static, project class) | no |
| `helper().move(2)` (call on a return value) | no |
| `new FileWriter(..)` then `w.write(v)` | no |

So for ApoGames, callers, callees and impact will mostly show calls inside one class. The export
makes this visible instead of hiding it:

- `edges.md`: per language and per file the number of functions, internal edges out and in, library
  edges, functions without callers, and the analyser's own counts (ambiguous names narrowed or dropped).
- `edges.tsv`: all edges with CoGraph ids, sorted, for session-396's JavaParser cross-check.
- Proposed small analyser change in the same branch: count every call site the Java analyser sees
  and how many it resolved, reported under `stats` and shown in `edges.md`. Edges stay unchanged.
- `README.md` names the limit in one paragraph, so a reader of the context files knows it.

Fixing the gap (resolve `x.m()` through the declared types of fields, locals and parameters) is a
separate change to the analyser and changes what the research measures. Decision for Bela, below.

## Tests

All plain Node (mocha on `out/`), no window. The full existing suite runs in the invisible nested
shell (`.termi/briefs/eval/nested-test.sh`).

- Fixtures: a small Java game (`src/test/fixtures/export/java-game/`, 4-5 classes with a highscore
  file write, overloads, a constructor) and a small Python app.
- Golden files: the expected export of both fixtures is checked in; any format change shows up as a
  diff.
- Determinism: export each fixture twice in two processes, from two different absolute paths, with
  different `PYTHONHASHSEED`, and compare every byte of the two directories. Shuffled node and edge
  order in a synthetic graph must give the same files.
- Each rule gets a test that fails when the rule is broken (for example: restore `localeCompare` or
  the Set order and the test goes red; checked by mutating the code once).
- Unit tests: file naming (escapes, overloads, case collision), `--symbols` and `--features`
  resolution (ambiguous names are an error listing the candidates, never a guess), `--clean` refusing
  a folder that is not an export, the edge counts on the fixture.

## Not in this change

No release, version bump, push or PR without Bela's go. No change to the extension UI or the VSIX.
No reading of `.cograph/graph-cache.json` (the export always analyses, so the result does not depend
on when VS Code last ran).

## Decisions for Bela

1. Symbol files for every function by default (recommended: yes; a game has a few hundred, small files).
2. Source slices: off by default, `--source` turns them on (recommended).
3. The Java gap: (a) export as is, with the counts and the README note, and decide after the
   JavaParser cross-check; or (b) a second branch that resolves `x.m()` by declared types before the
   Phase 2 runs. Recommended: (a) now, then (b) if the cross-check shows the gap matters, because the
   runs should use one fixed analyser version.
4. Where the ApoGames dataset is on this machine (it is not under `~`), for the example output.
