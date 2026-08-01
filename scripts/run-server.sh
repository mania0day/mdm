#!/usr/bin/env bash
# Start the SENTROID MDM backend (serves the API and, if built, the dashboard).
set -e
source "$(dirname "$0")/env.sh"

cd "$SENTROID_ROOT/server"
[ -d node_modules ] || npm install
[ -f .env ] || cp .env.example .env
echo "Starting SENTROID MDM server on http://localhost:4000 ..."
exec npm start
