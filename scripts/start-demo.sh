#!/usr/bin/env bash
# ==============================================================================
# SENTROID — Master Start Script for Demo / Presentation
# Launches Backend Server, React Dashboard, and Cloudflare Public Tunnel
# ==============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$SCRIPT_DIR/.demo.pids"

# Clear old PIDs file
> "$PID_FILE"

echo "=================================================================="
echo "          🚀 STARTING SENTROID MDM DEMO SUITE 🚀                "
echo "=================================================================="

# 1. Stop any previous instances first
if [ -f "$SCRIPT_DIR/stop-demo.sh" ]; then
  echo "Checking for previous running processes..."
  bash "$SCRIPT_DIR/stop-demo.sh" >/dev/null 2>&1 || true
fi

# 2. Check Node & Java environment
source "$SCRIPT_DIR/env.sh" 2>/dev/null || true

# 3. Start Backend Server (Port 4000)
echo ""
echo "[1/3] Starting SENTROID Backend Server (port 4000)..."
cd "$PROJECT_ROOT/server"
npm start > "$PROJECT_ROOT/scripts/server.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" >> "$PID_FILE"

# Wait for server health
echo "Waiting for server API readiness..."
for i in {1..15}; do
  if curl -s http://localhost:4000/api/health >/dev/null 2>&1; then
    echo "✓ Backend Server is live on http://localhost:4000"
    break
  fi
  sleep 1
done

# 4. Start React Dashboard (Port 5173)
echo ""
echo "[2/3] Starting SENTROID Admin Dashboard (port 5173)..."
cd "$PROJECT_ROOT/dashboard"
npm run dev > "$PROJECT_ROOT/scripts/dashboard.log" 2>&1 &
DASH_PID=$!
echo "$DASH_PID" >> "$PID_FILE"

echo "✓ Dashboard is live on http://localhost:5173"

# 5. Start Cloudflare Tunnel for Internet access
echo ""
echo "[3/3] Launching Public HTTPS Tunnel (Cloudflare)..."
CLOUDFLARED_BIN="$PROJECT_ROOT/tools/cloudflared"

if [ ! -f "$CLOUDFLARED_BIN" ]; then
  echo "Downloading cloudflared binary..."
  mkdir -p "$PROJECT_ROOT/tools"
  curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$CLOUDFLARED_BIN"
  chmod +x "$CLOUDFLARED_BIN"
fi

"$CLOUDFLARED_BIN" tunnel --url http://localhost:4000 > "$PROJECT_ROOT/scripts/tunnel.log" 2>&1 &
TUNNEL_PID=$!
echo "$TUNNEL_PID" >> "$PID_FILE"

echo "Waiting for Public HTTPS URL..."
PUBLIC_URL=""
for i in {1..20}; do
  PUBLIC_URL=$(grep -o 'https://[-a-z0-9]*\.trycloudflare\.com' "$PROJECT_ROOT/scripts/tunnel.log" 2>/dev/null | head -n 1 || true)
  if [ -n "$PUBLIC_URL" ]; then
    break
  fi
  sleep 1
done

# 6. USB Port Forwarding (if device attached)
ADB_BIN="$ANDROID_HOME/platform-tools/adb"
if [ -x "$ADB_BIN" ] && "$ADB_BIN" devices 2>/dev/null | grep -q "device$"; then
  echo ""
  echo "[ADB] Device detected via USB. Setting up port forwarding (adb reverse)..."
  "$ADB_BIN" reverse tcp:4000 tcp:4000 2>/dev/null || true
fi

# 7. Generate a fresh enrollment token
FRESH_TOKEN="ENR-DEMO-$(date +%s | tail -c 5)"
node --input-type=module -e "import { db } from './server/src/db.js'; db.prepare('INSERT INTO enrollment_tokens (token, label, department, created_by, used) VALUES (?, ?, ?, ?, 0)').run('$FRESH_TOKEN', 'Demo Phone', 'Operations', 1);" 2>/dev/null || true

# Local LAN IP
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "192.168.1.x")

echo ""
echo "=================================================================="
echo "                🎉 SENTROID DEMO IS READY! 🎉                    "
echo "=================================================================="
echo ""
echo "  🌐 Admin Console (Browser):  http://localhost:5173"
echo "     • Admin Username:          admin"
echo "     • Admin Password:          Admin@123"
echo ""
echo "  📱 Server URLs for Phone App:"
echo "     • Internet (Cellular/4G): ${PUBLIC_URL:-'Checking tunnel.log...'}"
echo "     • Local Wi-Fi:           http://${LAN_IP}:4000"
echo "     • Direct USB:            http://127.0.0.1:4000"
echo ""
echo "  🔑 Fresh Enrollment Token:    $FRESH_TOKEN"
echo ""
echo "  Logs:"
echo "     • Server Log:            scripts/server.log"
echo "     • Dashboard Log:         scripts/dashboard.log"
echo "     • Tunnel Log:            scripts/tunnel.log"
echo ""
echo "  To STOP all servers when done, run:"
echo "     ./scripts/stop-demo.sh"
echo "=================================================================="
