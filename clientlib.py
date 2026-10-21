#!/usr/bin/env python3
"""Shared helpers for the client catalog tooling.

The clients live in `clients/`, grouped in folders:

    clients/
      index.json            <- generated catalog (see build-index.py)
      eagler/
        _group.json         <- optional folder metadata
        26.2-dev-0.6.html   <- the build
        26.2-dev-0.6.json   <- optional metadata sidecar for that build

This module holds the pieces that the other scripts share: the shim
injection, the folder walk, and the catalog builder.
"""

import datetime
import hashlib
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
CLIENTS_DIR = HERE / "clients"
INDEX_PATH = CLIENTS_DIR / "index.json"
SOURCE = HERE / "client-shim.js"

BEGIN = "<!--launcher-shim-->"
END = "<!--/launcher-shim-->"
HEAD_RE = re.compile(r"<head\b[^>]*>", re.IGNORECASE)

GROUP_FILE = "_group.json"
DEFAULT_FILE = "_default.json"
DEFAULT_ICON = "icons/icon-192.png"
DEFAULT_VERSION = "—"


# ---------------------------------------------------------------------------
# Shim injection
# ---------------------------------------------------------------------------

def shim_source() -> str:
    return SOURCE.read_text(encoding="utf-8")


def shim_digest() -> str:
    """Short digest of the shim, used to tag the inlined copy."""
    return hashlib.sha256(shim_source().encode("utf-8")).hexdigest()[:12]


def build_block() -> str:
    """The block that gets inlined into a client page."""
    source = shim_source()
    digest = shim_digest()
    return (
        f"\n{BEGIN}\n"
        f"<!-- source: client-shim.js (sha256:{digest}) -->\n"
        f'<meta charset="utf-8" />\n'
        f"<script>\n{source}\n</script>\n"
        f"{END}\n"
    )


def strip_block(text: str) -> str:
    """Remove every inlined shim block, so the injection is idempotent."""
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
    """Put the shim block right after <head>, replacing any earlier copy."""
    text = strip_block(text)
    match = HEAD_RE.search(text)
    if not match:
        raise ValueError("no <head> tag found")
    at = match.end()
    return text[:at] + block + text[at:]


def has_block(text: str) -> bool:
    return BEGIN in text


def inject_all(check=False, write=True, root=None):
    """Put the shim into every client build.

    Returns (updated, uptodate, skipped) — each a list of paths relative to
    the repository root. A build without a <head> tag is skipped instead of
    aborting the run, so one odd file cannot starve the others.
    """
    block = build_block()
    updated = []
    uptodate = []
    skipped = []
    for path in iter_client_files(root):
        rel = path.relative_to(HERE) if HERE in path.parents else path
        try:
            original = path.read_text(encoding="utf-8", errors="surrogateescape")
        except OSError as err:
            skipped.append(rel)
            print(f"could not read {rel}: {err}", file=sys.stderr)
            continue
        try:
            new_text = inject(original, block)
        except ValueError:
            skipped.append(rel)
            continue
        if new_text == original:
            uptodate.append(rel)
            continue
        updated.append(rel)
        if check or not write:
            continue
        path.write_text(new_text, encoding="utf-8", errors="surrogateescape")
    return updated, uptodate, skipped


# ---------------------------------------------------------------------------
# Folder walk
# ---------------------------------------------------------------------------

def iter_client_files(root=None):
    """Yield every client HTML file under `root`, sorted, depth first."""
    root = pathlib.Path(root) if root else CLIENTS_DIR
    if not root.is_dir():
        return
    for path in sorted(root.rglob("*.html")):
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        # Skip anything inside a hidden folder.
        if any(part.startswith(".") for part in rel.parts):
            continue
        yield path


def group_path_for(rel: pathlib.PurePath) -> list:
    """The folder path of a client, relative to the clients root."""
    return list(rel.parts[:-1])


# ---------------------------------------------------------------------------
# Metadata
# ---------------------------------------------------------------------------

def load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def humanize(slug: str) -> str:
    """'26.2-dev-0.6' -> '26.2 Dev 0.6'."""
    words = slug.replace("_", " ").replace("-", " ").split()
    out = []
    for word in words:
        if any(ch.isdigit() for ch in word):
            out.append(word)
        else:
            out.append(word[:1].upper() + word[1:])
    return " ".join(out) or slug


def slugify(name: str) -> str:
    """'Eaglercraft 26.2 Dev 0.6' -> 'eaglercraft-26-2-dev-0-6'."""
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", name.strip().lower()).strip("-")
    return slug or "client"


def read_group_meta(group_dir: pathlib.Path) -> dict:
    """The optional `_group.json` of a folder."""
    data = load_json(group_dir / GROUP_FILE)
    return data if isinstance(data, dict) else {}


def read_sidecar(html_path: pathlib.Path) -> dict:
    """The optional `<slug>.json` next to a client build."""
    data = load_json(html_path.with_suffix(".json"))
    return data if isinstance(data, dict) else {}


def group_label(group_dir: pathlib.Path, fallback: str) -> str:
    meta = read_group_meta(group_dir)
    label = meta.get("label")
    return label if isinstance(label, str) and label.strip() else fallback


