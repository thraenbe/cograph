# Weekly Tech Debt Review Task
# Create recurring Task

Review tech-debt.md
Pick 1 improvement max
Implement

---

## Open items

### Single-parse cache: apply to `scripts/analyze_java.js`

**Done in C++ (`scripts/analyze_cpp.js`, branch `add-cpp-support`):** the analyzer ran a
two-pass pipeline (`collectDefinitions` then `collectCalls`) that parsed every
workspace file **twice** — and reanalysis runs on every save. Fixed by parsing
each file once and reusing the tree across both passes:

- `getTree(filepath)` memoises the parse tree in a module-level `treeCache`
  (`Map<filepath, Tree | null>`). Both passes call it; the second pass is a cache hit.
- `clearTreeCache()` frees the cached trees and is called in a `finally` in `main()`.
  Needed for C++ specifically because web-tree-sitter trees are WASM-heap objects
  that are **not** garbage-collected and must be `.delete()`d.
- `_stats.parses` is an exported counter so a test can assert N files → N parses
  (not 2N). See suite "parse cache (single-parse)" in `analyzeCpp.test.ts`.

**Trade-off:** all trees are held in memory between the two passes (vs one at a
time before). Fine for typical workspaces. Lower-memory alternative if it ever
matters: a single walk that extracts call-sites into plain JS objects and deletes
each tree immediately, resolving against the global `nameToIds` afterwards.

**TODO — Java:** `scripts/analyze_java.js` still double-parses (`collectDefinitions`
parses at the `parse(source)` call inside its file loop, and `collectCalls` parses
the same files again). Apply the identical `getTree` cache. It's *simpler* than C++:
`java-parser` returns a Chevrotain CST that **is** garbage-collected, so no
`clearTreeCache()`/`.delete()` lifecycle is needed — a plain memo `Map` suffices.
TS/JS analyzers use the TS Compiler API and do not have this double-parse shape.
