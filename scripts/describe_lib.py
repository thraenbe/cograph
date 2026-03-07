"""
Fetch the first-paragraph docstring for a library function.

Usage: python3 describe_lib.py <libraryName> <functionName>

Outputs a single line of text (the description) or an empty line if not found.
"""

import importlib
import inspect
import sys


def main():
    if len(sys.argv) < 3:
        print('')
        return
    lib_name = sys.argv[1]
    func_name = sys.argv[2]
    try:
        parts = lib_name.split('.')
        # Named imports store libraryName as "module.funcName" (e.g. "json.loads").
        # Strip the redundant suffix so we import the module, not traverse into the function.
        if len(parts) > 1 and parts[-1] == func_name:
            parts = parts[:-1]
        mod = importlib.import_module(parts[0])
        for p in parts[1:]:
            mod = getattr(mod, p, None)
            if mod is None:
                break
        fn = getattr(mod, func_name, None) if mod is not None else None
        if fn is None:
            print('')
            return
        doc = inspect.getdoc(fn)
        if doc:
            print(doc)
        else:
            print('')
    except Exception:
        print('')


if __name__ == '__main__':
    main()
