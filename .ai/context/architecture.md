# Architecture Overview

## Stack
- Frontend: TypeScript + Cytoscape.js (in VS Code Webview)
- Backend: Python (AST analysis script, spawned as child process)
- Extension Host: TypeScript (VS Code Extension API)
- Database: None (stateless — graph computed on demand)
- Auth: None
- Hosting: VS Code Marketplace

## Folder Structure

```
cograph/
├── src/
│   ├── extension.ts          # Activation, command registration, child process management
│   ├── graphProvider.ts      # Webview panel lifecycle, message routing
│   └── webview/
│       ├── index.html        # Webview entry point
│       ├── main.ts           # Cytoscape init, user interaction, message handling
│       └── styles.css
├── scripts/
│   └── analyze.py            # AST walker — reads workspace .py files, outputs JSON graph
├── package.json              # VS Code extension manifest + dependencies
├── tsconfig.json
└── README.md
```

## Core Flows

1. **Graph generation**
   - User runs command "CoGraph: Visualize Project"
   - Extension host spawns `analyze.py` as a child process, passing workspace root
   - `analyze.py` walks all `.py` files via Python `ast` module
   - Outputs JSON `{ nodes: [{id, name, file, line}], edges: [{source, target}] }` to stdout
   - Extension host parses JSON and opens a Webview panel
   - Graph data sent to Webview via `webview.postMessage`

2. **Interactive visualization**
   - Webview renders graph using Cytoscape.js (`cose-bilkent` layout by default)
   - User can zoom, pan, and filter/search by function name

3. **Navigate to source**
   - User clicks a node in the Webview
   - Webview sends `{ type: 'navigate', file, line }` message to extension host
   - Extension host calls `vscode.workspace.openTextDocument` + `vscode.window.showTextDocument`

## Data Flow

```
Workspace .py files
        │
        ▼
  analyze.py (child_process)   ← Python AST, best-effort static analysis
        │  JSON via stdout
        ▼
  Extension Host (TypeScript)
        │  postMessage
        ▼
  Webview (Cytoscape.js)
        │  postMessage { type: 'navigate', file, line }
        ▼
  Extension Host → opens file at line in editor
```

## Design Decisions

- **Python `ast` module over third-party parsers:** Zero extra dependencies, ships with Python, sufficient for best-effort static call graph extraction.
- **Scope limited to workspace files only:** Do not follow imports into installed packages — prevents node explosion on projects like TensorFlow.
- **Cytoscape.js for rendering:** Handles thousands of nodes, multiple layout algorithms, runs fully client-side in the Webview sandbox.
- **Monolith:** Single extension package — no separate backend server. Simpler deployment and no network requirements.
- **Best-effort static analysis:** Dynamic Python features (decorators, `getattr`, monkey-patching) are not resolved. Documented limitation.

## Known Limitations

- Dynamic dispatch, `getattr`, and runtime-generated functions are not tracked
- Cross-package call edges (into installed libraries) are intentionally excluded
- Very large projects (TensorFlow, PyTorch) may require filtering to remain usable

## Benchmark Projects

NumPy, Requests, Pandas, Matplotlib, Scikit-learn, TensorFlow, PyTorch, Django, Flask, Pillow, SciPy, SQLAlchemy, Pytest, Celery, FastAPI, Boto3, Pydantic, BeautifulSoup, Scrapy, OpenCV, Keras, Selenium, Cryptography, NLTK, Airflow
