#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1 && [ -x "$SCRIPT_DIR/../node_binary/bin/node" ]; then
  export PATH="$SCRIPT_DIR/../node_binary/bin:$PATH"
fi

echo "=============================================="
echo "    Starting Live Translation Server...       "
echo "=============================================="

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 20.19 or newer is required."
  read -r -p "Press Enter to close..."
  exit 1
fi

# Reinstall only when the lockfile changed or a required package is missing.
if ! node scripts/runtime-state.js dependencies-ready >/dev/null 2>&1; then
  npm ci || exit 1
fi

# Rebuild after a pull or source/asset change, while keeping unchanged launches fast.
if ! node scripts/runtime-state.js build-ready >/dev/null 2>&1; then
  npm run build || exit 1
fi

# Open the browser automatically after 2 seconds
(sleep 2 && open "https://localhost:5173" && open "https://localhost:5173/audio-sender.html?host=1") &

# Start the production local server
npm start
