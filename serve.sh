#!/usr/bin/env bash
# Serve the launcher over HTTP so the PWA works.
# Opening index.html directly (file://) blocks service workers, fetches,
# and the manifest — so Chrome can never offer the install.
#
# Usage: ./serve.sh [port]   (default: 8000)
# Then open http://localhost:<port> in Chrome.

PORT="${1:-8000}"

exec python3 "$(dirname "$0")/serve.py" "${PORT}"
