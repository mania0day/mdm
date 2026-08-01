#!/usr/bin/env bash
# Start the SENTROID dashboard in Vite dev mode (hot reload), proxying /api to
# the backend. For production, run `npm run build` and let the server serve it.
set -e
source "$(dirname "$0")/env.sh"

cd "$SENTROID_ROOT/dashboard"
[ -d node_modules ] || npm install
echo "Starting SENTROID dashboard on http://localhost:5173 ..."
exec npm run dev
