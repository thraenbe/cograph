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

## 2026-09-19
- **Annotate Graph uses a narrow provider call, not the whole-graph round trip.**
  Why: `run()` ships the full graph both ways and runs the CLI write-capable, which is the
  main cost and failure source and the wrong trust level for "40 one-line summaries".
  `runJson()` sends a prompt + JSON schema over stdin and gets one object back; Claude gets no
  tools (read-only tools only when the user opts into source reading), Codex always runs in
  the read-only sandbox. Evidence: default Claude Code context cost $0.195 per haiku call vs
  $0.005 with `--system-prompt --strict-mcp-config --disable-slash-commands`; extended
  thinking was ~4x the output tokens, so it is off (`MAX_THINKING_TOKENS=0`). A 182-path repo
  cost $0.09 in 69 s.
  Design: annotations live outside `GraphData` in `.cograph/annotations/annotations.json`,
  keyed by workspace-relative POSIX path; staleness is a content hash (size + mtime only skip
  the hashing); folders are summarised bottom-up from child summaries; nothing is ever
  re-sent automatically. The hover card is one delegated listener set and edits no other
  webview module. Plan and measurements: `.ai/plans/annotate-graph.md`.

