"""Tests for the web assets.

These check the things that break quietly: a manifest that points at an
icon that is not there, a service worker that precaches a file that does
not exist, an element id the script uses but the page does not have (the
`fsLabel is not defined` class of bug), and a catalog that points at
builds that are gone.

They run against the real repository, so they catch the mistakes that
only show up after a push.
"""

import json
import os
import pathlib
import re
import shutil
import struct
import subprocess
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from tests.helpers import REPO  # noqa: E402

HAS_NODE = shutil.which("node") is not None


def png_size(path):
    """The width and height of a PNG, straight from the IHDR chunk."""
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", data[16:24])


class ManifestTests(unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.manifest_path = REPO / "manifest.json"
        self.manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))

    def test_it_is_valid_json(self):
        self.assertIsInstance(self.manifest, dict)

    def test_it_has_the_fields_the_browser_needs(self):
        for key in ("name", "short_name", "start_url", "scope", "display", "icons"):
            self.assertIn(key, self.manifest, f"manifest.json has no {key}")

    def test_every_icon_exists(self):
        for icon in self.manifest.get("icons", []):
            path = REPO / icon["src"]
            self.assertTrue(path.is_file(), f"{icon['src']} is listed but not there")

    def test_the_icon_sizes_are_right(self):
        for icon in self.manifest.get("icons", []):
            path = REPO / icon["src"]
            size = png_size(path)
            self.assertIsNotNone(size, f"{icon['src']} is not a PNG")
            declared = icon.get("sizes", "")
            if "x" in declared:
                width, height = (int(part) for part in declared.split("x")[:2])
                self.assertEqual(
                    size, (width, height),
                    f"{icon['src']} is {size[0]}x{size[1]} but the manifest says {declared}",
                )

    def test_there_is_a_maskable_icon(self):
        purposes = [icon.get("purpose", "any") for icon in self.manifest.get("icons", [])]
        self.assertIn("maskable", purposes, "Android wants a maskable icon")

    def test_the_start_url_is_inside_the_scope(self):
        start = self.manifest["start_url"]
        scope = self.manifest["scope"]
        self.assertTrue(start.startswith(scope.rstrip("/")), f"{start} is not inside {scope}")


