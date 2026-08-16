#!/usr/bin/env bash
# Starts the full SENTROID stack: builds the dashboard, then runs the server
# (which serves the built dashboard + API from one port). Safe to re-run —
# stops any instance it previously started before launching a fresh one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$ROOT/server"
DASH_DIR="$ROOT/dashboard"
RUN_DIR="$ROOT/.run"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"
PORT="${PORT:-4000}"

mkdir -p "$RUN_DIR"

log() { printf '\033[1;36m[start.sh]\033[0m %s\n' "$1"; }

# --- stop any previous instance this script started -------------------------
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "Stopping previous server instance (pid $OLD_PID)…"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi
# Also clear anything else already bound to $PORT (e.g. a manually-started
# server from a previous session), so this always ends up the sole listener.
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
fi

# --- server dependencies -----------------------------------------------------
if [ ! -d "$SERVER_DIR/node_modules" ]; then
  log "Installing server dependencies…"
  (cd "$SERVER_DIR" && npm install)
fi

# --- dashboard: install, build (server serves dashboard/dist as static) -----
if [ ! -d "$DASH_DIR/node_modules" ]; then
  log "Installing dashboard dependencies…"
  (cd "$DASH_DIR" && npm install)
fi
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  log "Building dashboard…"
  (cd "$DASH_DIR" && npm run build)
else
  log "SKIP_BUILD=1 set — using existing dashboard/dist as-is."
fi

# --- start the server ---------------------------------------------------------
log "Starting server on port $PORT…"
(cd "$SERVER_DIR" && PORT="$PORT" nohup node src/index.js > "$LOG_FILE" 2>&1 & echo $! > "$PID_FILE")
SERVER_PID="$(cat "$PID_FILE")"

# --- wait for health check ----------------------------------------------------
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    log "Server process died on startup. Last log lines:"
    tail -n 30 "$LOG_FILE"
    exit 1
  fi
  sleep 0.5
done

if ! curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  log "Server did not become healthy in time. Last log lines:"
  tail -n 30 "$LOG_FILE"
  exit 1
fi

# Best-guess LAN IP a phone on the same network/hotspot uses to reach us.
# `ip route get` returns the source IP the kernel picks for off-link traffic —
# correct even over a phone hotspot with NO internet, as long as the hotspot
# handed out a default route (Android/iOS hotspots do). Falls back to the first
# private, non-virtual IPv4 when there is no default route at all. This is why
# it beats `hostname -I`, which just prints the first address of any interface
# (often a docker/virbr bridge that the phone can't reach).
detect_lan_ip() {
  local ip
  ip="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -n1)"
  if [ -z "$ip" ]; then
    ip="$(ip -4 -o addr show scope global up 2>/dev/null \
      | awk '$2 !~ /^(lo|docker|veth|virbr|br-|tun|tap|tailscale|zt)/ {print $4}' \
      | cut -d/ -f1 \
      | grep -E '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' | head -n1)"
  fi
  printf '%s' "$ip"
}

LAN_IP="$(detect_lan_ip)"

echo
log "SENTROID is up (pid $SERVER_PID)."
echo "  Local:            http://127.0.0.1:${PORT}"
if [ -n "${LAN_IP:-}" ]; then
  echo "  Enroll phone at:  http://${LAN_IP}:${PORT}   <-- type this server URL into the agent"
fi
# List every private address on this machine too, in case the pick above is not
# the phone-hotspot interface (e.g. Ethernet + Wi-Fi both up). The hotspot one
# is almost always the wl* / wlan* row.
OTHER_IPS="$(ip -4 -o addr show scope global up 2>/dev/null \
  | awk -v p="$PORT" '$2 !~ /^(lo|docker|veth|virbr|br-|tun|tap|tailscale|zt)/ {
      ip=$4; sub(/\/.*/,"",ip); printf "      %-10s http://%s:%s\n", $2, ip, p }')"
if [ -n "$OTHER_IPS" ]; then
  echo "  If that isn't your phone's hotspot, use one of these (pick the wlan* one):"
  printf '%s\n' "$OTHER_IPS"
fi
echo "  Logs:             $LOG_FILE"
echo "  Stop:             kill \$(cat $PID_FILE)"
echo

# --- optional HTTPS tunnel, only if cloudflared is installed -----------------
if command -v cloudflared >/dev/null 2>&1; then
  TUNNEL_LOG="$RUN_DIR/tunnel.log"
  log "cloudflared found — opening an HTTPS tunnel (for a phone that isn't on this network)…"
  nohup cloudflared tunnel --url "http://127.0.0.1:${PORT}" > "$TUNNEL_LOG" 2>&1 &
  echo $! > "$RUN_DIR/tunnel.pid"
  for i in $(seq 1 20); do
    URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -n1 || true)"
    [ -n "${URL:-}" ] && break
    sleep 1
  done
  if [ -n "${URL:-}" ]; then
    echo "  HTTPS:   $URL"
  else
    log "Tunnel is still starting — check $TUNNEL_LOG for the URL shortly."
  fi
else
  log "cloudflared not installed — skipping HTTPS tunnel (Local/LAN URLs above still work)."
fi
