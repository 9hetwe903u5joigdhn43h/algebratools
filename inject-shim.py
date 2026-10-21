#!/usr/bin/env python3
"""Inline client-shim.js into the Eaglercraft client builds.

The service worker already injects the shim when it serves a client, but the
shim is also written into the builds themselves so it is in place no matter
what: no service worker, a stale worker, or an offline copy still get it.

The script is injected right after the opening <head> tag, so it runs before
the game's own scripts. It is wrapped in markers and the script is guarded by
a flag, so re-running this is idempotent and double injection is harmless.

    ./inject-shim.py           # inject into every Eagler-*.html
    ./inject-shim.py --check   # only report which builds are up to date
"""

import argparse
import hashlib
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
SOURCE = HERE / "client-shim.js"
BEGIN = "<!--launcher-shim-->"
END = "<!--/launcher-shim-->"

HEAD_RE = re.compile(r"<head\b[^>]*>", re.IGNORECASE)


def build_block() -> str:
    source = SOURCE.read_text(encoding="utf-8")
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()[:12]
    return (
        f"\n{BEGIN}\n"
        f"<!-- source: client-shim.js (sha256:{digest}) -->\n"
        f"<script>\n{source}\n</script>\n"
        f"{END}\n"
    )


def strip_block(text: str) -> str:
    while True:
        start = text.find(BEGIN)
        if start == -1:
            return text
        # Swallow the newline that was added before the marker.
        if start > 0 and text[start - 1] == "\n":
            start -= 1
        end = text.find(END, start)
        if end == -1:
            return text[:start] + text[start + len(BEGIN):]
        end += len(END)
        if text[end:end + 1] == "\n":
            end += 1
        text = text[:start] + text[end:]


def inject(text: str, block: str) -> str:
    text = strip_block(text)
    match = HEAD_RE.search(text)
    if not match:
        raise SystemExit("no <head> tag found — is this an Eaglercraft build?")
    at = match.end()
    return text[:at] + block + text[at:]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="only report which builds are up to date")
    args = parser.parse_args()

    if not SOURCE.exists():
        raise SystemExit(f"missing {SOURCE}")

    block = build_block()
    clients = sorted(HERE.glob("Eagler-*.html"))
    if not clients:
        raise SystemExit("no Eagler-*.html builds found next to this script")

    changed = []
    for path in clients:
        original = path.read_text(encoding="utf-8", errors="surrogateescape")
        updated = inject(original, block)
        if updated == original:
            print(f"up to date: {path.name}")
            continue
        changed.append(path.name)
        if args.check:
            print(f"needs update: {path.name}")
            continue
        path.write_text(updated, encoding="utf-8", errors="surrogateescape")
        print(f"updated: {path.name} ({len(original)} -> {len(updated)} bytes)")

    if args.check and changed:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
