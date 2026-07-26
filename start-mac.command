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

# Install only on first setup. Routine launches never contact the package registry.
if [ ! -d "node_modules" ]; then
  npm ci || exit 1
fi

npm run build || exit 1

# Open the browser automatically after 2 seconds
(sleep 2 && open "https://localhost:5173") &

# Start the production local server
npm start
