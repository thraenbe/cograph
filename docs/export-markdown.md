# Export Markdown and Java analyzer fix: plan

Status: plan, revision 3 (2026-11-04), waiting for Bela's go on both parts. Branch
`feat/export-markdown`, off `main` at 6241ae7. Revision 2 added the research orchestrator's
requirements r1-r5; revision 3 adds the Java analyzer fix (option b) after the research's javac gate.

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

The research project measured it against javac on six ApoGames (session-416,
`~/dresden-tu/1/research-project/impl/02-cograph-context.md`, section 2; 17,624 in-project calls):
recall 60.7 %, cross-class recall 54.1 %, cross-class calls on a receiver 31.3 %, precision 50.5 %,
constructors 0 of 1345, library recall 2.7 %, and 0 of 67 Highscore sink calls linked. ApoMario's
sources are inside `ApoMario.jar` (109 files); the research unzips it. The phase-0 gate failed, so
the export alone is not enough: the analyser fix below (option b) comes first.

### Opt-in analyser report (r1, r2)

The class cards and call sites come from the Java analyser's own parse, behind a new opt-in flag
`--export-info`. The extension never passes it, so its graph stays byte-identical (a test checks
nodes and edges with and without the flag). With the flag, the analyser adds:

- `classes`: per class its file, line, extends, implements, fields and asset references.
- `callSites`: every method invocation in a chain (each `.m(..)` of `a.b().c()` is its own site) and
  every `new X(..)`, with file, line, column, calling method, receiver expression as written, method
  name, and either the linked target ids or the reason it was not linked (`unknown-type`,
  `no-definition`, `ambiguous-dropped`; after the fix below, receiver, chained and `new` calls link).

`callsites.tsv` and `unresolved.tsv` are these rows, sorted by file, line and column. The cross-check
can then measure recall (sites with no link) as well as precision (`edges.tsv`). The flag adds
report fields only; which calls become edges is the analyser fix's job.

## Java analyzer fix (option b)

### Scope

The five defects the research found (section 2 of their report), all in `scripts/analyze_java.js`:

1. `this.` linking by name: a chain that starts with `this` links by method name only, so
   `this.player.move()` links and `player.move()` does not, and neither checks the type.
2. `super.m()` is dropped: the `Super` token is lost, the call becomes bare, and narrowing can pick the
   caller itself, which is then thrown away as a self-loop.
3. Bare calls ignore the class hierarchy: they link to up to 8 methods of the same name anywhere,
   which is most of the 50 % precision. `resolveThisCall` (`narrowCalls.js`) already does own class
   first, then base classes, but only the JS and TS analysers use it.
4. Library nodes lose the class: `URLEncoder.encode` becomes `library::java.net::encode`.
5. Project classes become library nodes (183 of 387 library edges): the check looks a class name up in
   a map keyed by method names.

Plus the two gaps behind most of the missing recall: calls on a receiver (`x.m()`, `Class.m()`,
`a().b()`, `a[i].m()`) and constructors (`new X()`, `super(..)`, `this(..)`).

### Approach: declared-type resolution

No compiler and no JDK model, still one `java-parser` parse per file. Two passes, as today:

- Pass 1 builds a type table for the project: per file the package and imports (single type,
  wildcard, static); per class (top level, nested, inner, enum, interface) its full name, outer class,
  `extends`, `implements`, fields with declared types, methods with parameter count, parameter types,
  return type and `static`, and constructors.
- Pass 2 walks each method body with a scope stack: parameters, locals (including for-each, catch,
  try-with-resources and `var` from a `new` or a resolved call), fields of the class, its project
  base classes and its outer classes. Each call site resolves its receiver to a type:

| Receiver form | Resolved through |
|---|---|
| bare `m()`, `this.m()` | own class, then project base classes, then outer classes, then static imports (`resolveThisCall` order) |
| `super.m()` | the base class chain, starting above the own class |
| `x.m()`, `this.f.m()`, `x.f.m()` | declared type of the local, parameter or field, through field chains |
| `Class.m()`, `pkg.Class.m()` | the class itself (static call) |
| `a[i].m()` | element type of the array |
| `((T) x).m()` | the cast type |
| `a().b()` | declared return type of the resolved `a` |
| `list.get(i).m()` | element type of a generic `java.util` container (fixed table: get, remove, elementAt, firstElement, lastElement, peek, poll, pop, next, getFirst, getLast; Map get, put, remove) |
| `new X(..)`, `super(..)`, `this(..)` | the constructor of X, the base class or the own class |

  Once the type is known, the method is looked up in that class and then up its project base classes
  and interfaces (the static target, as javac resolves it). Overloads are chosen by argument count,
  then by argument types where they are known; when several remain, all of them are linked.
