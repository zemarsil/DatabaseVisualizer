#!/usr/bin/env python3
"""
Read a codebase into a Database Visualizer code map.

The code map (docs/CODE_MAP_FORMAT.md) says what talks to the database: the
program, the files inside it, the classes in those, the functions that actually
run a SELECT or an INSERT, and the calls and imports between them. Drawing one
by hand is the right way to map a service you are designing. Drawing one by
hand for a codebase that already exists is an afternoon of grep, which is what
this script is for.

    python3 scripts/scan_code.py services/api --into bookshop.dbviz.json -o mapped.dbviz.json

It reads Python with Python's own ``ast`` and Rust, Go, C, C++, Java,
JavaScript and TypeScript with a tolerant lexer — not with a regex over the
source, so a `fn` inside a string is not a function and a commented-out query is
not a step — and writes the nodes, their parents and their steps. Everything
else about the picture (the arrows, the regions around the containers) the app
derives from those, so the scanner only has to place the leaves.

What it cannot do is guess. A table name assembled at run time, a query built
by an ORM, a call through a registry or an interface: none of those are in the
syntax, so none of them are in the map. The map it writes is the part the code
says out loud, and the honest way to use it is as a first draft to correct, the
same as an imported schema.

Nothing to install: the standard library is the whole of it.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dbviz_scan.cli import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())
