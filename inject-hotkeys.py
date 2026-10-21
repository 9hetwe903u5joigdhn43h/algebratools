#!/usr/bin/env python3
"""Inline client-hotkeys.js into the Eaglercraft client builds.

The clients are single-file builds, so the hotkey script has to live inside
them for it to work offline (no extra request, nothing to cache separately).

The script is injected right after the opening <body> tag, wrapped in
markers so re-running this is idempotent: the previous block is replaced
instead of stacking up.

    ./inject-hotkeys.py            # inject into every Eagler-*.html
    ./inject-hotkeys.py --check    # report which builds are up to date
"""

import argparse
import hashlib
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
SOURCE = HERE / "client-hotkeys.js"
BEGIN = "<!--launcher-hotkeys-->"
END = "<!--/launcher-hotkeys-->"

BODY_RE = re.compile(r"<body\b[^>]*>", re.IGNORECASE)


def build_block() -> str:
    source = SOURCE.read_text(encoding="utf-8")
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()[:12]
    return (
        f"\n{BEGIN}\n"
        f"<!-- source: client-hotkeys.js (sha256:{digest}) -->\n"
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
        # Swallow the trailing newline after the end marker too.
        if text[end:end + 1] == "\n":
            end += 1
        text = text[:start] + text[end:]


def inject(text: str, block: str) -> str:
    text = strip_block(text)
    match = BODY_RE.search(text)
    if not match:
        raise SystemExit("no <body> tag found — is this an Eaglercraft build?")
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