- A type that is not a project class resolves through the imports, the own package and a fixed list
  of `java.lang` names to a library class, and the edge goes to `library::<package>.<Class>::<method>`
  (constructors as `<init>`; `libraryName` becomes `<package>.<Class>`). The project-class check uses
  the type table, so project classes never become library nodes.
- A receiver whose type stays unknown (lambda parameter, raw generic, library return value) gets no
  edge and is reported as `unknown-type`. No more name-only guesses for receivers. Bare calls inside a
  class that find nothing in the hierarchy also get no edge; free name matching remains only where
  there is no class context.
- Ambiguous-name narrowing (D6) stays as the last step for the few pools still larger than 8.

The resolver records the outcome of every call site (targets or reason), which is exactly what the
export's `--export-info` report needs, so the two parts share one code path. New code goes into
`scripts/javaTypes.js` (type table) and `scripts/javaResolve.js` (scopes and resolution), keeping
`analyze_java.js` small. The other analysers are not touched.

### What changes for users of the extension

- Java graphs get more edges, fewer wrong ones, and constructor edges. Library nodes are per class,
  so the library groups in the graph view split by class instead of by package.
- Saved graphs and annotations keyed by old Java library ids no longer match those nodes; project
  method ids do not change. To be checked during the work and named in the PR.
- Analysis time: measured on the Java repos of the test corpus before and after, under the bench rules
  (pre-registered limit: at most 25 % slower on the largest Java repo; the measurement decides).
- The research's `crosscheck.js` keys library edges by package plus method name, so its library part
  needs a one-line change for the new ids (research side; `libraryName` and the id carry everything).

### Tests and acceptance

- Fixture `src/test/fixtures/java-resolve/`: a small two-package game with one case per row of the
  table above, plus overloads, an interface call, an inner class calling the outer class, an enum, a
  static import, a wildcard import, `java.lang` calls and calls through a library-typed variable. The
  expected edges are a checked-in TSV, written by hand and confirmed once with javac (the JDK's
  `jdk.compiler` module is on this machine); the test compares the edge set exactly.
- Regression tests for each of the five defects, each failing on today's analyser (checked by running
  it against `main`'s version once).
- The existing Java suites (`analyzeJava.test.ts`, `analyzeOop.test.ts`, narrowing, file list) stay
  green; changed expectations are listed one by one in the PR.
- Acceptance on ApoGames: the research's own gate (`work/context/run_gate.sh`, unchanged, read-only,
  with `COGRAPH` pointing at the fix branch) on the research's six-game tree must reach at least 90 %
  recall and 90 % precision on every game (the thresholds the research proposed; Bela agrees them).
  Also reported: recall per receiver form, constructors, library recall, and the edit-site check
  (`editsite_check.js`), where the Highscore sink calls must have edges.
- Determinism: two runs give byte-identical graphs, also from another path.

### Effort

About two working days for the analyser (type table and scopes one day, receiver forms, constructors,
library keying and gate iterations one day), half a day for tests, the bench and the full suite in
the nested shell. The export afterwards about one day, less if it ports the research's stopgap
(`work/cograph/export.js`, 562 lines, same layout). Risk: 90 % recall depends on how much of the code
calls through library return values; the per-form table shows where it stands after the first day.

## Order of the work

1. Branch `fix/java-type-resolution` off `main`: the analyser fix, its own PR.
2. Branch `feat/export-markdown` on top of it: the export, a second PR, merged after the first.
   The research's stopgap keeps serving phase 1 meanwhile. Its layout is the reference: CoGraph's
   export writes the same paths, and the acceptance is a diff against the stopgap with every
   difference explained (expected: the better edges). The stopgap's `--budget` selection rule
   (tiers T0 to T9) is experiment design and stays in the research code unless Bela wants it in CoGraph;
   `aliases.tsv` becomes unnecessary once library keying is fixed.

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
on when VS Code last ran). No change to the other analysers.

## Decisions

Recommendations from the research orchestrator (session-396), matching mine; final word is Bela's.

1. Symbol files for every function by default: yes.
2. Source slices: off by default, `--source` turns them on.
3. The Java gap: the cross-check showed it touches the edit sites, so option (b), the analyser fix
   above, is required (research, 4 Nov). Bela decides the go for the fix and the export together, and
   the acceptance thresholds (proposed 90 % recall and 90 % precision on all six games). The analyser
   version used for the runs is frozen before any run (its script hashes are in `manifest.json`).
4. Dataset: `~/dresden-tu/1/rp-data/apogamessrc`, read-only. The example output uses ApoMario from
   the research's unzipped tree.
5. Where the export lives: CoGraph's repo (this plan) or the research's stopgap (open decision 6 of
   the research PLAN). Recommended: CoGraph, after the analyser fix, matching the stopgap's layout.
