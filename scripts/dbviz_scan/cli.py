"""
The command: flags, the order the passes run in, and the report on standard
error saying what the scan could not work out.

That report is half the tool. A map that silently left out the queries an ORM
builds would be worse than no map, because it would look complete; saying "six
queries name a table that is built at run time" is what makes the rest of it
trustworthy.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

from .emit import (
    Report,
    Schema,
    assign_ids,
    build_programs,
    layout,
    load_target,
    park_beside_schema,
    strip_previous,
)
from .model import LANGUAGE_BY_ID, LANGUAGES, count
from .resolve import Resolver, prune
from .scanner import Scanner, spread_language

USAGE = """
  python3 scripts/scan_code.py services/api --into bookshop.dbviz.json -o mapped.dbviz.json
  python3 scripts/scan_code.py cmd/worker internal --lang go --into warehouse.dbviz.json
  python3 scripts/scan_code.py . --all --collapse module > map.dbviz.json
"""

LANGUAGE_IDS = [lang.id for lang in LANGUAGES]


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog='scan_code.py',
        description='Read a codebase into a Database Visualizer code map. '
                    f'Reads {", ".join(LANGUAGE_BY_ID[i].label for i in LANGUAGE_IDS)}.',
        epilog=f'examples:{USAGE}',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument('sources', nargs='+', metavar='SOURCE',
                    help='a package, a directory or a single source file; one program per source.')
    ap.add_argument('--into', metavar='FILE',
                    help='the .dbviz.json to write the map into. Its tables are what the '
                         'steps point at, matched by name. Without it the scan writes a new '
                         'diagram whose tables are the ones the queries implied.')
    ap.add_argument('-o', '--out', metavar='FILE',
                    help='where to write (default: standard output). Pass the --into file to '
                         'update it in place.')
    ap.add_argument('--sheet', metavar='NAME', help='which diagram of a workspace file to write into.')
    ap.add_argument('--name', metavar='NAME', help='what to call the program (default: the source\'s name).')
    ap.add_argument('--lang', choices=LANGUAGE_IDS, metavar='LANG',
                    help='read only this language, instead of every one found. '
                         f'One of: {", ".join(LANGUAGE_IDS)}. Also settles whether a .h '
                         'file is C or C++.')
    ap.add_argument('--role', choices=['service', 'job', 'script', 'etl'], help='what kind of program it is.')
    ap.add_argument('--dialect', default='postgresql', choices=['postgresql', 'mariadb', 'sqlite', 'duckdb'],
                    help='dialect for a diagram the scan creates (default: postgresql).')
    ap.add_argument('--all', action='store_true',
                    help='keep every function, not only the ones that reach the database.')
    ap.add_argument('--callers', type=int, default=1, metavar='N',
                    help='how many call hops away from a query to keep (default: 1).')
    ap.add_argument('--exclude', action='append', metavar='GLOB',
                    help='skip files and directories matching this, on top of the defaults. Repeatable.')
    ap.add_argument('--include-tests', action='store_true', help='scan tests as well.')
    ap.add_argument('--no-stub-tables', dest='stub_tables', action='store_false',
                    help='do not invent a table for SQL that names one the diagram has not got; '
                         'leave the step pointing at nothing, for Problems to report.')
    ap.add_argument('--collapse', action='append', choices=['program', 'module', 'class'], metavar='KIND',
                    help='fold containers of this kind on the canvas. Repeatable.')
    ap.add_argument('--relayout', action='store_true',
                    help='lay every node out afresh, discarding where an earlier scan or a person put it.')
    ap.add_argument('--strict-calls', action='store_true',
                    help='only draw a call the code names unambiguously; never guess from a unique name.')
    ap.add_argument('-q', '--quiet', action='store_true', help='report nothing but errors.')
    return ap.parse_args(argv)


def report_lines(report: Report, scan: Scanner, schema: Schema, dropped: int, opts: argparse.Namespace) -> list[str]:
    lines = [
        f'{count(report.nodes, "node")} ({count(report.functions, "function")}), '
        f'{count(report.reads, "read")}, {count(report.writes, "write")}, '
        f'{count(report.calls, "call")}, {count(report.imports, "import or inheritance", "imports and inheritances")}.'
    ]
    read = sorted(scan.languages.items(), key=lambda kv: (-kv[1], kv[0]))
    if len(read) > 1:
        spread = ', '.join(f'{LANGUAGE_BY_ID[lang].label} ({n})' for lang, n in read)
        lines.append(f'files read: {spread}.')
    if dropped and not opts.all:
        lines.append(f'{count(dropped, "node")} left out: nothing in them reaches the database. --all keeps them.')
    if scan.dynamic:
        lines.append(f'{count(scan.dynamic, "query", "queries")} name a table that is built at run time, '
                     'so there is nothing to draw an arrow to; add those steps by hand.'
                     if scan.dynamic > 1 else
                     'one query names a table that is built at run time, so there is nothing to '
                     'draw an arrow to; add that step by hand.')
    if not report.reads and not report.writes:
        lines.append('No SQL found. The scanner reads string literals; an ORM or a query builder '
                     'assembles its statements somewhere this cannot see.')
    for key, number in sorted(report.missing_tables.items()):
        lines.append(f'"{key}" is not a table in the diagram; {count(number, "step")} '
                     f'{"points" if number == 1 else "point"} at nothing.')
    missing = sorted(report.missing_columns.items())
    if missing:
        shown = ', '.join(f'{k} ({v})' for k, v in missing[:6])
        lines.append(f'columns named in SQL that their table has not got, left off the steps: {shown}'
                     + ('…' if len(missing) > 6 else ''))
    if schema.stubbed:
        names = ', '.join(sorted(schema.stubbed))
        them = 'it' if len(schema.stubbed) == 1 else 'them'
        lines.append(f'invented {count(len(schema.stubbed), "table")} the code names but the diagram '
                     f'has not got: {names}. Check {them} before you keep {them}.')
    if scan.notes:
        lines.extend(scan.notes)
    return lines


def main(argv: Optional[list[str]] = None) -> int:
    opts = parse_args(argv)
    scan = Scanner(opts)

    used: set[str] = set()
    for source in opts.sources:
        root = Path(source)
        if not root.exists():
            raise SystemExit(f'{source}: no such file or directory.')
        name = opts.name if opts.name and len(opts.sources) == 1 else (root.stem if root.is_file() else root.name)
        name = name or 'program'
        base, n = name, 2
        while name in used:
            name, n = f'{base}_{n}', n + 1
        used.add(name)
        scan.scan_root(root, name)

    Resolver(scan).run()
    dropped = prune(scan.programs, opts)
    for program in scan.programs:
        spread_language(program)

    document, diagram = load_target(opts.into, opts.sheet, scan.programs[0].name, opts.dialect)
    previous = strip_previous(diagram, {p.name for p in scan.programs})
    # After the strip, because what an earlier run of this same scan left is
    # being replaced and its ids are free again.
    assign_ids(scan.programs, {str(p.get('id')) for p in diagram.get('programs') or []})
    layout(scan.programs, (0.0, 0.0))
    park_beside_schema(scan.programs, diagram)
    schema = Schema(diagram, stub=opts.stub_tables)
    entries, report = build_programs(scan.programs, schema, opts, previous)
    diagram.setdefault('programs', []).extend(entries)

    text = json.dumps(document, indent=2, ensure_ascii=False) + '\n'
    if opts.out:
        Path(opts.out).write_text(text, encoding='utf-8')
    else:
        sys.stdout.write(text)
    if not opts.quiet:
        headline, *rest = report_lines(report, scan, schema, dropped, opts)
        print(f'{opts.out or "standard output"}: {headline}', file=sys.stderr)
        for line in rest:
            print(f'  {line}', file=sys.stderr)
    return 0
