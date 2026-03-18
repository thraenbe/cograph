# Adding Support for a New Language

This document lists every place in the codebase that must be changed to add a new language (e.g. `go`, `rust`, `java`). Follow the checklist in order — each section builds on the previous one.

---

## 1. Write the analyzer script

Create `scripts/analyze_<lang>.<ext>`. The script must:

- Accept the workspace root as its sole CLI argument
- Walk source files of the new language, skipping hidden directories (names starting with `.`) and `node_modules`, `out`, `dist`
- Write a single JSON object to **stdout**:

```json
{
  "nodes": [
    {
      "id":       "<filepath>::<name>::<line>",
      "name":     "<functionName>",
      "file":     "<absolutePath>",
      "line":     42,
      "language": "<newlang>",
      "isLibrary":    true,
      "libraryName":  "<pkgName>",
      "className":    "<ClassName>",
      "classExtends": "<BaseClass>",
      "classImplements": ["<Interface>"]
    }
  ],
  "edges": [
    { "source": "<id>", "target": "<id>", "isLibraryEdge": false }
  ],
  "files": ["<absolutePath>", ...]
}
```

`isLibrary`, `libraryName`, `className`, `classExtends`, `classImplements` are optional and may be omitted when not applicable.

**Reference implementations:** `scripts/analyze.py` (Python), `scripts/analyze_ts.js` (TypeScript), `scripts/analyze_js.js` (JavaScript).

---

## 2. Register the analyzer — `src/analyzerRunner.ts`

**Line ~52-56** — add the script path and a new `spawnAnalyzerProcess` call, then include the result in `Promise.all`:

```ts
const newScript = path.join(this.context.extensionPath, 'scripts', 'analyze_newlang.xxx');
const newPromise = this.spawnAnalyzerProcess(process.execPath, [newScript, workspaceRoot], false);

Promise.all([pyPromise, tsPromise, jsPromise, newPromise]).then(([pyGraph, tsGraph, jsGraph, newGraph]) => {
  const merged = {
    nodes: [...pyGraph.nodes, ...tsGraph.nodes, ...jsGraph.nodes, ...newGraph.nodes],
    edges: [...pyGraph.edges, ...tsGraph.edges, ...jsGraph.edges, ...newGraph.edges],
    files: [...(pyGraph.files ?? []), ...(tsGraph.files ?? []), ...(jsGraph.files ?? []), ...(newGraph.files ?? [])],
  };
  ...
```

If the analyzer is a compiled binary rather than a Node.js script, replace `process.execPath` with the binary path.

---

## 3. Extend the `GraphNode` type union — 3 files

Search for `'python' | 'typescript' | 'javascript'` and add `'<newlang>'`:

| File | Line | Change |
|------|------|--------|
| `src/analyzerRunner.ts` | ~10 | `language?: 'python' \| 'typescript' \| 'javascript' \| '<newlang>'` |
| `src/graphProvider.ts`  | ~16 | same union |
| `src/gitService.ts`     | ~9  | same union |

---

## 4. File-save re-analysis — `src/graphProvider.ts`

**Line ~91-97** — the save listener checks file extensions to decide whether to re-analyse. Add the new language's extensions to the watched set.

**Line ~140** — the extension-to-language-ID mapping used when opening docs:

```ts
const languageId = ext === 'py' ? 'python'
  : ext === 'js' ? 'javascript'
  : ext === 'go' ? 'go'          // ← add
  : 'typescript';
```

---

## 5. Language color — `src/webview/colors.js`

**Lines 2-6** — add an entry to `languageColors`. Pick a color representative of the language (check its official branding):

```js
const languageColors = {
  python:     '#3572A5',
  typescript: '#dd3b71',
  javascript: '#f7df1e',
  go:         '#00ADD8',   // ← add
};
```

`getLanguageColor()` falls back to a hash for unknown languages, so nodes will render even before this step — but the legend and explicit styling won't appear until this is set.

---

## 6. File-to-language inference — `src/webview/folder.js`

**Lines 122-130** — `inferLangFromPath()` maps file extensions to language strings for folder-overlay colouring. Add new extensions before the `return null`:

