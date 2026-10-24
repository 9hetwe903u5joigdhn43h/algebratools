"""Unit tests for the catalog tooling (clientlib.py).

These cover the parts that are easy to break and hard to notice: the shim
injection has to be idempotent, the catalog has to describe the folder
tree correctly, and the default/recommended marks have to survive a
round trip through the metadata files.
"""

import datetime
import json
import pathlib
import sys
import unittest
import unittest.mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import clientlib  # noqa: E402

from tests.helpers import TempTree, make_build, make_build_without_head  # noqa: E402


class ShimInjectionTests(TempTree):
    def setUp(self):
        super().setUp()
        self.patch_clientlib(clientlib)

    def test_inject_puts_the_block_right_after_head(self):
        block = clientlib.build_block()
        text = "<html><head><title>x</title></head><body></body></html>"
        out = clientlib.inject(text, block)
        self.assertIn(clientlib.BEGIN, out)
        self.assertLess(out.index(clientlib.BEGIN), out.index("<title>"))
        self.assertLess(out.index("<head>"), out.index(clientlib.BEGIN))

    def test_inject_is_idempotent(self):
        block = clientlib.build_block()
        text = "<html><head><title>x</title></head><body></body></html>"
        once = clientlib.inject(text, block)
        twice = clientlib.inject(once, block)
        self.assertEqual(once, twice)
        self.assertEqual(once.count(clientlib.BEGIN), 1)

    def test_inject_preserves_existing_line_endings(self):
        original = "<html>\r\n<head>\r\n<title>x</title>\r\n</head>\r\n</html>\r\n"
        out = clientlib.inject(original, clientlib.build_block())
        self.assertEqual(clientlib.strip_block(out), original)
        self.assertIn("\r\n" + clientlib.BEGIN + "\r\n", out)

    def test_inject_replaces_an_older_block(self):
        old = "\n" + clientlib.BEGIN + "\nold stuff\n" + clientlib.END + "\n"
        text = "<html><head>" + old + "<title>x</title></head><body></body></html>"
        out = clientlib.inject(text, clientlib.build_block())
        self.assertEqual(out.count(clientlib.BEGIN), 1)
        self.assertNotIn("old stuff", out)

    def test_inject_without_a_head_raises(self):
        with self.assertRaises(ValueError):
            clientlib.inject("<html><body>no head</body></html>", clientlib.build_block())

    def test_strip_block_removes_the_block(self):
        block = clientlib.build_block()
        text = "<html><head><title>x</title></head><body></body></html>"
        out = clientlib.inject(text, block)
        self.assertEqual(clientlib.strip_block(out), text)

    def test_inject_all_reports_updated_and_uptodate(self):
        build = make_build(self.clients / "a" / "one.html")
        updated, uptodate, skipped = clientlib.inject_all()
        self.assertEqual([p.name for p in updated], ["one.html"])
        self.assertEqual(uptodate, [])
        self.assertEqual(skipped, [])

        updated, uptodate, skipped = clientlib.inject_all()
        self.assertEqual(updated, [])
        self.assertEqual([p.name for p in uptodate], ["one.html"])

    def test_inject_all_skips_a_file_without_a_head(self):
        make_build(self.clients / "a" / "one.html")
        make_build_without_head(self.clients / "a" / "broken.html")
        updated, uptodate, skipped = clientlib.inject_all()
        self.assertEqual([p.name for p in updated], ["one.html"])
        self.assertEqual([p.name for p in skipped], ["broken.html"])

    def test_inject_all_check_does_not_write(self):
        build = make_build(self.clients / "a" / "one.html")
        before = build.read_text(encoding="utf-8")
        updated, _uptodate, _skipped = clientlib.inject_all(check=True)
        self.assertEqual([p.name for p in updated], ["one.html"])
        self.assertEqual(build.read_text(encoding="utf-8"), before)

    def test_group_exclusions_keep_non_game_pages_out_of_catalog_and_injection(self):
        chromium_dir = self.clients / "modded" / "Chromium Client"
        launcher = make_build(chromium_dir / "Chromium Launcher.html")
        builds = [
            make_build(chromium_dir / f"game-{name}.html")
            for name in ("performance", "shaders", "vanilla")
        ]
        self.write_group("modded", {
            "exclude": ["Chromium Client/Chromium Launcher.html"],
        })

        updated, _uptodate, skipped = clientlib.inject_all()
        self.assertEqual(set(updated), {path.relative_to(self.tmp) for path in builds})
        self.assertEqual(skipped, [])
        self.assertNotIn(clientlib.BEGIN, launcher.read_text(encoding="utf-8"))

        catalog, _problems = clientlib.build_catalog()
        self.assertEqual(len(catalog["clients"]), 3)
        self.assertTrue(all("Chromium Launcher" not in c["name"] for c in catalog["clients"]))
        self.assertTrue(all(
            c["groupPath"] == ["modded", "Chromium Client"]
            for c in catalog["clients"]
        ))


