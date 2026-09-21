"""
Reading a codebase into a Coditect code map.

The entry point is `scripts/scan_code.py`; this package is what it runs.

    scan_code.py  ->  cli        the flags and the order the passes run in
                      scanner    walks the tree, one module per file
                      pysource   Python, read with the standard library's ast
                      bracesource + lexer
                                 Rust, Go, C, C++, Java, JavaScript, TypeScript
                      sqlread    the queries inside the strings either finds
                      resolve    what the names the code used meant
                      emit       ids, layout, and the diagram it writes into

The split is along the one seam that matters: everything up to `resolve` talks
about source code, and everything after it talks about the diagram. A new
language is a new front end and nothing else.
"""

from .cli import main

__all__ = ['main']
