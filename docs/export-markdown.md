# Export Markdown: plan

Status: plan, revision 2 (2026-11-03), waiting for Bela's go. Branch `feat/export-markdown`, off
`main` at 6241ae7. Revision 2 adds the research orchestrator's requirements r1-r5.

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
  --symbols <list|@file>  only these symbols get a symbol file (default: every function)
  --features <file.json>  {"<feature>": ["<entry>", ...]} -> one file per feature
  --depth <1-5>           callers/callees depth in symbol and feature files (default 2)
  --source                add the source slice to symbol files (default off)
  --python <bin>          Python for analyze.py (default python3)
  --clean                 replace <dir> if it holds an earlier export (never anything else)
```

It runs the analysers itself (same scripts the extension spawns, given a sorted file list), builds the
same `GraphIndex` the MCP server uses, and renders with the same formatters. So the files say what the
MCP tools say, minus the parts that are not deterministic, plus the Java details below.

A feature entry (r5) is a method (`src/a/Score.java::Score.save` or a unique name), a class
(`Score`, or `src/a/Score.java::Score` when the name exists in several files) or a file
(`src/a/Score.java`); a class or file stands for all its methods. A name that matches several things
is an error that lists them, never a guess. The export covers one repo per run: a reuse source in a
sibling game is exported by a second run on that game, with its own features file.

No MCP tool: the MCP server is read-only by design (`readOnlyHint`), and a tool that writes files
would change that. A VS Code command can come later; it is not needed for the research.

## Output layout

```
<out>/
  README.md                  what this is, options, versions, the analyser limits below
  manifest.json              inputs, options, versions, every output file with bytes, words, sha256
  overview.md                workspace overview: languages, folder tree, entry points, hot spots
  edges.md                   edge and call-site counts: per language and per file
  edges.tsv                  every resolved edge: caller id, callee id, kind (internal, library)
  callsites.tsv              Java: every call site the analyser saw, linked or not
  unresolved.tsv             Java: the call sites it saw but did not link (r2)
  files/<rel path>.md        per source file: class cards, then its functions with callers and callees (depth 1)
  symbols/<rel path>/<Class.method>.md          per symbol: card, callers and callees (--depth), impact
  symbols/<rel path>/<Class.method>-L<line>.md  same, when the name repeats in that file (overloads)
  features/<feature>.md      per feature: each entry's card, callers and callees (--depth), combined impact
