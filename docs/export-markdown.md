# Markdown export

Writes CoGraph's call-graph context for a whole repository to Markdown and TSV files:
deterministic, no AI, no VS Code, no network. Built for a TU Dresden research project that uses
CoGraph's Markdown as the non-AI context of LLM experiments on the ApoGames Java games; it works for
every language CoGraph analyses.

Status: implemented on `feat/export-markdown` (2026-11-05), on top of the Java analyser fix
(`fix/java-receiver-resolution`, declared-type resolution of calls). The plan this replaces went
through three revisions on 3 and 4 November; its decisions are listed at the end.

## Run it

From a checkout with `npm ci` and `npm run compile` done:

```
npm run export:md -- <repo> --out <dir> [options]
  --lang <list>           analysers to run: python,typescript,javascript,java,cpp,c (default: all)
  --symbols <list|@file>  only these get a symbol file (comma list, or one entry per line in a file)
  --features <file.json>  {"<feature>": ["<entry>", ...]}; an entry is a method, a class or a file
  --feature-set <name>    for a file grouped by project ({"<set>": {"<feature>": [...]}}); default:
                          the repo folder's name
  --depth <1-5>           callers and callees depth in symbol and feature files (default 2)
  --source                add the source slice to symbol and feature files
  --python <bin>          Python for the Python analyser (default python3)
  --clean                 replace <dir> when it holds an earlier export
```

Example, one ApoGames game with the research's features file:

```
npm run export:md -- ~/games/ApoIcarus --out ~/ctx/ApoIcarus --lang java \
  --features work/context/features/features.json
```

Exit codes: 0 written, 2 a usage or entry mistake (an ambiguous name lists its candidates), 1 an
analyser failure (no partial export is written).

A feature entry is a method (`src/a/Score.java::Score.save`, or a unique `Score.save` or `save`), a
class (`Score`, or `src/a/Score.java::Score` when the name exists in several files) or a file
(`src/a/Score.java`); a class or a file stands for all its functions. One run covers one repo: a reuse
source in a sibling game is a second run on that game.

## Output

```
<out>/
  README.md                  what this is, options, versions, the analyser's limits
  manifest.json              inputs with sha256, options, analyser hashes, bytes, words, sha256 per file
  overview.md                languages, folder tree, entry points, hot spots, Java classes
  edges.md                   edge and call-site counts per language and per file
  edges.tsv                  every edge: caller, callee, kind (internal, library)
  files/<path>.md            per source file: class cards, then each function with direct callers and callees
  symbols/<path>/<Class.method>.md   per function: card, signature, callers and callees (--depth), impact, call sites
  features/<name>.md         per feature: entries, class cards, functions, callers and callees around them, impact
  callsites.tsv              Java: every call site with its targets (linked 1) or the reason it has none
  unresolved.tsv             Java: the call sites without an edge
  nodes.tsv                  Java: classes (also without methods), methods with line ranges, library nodes
  signatures.tsv             Java: class declarations and method signatures with Javadoc
  literals.tsv               Java: string literals that name a URL, an asset or a file, with their owner
```

- A class card holds the declaration (modifiers, `extends`, `implements`), Javadoc, fields with their
  initialisers, and the literals that end in an asset extension, start with `http(s)://`, or are the first
  argument of a file or resource call (`getResource`, `new File`, `FileOutputStream`, `new URL`, ...).
- A Java symbol page adds the signature, the body's line range, Javadoc, the `Class.CONSTANT` reads of
  project classes with their declared values, and every call site with its target or reason. Callees
  include library nodes (`library::java.net.URL::openConnection`).
- Symbol page names follow the MCP ids; `-L<line>` marks a name that repeats in a file (overloads).
  Characters Windows forbids are escaped as `%XX`; names that differ only in case get `-C2`, `-C3`, ...
  in ordinal order, so nothing overwrites anything on macOS or Windows.
