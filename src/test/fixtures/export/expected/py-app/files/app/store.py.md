# app/store.py

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).

## Functions

app/store.py: 4 function(s) in 1 file(s).
Languages: python 4.

Functions (id, line, ←callers →callees):
- app/store.py::__init__  L5  ←0 →0
- app/store.py::load  L8  ←0 →1
- app/store.py::save  L12  ←0 →1
- app/store.py::make_store  L17  ←1 →0

### app/store.py::__init__

Called by (0):
none

Calls (0):
none

### app/store.py::load

Called by (0):
none

Calls (1):
- library::json::load  (library json)  ←1 →0

### app/store.py::save

Called by (0):
none

Calls (1):
- library::json::dump  (library json)  ←1 →0

### app/store.py::make_store

Called by (1):
- app/main.py::run  L4  ←0 →2

Calls (0):
none
