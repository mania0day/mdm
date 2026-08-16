#!/usr/bin/env bash
# ==============================================================================
# SENTROID — Oracle Cloud Free Tier provisioning script
#
# Run this ON THE VM, as root (sudo -i), AFTER copying the project there:
#   rsync -avz --exclude node_modules --exclude .git \
#     ./ ubuntu@<VM_PUBLIC_IP>:/tmp/sentroid-src
#   ssh ubuntu@<VM_PUBLIC_IP>
#   sudo mv /tmp/sentroid-src /opt/sentroid && cd /opt/sentroid
#   sudo SENTROID_DOMAIN=mdm.yourorg.duckdns.org ./deploy/setup-vm.sh
#
# Idempotent: safe to re-run after pulling an update.
# Tested against Ubuntu 22.04/24.04 (the default Oracle Cloud free-tier image).
# ==============================================================================
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo SENTROID_DOMAIN=your.domain ./deploy/setup-vm.sh" >&2
  exit 1
fi
if [ -z "${SENTROID_DOMAIN:-}" ]; then
  echo "Set SENTROID_DOMAIN first, e.g.:" >&2
  echo "  SENTROID_DOMAIN=mdm.yourorg.duckdns.org sudo -E ./deploy/setup-vm.sh" >&2
  exit 1
fi

PROJECT_DIR="/opt/sentroid"
cd "$PROJECT_DIR"

echo "[1/8] Installing base packages…"
apt-get update -qq
apt-get install -y -qq curl git ufw debian-keyring debian-archive-keyring apt-transport-https gnupg

echo "[2/8] Installing Node.js 20 LTS…"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

echo "[3/8] Installing Caddy (automatic HTTPS reverse proxy)…"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "[4/8] Installing Tailscale (private VPN mesh for the admin console)…"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "[5/8] Creating dedicated service user…"
id -u sentroid >/dev/null 2>&1 || useradd --system --home "$PROJECT_DIR" --shell /usr/sbin/nologin sentroid

echo "[6/8] Installing dependencies + building the dashboard…"
(cd server && npm ci --omit=dev)
(cd dashboard && npm ci && npm run build)

echo "[7/8] Writing production environment + systemd unit…"
mkdir -p "$PROJECT_DIR/server/data"
if [ ! -f "$PROJECT_DIR/server/.env" ]; then
  JWT_SECRET="$(openssl rand -hex 32)"
  ADMIN_PASS="$(openssl rand -base64 18 | tr -d '=+/')"
  cat > "$PROJECT_DIR/server/.env" <<EOF
PORT=4000
# Caddy is the only public entry point; the app itself only needs to listen
# on loopback — never expose 4000 directly to the internet.
HOST=127.0.0.1
NODE_ENV=production
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=12h
SEED_ADMIN_USERNAME=admin
SEED_ADMIN_PASSWORD=${ADMIN_PASS}
SEED_ADMIN_NAME=System Administrator
DEVICE_OFFLINE_THRESHOLD_SECONDS=60
EOF
  echo ""
  echo "  >>> Generated admin password: ${ADMIN_PASS}"
  echo "  >>> Save it now — it is only printed this once (see server/.env after)."
  echo ""
else
  echo "  server/.env already exists — leaving it untouched."
fi
chown -R sentroid:sentroid "$PROJECT_DIR"
chmod 600 "$PROJECT_DIR/server/.env"

cp deploy/sentroid.service /etc/systemd/system/sentroid.service
systemctl daemon-reload
systemctl enable --now sentroid

mkdir -p /var/log/caddy
SENTROID_DOMAIN="$SENTROID_DOMAIN" envsubst < deploy/Caddyfile > /etc/caddy/Caddyfile 2>/dev/null \
  || sed "s/{\$SENTROID_DOMAIN}/$SENTROID_DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl restart caddy

echo "[8/8] Configuring firewall (22, 80, 443 only — Node stays on loopback)…"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo ""
echo "============================================================"
echo " SENTROID is deployed."
echo "   Agent endpoint (public):   https://${SENTROID_DOMAIN}/api/agent/*"
echo "   Dashboard (Tailscale only): https://${SENTROID_DOMAIN}/"
echo ""
echo " Next steps:"
echo "   1. tailscale up   (on this VM — follow the printed login link)"
echo "   2. Install Tailscale on the admin's laptop, join the same tailnet"
echo "   3. Point the Android agent's 'MDM Server URL' at https://${SENTROID_DOMAIN}"
echo "   4. journalctl -u sentroid -f   to tail server logs"
echo "============================================================"
