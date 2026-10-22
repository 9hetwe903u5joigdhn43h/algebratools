"""End-to-end tests for the command line scripts.

The scripts are run as real subprocesses against a throwaway copy of the
tooling, so what is tested is exactly what a user gets: the exit codes,
the files on disk and what the catalog ends up saying.
"""

import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from tests.helpers import TempRepo, make_build, make_build_without_head  # noqa: E402


class BuildIndexTests(unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.repo = TempRepo()
        self.addCleanup(self.repo.cleanup)

    def test_it_writes_the_catalog(self):
        self.repo.build("vanilla/26.2.html")
        self.repo.run("build-index.py")
        catalog = self.repo.catalog()
        self.assertIsNotNone(catalog)
        self.assertEqual(len(catalog["clients"]), 1)
        self.assertEqual(catalog["clients"][0]["id"], "vanilla/26.2")
        self.assertEqual(catalog["clients"][0]["url"], "clients/vanilla/26.2.html")

    def test_it_injects_the_shim_into_the_builds(self):
        build = self.repo.build("vanilla/26.2.html")
        self.repo.run("build-index.py")
        text = build.read_text(encoding="utf-8")
        self.assertIn("<!--launcher-shim-->", text)
        self.assertIn("eaglercraftShim", text)

    def test_check_is_happy_with_a_fresh_catalog(self):
        self.repo.build("vanilla/26.2.html")
        self.repo.run("build-index.py")
        result = self.repo.run("build-index.py", "--check")
        self.assertEqual(result.returncode, 0)
        self.assertIn("up to date", result.stdout)

    def test_check_notices_a_stale_catalog(self):
        self.repo.build("vanilla/26.2.html")
        self.repo.run("build-index.py")
        self.repo.build("modded/other.html")
        result = self.repo.run("build-index.py", "--check", expect_success=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("needs update", result.stdout)

    def test_no_inject_leaves_the_builds_alone(self):
        build = self.repo.build("vanilla/26.2.html")
        before = build.read_text(encoding="utf-8")
        self.repo.run("build-index.py", "--no-inject")
        self.assertEqual(build.read_text(encoding="utf-8"), before)
        self.assertIsNotNone(self.repo.catalog())

    def test_it_sets_the_default_client(self):
        self.repo.build("vanilla/26.2.html")
        self.repo.run("build-index.py", "--default", "vanilla/26.2")
        self.assertEqual(self.repo.catalog()["defaultClient"], "vanilla/26.2")

    def test_the_default_can_be_cleared(self):
        self.repo.build("vanilla/26.2.html")
        self.repo.run("build-index.py", "--default", "vanilla/26.2")
        self.repo.run("build-index.py", "--default", "none")
        self.assertEqual(self.repo.catalog()["defaultClient"], "")

    def test_it_marks_the_recommended_client(self):
        self.repo.build("vanilla/26.2.html")
        self.repo.run("build-index.py", "--recommended", "vanilla/26.2")
        catalog = self.repo.catalog()
        self.assertTrue(catalog["clients"][0]["recommended"])

    def test_the_recommended_mark_can_be_cleared(self):
        self.repo.build("vanilla/26.2.html")
        self.repo.run("build-index.py", "--recommended", "vanilla/26.2")
        self.repo.run("build-index.py", "--recommended", "none")
        catalog = self.repo.catalog()
        self.assertFalse(catalog["clients"][0]["recommended"])

    def test_an_unknown_client_is_refused(self):
        self.repo.build("vanilla/26.2.html")
        result = self.repo.run(
            "build-index.py", "--recommended", "nope/nope", expect_success=False
        )
        self.assertNotEqual(result.returncode, 0)

    def test_a_build_without_a_head_does_not_stop_the_others(self):
        self.repo.build("vanilla/good.html")
        make_build_without_head(self.repo.clients / "vanilla" / "broken.html")
        result = self.repo.run("build-index.py")
        self.assertIn("skipped", result.stdout)
        catalog = self.repo.catalog()
        self.assertEqual(len(catalog["clients"]), 2)


class AddClientTests(unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.repo = TempRepo()
        self.addCleanup(self.repo.cleanup)
        self.source = self.repo.dir / "Some-Build.html"
        make_build(self.source)

    def test_it_copies_the_build_and_writes_the_sidecar(self):
        self.repo.run(
            "add-client.py", str(self.source),
            "--group", "vanilla",
            "--name", "Eaglercraft 26.2",
            "--version", "26.2",
            "--description", "Minecraft in the browser",
            "--author", "o_xer",
        )
        build = self.repo.clients / "vanilla" / "eaglercraft-26-2.html"
        self.assertTrue(build.is_file())
        sidecar = self.repo.clients / "vanilla" / "eaglercraft-26-2.json"
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        self.assertEqual(data["name"], "Eaglercraft 26.2")
        self.assertEqual(data["author"], "o_xer")
        self.assertTrue((self.repo.clients / "vanilla" / "_group.json").is_file())

    def test_the_client_is_in_the_catalog_straight_away(self):
        self.repo.run(
            "add-client.py", str(self.source),
            "--group", "vanilla", "--name", "Eaglercraft 26.2",
        )
        catalog = self.repo.catalog()
        self.assertEqual(len(catalog["clients"]), 1)
        self.assertEqual(catalog["clients"][0]["name"], "Eaglercraft 26.2")

    def test_it_refuses_to_overwrite_without_force(self):
        self.repo.run(
            "add-client.py", str(self.source),
            "--group", "vanilla", "--name", "Eaglercraft 26.2",
        )
        result = self.repo.run(
            "add-client.py", str(self.source),
            "--group", "vanilla", "--name", "Eaglercraft 26.2",
            expect_success=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--force", result.stdout + result.stderr)

    def test_force_overwrites(self):
        self.repo.run(
            "add-client.py", str(self.source),
            "--group", "vanilla", "--name", "Eaglercraft 26.2",
        )
        self.repo.run(
            "add-client.py", str(self.source),
            "--group", "vanilla", "--name", "Eaglercraft 26.2", "--force",
        )

    def test_it_can_move_instead_of_copying(self):
        self.repo.run(
            "add-client.py", str(self.source),
            "--group", "vanilla", "--name", "Eaglercraft 26.2", "--move",
        )
        self.assertFalse(self.source.exists())
        self.assertTrue((self.repo.clients / "vanilla" / "eaglercraft-26-2.html").is_file())

    def test_it_can_set_the_default_and_the_recommended(self):
        self.repo.run(
            "add-client.py", str(self.source),
            "--group", "vanilla", "--name", "Eaglercraft 26.2",
            "--default", "--recommended",
        )
        catalog = self.repo.catalog()
        self.assertEqual(catalog["defaultClient"], "vanilla/eaglercraft-26-2")
        self.assertTrue(catalog["clients"][0]["recommended"])

    def test_it_refuses_a_missing_file(self):
        result = self.repo.run(
            "add-client.py", str(self.repo.dir / "nope.html"),
            "--group", "vanilla", "--name", "Nope", expect_success=False,
        )
        self.assertNotEqual(result.returncode, 0)

    def test_it_refuses_a_group_with_a_slash(self):
        result = self.repo.run(
            "add-client.py", str(self.source),
            "--group", "a/b", "--name", "Nested", expect_success=False,
        )
        self.assertNotEqual(result.returncode, 0)


class InjectShimTests(unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.repo = TempRepo()
        self.addCleanup(self.repo.cleanup)

    def test_it_injects_the_shim(self):
        build = self.repo.build("vanilla/26.2.html")
        self.repo.run("inject-shim.py")
        self.assertIn("<!--launcher-shim-->", build.read_text(encoding="utf-8"))

    def test_running_it_twice_changes_nothing(self):
        build = self.repo.build("vanilla/26.2.html")
        self.repo.run("inject-shim.py")
        once = build.read_text(encoding="utf-8")
        self.repo.run("inject-shim.py")
        self.assertEqual(build.read_text(encoding="utf-8"), once)

    def test_check_reports_a_build_that_needs_the_shim(self):
        self.repo.build("vanilla/26.2.html")
        result = self.repo.run("inject-shim.py", "--check", expect_success=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("needs update", result.stdout)

    def test_check_is_happy_after_an_injection(self):
        self.repo.build("vanilla/26.2.html")
        self.repo.run("inject-shim.py")
        result = self.repo.run("inject-shim.py", "--check")
        self.assertEqual(result.returncode, 0)
        self.assertIn("up to date", result.stdout)


if __name__ == "__main__":
    unittest.main()
