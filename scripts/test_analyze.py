"""
Unit tests for analyze.py.
Run with: python3 -m pytest scripts/test_analyze.py -v
       or: python3 -m unittest scripts/test_analyze.py
"""

import ast
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
            edges = analyze.collect_calls(d, defs)

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
            edges = analyze.collect_calls(d, defs)

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
            edges = analyze.collect_calls(d, defs)

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
            edges = analyze.collect_calls(d, defs)

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
            edges = analyze.collect_calls(d, defs)

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
            edges = analyze.collect_calls(d, defs)

        helper_ids = [qid for qid, v in defs.items() if v['name'] == 'helper']
        main_ids = [qid for qid, v in defs.items() if v['name'] == 'main']
        matching = [e for e in edges if e['source'] == main_ids[0] and e['target'] == helper_ids[0]]
        self.assertEqual(len(matching), 1, 'Edge should appear exactly once')


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


if __name__ == '__main__':
    unittest.main()
