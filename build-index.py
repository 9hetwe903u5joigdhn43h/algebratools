#!/usr/bin/env python3
"""Build the client catalog from the clients/ folder.

Walks `clients/`, injects the launcher shim into every build it finds
(idempotent), reads the metadata sidecars and writes `clients/index.json`.

The launcher only ever reads that one file, so the catalog can be regenerated
at any time without touching the launcher.

    ./build-index.py             # inject + write clients/index.json
    ./build-index.py --check     # only report whether the index is current
    ./build-index.py --no-inject # write the index, leave the builds alone
"""

import argparse
import json
import sys

import clientlib


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="only report whether the index is up to date")
    parser.add_argument("--no-inject", action="store_true",
                        help="do not write the shim into the builds")
    parser.add_argument("--default", metavar="ID",
                        help="make this client the default one "
                             "(use 'none' to clear it)")
    args = parser.parse_args()

    if not clientlib.CLIENTS_DIR.is_dir():
        raise SystemExit(f"missing {clientlib.CLIENTS_DIR}")

    if args.default is not None:
        wanted = "" if args.default.strip().lower() in ("none", "-") else args.default.strip()
        path = clientlib.write_default(wanted)
        print(f"default: {wanted or '(none)'} -> {path.relative_to(clientlib.HERE)}")

    # 1. The shim goes into the builds first, so the sizes the catalog
    #    reports are the sizes that are actually served.
    if not args.no_inject and not args.check:
        updated, _uptodate, skipped = clientlib.inject_all()
        for rel in updated:
            print(f"updated: {rel}")
        for rel in skipped:
            print(f"skipped (no <head> tag): {rel}")

    # 2. Build the catalog.
    catalog, problems = clientlib.build_catalog()

    for problem in problems:
        print(f"warning: {problem}", file=sys.stderr)

    if not catalog["clients"]:
        print("no clients found under clients/", file=sys.stderr)

    if args.check:
        current = clientlib.load_json(clientlib.INDEX_PATH)
        if current is None:
            print("needs update: clients/index.json (missing)")
            return 1
        wanted = dict(catalog)
        wanted["generated"] = current.get("generated", "")
        if json.dumps(current, sort_keys=True) != json.dumps(wanted, sort_keys=True):
            print("needs update: clients/index.json")
            return 1
        print("up to date: clients/index.json")
        return 0

    # 3. Write it. The timestamp only moves when the content really changed,
    #    so a rebuild that finds nothing to do leaves the file alone.
    clientlib.stamp_catalog(catalog)
    path = clientlib.write_catalog(catalog)
    print(f"wrote {path.relative_to(clientlib.HERE)}: "
          f"{len(catalog['clients'])} clients in {len(catalog['groups'])} groups")
    return 0


if __name__ == "__main__":
    sys.exit(main())
