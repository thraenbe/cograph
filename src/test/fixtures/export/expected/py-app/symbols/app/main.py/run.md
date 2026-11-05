# app/main.py::run

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
app/main.py::run
  where: app/main.py:4
  language: python

Called by: none in the graph.

Calls (2):
- app/main.py::report  L12  ←1 →0
- app/store.py::make_store  L17  ←1 →0

## Callers within depth 2

Nothing in the graph calls app/main.py::run. Static analysis misses dynamic dispatch, callbacks and reflection, so this is not proof it is unused.

## Callees within depth 2 (with libraries)

2 function(s) within depth 2 are called by app/main.py::run:

depth 1:
- app/main.py::report  L12  ←1 →0
- app/store.py::make_store  L17  ←1 →0

## Impact

Nothing in the graph calls into app/main.py::run (1 function(s)). Static analysis misses dynamic dispatch, callbacks and reflection; check those before assuming it is safe.
