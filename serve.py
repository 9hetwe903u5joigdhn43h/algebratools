#!/usr/bin/env python3
"""Local HTTP server for the Eaglercraft Launcher.

`python3 -m http.server` works fine, but this wrapper keeps the log clean:
- `/health` gets a 200 "ok" (external pollers hit it; the launcher doesn't)
- `/.well-known/appspecific/com.chrome.devtools.json` gets 204 No Content
  (Chrome DevTools probes this automatically when opened on localhost)
Both are answered quietly instead of being logged as 404 noise.
"""

import http.server
import socketserver
import sys
from urllib.parse import urlsplit

# path -> (status, body bytes | None); body None => 204 No Content
QUIET = {
    "/health": (200, b"ok\n"),
    "/.well-known/appspecific/com.chrome.devtools.json": (204, None),
}


class LauncherHandler(http.server.SimpleHTTPRequestHandler):
    def _path(self):
        return urlsplit(self.path).path

    def do_GET(self):
        quiet = QUIET.get(self._path())
        if quiet is not None:
            status, body = quiet
            self.send_response(status)
            if body is None:
                self.send_header("Content-Length", "0")
            else:
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if body is not None:
                self.wfile.write(body)
            return
        super().do_GET()

    def log_request(self, code="-", size="-"):
        if self._path() in QUIET:
            return  # keep probe spam out of the log
        super().log_request(code, size)


class LauncherServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    with LauncherServer(("127.0.0.1", port), LauncherHandler) as httpd:
        print(f"Serving Eaglercraft Launcher at http://localhost:{port}")
        print("Stop with Ctrl+C.", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
