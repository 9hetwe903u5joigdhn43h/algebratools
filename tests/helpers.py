"""Shared helpers for the test suite.

The tests never touch the real `clients/` folder — the builds are 75 MB
each and the point of the tests is to be quick and safe to run. Every test
works in a throwaway directory instead.
"""

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent

# The scripts that make up the catalog tooling.
TOOLING = ("build-index.py", "add-client.py", "inject-shim.py", "clientlib.py")

# A small, believable client build. The real ones are 75 MB; what matters
# to the tooling is the <head> tag and the rest of the file.
BUILD_HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>{title}</title>
</head>
<body>
<canvas id="game"></canvas>
<script>
  // A pretend game.
</script>
</body>
</html>
"""


def make_build(path, title="Test build"):
    """Write a small client build and return its path."""
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(BUILD_HTML.format(title=title), encoding="utf-8")
    return path


def make_build_without_head(path):
    """A file that is not a client build: no <head> to inject into."""
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("<html><body>no head here</body></html>", encoding="utf-8")
    return path


class TempTree(unittest.TestCase):
    """A base class with a throwaway directory and a patched clientlib."""

    def setUp(self):
        super().setUp()
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="algebratools-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.clients = self.tmp / "clients"
        self.clients.mkdir()

    def patch_clientlib(self, module):
        """Point clientlib at the throwaway tree."""
        import unittest.mock

        patcher = unittest.mock.patch.multiple(
            module,
            HERE=self.tmp,
            CLIENTS_DIR=self.clients,
            INDEX_PATH=self.clients / "index.json",
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_sidecar(self, relative, data):
        """Write a metadata sidecar under clients/."""
        path = self.clients / (relative + ".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        return path

    def write_group(self, relative, data):
        """Write a _group.json under clients/."""
        path = self.clients / relative / "_group.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        return path


class TempRepo:
    """A throwaway copy of the tooling, with its own clients/ folder.

    The scripts find their own folder with `pathlib.Path(__file__)`, so
    copying them into a temporary directory is what makes them work on a
    temporary catalog — no test hooks in the production code.
    """

    def __init__(self):
        self.dir = pathlib.Path(tempfile.mkdtemp(prefix="algebratools-repo-"))
        self.clients = self.dir / "clients"
        self.clients.mkdir()
        for name in TOOLING:
            shutil.copy2(REPO / name, self.dir / name)
        # The shim is read from next to clientlib.py.
        shutil.copy2(REPO / "client-shim.js", self.dir / "client-shim.js")

    def cleanup(self):
        shutil.rmtree(self.dir, True)

    def build(self, relative, title="Test build"):
        """Put a client build into the throwaway catalog."""
        return make_build(self.clients / relative, title)

    def run(self, script, *args, expect_success=True):
        """Run one of the tooling scripts and return the result."""
        result = subprocess.run(
            [sys.executable, str(self.dir / script), *args],
            cwd=str(self.dir),
            capture_output=True,
            text=True,
        )
        if expect_success and result.returncode != 0:
            raise AssertionError(
                f"{script} {' '.join(args)} failed with {result.returncode}\n"
                f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
            )
        return result

    def catalog(self):
        """The generated catalog, parsed."""
        path = self.clients / "index.json"
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