class CatalogTests(TempTree):
    def setUp(self):
        super().setUp()
        self.patch_clientlib(clientlib)

    def test_catalog_reads_the_sidecar(self):
        make_build(self.clients / "vanilla" / "26.2.html")
        self.write_sidecar("vanilla/26.2", {
            "name": "Eaglercraft 26.2",
            "version": "26.2",
            "author": "o_xer",
            "description": "Minecraft in the browser",
        })
        catalog, problems = clientlib.build_catalog()
        self.assertEqual(len(catalog["clients"]), 1)
        client = catalog["clients"][0]
        self.assertEqual(client["id"], "vanilla/26.2")
        self.assertEqual(client["name"], "Eaglercraft 26.2")
        self.assertEqual(client["version"], "26.2")
        self.assertEqual(client["author"], "o_xer")
        self.assertEqual(client["url"], "clients/vanilla/26.2.html")
        self.assertEqual(problems, [])

    def test_catalog_falls_back_to_the_file_name(self):
        make_build(self.clients / "vanilla" / "26.2-dev-0.6.html")
        catalog, problems = clientlib.build_catalog()
        self.assertEqual(catalog["clients"][0]["name"], "26.2 Dev 0.6")
        self.assertEqual(catalog["clients"][0]["version"], clientlib.DEFAULT_VERSION)
        self.assertTrue(problems, "a missing sidecar should be reported")

    def test_catalog_follows_nested_folders(self):
        make_build(self.clients / "a" / "b" / "deep.html")
        self.write_group("a", {"label": "A group", "icon": "icons/icon-192.png", "order": 3})
        catalog, _problems = clientlib.build_catalog()
        client = catalog["clients"][0]
        self.assertEqual(client["groupPath"], ["a", "b"])
        self.assertEqual(client["groupLabel"], "B")
        paths = sorted(g["path"] for g in catalog["groups"])
        self.assertEqual(paths, ["a", "a/b"])

    def test_the_group_order_decides_the_list_order(self):
        make_build(self.clients / "a" / "one.html")
        make_build(self.clients / "b" / "two.html")
        self.write_group("a", {"order": 5})
        self.write_group("b", {"order": 1})
        catalog, _problems = clientlib.build_catalog()
        paths = [g["path"] for g in catalog["groups"]]
        self.assertEqual(paths, ["b", "a"], "the folder with the lower order comes first")

    def test_group_metadata_is_inherited(self):
        make_build(self.clients / "a" / "b" / "deep.html")
        self.write_group("a", {"icon": "icons/icon-192.png"})
        catalog, _problems = clientlib.build_catalog()
        self.assertEqual(catalog["clients"][0]["icon"], "icons/icon-192.png")

    def test_group_counts(self):
        make_build(self.clients / "a" / "one.html")
        make_build(self.clients / "a" / "two.html")
        make_build(self.clients / "a" / "b" / "three.html")
        catalog, _problems = clientlib.build_catalog()
        groups = {g["path"]: g for g in catalog["groups"]}
        self.assertEqual(groups["a"]["count"], 2, "two clients sit directly in a/")
        self.assertEqual(groups["a"]["total"], 3, "three clients sit under a/")
        self.assertEqual(groups["a/b"]["count"], 1)

    def test_recommended_is_read_from_the_sidecar(self):
        make_build(self.clients / "a" / "one.html")
        self.write_sidecar("a/one", {"recommended": True})
        catalog, _problems = clientlib.build_catalog()
        self.assertTrue(catalog["clients"][0]["recommended"])

    def test_recommended_accepts_the_string_forms(self):
        self.assertTrue(clientlib.is_recommended("true"))
        self.assertTrue(clientlib.is_recommended("YES"))
        self.assertTrue(clientlib.is_recommended("on"))
        self.assertFalse(clientlib.is_recommended("false"))
        self.assertFalse(clientlib.is_recommended(None))
        self.assertFalse(clientlib.is_recommended(0))

    def test_catalog_carries_the_default_client(self):
        make_build(self.clients / "a" / "one.html")
        clientlib.write_default("a/one")
        catalog, _problems = clientlib.build_catalog()
        self.assertEqual(catalog["defaultClient"], "a/one")

    def test_catalog_urls_point_at_the_builds(self):
        make_build(self.clients / "a" / "one.html")
        catalog, _problems = clientlib.build_catalog()
        url = catalog["clients"][0]["url"]
        self.assertTrue((self.tmp / url).is_file(), f"{url} should exist")