def group_icon(group_dir: pathlib.Path, inherited: str) -> str:
    meta = read_group_meta(group_dir)
    icon = meta.get("icon")
    return icon if isinstance(icon, str) and icon.strip() else inherited


def group_order(group_dir: pathlib.Path) -> int:
    meta = read_group_meta(group_dir)
    order = meta.get("order")
    return order if isinstance(order, (int, float)) else 0


def read_default(root=None) -> str:
    """The client id that opens selected by default ("" when there is none)."""
    root = pathlib.Path(root) if root else CLIENTS_DIR
    data = load_json(root / DEFAULT_FILE)
    if isinstance(data, dict):
        value = data.get("defaultClient") or data.get("client")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def write_default(client_id: str, root=None) -> pathlib.Path:
    """Record the default client. An empty id clears it."""
    root = pathlib.Path(root) if root else CLIENTS_DIR
    root.mkdir(parents=True, exist_ok=True)
    path = root / DEFAULT_FILE
    payload = {"defaultClient": client_id.strip()}
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------

def build_catalog(root=None):
    """Walk the clients folder and build the catalog.

    Returns (catalog, problems). `problems` is a list of human readable
    strings about files that could not be used — the caller decides how
    loudly to complain about them.
    """
    root = pathlib.Path(root) if root else CLIENTS_DIR
    problems = []
    clients = []

    for path in iter_client_files(root):
        rel = path.relative_to(root)
        gpath = group_path_for(rel)
        slug = rel.stem
        sidecar = read_sidecar(path)

        # Resolve the group chain, so a nested client inherits its folder's
        # icon and gets sensible labels.
        icon = DEFAULT_ICON
        labels = []
        order = 0
        current = root
        for depth, segment in enumerate(gpath):
            current = current / segment
            meta = read_group_meta(current)
            label = meta.get("label")
            labels.append(label if isinstance(label, str) and label.strip() else humanize(segment))
            icon = group_icon(current, icon)
            if depth == 0:
                order = group_order(current)

        name = sidecar.get("name")
        if not isinstance(name, str) or not name.strip():
            name = humanize(slug)
            if not sidecar:
                problems.append(f"{rel}: no metadata sidecar, using the file name")

        version = sidecar.get("version")
        if not isinstance(version, str) or not version.strip():
            version = DEFAULT_VERSION

        client_icon = sidecar.get("icon")
        if not isinstance(client_icon, str) or not client_icon.strip():
            client_icon = icon

        try:
            size = path.stat().st_size
        except OSError:
            size = 0

        clients.append({
            "id": "/".join(gpath + [slug]),
            "url": path.relative_to(HERE).as_posix(),
            "name": name.strip(),
            "version": version.strip(),
            "author": sidecar.get("author") or "",
            "description": sidecar.get("description") or "",
            "icon": client_icon,
            "group": gpath[0] if gpath else "",
            "groupPath": gpath,
            "groupLabel": labels[-1] if labels else "Ungrouped",
            "size": size,
        })

    clients.sort(key=lambda c: (c["groupPath"], c["name"].lower()))

    # The folder tree: every distinct folder prefix becomes a group.
    groups = {}
    for client in clients:
        chain = []
        current = root
        for depth, segment in enumerate(client["groupPath"]):
            current = current / segment
            chain.append((segment, current))
        for depth, (segment, folder) in enumerate(chain):
            path_key = "/".join(client["groupPath"][:depth + 1])
            if path_key not in groups:
                meta = read_group_meta(folder)
                label = meta.get("label")
                groups[path_key] = {
                    "path": path_key,
                    "label": label if isinstance(label, str) and label.strip() else humanize(segment),
                    "icon": group_icon(folder, DEFAULT_ICON),
                    "order": group_order(folder) if depth == 0 else 0,
                    "count": 0,
                    "total": 0,
                }
            groups[path_key]["total"] += 1

    # `count` is the number of clients directly in that folder.
    for client in clients:
        if client["groupPath"]:
            key = "/".join(client["groupPath"])
            if key in groups:
                groups[key]["count"] += 1

    group_list = sorted(groups.values(), key=lambda g: (g["order"], g["path"]))

    catalog = {
        "generated": "",
        "groups": group_list,
        "clients": clients,
        "defaultClient": read_default(root),
    }
    return catalog, problems


def catalog_bytes(catalog) -> bytes:
    """The catalog as it is written to disk (stable, sorted keys)."""
    return (json.dumps(catalog, indent=2, ensure_ascii=False, sort_keys=False) + "\n").encode("utf-8")


def write_catalog(catalog, path=None) -> pathlib.Path:
    path = pathlib.Path(path) if path else INDEX_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(catalog_bytes(catalog))
    return path


def rebuild_catalog(inject_shims=True):
    """Inject the shim into the builds and write the catalog.

    Returns (catalog, path, updated, skipped, problems).
    """
    updated = []
    skipped = []
    if inject_shims:
        updated, _uptodate, skipped = inject_all()

    catalog, problems = build_catalog()
    catalog["generated"] = datetime.datetime.now(datetime.timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    path = write_catalog(catalog)
    return catalog, path, updated, skipped, problems
