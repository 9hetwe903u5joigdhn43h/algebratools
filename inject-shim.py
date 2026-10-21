#!/usr/bin/env python3
"""Inline client-shim.js into the client builds.

The service worker already injects the shim when it serves a client, but the
shim is also written into the builds themselves so it is in place no matter
what: no service worker, a stale worker, or an offline copy still get it.

The script is injected right after the opening <head> tag, so it runs before
the game's own scripts. It is wrapped in markers and the script is guarded by
a flag, so re-running this is idempotent and double injection is harmless.

    ./inject-shim.py           # inject into every client under clients/
    ./inject-shim.py --check   # only report which builds are up to date

A build without a <head> tag is skipped and reported; it never stops the
other builds from being updated.
"""

import argparse
import sys

import clientlib


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="only report which builds are up to date")
    args = parser.parse_args()

    if not clientlib.SOURCE.exists():
        raise SystemExit(f"missing {clientlib.SOURCE}")

    if not list(clientlib.iter_client_files()):
        raise SystemExit(f"no client builds found under {clientlib.CLIENTS_DIR}")

    updated, uptodate, skipped = clientlib.inject_all(check=args.check)

    for rel in updated:
        print(f"{'needs update' if args.check else 'updated'}: {rel}")
    for rel in uptodate:
        print(f"up to date: {rel}")
    for rel in skipped:
        print(f"skipped (no <head> tag): {rel}")

    if args.check and updated:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