class MarkTests(TempTree):
    def setUp(self):
        super().setUp()
        self.patch_clientlib(clientlib)

    def test_set_recommended_writes_the_sidecar(self):
        make_build(self.clients / "a" / "one.html")
        path = clientlib.set_recommended("a/one", True)
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertTrue(data["recommended"])
        catalog, _problems = clientlib.build_catalog()
        self.assertTrue(catalog["clients"][0]["recommended"])

    def test_set_recommended_keeps_the_other_fields(self):
        make_build(self.clients / "a" / "one.html")
        self.write_sidecar("a/one", {"name": "Keep me", "author": "o_xer"})
        clientlib.set_recommended("a/one", True)
        data = json.loads((self.clients / "a" / "one.json").read_text(encoding="utf-8"))
        self.assertEqual(data["name"], "Keep me")
        self.assertEqual(data["author"], "o_xer")

    def test_set_recommended_needs_an_existing_build(self):
        with self.assertRaises(ValueError):
            clientlib.set_recommended("a/missing", True)

    def test_clear_recommended_clears_every_client(self):
        make_build(self.clients / "a" / "one.html")
        make_build(self.clients / "a" / "two.html")
        self.write_sidecar("a/one", {"recommended": True})
        self.write_sidecar("a/two", {"recommended": True})
        clientlib.clear_recommended()
        catalog, _problems = clientlib.build_catalog()
        self.assertFalse(any(c["recommended"] for c in catalog["clients"]))

    def test_default_round_trip(self):
        clientlib.write_default("a/one")
        self.assertEqual(clientlib.read_default(), "a/one")

    def test_default_can_be_cleared(self):
        clientlib.write_default("a/one")
        clientlib.write_default("")
        self.assertEqual(clientlib.read_default(), "")

    def test_read_default_without_a_file(self):
        self.assertEqual(clientlib.read_default(), "")

    def test_sidecar_path(self):
        self.assertEqual(
            clientlib.sidecar_path("a/b/one").as_posix(),
            (self.clients / "a" / "b" / "one.json").as_posix(),
        )


class StampTests(TempTree):
    """The 'generated' stamp must only move when the content really changes.

    The stamp has a resolution of one second, so the tests move the clock
    instead of sleeping.
    """

    def setUp(self):
        super().setUp()
        self.patch_clientlib(clientlib)

    def stamp_at(self, moment, catalog):
        class FakeNow:
            @staticmethod
            def now(tz=None):
                return moment

        with unittest.mock.patch.object(clientlib.datetime, "datetime", FakeNow):
            clientlib.stamp_catalog(catalog)
        return catalog["generated"]

    def test_the_stamp_moves_when_the_content_changes(self):
        catalog = {"generated": "", "groups": [], "clients": [{"id": "a"}]}
        first = self.stamp_at(
            datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc), catalog
        )
        clientlib.write_catalog(catalog)

        catalog["clients"].append({"id": "b"})
        second = self.stamp_at(
            datetime.datetime(2026, 1, 2, tzinfo=datetime.timezone.utc), catalog
        )
        self.assertNotEqual(first, second)

    def test_the_stamp_stays_when_nothing_changed(self):
        catalog = {"generated": "", "groups": [], "clients": [{"id": "a"}]}
        first = self.stamp_at(
            datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc), catalog
        )
        clientlib.write_catalog(catalog)

        again = {"generated": "", "groups": [], "clients": [{"id": "a"}]}
        self.stamp_at(datetime.datetime(2026, 6, 6, tzinfo=datetime.timezone.utc), again)
        self.assertEqual(again["generated"], first)


class NamingTests(unittest.TestCase):
    def test_humanize(self):
        self.assertEqual(clientlib.humanize("26.2-dev-0.6"), "26.2 Dev 0.6")
        self.assertEqual(clientlib.humanize("vanilla"), "Vanilla")
        self.assertEqual(clientlib.humanize("some_long_name"), "Some Long Name")

    def test_slugify(self):
        self.assertEqual(clientlib.slugify("Eaglercraft 26.2 Dev 0.6"), "eaglercraft-26-2-dev-0-6")
        self.assertEqual(clientlib.slugify("!!!"), "client")


if __name__ == "__main__":
    unittest.main()
