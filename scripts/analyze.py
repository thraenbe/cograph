"""
CoGraph Python AST analyzer.

Usage: python3 analyze.py <workspace_root>

Outputs a JSON call graph to stdout:
  { "nodes": [{id, name, file, line}], "edges": [{source, target}] }

Scope: workspace .py files only. Best-effort static analysis.
Dynamic dispatch, getattr, and monkey-patching are not resolved.
"""

import ast
import json
import os
import sys


def collect_definitions(root: str) -> dict[str, dict]:
    """Walk all .py files and collect function definitions keyed by qualified id."""
    definitions = {}
    for dirpath, _, filenames in os.walk(root):
        for filename in filenames:
            if not filename.endswith('.py'):
                continue
            filepath = os.path.join(dirpath, filename)
            try:
                source = open(filepath, encoding='utf-8', errors='ignore').read()
                tree = ast.parse(source, filename=filepath)
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    qualified_id = f"{filepath}::{node.name}::{node.lineno}"
                    definitions[qualified_id] = {
                        'id': qualified_id,
                        'name': node.name,
                        'file': filepath,
                        'line': node.lineno,
                        'language': 'python',
                    }
    return definitions


def collect_import_map(tree: ast.AST) -> dict[str, str]:
    """Return localName -> moduleName for all non-relative imports in a parsed AST."""
    import_map: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                local = alias.asname if alias.asname else alias.name
                import_map[local] = alias.name
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                continue  # skip relative imports
            module = node.module or ''
            for alias in node.names:
                local = alias.asname if alias.asname else alias.name
                import_map[local] = f"{module}.{alias.name}" if module else alias.name
    return import_map


