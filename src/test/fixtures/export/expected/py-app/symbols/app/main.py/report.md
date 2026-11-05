# app/main.py::report

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
app/main.py::report
  where: app/main.py:12
  language: python

Called by (1):
- app/main.py::run  L4  ←0 →2

Calls: none in the graph.

## Callers within depth 2

1 function(s) within depth 2 call app/main.py::report:

depth 1:
- app/main.py::run  L4  ←0 →2

## Callees within depth 2 (with libraries)

app/main.py::report calls nothing that the analysis resolved.

## Impact

Changing app/main.py::report (1 function(s)) can affect 1 caller(s) in 1 file(s), up to 1 call(s) away.

By file (nearest first: file, functions affected, nearest distance):
- app/main.py  1 fn, 1 hop(s)

Entry points on these call chains (nothing calls them) (1):
- app/main.py::run  L4  ←0 →2

Nearest callers (1 of 1):
- app/main.py::run  L4  ←0 →2  1 hop(s)