```js
if (ext === '.go') return 'go';
```

Also check **line ~34** — `EMPTY_FILE_EXTS` is a set of extensions that represent analysed source files. Add the new extension if folder nodes should track it.

---

## 7. Source extraction — `src/sourceEditor.ts`

`getFuncSource()` and `saveFuncSource()` detect function boundaries by file extension:

- `.py` → `findPythonFuncEnd()` (indentation-based)
- everything else → `findJsFuncEnd()` (brace-counting)

If the new language uses **indentation** to delimit blocks (like Python), add an `endsWith('.newext')` branch that calls `findPythonFuncEnd()`. If it uses **braces**, the existing fallback already handles it and no change is needed.

---

## 8. Syntax highlighting — `src/webview/highlight.js`

`highlightCode(source, lang)` is a lightweight tokeniser used in the function popup. It has explicit branches for `python` and a shared TS/JS path.

Add a keyword list and any language-specific rules (comment chars, string delimiters, decorators, etc.):

```js
const GO_KW = new Set(['func', 'package', 'import', 'var', 'const', 'type', 'struct', ...]);
```

Then branch on `lang === 'go'` in the tokeniser. At minimum, add the keyword set; block- and line-comment syntax also need wiring if they differ from `//` and `/* */`.

---

## 9. Library documentation — `src/libraryDescriber.ts`

**Line ~15** — `fetchDescription()` branches on `language`:

```ts
if (language === 'python') { return fetchPythonDescription(...); }
// falls through to TypeScript/npm logic
```

Add a branch for the new language pointing to the appropriate registry or docs endpoint. If the language has no package manager or docs lookup, the fallback (showing nothing) is acceptable.

---

## 10. Library popup UI — `src/webview/popups.js`

Three small changes in `showLibDocPopup()`:

| Line | What to change |
|------|---------------|
| ~4   | Docs URL: `d.language === 'python' ? 'https://docs.python.org/...' : d.language === 'go' ? 'https://pkg.go.dev/...' : 'https://npmjs.com/...'` |
| ~9   | Badge label: `d.language === 'python' ? 'Python' : d.language === 'go' ? 'Go' : 'TypeScript'` |

The badge CSS class (`lang-badge-${d.language}`) is generated dynamically and will work automatically once a colour is defined for the language in `colors.js`.

---

## 11. Tests

Add a test file `src/test/suite/analyze<Lang>.test.ts` that covers at minimum:

- File collection (correct extensions included, hidden dirs and excluded dirs skipped)
- `collectDefinitions` — function/method detection, correct `language` field
- `collectCalls` — internal edge creation, library node creation, deduplication

Also add cases to `src/test/suite/webviewUtils.test.ts` for:

- `highlightCode(source, '<newlang>')` with representative keyword and comment syntax
- `getLanguageColor('<newlang>')` returns the expected hex

---

## 12. Package metadata — `package.json`

Update the `description` (line ~4) and `keywords` array (lines ~18-20) to mention the new language, so the VS Code Marketplace listing stays accurate.

---

## Quick-reference checklist

```
[ ] scripts/analyze_<lang>.<ext>         — new analyzer script
[ ] src/analyzerRunner.ts                — spawn + merge results
[ ] src/analyzerRunner.ts                — GraphNode type union
[ ] src/graphProvider.ts                 — GraphNode type union
[ ] src/graphProvider.ts                 — save-listener extensions + languageId map
[ ] src/gitService.ts                    — GraphNode type union
[ ] src/webview/colors.js                — languageColors entry
[ ] src/webview/folder.js                — inferLangFromPath() + EMPTY_FILE_EXTS
[ ] src/sourceEditor.ts                  — function boundary detection (if needed)
[ ] src/webview/highlight.js             — keywords + tokeniser rules
[ ] src/libraryDescriber.ts              — docs fetcher (if applicable)
[ ] src/webview/popups.js                — docs URL + badge label
[ ] src/test/suite/analyze<Lang>.test.ts — analyzer tests
[ ] src/test/suite/webviewUtils.test.ts  — highlight + color tests
[ ] package.json                         — description + keywords
```