def collect_calls(root: str, definitions: dict) -> tuple[list[dict], list[dict]]:
    """Walk all .py files and collect call edges between known definitions, plus library nodes."""
    name_to_ids: dict[str, list[str]] = {}
    for qid, defn in definitions.items():
        name_to_ids.setdefault(defn['name'], []).append(qid)

    edges = []
    seen_edges: set[tuple[str, str]] = set()
    library_nodes: dict[str, dict] = {}

    for dirpath, _, filenames in os.walk(root):
        for filename in filenames:
            if not filename.endswith('.py'):
                continue
            filepath = os.path.join(dirpath, filename)
            try:
                source = open(filepath, encoding='utf-8', errors='ignore').read()
                tree = ast.parse(source, filename=filepath)
            except SyntaxError:
                continue

            import_map = collect_import_map(tree)

            for func_node in ast.walk(tree):
                if not isinstance(func_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                caller_id = f"{filepath}::{func_node.name}::{func_node.lineno}"
                if caller_id not in definitions:
                    continue
                for child in ast.walk(func_node):
                    if not isinstance(child, ast.Call):
                        continue
                    callee_name = _bare_name(child.func) or _method_name(child.func)
                    if callee_name and callee_name in name_to_ids:
                        for callee_id in name_to_ids[callee_name]:
                            key = (caller_id, callee_id)
                            if key not in seen_edges and caller_id != callee_id:
                                seen_edges.add(key)
                                edges.append({'source': caller_id, 'target': callee_id})
                    # Detect bare-name library calls: foo() where foo is an imported name
                    if isinstance(child.func, ast.Name):
                        name = child.func.id
                        if name in import_map and name not in name_to_ids:
                            _emit_library_edge(caller_id, import_map[name], name, library_nodes, seen_edges, edges)
                    # Detect attribute library calls: np.array() where np is an imported name
                    elif isinstance(child.func, ast.Attribute) and isinstance(child.func.value, ast.Name):
                        obj_name = child.func.value.id
                        if obj_name in import_map and obj_name not in name_to_ids:
                            _emit_library_edge(caller_id, import_map[obj_name], child.func.attr, library_nodes, seen_edges, edges)
    return edges, list(library_nodes.values())


def _emit_library_edge(caller_id: str, lib_name: str, func_name: str, library_nodes: dict, seen_edges: set, edges: list) -> None:
    """Emit a library node (if new) and a library edge from caller to it."""
    lib_id = f"library::{lib_name}::{func_name}"
    if lib_id not in library_nodes:
        library_nodes[lib_id] = {
            'id': lib_id, 'name': func_name, 'file': None, 'line': 0,
            'isLibrary': True, 'libraryName': lib_name, 'language': 'python',
        }
    key = (caller_id, lib_id)
    if key not in seen_edges:
        seen_edges.add(key)
        edges.append({'source': caller_id, 'target': lib_id, 'isLibraryEdge': True})


def _bare_name(node: ast.expr) -> str | None:
    """Direct calls only: foo()"""
    if isinstance(node, ast.Name):
        return node.id
    return None


def _method_name(node: ast.expr) -> str | None:
    """self.foo() and cls.foo() only — not arbitrary obj.foo()"""
    if not isinstance(node, ast.Attribute):
        return None
    if not isinstance(node.value, ast.Name):
        return None
    if node.value.id not in ('self', 'cls'):
        return None
    return node.attr


MAIN_NODE_ID = '::MAIN::0'


def collect_entry_points(root: str, definitions: dict) -> list[str]:
    """Return IDs of functions called at module top-level or in if __name__=='__main__' blocks."""
    name_to_ids: dict[str, list[str]] = {}
    for qid, defn in definitions.items():
        name_to_ids.setdefault(defn['name'], []).append(qid)

    found: set[str] = set()

    for dirpath, _, filenames in os.walk(root):
        for filename in filenames:
            if not filename.endswith('.py'):
                continue
            filepath = os.path.join(dirpath, filename)
            try:
                source = open(filepath, encoding='utf-8', errors='ignore').read()
                tree = ast.parse(source, filename=filepath)
            except SyntaxError:
                continue

            for node in tree.body:
                if _is_main_guard(node):
                    for stmt in node.body:
                        _collect_calls_in_stmt(stmt, name_to_ids, found)
                elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                    _collect_calls_in_stmt(node, name_to_ids, found)

    return list(found)


def _is_main_guard(node: ast.stmt) -> bool:
    """True if node is `if __name__ == '__main__':` (or reversed)."""
    if not isinstance(node, ast.If):
        return False
    test = node.test
    if not isinstance(test, ast.Compare) or len(test.ops) != 1:
        return False
    if not isinstance(test.ops[0], ast.Eq):
        return False
    left, comparator = test.left, test.comparators[0]
    def _is_name(n): return isinstance(n, ast.Name) and n.id == '__name__'
    def _is_main(n): return isinstance(n, ast.Constant) and n.value == '__main__'
    return (_is_name(left) and _is_main(comparator)) or (_is_main(left) and _is_name(comparator))


def _collect_calls_in_stmt(stmt: ast.stmt, name_to_ids: dict, found: set) -> None:
    """Walk a statement and add known bare-name call targets to found."""
    for node in ast.walk(stmt):
        if isinstance(node, ast.Call):
            name = _bare_name(node.func)
            if name and name in name_to_ids:
                for qid in name_to_ids[name]:
                    found.add(qid)


def main():
    if len(sys.argv) < 2:
        print('Usage: analyze.py <workspace_root>', file=sys.stderr)
        sys.exit(1)

    root = sys.argv[1]
    definitions = collect_definitions(root)
    edges, library_nodes = collect_calls(root, definitions)
    entry_point_ids = collect_entry_points(root, definitions)

    nodes = list(definitions.values())
    if entry_point_ids:
        nodes.append({'id': MAIN_NODE_ID, 'name': 'MAIN', 'file': '', 'line': 0})
        for ep_id in entry_point_ids:
            edges.append({'source': MAIN_NODE_ID, 'target': ep_id})

    nodes.extend(library_nodes)
    all_files = [os.path.join(dp, f) for dp, _, fs in os.walk(root) for f in fs if f.endswith('.py')]
    print(json.dumps({'nodes': nodes, 'edges': edges, 'files': all_files}))


if __name__ == '__main__':
    main()
