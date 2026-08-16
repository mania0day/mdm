#!/usr/bin/env bash
# Regenerate the Device Owner provisioning QR for the CURRENT network:
# recomputes the APK signing checksum, detects this machine's server IP, mints a
# fresh single-use enrollment token, and writes do-provisioning.svg / .json next
# to this script. Run it after switching Wi-Fi / hotspot (the IP changes) or
# whenever you need a fresh token. The SENTROID server must be running.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK="$ROOT/apk/sentroid-agent.apk"
PORT="${PORT:-4000}"
OUT_DIR="${OUT_DIR:-$ROOT/android-agent}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-Admin@123}"

APKSIGNER="$(ls "$HOME/Android/Sdk/build-tools/"*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
[ -f "$APK" ]        || { echo "APK not found at $APK — build it first: android-agent/build-apk.sh" >&2; exit 1; }
[ -n "$APKSIGNER" ]  || { echo "apksigner not found under \$HOME/Android/Sdk/build-tools" >&2; exit 1; }

# 1) Signing-certificate checksum (base64url of its SHA-256) — matches the served APK.
HEX="$("$APKSIGNER" verify --print-certs "$APK" | sed -n 's/.*SHA-256 digest: //p' | head -1 | tr -d ' ')"
CK="$(python3 -c "import base64,sys; print(base64.urlsafe_b64encode(bytes.fromhex(sys.argv[1])).decode().rstrip('='))" "$HEX")"

# 2) This machine's LAN/hotspot IP (same detector start.sh uses).
IP="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)"
[ -n "$IP" ] || { echo "Could not detect a LAN IP (is the network up?)" >&2; exit 1; }
SERVER_URL="http://${IP}:${PORT}"

# 3) Fresh single-use enrollment token via the admin API.
JWT="$(curl -s -X POST "$SERVER_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")"
ENR="$(curl -s -X POST "$SERVER_URL/api/enrollment/tokens" -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"label":"Device Owner QR provision"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token']['token'])")"

# 4) Build the QR.
SIGNATURE_CHECKSUM="$CK" SERVER_URL="$SERVER_URL" ENROLL_TOKEN="$ENR" \
  DOWNLOAD_URL="$SERVER_URL/sentroid-agent.apk" OUT_DIR="$OUT_DIR" \
  python3 "$ROOT/android-agent/make-do-qr.py"

echo
echo "QR + JSON written to $OUT_DIR (do-provisioning.svg / do-provisioning.json)"
echo "Server URL baked in: $SERVER_URL   Token: $ENR"
