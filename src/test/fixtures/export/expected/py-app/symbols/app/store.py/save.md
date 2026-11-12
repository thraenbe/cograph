# app/store.py::save

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
app/store.py::save
  where: app/store.py:12
  language: python

Called by: none in the graph.

Calls (1):
- library::json::dump  (library json)  ←1 →0

## Callers within depth 2

Nothing in the graph calls app/store.py::save. Static analysis misses dynamic dispatch, callbacks and reflection, so this is not proof it is unused.

## Callees within depth 2 (with libraries)

1 function(s) within depth 2 are called by app/store.py::save:

depth 1:
- library::json::dump  (library json)  ←1 →0

## Impact

Nothing in the graph calls into app/store.py::save (1 function(s)). Static analysis misses dynamic dispatch, callbacks and reflection; check those before assuming it is safe.
