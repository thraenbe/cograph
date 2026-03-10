"""
Unit tests for analyze.py.
Run with: python3 -m pytest scripts/test_analyze.py -v
       or: python3 -m unittest scripts/test_analyze.py
"""

import ast
import io
import json
import os
import sys
import tempfile
import textwrap
import unittest

# Add scripts/ directory to the path so we can import analyze.
sys.path.insert(0, os.path.dirname(__file__))
import analyze


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def write_py(directory: str, filename: str, source: str) -> str:
    """Write a .py file inside directory and return its path."""
    path = os.path.join(directory, filename)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(textwrap.dedent(source).lstrip('\n'))
    return path


# ---------------------------------------------------------------------------
# TestCollectDefinitions
# ---------------------------------------------------------------------------

class TestCollectDefinitions(unittest.TestCase):

    def test_simple_function(self):
        """A single def inside a .py file is collected."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'foo.py', """
                def my_func():
                    pass
            """)
            defs = analyze.collect_definitions(d)
        self.assertEqual(len(defs), 1)
        (qid, defn), = defs.items()
        self.assertEqual(defn['name'], 'my_func')
        self.assertEqual(defn['line'], 1)

    def test_async_function(self):
        """async def is collected alongside regular def."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'bar.py', """
                async def async_op():
                    pass
            """)
            defs = analyze.collect_definitions(d)
        names = {v['name'] for v in defs.values()}
        self.assertIn('async_op', names)

    def test_syntax_error_skipped(self):
        """Files with SyntaxErrors are silently skipped."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'broken.py', 'def (: pass')
            defs = analyze.collect_definitions(d)
        self.assertEqual(len(defs), 0)

    def test_nested_functions(self):
        """Both outer and inner functions are collected."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'nested.py', """
                def outer():
                    def inner():
                        pass
            """)
            defs = analyze.collect_definitions(d)
        names = {v['name'] for v in defs.values()}
        self.assertIn('outer', names)
        self.assertIn('inner', names)

    def test_empty_directory(self):
        """An empty directory produces an empty definitions dict."""
        with tempfile.TemporaryDirectory() as d:
            defs = analyze.collect_definitions(d)
        self.assertEqual(defs, {})

    def test_non_py_files_ignored(self):
        """Non-.py files (e.g. .txt) are not processed."""
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'readme.txt')
            with open(path, 'w') as f:
                f.write('def fake_func(): pass\n')
            defs = analyze.collect_definitions(d)
        self.assertEqual(len(defs), 0)

    def test_multiple_files(self):
        """Definitions from multiple .py files are all collected."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'a.py', """
                def func_a():
                    pass
            """)
            write_py(d, 'b.py', """
                def func_b():
                    pass
            """)
            defs = analyze.collect_definitions(d)
        names = {v['name'] for v in defs.values()}
        self.assertIn('func_a', names)
        self.assertIn('func_b', names)

    def test_subdirectory_walking(self):
        """Functions inside nested subdirectory files are collected."""
        with tempfile.TemporaryDirectory() as d:
            sub_dir = os.path.join(d, 'sub')
            os.makedirs(sub_dir)
            write_py(sub_dir, 'module.py', """
                def nested_func():
                    pass
            """)
            defs = analyze.collect_definitions(d)
        names = {v['name'] for v in defs.values()}
        self.assertIn('nested_func', names)


# ---------------------------------------------------------------------------
# TestCollectCalls
# ---------------------------------------------------------------------------

class TestCollectCalls(unittest.TestCase):

    def test_direct_call_edge(self):
        """A bare function call foo() produces an edge caller → foo."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'a.py', """
                def callee():
                    pass

                def caller():
                    callee()
            """)
            defs = analyze.collect_definitions(d)
            edges, _ = analyze.collect_calls(d, defs)

        caller_ids = [qid for qid, v in defs.items() if v['name'] == 'caller']
        callee_ids = [qid for qid, v in defs.items() if v['name'] == 'callee']
        self.assertEqual(len(caller_ids), 1)
        self.assertEqual(len(callee_ids), 1)
        self.assertIn({'source': caller_ids[0], 'target': callee_ids[0]}, edges)

    def test_self_method_call_edge(self):
        """self.method() inside a class produces an edge to the method."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'cls.py', """
                class MyClass:
                    def helper(self):
                        pass

                    def runner(self):
                        self.helper()
            """)
            defs = analyze.collect_definitions(d)
            edges, _ = analyze.collect_calls(d, defs)

        runner_ids = [qid for qid, v in defs.items() if v['name'] == 'runner']
        helper_ids = [qid for qid, v in defs.items() if v['name'] == 'helper']
        self.assertEqual(len(runner_ids), 1)
        self.assertEqual(len(helper_ids), 1)
        self.assertIn({'source': runner_ids[0], 'target': helper_ids[0]}, edges)

    def test_cls_method_call_edge(self):
        """cls.method() (class method pattern) produces an edge."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'clsm.py', """
                class Factory:
                    @classmethod
                    def build(cls):
                        cls.validate()

                    @classmethod
                    def validate(cls):
                        pass
            """)
            defs = analyze.collect_definitions(d)
            edges, _ = analyze.collect_calls(d, defs)

        build_ids = [qid for qid, v in defs.items() if v['name'] == 'build']
        validate_ids = [qid for qid, v in defs.items() if v['name'] == 'validate']
        self.assertTrue(len(build_ids) >= 1)
        self.assertTrue(len(validate_ids) >= 1)
        self.assertTrue(
            any(e['source'] == build_ids[0] and e['target'] == validate_ids[0] for e in edges),
            'Expected edge from build → validate',
        )

    def test_arbitrary_obj_call_no_edge(self):
        """obj.method() where obj is not self/cls must NOT produce an edge."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'noedge.py', """
                def process(response):
                    data = response.json()
                    return data

                def json():
                    pass
            """)
            defs = analyze.collect_definitions(d)
            edges, _ = analyze.collect_calls(d, defs)

        process_ids = [qid for qid, v in defs.items() if v['name'] == 'process']
        json_ids = [qid for qid, v in defs.items() if v['name'] == 'json']
        self.assertEqual(len(process_ids), 1)
        self.assertEqual(len(json_ids), 1)
        self.assertNotIn({'source': process_ids[0], 'target': json_ids[0]}, edges)

    def test_no_self_edges(self):
        """A function calling itself recursively does not produce a self-edge."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'recur.py', """
                def recurse(n):
                    if n > 0:
                        recurse(n - 1)
            """)
            defs = analyze.collect_definitions(d)
            edges, _ = analyze.collect_calls(d, defs)

        for edge in edges:
            self.assertNotEqual(edge['source'], edge['target'], 'Self-edges are forbidden')

    def test_deduplication(self):
        """The same call site counted twice produces only one edge."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'dup.py', """
                def helper():
                    pass

                def main():
                    helper()
                    helper()
            """)
            defs = analyze.collect_definitions(d)
            edges, _ = analyze.collect_calls(d, defs)

        helper_ids = [qid for qid, v in defs.items() if v['name'] == 'helper']
        main_ids = [qid for qid, v in defs.items() if v['name'] == 'main']
        matching = [e for e in edges if e['source'] == main_ids[0] and e['target'] == helper_ids[0]]
        self.assertEqual(len(matching), 1, 'Edge should appear exactly once')

    def test_cross_file_call(self):
        """Function in a.py calling function defined in b.py produces an edge."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'a.py', """
                def caller():
                    callee()
            """)
            write_py(d, 'b.py', """
                def callee():
                    pass
            """)
            defs = analyze.collect_definitions(d)
            edges, _ = analyze.collect_calls(d, defs)

        caller_ids = [qid for qid, v in defs.items() if v['name'] == 'caller']
        callee_ids = [qid for qid, v in defs.items() if v['name'] == 'callee']
        self.assertEqual(len(caller_ids), 1)
        self.assertEqual(len(callee_ids), 1)
        self.assertIn({'source': caller_ids[0], 'target': callee_ids[0]}, edges)

    def test_multiple_edges_from_one_caller(self):
        """One function calling three others produces three distinct edges."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'multi.py', """
                def a():
                    pass

                def b():
                    pass

                def c():
                    pass

                def caller():
                    a()
                    b()
                    c()
            """)
            defs = analyze.collect_definitions(d)
            edges, _ = analyze.collect_calls(d, defs)

        caller_ids = [qid for qid, v in defs.items() if v['name'] == 'caller']
        self.assertEqual(len(caller_ids), 1)
        outgoing = [e for e in edges if e['source'] == caller_ids[0]]
        self.assertEqual(len(outgoing), 3)

    def test_call_inside_nested_function(self):
        """Inner function calling an outer-defined function produces an edge."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'nested.py', """
                def helper():
                    pass

                def outer():
                    def inner():
                        helper()
            """)
            defs = analyze.collect_definitions(d)
            edges, _ = analyze.collect_calls(d, defs)

        inner_ids = [qid for qid, v in defs.items() if v['name'] == 'inner']
        helper_ids = [qid for qid, v in defs.items() if v['name'] == 'helper']
        self.assertEqual(len(inner_ids), 1)
        self.assertEqual(len(helper_ids), 1)
        self.assertIn({'source': inner_ids[0], 'target': helper_ids[0]}, edges)


# ---------------------------------------------------------------------------
# TestNameHelpers
# ---------------------------------------------------------------------------

class TestNameHelpers(unittest.TestCase):

    def test_bare_name_returns_name(self):
        """_bare_name on an ast.Name node returns the identifier."""
        node = ast.parse('foo()', mode='eval').body  # ast.Call
        name_node = node.func  # ast.Name
        self.assertEqual(analyze._bare_name(name_node), 'foo')

    def test_method_name_self(self):
        """_method_name on self.bar returns 'bar'."""
        node = ast.parse('self.bar()', mode='eval').body
        attr_node = node.func  # ast.Attribute
        self.assertEqual(analyze._method_name(attr_node), 'bar')

    def test_method_name_cls(self):
        """_method_name on cls.baz returns 'baz'."""
        node = ast.parse('cls.baz()', mode='eval').body
        attr_node = node.func
        self.assertEqual(analyze._method_name(attr_node), 'baz')

    def test_method_name_other_returns_none(self):
        """_method_name on obj.qux (not self/cls) returns None."""
        node = ast.parse('obj.qux()', mode='eval').body
        attr_node = node.func
        self.assertIsNone(analyze._method_name(attr_node))


# ---------------------------------------------------------------------------
# TestCollectEntryPoints
# ---------------------------------------------------------------------------

class TestCollectEntryPoints(unittest.TestCase):

    def test_main_guard_calls(self):
        """Functions called in if __name__ == '__main__': are detected."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'app.py', """
                def run():
                    pass

                if __name__ == '__main__':
                    run()
            """)
            defs = analyze.collect_definitions(d)
            entry_ids = analyze.collect_entry_points(d, defs)

        run_ids = [qid for qid, v in defs.items() if v['name'] == 'run']
        self.assertEqual(len(run_ids), 1)
        self.assertIn(run_ids[0], entry_ids)

    def test_top_level_call(self):
        """A bare top-level call is detected as an entry point."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'script.py', """
                def process():
                    pass

                process()
            """)
            defs = analyze.collect_definitions(d)
            entry_ids = analyze.collect_entry_points(d, defs)

        proc_ids = [qid for qid, v in defs.items() if v['name'] == 'process']
        self.assertEqual(len(proc_ids), 1)
        self.assertIn(proc_ids[0], entry_ids)

    def test_reversed_main_guard(self):
        """if '__main__' == __name__: (reversed) is also detected."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'rev.py', """
                def start():
                    pass

                if '__main__' == __name__:
                    start()
            """)
            defs = analyze.collect_definitions(d)
            entry_ids = analyze.collect_entry_points(d, defs)

        start_ids = [qid for qid, v in defs.items() if v['name'] == 'start']
        self.assertEqual(len(start_ids), 1)
        self.assertIn(start_ids[0], entry_ids)

    def test_multiple_entry_points(self):
        """Multiple calls in __main__ block are all detected as entry points."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'multi.py', """
                def init():
                    pass

                def run():
                    pass

                def cleanup():
                    pass

                if __name__ == '__main__':
                    init()
                    run()
                    cleanup()
            """)
            defs = analyze.collect_definitions(d)
            entry_ids = analyze.collect_entry_points(d, defs)

        for name in ('init', 'run', 'cleanup'):
            ids = [qid for qid, v in defs.items() if v['name'] == name]
            self.assertEqual(len(ids), 1, f'{name} should be defined')
            self.assertIn(ids[0], entry_ids, f'{name} should be an entry point')

    def test_no_entry_points(self):
        """File with no top-level calls returns empty list."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'lib.py', """
                def helper():
                    pass

                def util():
                    helper()
            """)
            defs = analyze.collect_definitions(d)
            entry_ids = analyze.collect_entry_points(d, defs)

        self.assertEqual(entry_ids, [], 'no entry points expected')


# ---------------------------------------------------------------------------
# TestMain
# ---------------------------------------------------------------------------

class TestMain(unittest.TestCase):

    def _run_main(self, workspace_dir: str) -> dict:
        """Run analyze.main() against workspace_dir and return parsed JSON output."""
        old_argv = sys.argv[:]
        old_stdout = sys.stdout
        buf = io.StringIO()
        try:
            sys.argv = ['analyze.py', workspace_dir]
            sys.stdout = buf
            analyze.main()
        finally:
            sys.argv = old_argv
            sys.stdout = old_stdout
        return json.loads(buf.getvalue())

    def test_main_output_is_valid_json(self):
        """main() outputs valid JSON with 'nodes' and 'edges' keys."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'simple.py', """
                def greet():
                    pass
            """)
            result = self._run_main(d)
        self.assertIn('nodes', result)
        self.assertIn('edges', result)
        self.assertIsInstance(result['nodes'], list)
        self.assertIsInstance(result['edges'], list)

    def test_main_with_entry_points_adds_main_node(self):
        """main() adds ::MAIN::0 node and outgoing edges when entry points exist."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'app.py', """
                def start():
                    pass

                if __name__ == '__main__':
                    start()
            """)
            result = self._run_main(d)
        node_ids = [n['id'] for n in result['nodes']]
        self.assertIn('::MAIN::0', node_ids, '::MAIN::0 node should be present')
        main_edges = [e for e in result['edges'] if e['source'] == '::MAIN::0']
        self.assertTrue(len(main_edges) > 0, 'MAIN node should have outgoing edges')

    def test_main_no_entry_points_no_main_node(self):
        """main() omits ::MAIN::0 when there are no entry points."""
        with tempfile.TemporaryDirectory() as d:
            write_py(d, 'lib.py', """
                def helper():
                    pass
            """)
            result = self._run_main(d)
        node_ids = [n['id'] for n in result['nodes']]
        self.assertNotIn('::MAIN::0', node_ids, '::MAIN::0 should not appear without entry points')


if __name__ == '__main__':
    unittest.main()
