# CoGraph

A VS Code extension that visualizes Python project call graphs. Functions are nodes; calls between them are edges. Click any node to jump directly to that function in the editor.

## Features

- Static call graph extraction via Python's built-in `ast` module — no runtime required
- Interactive graph with zoom, pan, and function name filtering
- Click-to-navigate: clicking a node opens the file and places the cursor on the function
- Works on any Python project — no configuration needed

## Requirements

- VS Code 1.85+
- Python 3.x installed and available as `python3`

## Usage

1. Open a Python project folder in VS Code
2. Run the command **`CoGraph: Visualize Project`** (via Command Palette `Ctrl+Shift+P`)
3. The call graph opens in a side panel
4. Use the search bar to filter functions by name
5. Click any node to navigate to the function definition

## Development Setup

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch the Extension Development Host.

To watch for changes:

```bash
npm run watch
```

To lint:

```bash
npm run lint
```

## Architecture

```
Workspace .py files
      │
      ▼
scripts/analyze.py          Python AST walker (child process)
      │  JSON via stdout
      ▼
src/graphProvider.ts        Webview lifecycle + message routing
      │  postMessage
      ▼
src/webview/main.ts         Cytoscape.js graph rendering
      │  postMessage { navigate }
      ▼
src/graphProvider.ts        Opens file at line in editor
```

**Key design decisions:**

- Analysis is scoped to workspace files only — installed packages are not traversed
- Static analysis is best-effort; dynamic Python patterns (decorators, `getattr`, monkey-patching) are not resolved
- Monolith — no external server; the Python script is a self-contained child process

## Limitations

- Dynamic dispatch and runtime-generated functions are not tracked
- Cross-package call edges (into installed libraries) are intentionally excluded
- Very large projects may require using the filter to navigate comfortably
