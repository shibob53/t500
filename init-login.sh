#!/usr/bin/env bash
cd "$(dirname "$(readlink -f "$0")")"

set -e

echo "=== Midasbuy Init Login ==="
echo "This opens a visible browser. Sign in once, press Enter here, done."
echo "Cookies persist in .midasbuy-profile/ — only need this once."
echo

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js not found in PATH."
    echo "On Debian/Ubuntu/Mint: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
    exit 1
fi

if [ ! -d "node_modules/playwright" ]; then
    echo "Installing dependencies first..."
    npm install
fi

CACHE_DIR="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
if [ ! -d "$CACHE_DIR" ]; then
    echo "Downloading Playwright Chromium + system deps..."
    npx playwright install chromium --with-deps
fi

node midasbuy-hybrid.js init-login

echo
echo "Done. You can now run ./start-daemon.sh, or set up the systemd service for auto-start."
