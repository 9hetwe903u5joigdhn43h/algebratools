#!/usr/bin/env python3
"""Add a client build to the catalog.

Copies the build into `clients/<group>/`, writes the metadata sidecar next to
it and rebuilds the catalog. One command, and the client shows up in the
launcher.

    ./add-client.py Eagler-26.2-Dev-0.6.html \\
        --group eagler \\
        --name "Eaglercraft 26.2 Dev 0.6" \\
        --version "26.2 Dev 0.6" \\
        --description "Minecraft 26.2 in the browser" \\
        --author "o_xer"

Options:
    --slug      the file name to use (default: derived from the name)
    --icon      icon path for the card (default: the folder's icon)
    --move      move the build instead of copying it
    --force     overwrite an existing client with the same slug
    --no-build  skip the catalog rebuild (do it yourself later)
"""

import argparse
import json
import pathlib
import shutil
import sys

import clientlib


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("build", help="the client build to add")
    parser.add_argument("--group", required=True,
                        help="folder under clients/ to put it in")
    parser.add_argument("--name", required=True, help="display name")
    parser.add_argument("--version", default="", help="version string")
    parser.add_argument("--description", default="", help="short description")
    parser.add_argument("--author", default="", help="who made it")
    parser.add_argument("--icon", default="", help="icon path for the card")
    parser.add_argument("--slug", default="", help="file name to use")
    parser.add_argument("--move", action="store_true", help="move instead of copy")
    parser.add_argument("--force", action="store_true", help="overwrite an existing entry")
    parser.add_argument("--no-build", action="store_true", help="do not rebuild the catalog")
    args = parser.parse_args()

    source = pathlib.Path(args.build).expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"no such file: {source}")
    if source.suffix.lower() != ".html":
        raise SystemExit("the build has to be an .html file")

    group = args.group.strip().strip("/")
    if not group or "/" in group:
        raise SystemExit("--group is a single folder name under clients/")

    group_dir = clientlib.CLIENTS_DIR / group
    group_dir.mkdir(parents=True, exist_ok=True)

    slug = args.slug.strip() or clientlib.slugify(args.name)
    if not slug.endswith(".html"):
        slug = slug + ".html"

    target = group_dir / slug
    sidecar = group_dir / (pathlib.Path(slug).stem + ".json")

    if target.exists() and not args.force:
        raise SystemExit(f"{target.relative_to(clientlib.HERE)} already exists (use --force)")

    # 1. The build itself.
    if args.move:
        shutil.move(str(source), str(target))
    else:
        shutil.copy2(str(source), str(target))
    print(f"build: {target.relative_to(clientlib.HERE)}")

    # 2. The metadata sidecar.
    meta = {"name": args.name.strip()}
    if args.version:
        meta["version"] = args.version.strip()
    if args.description:
        meta["description"] = args.description.strip()
    if args.author:
        meta["author"] = args.author.strip()
    if args.icon:
        meta["icon"] = args.icon.strip()
    sidecar.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n",
                       encoding="utf-8")
    print(f"meta:  {sidecar.relative_to(clientlib.HERE)}")

    # 3. A folder with no metadata of its own gets a sensible one.
    group_meta = group_dir / clientlib.GROUP_FILE
    if not group_meta.exists():
        group_meta.write_text(json.dumps(
            {"label": clientlib.humanize(group), "icon": clientlib.DEFAULT_ICON, "order": 0},
            indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"group: {group_meta.relative_to(clientlib.HERE)} (created)")

    # 4. Rebuild the catalog.
    if not args.no_build:
        print()
        catalog, path, updated, skipped, problems = clientlib.rebuild_catalog()
        for rel in updated:
            print(f"updated: {rel}")
        for rel in skipped:
            print(f"skipped (no <head> tag): {rel}")
        for problem in problems:
            print(f"warning: {problem}", file=sys.stderr)
        print(f"wrote {path.relative_to(clientlib.HERE)}: "
              f"{len(catalog['clients'])} clients in {len(catalog['groups'])} groups")

    print()
    print("Done. The client is in the launcher now — no cache bump needed.")
    print(f"Remember to commit: {target.relative_to(clientlib.HERE)} and "
          f"{sidecar.relative_to(clientlib.HERE)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
