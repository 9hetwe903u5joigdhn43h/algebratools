#!/usr/bin/env python3
"""Run the test suite.

    ./test.py            # everything that is quick
    ./test.py --slow     # also the tests that read the 75 MB builds
    ./test.py -v         # verbose
    ./test.py clientlib  # only the tests whose name matches

The suite has three parts:

  * the Python tests (tests/test_*.py) — the catalog tooling,
  * the launcher tests (tests/test_launcher.js) — the real launcher script,
    run against a small DOM stub in node,
  * the asset tests — the manifest, the service worker and the catalog.
"""

import argparse
import os
import pathlib
import shutil
import subprocess
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SLOW = os.environ.get("ALGEBRATOOLS_SLOW") == "1"


def run_python_tests(pattern, verbose):
    """Run the unittest suite."""
    loader = unittest.TestLoader()
    if pattern:
        loader.testNamePatterns = [f"*{pattern}*"]

    # The slow tests read every build in clients/ — 375 MB of HTML. They
    # are off by default; --slow turns them on.
    if not SLOW and not pattern:
        os.environ["ALGEBRATOOLS_SKIP_SLOW"] = "1"

    suite = loader.discover(str(HERE / "tests"), top_level_dir=str(HERE))
    runner = unittest.TextTestRunner(verbosity=2 if verbose else 1)
    result = runner.run(suite)
    return result.wasSuccessful()


def run_launcher_tests(verbose):
    """Run the node tests for the launcher."""
    node = shutil.which("node")
    if not node:
        print("node is not installed — skipping the launcher tests")
        return True

    env = dict(os.environ)
    if verbose:
        env["VERBOSE"] = "1"
    result = subprocess.run(
        [node, str(HERE / "tests" / "test_launcher.js")],
        cwd=str(HERE),
        env=env,
    )
    return result.returncode == 0


def free_port():
    """A port nothing is listening on."""
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run_browser_tests(verbose):
    """Run the browser test: a real chromium, the real launcher.

    The launcher is served over http://localhost, because that is the only
    way a service worker, a fetch and the PWA install work.
    """
    node = shutil.which("node")
    if not node:
        print("node is not installed — skipping the browser test")
        return True

    port = free_port()
    server = subprocess.Popen(
        [sys.executable, str(HERE / "serve.py"), str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        # Wait for the server to answer.
        import time
        import urllib.error
        import urllib.request

        url = f"http://localhost:{port}/index.html"
        for _ in range(50):
            if server.poll() is not None:
                print("the local server would not start — skipping the browser test")
                return True
            try:
                with urllib.request.urlopen(url, timeout=1) as response:
                    if response.status == 200:
                        break
            except (urllib.error.URLError, OSError):
                time.sleep(0.1)
        else:
            print("the local server did not come up — skipping the browser test")
            return True

        result = subprocess.run(
            [node, str(HERE / "tests" / "e2e.js"), f"{url}?debug"],
            cwd=str(HERE),
        )
        return result.returncode == 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


def main() -> int:
    global SLOW

    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pattern", nargs="?", default="",
                        help="only run the tests whose name matches this")
    parser.add_argument("-v", "--verbose", action="store_true", help="be verbose")
    parser.add_argument("--slow", action="store_true",
                        help="also run the tests that read every build (slow)")
    parser.add_argument("--no-launcher", action="store_true",
                        help="skip the node launcher tests")
    parser.add_argument("--no-browser", action="store_true",
                        help="skip the chromium browser test")
    args = parser.parse_args()

    if args.slow:
        SLOW = True
        os.environ.pop("ALGEBRATOOLS_SKIP_SLOW", None)

    print("== python ==", flush=True)
    ok = run_python_tests(args.pattern, args.verbose)

    if not args.no_launcher and not args.pattern:
        print("\n== launcher (node) ==", flush=True)
        ok = run_launcher_tests(args.verbose) and ok

        if not args.no_browser:
            print("\n== browser (chromium) ==", flush=True)
            ok = run_browser_tests(args.verbose) and ok

    print("\n" + ("All tests passed." if ok else "Some tests FAILED."))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
