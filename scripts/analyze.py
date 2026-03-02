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
                    }
    return definitions


def collect_calls(root: str, definitions: dict) -> list[dict]:
    """Walk all .py files and collect call edges between known definitions."""
    name_to_ids: dict[str, list[str]] = {}
    for qid, defn in definitions.items():
        name_to_ids.setdefault(defn['name'], []).append(qid)

    edges = []
    seen_edges: set[tuple[str, str]] = set()

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
    return edges


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


def main():
    if len(sys.argv) < 2:
        print('Usage: analyze.py <workspace_root>', file=sys.stderr)
        sys.exit(1)

    root = sys.argv[1]
    definitions = collect_definitions(root)
    edges = collect_calls(root, definitions)

    graph = {
        'nodes': list(definitions.values()),
        'edges': edges,
    }
    print(json.dumps(graph))


if __name__ == '__main__':
    main()