- Words in the manifest are maximal runs of non-whitespace characters. `inputs_sha256` is the sha256 of
  the sorted `path<TAB>sha256<LF>` lines, as in the research's interim export, whose readers check it.
- The TSV columns match the research's interim export (`work/cograph/export.js`), so its readers (the
  knowledge-graph builder) work unchanged. `callsites.tsv` adds `form`, `reason` and `targets` after
  them. The interim export's paper role tags (`annotations_or_roles` for classes) are experiment design
  and not computed; its `aliases.tsv` is not needed since the analyser fix.

## How it works

1. The project's source files, by the extension's own scope rule, sorted ordinally.
2. The analysers, one after another in a fixed language order, each given that one list; the Java
   analyser with `--export-info`, which adds class cards, signatures, literals and every call site's text
   to its output (`scripts/javaExportInfo.js`). Nodes and edges are the same with and without the flag.
3. The MCP server's `GraphIndex`, walks, impact and formatters, with the reply caps lifted.
4. Pages written to a temporary folder next to `<dir>` and renamed into place.

## Determinism rules

Two runs on the same code give byte-identical folders, also from another path, under another locale,
time zone or Python hash seed (tested).

1. Nothing time- or machine-dependent: no timestamps, durations, absolute paths, user or host names,
   staleness or git status. The README and manifest name the CoGraph version, commit and analyser hashes.
2. No AI content: Annotate Graph summaries are left out.
3. Every order is an ordinal comparison (`src/mcp/compare.ts`), never `localeCompare` and never the
   analyser's output order. Walks and impact visit neighbours in location order, and functions on one line
   are ordered by id.
4. No silent truncation: the MCP caps (60 functions, 15 folders, 50 files, 25 tests, 15 entry points,
   25 neighbours) are lifted.
5. UTF-8 without BOM, LF line endings, exactly one trailing newline.
6. An existing `<dir>` is replaced only with `--clean` and only when it holds a `manifest.json`.

Changes to shared code: the MCP tie-breaks are ordinal, `formatSymbol` sorts its neighbour lists, walks
and impact iterate neighbours in location order, the formatters take caps as a parameter (MCP defaults
unchanged). MCP replies change only in the order of ties and in which equal-distance path a walk's
`via` names.

## Limits

Static analysis: a call through reflection, a callback or a string lookup has no edge, and a recursive
call is not an edge. Java calls link to the static target (the method javac picks for the declared
receiver type); overrides are not added. A Java call site without an edge says why: `unknown-type`
(lambda parameter, raw generic, library return value), `no-definition`, `implicit-constructor`,
`anonymous-class` (an anonymous class of a library type), `ambiguous-dropped`.

Measured on ApoGames against javac (research gate, ten games): call recall 99.9 %, precision 100 %.

## Tests

`src/test/suite/exportMarkdown.test.ts`, plain Node (`npx mocha --ui tdd out/test/suite/exportMarkdown.test.js`):
golden pages for a Java game and a Python app (`src/test/fixtures/export/`, `UPDATE_GOLDEN=1` rewrites
them), two processes from two paths under different locales and hash seeds byte for byte, shuffled node
and edge order, `--export-info` leaving the graph unchanged, every linked call site having its edge,
class cards and static reads, entry resolution, names, `--clean`, manifest sizes, usage errors. Each
ordering rule was broken once on a copy to check that a test goes red.

## Decisions (plan, 3 and 4 November)

1. Symbol files for every function by default.
2. Source slices off by default (`--source`).
3. Java gap: option (b), the analyser fix, before the export; the analyser version used for experiment
   runs is frozen (its hashes are in `manifest.json`).
4. No MCP tool: the MCP server stays read-only.
5. The export lives in CoGraph's repository; the research's interim export was the reference, and its
   TSVs are reproduced (rows identical on ApoMario for `edges`, `nodes`, `literals` and `signatures` apart
   from role tags; call sites a superset).
