# CoGraph

Visualize your Python, TypeScript, or JavaScript project as an interactive call graph. Functions are nodes; calls between them are edges. Navigate your codebase by clicking — no configuration required.

## Features

- **Static analysis** — extracts the call graph from Python's built-in `ast` module (Python) and TypeScript's compiler API (TypeScript/JavaScript); no runtime or instrumentation needed
- **Interactive graph** — zoom, pan, drag nodes, and filter by function name
- **Click-to-navigate** — click any node to open the file and jump to the function definition
- **Function source popup** — click a node to open a draggable, resizable popup showing syntax-highlighted source code; multiple popups can be open simultaneously
- **OOP class overlay** — visualize class hierarchies, fields, and methods; toggle with the **Class** button
- **Folder/file structure overlay** — hierarchical grouping by directory with drag/resize support; toggle with the **Folder** button
- **Detail / Complexity slider** — progressively cluster low-connectivity nodes to keep large projects navigable
- **Git integration** — color nodes by their git status (modified, new, deleted, staged); toggle with the **Git** button
- **Language coloring** — color nodes by file/language; toggle with the **Language** button
- **Library node clustering** — external library calls are grouped into collapsed cluster nodes (e.g. `numpy (7)`) to prevent visual clutter; click a cluster to expand it
- **Settings panel** — tune layout forces (center, repel, link strength, link distance), display options (node size, text size, link thickness, arrows), and visibility toggles (orphan nodes, library nodes)

## Requirements

- VS Code 1.85+
- **Python projects:** Python 3.x installed and available (via `python3`, a virtual environment, or the VS Code Python extension)
- **TypeScript/JavaScript projects:** Node.js installed; no additional configuration needed

## Usage

1. Open a Python, TypeScript, or JavaScript project folder in VS Code
2. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run **`CoGraph: Visualize Project`**
3. The call graph opens in a side panel
4. Use the search bar to filter functions by name
5. Click any node to navigate to its definition, or view its source in a popup
6. Toggle **Git** or **Language** coloring with the buttons in the top-left
7. Toggle the **Class** button to overlay OOP class hierarchy and field information
8. Toggle the **Folder** button to overlay the directory/file structure as collapsible groups
9. Use the **Complexity** slider to collapse less-connected nodes on large graphs
10. Open the **Settings** panel (gear icon) to adjust layout and display options

## Limitations

- Dynamic dispatch and runtime-generated functions are not tracked
- Cross-package call edges (into installed libraries) are intentionally excluded
- TypeScript/JavaScript analysis covers static call sites; dynamic patterns (e.g. `eval`, computed property calls) are not tracked
- Very large projects may require using the Complexity slider or search filter to navigate comfortably
