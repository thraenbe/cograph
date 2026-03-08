# CoGraph

Visualize your Python project as an interactive call graph. Functions are nodes; calls between them are edges. Navigate your codebase by clicking — no configuration required.

## Features

- **Static analysis** — extracts the call graph from Python's built-in `ast` module; no runtime or instrumentation needed
- **Interactive graph** — zoom, pan, drag nodes, and filter by function name
- **Click-to-navigate** — click any node to open the file and jump to the function definition
- **Detail / Complexity slider** — progressively cluster low-connectivity nodes to keep large projects navigable
- **Git integration** — color nodes by their git status (modified, new, deleted, staged); toggle with the Git button
- **Language coloring** — color nodes by file/language; toggle with the Language button
- **Library node clustering** — external library calls are grouped into collapsed cluster nodes (e.g. `numpy (7)`) to prevent visual clutter; click a cluster to expand it
- **Settings panel** — tune layout forces (center, repel, link strength, link distance), display options (node size, text size, link thickness, arrows), and visibility toggles (orphan nodes, library nodes)

## Requirements

- VS Code 1.85+
- Python 3.x installed and available as `python3`

## Usage

1. Open a Python project folder in VS Code
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **`CoGraph: Visualize Project`**
3. The call graph opens in a side panel
4. Use the search bar to filter functions by name
5. Click any node to navigate to its definition
6. Toggle **Git** or **Language** coloring with the buttons in the top-left
7. Use the **Complexity** slider to collapse less-connected nodes on large graphs
8. Open the **Settings** panel (gear icon) to adjust layout and display options

## Limitations

- Dynamic dispatch and runtime-generated functions are not tracked
- Cross-package call edges (into installed libraries) are intentionally excluded
- Very large projects may require using the Complexity slider or search filter to navigate comfortably