class ServiceWorkerTests(unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.source = (REPO / "sw.js").read_text(encoding="utf-8")

    def test_every_precached_asset_exists(self):
        match = re.search(r"const ASSETS = \[(.*?)\];", self.source, re.S)
        self.assertIsNotNone(match, "no ASSETS list in sw.js")
        for entry in re.findall(r'"([^"]+)"', match.group(1)):
            if entry == "./":
                path = REPO / "index.html"
            else:
                path = REPO / entry.lstrip("./")
            self.assertTrue(path.is_file(), f"sw.js precaches {entry}, which is not there")

    def test_the_cache_name_is_bumped(self):
        match = re.search(r'const CACHE_NAME = "([^"]+)"', self.source)
        self.assertIsNotNone(match)
        self.assertTrue(match.group(1), "the cache name must not be empty")


class LauncherMarkupTests(unittest.TestCase):
    """The launcher is one file: the script and the markup have to agree."""

    def setUp(self):
        super().setUp()
        self.html = (REPO / "index.html").read_text(encoding="utf-8")
        self.script = self._inline_script()

    def _inline_script(self):
        blocks = re.findall(r"<script\b([^>]*)>(.*?)</script>", self.html, re.S | re.I)
        inline = [body for attrs, body in blocks if "src=" not in attrs.lower()]
        self.assertTrue(inline, "no inline script in index.html")
        return inline[-1]

    def test_every_element_the_script_uses_exists(self):
        wanted = set(re.findall(r'getElementById\("([^"]+)"\)', self.script))
        present = set(re.findall(r'id="([^"]+)"', self.html))
        missing = sorted(wanted - present)
        self.assertEqual(missing, [], f"the script uses ids the page does not have: {missing}")

    def test_the_element_ids_are_unique(self):
        ids = re.findall(r'id="([^"]+)"', self.html)
        duplicates = sorted({name for name in ids if ids.count(name) > 1})
        self.assertEqual(duplicates, [], f"duplicate element ids: {duplicates}")

    def test_the_launch_button_exists(self):
        self.assertIn('id="launch-btn"', self.html)

    def test_there_is_no_debug_panel_left_over(self):
        self.assertNotIn('id="debug-panel"', self.html)


class CatalogTests(unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.path = REPO / "clients" / "index.json"
        if not self.path.exists():
            self.skipTest("no catalog yet")
        self.catalog = json.loads(self.path.read_text(encoding="utf-8"))

    def test_it_is_valid_json(self):
        self.assertIsInstance(self.catalog, dict)
        self.assertIn("clients", self.catalog)
        self.assertIn("groups", self.catalog)

    def test_every_client_has_what_it_needs(self):
        for client in self.catalog["clients"]:
            for key in ("id", "url", "name", "groupPath"):
                self.assertIn(key, client, f"a client has no {key}: {client}")
            self.assertTrue(client["name"], f"a client has no name: {client}")
            self.assertTrue(client["url"], f"a client has no url: {client}")

    def test_the_client_ids_are_unique(self):
        ids = [client["id"] for client in self.catalog["clients"]]
        duplicates = sorted({name for name in ids if ids.count(name) > 1})
        self.assertEqual(duplicates, [], f"duplicate client ids: {duplicates}")

    def test_every_build_is_where_the_catalog_says(self):
        for client in self.catalog["clients"]:
            path = REPO / client["url"]
            self.assertTrue(path.is_file(), f"{client['url']} is in the catalog but not on disk")

    def test_the_default_client_exists(self):
        default = self.catalog.get("defaultClient")
        if not default:
            return
        ids = [client["id"] for client in self.catalog["clients"]]
        self.assertIn(default, ids, f"the default client {default} is not in the catalog")

    def test_the_sizes_are_right(self):
        for client in self.catalog["clients"]:
            path = REPO / client["url"]
            self.assertEqual(
                client.get("size", 0), path.stat().st_size,
                f"{client['id']}: the catalog size does not match the file",
            )


@unittest.skipUnless(
    not os.environ.get("ALGEBRATOOLS_SKIP_SLOW"),
    "slow: reads every build (run with --slow)",
)
class BuildSyncTests(unittest.TestCase):
    """The builds and the catalog have to match what is in the repository.

    These read all 375 MB of client builds, so they are off by default:
    ./test.py --slow
    """

    def run_tool(self, script, *args):
        return subprocess.run(
            [sys.executable, str(REPO / script), *args],
            cwd=str(REPO), capture_output=True, text=True,
        )

    def test_every_build_has_the_current_shim(self):
        result = self.run_tool("inject-shim.py", "--check")
        self.assertEqual(
            result.returncode, 0,
            "the shim is out of date in some builds — run ./inject-shim.py\n"
            + result.stdout,
        )

    def test_the_catalog_is_up_to_date(self):
        result = self.run_tool("build-index.py", "--check")
        self.assertEqual(
            result.returncode, 0,
            "the catalog is out of date — run ./build-index.py\n" + result.stdout,
        )


class JavaScriptSyntaxTests(unittest.TestCase):

    def setUp(self):
        super().setUp()
        if not HAS_NODE:
            self.skipTest("node is not installed")

    def check(self, source, name):
        result = subprocess.run(
            ["node", "--check", "-"], input=source, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"{name} has a syntax error:\n{result.stderr}")

    def test_the_launcher_script_parses(self):
        html = (REPO / "index.html").read_text(encoding="utf-8")
        blocks = re.findall(r"<script\b([^>]*)>(.*?)</script>", html, re.S | re.I)
        inline = [body for attrs, body in blocks if "src=" not in attrs.lower()]
        self.check(inline[-1], "index.html")

    def test_the_service_worker_parses(self):
        self.check((REPO / "sw.js").read_text(encoding="utf-8"), "sw.js")

    def test_the_shim_parses(self):
        self.check((REPO / "client-shim.js").read_text(encoding="utf-8"), "client-shim.js")


if __name__ == "__main__":
    unittest.main()
