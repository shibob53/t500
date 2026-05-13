#!/usr/bin/env bash
# Run from this script's own directory regardless of where it was invoked.
cd "$(dirname "$(readlink -f "$0")")"

set -e

echo "=== Midasbuy Hybrid Daemon ==="
echo

# --- Node.js ---
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js not found in PATH."
    echo "On Debian/Ubuntu/Mint: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
    exit 1
fi

# --- npm dependencies (Playwright) ---
if [ ! -d "node_modules/playwright" ]; then
    echo "Installing npm dependencies (one-time, ~30 seconds)..."
    npm install
    echo
fi

# --- Playwright Chromium browser ---
# Default cache dir for Linux. Adjusted via PLAYWRIGHT_BROWSERS_PATH if set.
CACHE_DIR="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if [ ! -d "$CACHE_DIR" ]; then
    echo "Downloading Playwright Chromium + system deps (one-time, ~150 MB)..."
    npx playwright install chromium --with-deps
    echo
fi

# --- First-time login hint ---
if [ ! -d ".midasbuy-profile" ]; then
    echo "NOTE: No login profile found."
    echo "/lookup will work, but /switch and /coupon need a logged-in session."
    echo "To log in, close this and run once:  ./init-login.sh"
    echo
fi

echo "Starting daemon..."
echo "Once you see 'Listening on http://127.0.0.1:7777', open the Vercel UI."
echo "Press Ctrl+C to stop."
echo

# Run headed by default. If no real display is available, Xvfb is auto-started.
# Use --visible only when you need to SEE the browser window on screen.
node midasbuy-hybrid.js serve "$@"
