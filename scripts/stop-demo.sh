#!/usr/bin/env bash
# ==============================================================================
# SENTROID — Master Stop Script for Demo / Presentation
# Gracefully terminates Server, Dashboard, and Cloudflare Tunnel processes
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/.demo.pids"

echo "Stopping SENTROID Demo processes..."

# 1. Kill tracked PIDs if file exists
if [ -f "$PID_FILE" ]; then
  while read -r pid; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# 2. Force cleanup by port matching & process name to guarantee clean state
pkill -f "node src/index.js" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
pkill -f "cloudflared tunnel" 2>/dev/null || true

# Kill anything listening on ports 4000 or 5173
fuser -k 4000/tcp 2>/dev/null || true
fuser -k 5173/tcp 2>/dev/null || true

echo "✓ SENTROID Demo services stopped."
