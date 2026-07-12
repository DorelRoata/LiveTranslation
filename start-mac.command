#!/bin/bash

# Move to the directory where this script is located
cd "$(dirname "$0")"

echo "=============================================="
echo "    Starting Live Translation Server...       "
echo "=============================================="

# Ensure dependencies are installed
npm install

# Open the browser automatically after 2 seconds
(sleep 2 && open "https://localhost:5173") &

# Start the Vite dev server
npm run dev