```

Names follow the MCP ids (`src/game/Score.java::Score.save` ->
`symbols/src/game/Score.java/Score.save.md`). Characters that Windows forbids are escaped. If two
output paths differ only in case, the export stops with an error that names both.

### Content per file

- Class card (r1), one per class in `files/<path>.md`: name, `extends`, `implements`, fields (modifiers,
  type, name, no initialiser values), and asset references: string literals in the class that end in a
  known asset extension (png, gif, jpg, wav, mp3, ogg, ttf, txt, properties, xml, mar, rep, dat, ...) or
  are the first argument of a resource or file call (`getResource`, `getResourceAsStream`,
  `ImageIO.read`, `new File`, `FileInputStream`, `FileOutputStream`, `FileReader`, `FileWriter`, `new URL`,
  ...). The two lists are fixed in the code and printed in `README.md`. Java only in this change; for
  Python the card shows the class and its bases and says fields and assets are not extracted.
- Symbol and feature files keep library callees (r4): the callee walk includes library nodes such as
  `java.net.URLEncoder.encode`. In Java, a library edge exists only for a call on an imported type
  name or a static import; `new FileOutputStream(..)` and `out.write(..)` on a variable are not edges.
  So every Java symbol file also lists the method's unlinked call sites ("Calls the analyser did not
  link": line, receiver expression, method), which is where those security-relevant calls show up.
- `manifest.json` (r3): per output file the path, bytes (UTF-8), words and sha256, plus totals per
  folder, so context arms can be matched on size. Words are maximal runs of non-whitespace characters.
  It also records the inputs (every analysed file with sha256), the options, the CoGraph version and
  commit, and the sha256 of every analyser script, so a frozen analyser version can be checked.

## The Java analyser limit (important for the research)

`scripts/analyze_java.js` links a call when it is a bare name or on `this` (matched by name across the
whole project), or on an imported library type or static import. Checked on a three-class sample:

| Call in `Game.tick()` | Edge today |
|---|---|
| `update()`, `this.render()` | yes |
| `player.move(1)` (field of a project type) | no |
| `Score.save(3)` (static, project class) | no |
| `helper().move(2)` (call on a return value; the analyser does not even see the `.move`) | no |
| `new FileWriter(..)` then `w.write(v)` | no |

Measured on ApoGames (read-only, analyser from `main`):

| Game | Methods | Internal edges | of them cross-file | Library edges | Receiver-style call sites (rough grep) |
|---|---|---|---|---|---|
| ApoSimple | 1304 | 2858 | 2263 | 148 | about 4000 |
| ApoPongBeat | 708 | 795 | 530 | 37 | about 1200 |
| ApoCommando | 893 | 2303 | 1801 | 51 | about 1900 |

Two gaps follow: calls on a receiver have no edge, and a bare-name match picks methods by name, not
by type, so some edges can point at the wrong class. ApoMario has no Java sources in the dataset
(only a jar).

### Opt-in analyser report (r1, r2)

The class cards and call sites come from the Java analyser's own parse, behind a new opt-in flag
`--export-info`. The extension never passes it, so its graph stays byte-identical (a test checks
nodes and edges with and without the flag). With the flag, the analyser adds:

- `classes`: per class its file, line, extends, implements, fields and asset references.
- `callSites`: every method invocation in a chain (each `.m(..)` of `a.b().c()` is its own site) and
  every `new X(..)`, with file, line, column, calling method, receiver expression as written, method
  name, and either the linked target ids or the reason it was not linked (`receiver`, `chained`,
  `new`, `no-definition`, `ambiguous-dropped`, `library-not-imported`).

`callsites.tsv` and `unresolved.tsv` are these rows, sorted by file, line and column. The cross-check
can then measure recall (sites with no link) as well as precision (`edges.tsv`). Edges do not change.

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
ordinal compare, `formatSymbol` sorts its neighbour lists (today they are in Set order), and the
formatters take caps as a parameter. MCP replies only change in the order of ties.

## Tests

All plain Node (mocha on `out/`), no window. The full existing suite runs in the invisible nested
shell (`.termi/briefs/eval/nested-test.sh`).

- Fixtures: a small Java game (`src/test/fixtures/export/java-game/`, 4-5 classes with fields, an
  `extends`, overloads, a constructor, image and highscore-file literals, receiver, chained, static
  and `new` calls) and a small Python app.
- Golden files: the expected export of both fixtures is checked in; any format change shows up as a
  diff.
- Determinism: export each fixture twice in two processes, from two different absolute paths, with
  different `PYTHONHASHSEED`, and compare every byte of the two directories. Shuffled node and edge
  order in a synthetic graph must give the same files.
- Analyser: graph identical with and without `--export-info`; each unlinked kind in the fixture
  appears in `unresolved.tsv` with the right reason; every linked site matches an edge in `edges.tsv`.
- Each rule gets a test that fails when the rule is broken (for example: restore `localeCompare` or
  the Set order and the test goes red; checked by mutating the code once, on a copy).
- Unit tests: file naming (escapes, overloads, case collision), `--symbols` and `--features`
  resolution for method, class and file entries (ambiguous names are an error listing the
  candidates), `--clean` refusing a folder that is not an export, word and byte counts.

## Not in this change

No release, version bump, push or PR without Bela's go. No change to the extension UI or the VSIX.
No reading of `.cograph/graph-cache.json` (the export always analyses, so the result does not depend
on when VS Code last ran). No change to which Java calls become edges.

## Decisions

Recommendations from the research orchestrator (session-396), matching mine; final word is Bela's.

1. Symbol files for every function by default: yes.
2. Source slices: off by default, `--source` turns them on.
3. The Java gap: (a) export as is now, with the call-site report; (b) resolving `x.m()` by declared
   types only if the cross-check shows the gap touches the edit sites. The analyser version used for
   the runs is frozen before any run (its script hashes are in `manifest.json`).
4. Dataset: `~/dresden-tu/1/rp-data/apogamessrc`, read-only. The example output uses a game that
   has sources (ApoSimple or ApoCommando), not ApoMario.
