# Contributing to CoGraph

Thanks for your interest in improving CoGraph! This document covers how to set up a
local development environment, the project conventions, and how changes get released.

CoGraph is a VS Code extension that renders an interactive call graph of your project.
It's a solo-maintained, monolithic TypeScript codebase — lower cognitive load over
microservice ceremony.

## Prerequisites

- **Node.js 20+** and npm
- **VS Code 1.75+**
- **Python 3.x** (only needed to exercise the Python analyzer)
- Git

## Local setup

```bash
git clone https://github.com/thraenbe/cograph.git
cd cograph
npm ci
npm run bundle:watch # incremental esbuild bundle to ./dist — this is what the dev host runs
```

`npm run watch` (incremental `tsc` to `./out`) is still useful alongside it: esbuild
does not type-check, so tsc is where type errors surface.

To launch the extension in a development host:

1. Open the folder in VS Code.
2. Press **F5** (Run → Start Debugging) to open an **Extension Development Host** window.
3. In that window, open any project folder, then run **`CoGraph: Visualize Project`**
   from the Command Palette (`Ctrl/Cmd+Shift+P`).

## Build, lint, and test

```bash
npm run compile      # one-off type-checking TypeScript build to ./out (tests run from here)
npm run bundle       # one-off esbuild bundle to ./dist (VS Code runs the extension from here)
npm run lint         # ESLint over src/**/*.ts
npm test             # Mocha suite via @vscode/test-electron (downloads VS Code)
npm run package      # produce a .vsix (sanity-check packaging)
```

`npm test` downloads a pinned VS Code build and runs the suite headlessly. On Linux it
needs a display server — use `xvfb-run -a npm test` (this is what CI does).

## Project conventions

- **Naming:** `camelCase` variables, `PascalCase` components/classes, `snake_case` only
  for things that cross into Python/DB land.
- **Size:** prefer files < 400 LOC and functions < 50 LOC.
- **Error handling:** every async function handles its errors explicitly — don't swallow
  exceptions silently.
- **Logging:** structured logs only; no stray `console.log` in shipped code.
- **Tests:** add or update tests for behavior changes. Tests live in `src/test/suite/` and
  are discovered as `out/test/suite/**/*.test.js` after compilation.

### Analyzer constraint (important)

Language analyzers (`scripts/analyze_*.js`) run inside VS Code's bundled Electron/Node
runtime. On snap-packaged VS Code this pins an old `libstdc++`, so **prebuilt native
(`node-gyp`/`.node`) modules fail to load and the graph silently comes back empty**.
Any new language support **must use pure-JS or WebAssembly parsers** (like the
`web-tree-sitter` WASM grammar used for C++) — never native node modules.

### Packaging gotcha

`.vscodeignore` blanket-excludes `node_modules/**`. If you add a **runtime** dependency,
you must explicitly un-ignore it *and its hoisted transitive deps* in `.vscodeignore`, or
the extension will work locally but break in the packaged `.vsix`.

## Pull request process

1. Branch off `main` (`feat/…`, `fix/…`, or `chore/…`).
2. Keep changes focused; avoid unrelated refactors in the same PR.
3. Ensure `npm run lint` and `npm test` pass locally.
4. Update `CHANGELOG.md` under the `[Unreleased]` section.
5. Open the PR using the template; link any related issue and describe how you tested.
6. CI runs the suite on Linux, macOS, and Windows — keep it green.

## Release process (maintainer)

Releases are tag-driven and automated by `.github/workflows/release.yml`:

1. Move `[Unreleased]` notes into a new `[X.Y.Z]` section in `CHANGELOG.md`.
2. Bump `version` in `package.json`.
3. Commit, then tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin main --tags
   ```
4. The workflow tests, packages the `.vsix`, creates a GitHub Release with it attached,
   and publishes to the VS Code Marketplace (using the `VSCE_PAT` repository secret).

## Code of conduct

Participation is governed by our [Code of Conduct](CODE_OF_CONDUCT.md).
