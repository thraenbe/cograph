# Architectural Decisions

## 2026-02-27
Chose monolith over microservices because:
- Solo development
- Lower cognitive load

## 2026-08-24
- **Folder-frames layout engine over one global force simulation** (webview, File lens).
  Why: cost scaled with repo size on every axis (one d3 simulation over all nodes, full
  SVG rewrite per tick, per-tick folder boxes + pairwise separation forces, global reheat
  on any interaction) — issues #50/#52. Evidence: 765/776 function edges are intra-folder
  in this repo; sim-only cost at 3 000 nodes 12.3 ms/tick global vs 6.4 ms per-folder.
  Design: deterministic shelf-packed nested frames (frames.js) + one clamped local
  simulation per open folder (localSim.js, ≤4 active via frameScheduler.js), facade keeps
  every existing state.simulation call site untouched; node data stays absolute, DOM is
  frame-local. `cograph.layout.engine` switches engines; saved layouts v2. Full plan with
  measurements: dev.cograph.co (cograph-web/src/app/dev/). Next committed step: Web Worker
  pool behind the localSim API (P6) after real-world measurement.
