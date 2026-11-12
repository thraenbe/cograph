# Overview

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
workspace: 6 function(s) in 2 file(s).
Languages: python 6.

Folders (functions, files, AI summary if annotated):
./  6 fn in 2 file(s)
  app/  6 fn in 2 file(s)

Entry points (nothing calls them; tests excluded):
- app/main.py::run  L4  ←0 →2
- app/store.py::load  L8  ←0 →1
- app/store.py::save  L12  ←0 →1

Hot spots (most callers):
- app/main.py::report  L12  ←1 →0
- app/store.py::make_store  L17  ←1 →0
