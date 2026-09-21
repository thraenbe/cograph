# CoGraph

[![CI](https://github.com/thraenbe/cograph/actions/workflows/ci.yml/badge.svg)](https://github.com/thraenbe/cograph/actions/workflows/ci.yml)
[![VS Code Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/thraenbe.cograph?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=thraenbe.cograph)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/thraenbe.cograph)](https://marketplace.visualstudio.com/items?itemName=thraenbe.cograph)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/thraenbe.cograph)](https://marketplace.visualstudio.com/items?itemName=thraenbe.cograph&ssr=false#review-details)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Visualize your Python, TypeScript, JavaScript, Java, or C++ project as an interactive call graph — functions are nodes, calls are edges. Navigate your codebase by clicking. No configuration required.

When AI writes the code, humans need a better way to understand it. CoGraph is the situational-awareness layer for agentic development: a real-time, multi-dimensional map of what is being built in your project.

![CoGraph call graph overview](docs/images/graph-overview.png)

<!-- TODO(maintainer): replace the static screenshot above with an animated demo GIF at docs/images/demo.gif showing "CoGraph: Visualize Project" → navigating the graph. -->

## Install

- **VS Code Marketplace:** [marketplace.visualstudio.com/items?itemName=thraenbe.cograph](https://marketplace.visualstudio.com/items?itemName=thraenbe.cograph)
- **From the Extensions view:** open Extensions (`Ctrl/Cmd+Shift+X`), search **CoGraph**, and click *Install*.
- **Command line:**
  ```bash
  code --install-extension thraenbe.cograph
  ```

## Quick start (30 seconds)

1. Open any Python, TypeScript, JavaScript, Java, or C++ project folder in VS Code.
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Run **`CoGraph: Visualize Project`**.

The call graph opens in a side panel. Click a node to jump to its definition; use the
toolbar to toggle overlays.

## Features

- **Static analysis, zero config** — extracts the call graph using each language's native tooling: Python's built-in `ast`, the TypeScript compiler API, `java-parser` for Java, and `web-tree-sitter` for C++. No runtime instrumentation, no setup.
- **Interactive graph** — zoom, pan, drag nodes, and filter by function name.
- **Click-to-navigate** — click any node to open the file and jump to the function definition.
- **Function source popup** — click a node to open a draggable, resizable popup showing syntax-highlighted source code; multiple popups can be open simultaneously.
- **OOP class overlay** — visualize class hierarchies, fields, and methods; toggle with the **Class** button.
- **Folder/file structure overlay** — hierarchical grouping by directory with drag/resize support; toggle with the **Folder** button.
- **Git integration** — color nodes by their git status (modified, new, deleted, staged); toggle with the **Git** button.
- **Language coloring** — color nodes by file/language; toggle with the **Language** button.
- **Library node clustering** — external library calls are grouped into collapsed cluster nodes (e.g. `numpy (7)`) to prevent visual clutter; click a cluster to expand it.
- **Detail / Complexity slider** — progressively cluster low-connectivity nodes to keep large projects navigable.
- **Save Layout** — persist node positions to `.cograph/<name>.json`; reopen the same graph and pick up where you left off.
- **Open Chat** — focus the Cograph activity-bar view with the active graph already selected.
- **Hover card** — rest the pointer on a folder or file to see its path, size and languages, plus its AI summary once generated.
- **Settings panel** — tune layout forces (center, repel, link strength, link distance), display options (node size, text size, link thickness, arrows), and visibility toggles (orphan nodes, library nodes).

## Graph Intelligence (AI features)

AI features are **off by default**. Nothing is sent to an AI provider until you turn on `cograph.graphIntelligence.enabled`. They run the **Claude Code** or **OpenAI Codex** CLI that is already installed and signed in on your machine, so requests go through your own account; CoGraph has no server of its own.

- **Chat** — ask questions about the open graph in the CoGraph sidebar.
- **AI Workflow Graph** — a left-to-right view of how the system runs, from entry points to frontend output, with 10 detail levels.
- **Annotate Graph** — a one-sentence summary of what every folder and file is responsible for, shown when you hover it.
  - By default CoGraph sends only a locally built digest: file paths, function and class names with their signature lines, import names and the leading comment of each file. No function bodies are sent, and with Claude Code the AI cannot open files. Turn on `cograph.graphIntelligence.annotate.readSource` to let it read source files (read-only) for better summaries. The Codex CLI can always read files in the workspace.
  - You confirm an estimate before anything is sent, see the running cost, and the run stops at `cograph.graphIntelligence.annotate.maxRunBudgetUsd` (default $2) and keeps what is done. As a guide, a 180-path repository cost about $0.09 with Claude haiku.
  - Editing a file only marks its summary "outdated". Nothing is re-sent until you click **Update**, which re-annotates just the outdated and missing paths.
  - Summaries are stored locally in `.cograph/annotations/` and are not committed.

Chat and the Workflow Graph have per-request caps for turns, spend and time (`cograph.graphIntelligence.maxTurns`, `maxBudgetUsd`, `timeoutMs`).

## Requirements

- VS Code 1.75+
- **Python projects:** Python 3.x available (via `python3`, a virtual environment, or the VS Code Python extension)
- **TypeScript / JavaScript projects:** Node.js — no additional configuration needed
- **Java projects:** no extra runtime — the analyzer ships with a pure-JS parser
- **C++ projects:** no extra runtime — the analyzer ships with a tree-sitter WebAssembly grammar

## Usage

1. Open a Python, TypeScript, JavaScript, Java, or C++ project folder in VS Code.
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **`CoGraph: Visualize Project`**.
3. The call graph opens in a side panel.
4. Use the search bar to filter functions by name (`Ctrl+F` / `Cmd+F` focuses it).
5. Click any node to navigate to its definition, or view its source in a popup.
6. Toggle **Git** or **Language** coloring with the buttons in the top-left.
7. Toggle the **Class** button to overlay OOP class hierarchy and field information.
8. Toggle the **Folder** button to overlay the directory/file structure as collapsible groups.
9. Use the **Complexity** slider to collapse less-connected nodes on large graphs.
10. Click **Save Layout** to persist the current node positions, or **Open Chat** to focus the Cograph activity-bar view with this graph selected.
11. Open the **Settings** panel (gear icon) to adjust layout and display options.

## Troubleshooting

- **The graph is empty.** Make sure the open folder actually contains source files in a
  supported language. For Python, confirm a `python3` interpreter is resolvable (a
  virtual environment or the VS Code Python extension is enough).
- **Python projects show nothing on Linux.** If VS Code is installed as a **snap**, its
  bundled runtime can interfere with analyzers — a deb/tarball install of VS Code avoids
  this. (CoGraph's bundled analyzers are pure-JS/WASM specifically to minimize this.)
- **A large repo feels heavy.** Since 1.2.0 the **Shelf** engine packs each folder
  into its own frame and only simulates open folders, so size hurts far less (it opens
  in **Static** motion by default — click **Dynamic** to let it settle live). If needed,
  use the **Detail** slider or the search filter — or switch the engine toggle to
  **Global** for the classic layout (`cograph.layout.defaultEngine` /
  `cograph.layout.defaultMode` set the startup combination). The Shelf engine's
  simulations run in background workers (`cograph.layout.workers`: `auto` | `on` | `off`,
  default `auto`; `off` simulates on the UI thread), and when zoomed far out labels, call
  lines and function dots are dropped until you zoom back in.
- **Some calls are missing.** Dynamic dispatch, `eval`, and computed/runtime-generated
  calls are not statically resolvable — see *Limitations*.

## Limitations

- Dynamic dispatch and runtime-generated functions are not tracked.
- Calls are resolved by name. When a called name has more than 8 definitions in the workspace, only those in the caller's file, then directory, then top-level package are linked; if more than 8 still remain the call is left unresolved (the CoGraph output channel reports how many).
- Cross-package call edges (into installed libraries) are intentionally excluded — external calls are surfaced through library cluster nodes instead.
- TypeScript / JavaScript analysis covers static call sites; dynamic patterns (e.g. `eval`, computed property calls) are not tracked.
- Java and C++ analysis covers statically resolvable calls; macro-heavy or template-heavy C++ code may produce a partial graph.
- Very large projects may require the Complexity slider or search filter to navigate comfortably.

## Contributing

Contributions are welcome! See **[CONTRIBUTING.md](CONTRIBUTING.md)** for local setup,
build/test instructions, and the PR process. Please also review our
[Code of Conduct](CODE_OF_CONDUCT.md). For bugs and ideas, use the
[issue tracker](https://github.com/thraenbe/cograph/issues); for questions and sharing,
use [Discussions](https://github.com/thraenbe/cograph/discussions).

## Security

Found a vulnerability? Please report it privately — see **[SECURITY.md](SECURITY.md)**.

## License

[MIT](LICENSE) © Bela Thrän
