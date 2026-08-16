# SENTROID — Production Deployment (Oracle Cloud Free Tier + Tailscale)

This gets SENTROID running on a real server with a real public HTTPS
endpoint, at zero cost, in about 15 minutes. The design:

- **Agent check-in (`/api/agent/*`)** is reachable from the public internet
  over HTTPS — phones check in from cellular data, hotel wifi, anywhere.
  It's protected by per-device bearer tokens + rate limiting (already built
  into the server).
- **Everything else** — the admin dashboard and every other `/api/*` route —
  is only reachable over a private [Tailscale](https://tailscale.com) VPN
  mesh. Even a stolen admin password/JWT is useless to an attacker who isn't
  on your tailnet. This is enforced at the reverse-proxy layer
  (`deploy/Caddyfile`), on top of the existing JWT auth — defense in depth,
  which matters given the org is an explicit target of attacks.

```
Internet ──HTTPS──▶ Caddy (VM public IP) ──▶ /api/agent/*  ──▶ Node (127.0.0.1:4000)
                            │
Tailscale mesh ────────────┴────────────▶ dashboard + admin /api/*
```

## 1. Create the free VM (~5 min)

1. Sign up at [cloud.oracle.com](https://www.oracle.com/cloud/free/) (free
   tier, no ongoing cost — this is "Always Free", not a 12-month trial).
2. **Create an instance**: Ubuntu 22.04 or 24.04, shape `VM.Standard.E2.1.Micro`
   (x86, always-free) or an Ampere A1 `VM.Standard.A1.Flex` (ARM, more
   generous free quota — either works, the setup script handles both).
3. Attach a public IP (default on creation).
4. In the instance's **Security List / Network Security Group**, allow
   ingress TCP 22, 80, 443 from `0.0.0.0/0`. (The setup script also
   configures `ufw` on the box itself — Oracle's cloud-level firewall is a
   second gate in front of that.)
5. Note the public IP.

## 2. Point a free domain at it

Caddy needs a domain name to auto-provision a Let's Encrypt certificate (it
can't get a public cert for a bare IP). If you don't have a domain, use a
free one:

1. [duckdns.org](https://www.duckdns.org) → sign in → create a subdomain,
   e.g. `sentroid-yourorg.duckdns.org` → point it at the VM's public IP.

## 3. Copy the project to the VM and run setup

From your machine, in this repo:

```bash
rsync -avz --exclude node_modules --exclude .git --exclude dashboard/dist \
  ./ ubuntu@<VM_PUBLIC_IP>:/tmp/sentroid-src

ssh ubuntu@<VM_PUBLIC_IP>
sudo mv /tmp/sentroid-src /opt/sentroid && cd /opt/sentroid
sudo SENTROID_DOMAIN=sentroid-yourorg.duckdns.org ./deploy/setup-vm.sh
```

The script installs Node 20, Caddy, Tailscale, builds the dashboard,
generates a strong `JWT_SECRET` and a random admin password (printed once —
save it), creates a locked-down `sentroid` system user, installs the
systemd service, and configures the firewall. It's idempotent — re-run it
after `git pull`-ing an update.

## 4. Join the private admin network

```bash
# on the VM
sudo tailscale up
# follow the printed login link to add it to your tailnet

# on your laptop (macOS/Windows/Linux)
# install from https://tailscale.com/download, then:
tailscale up
```

Now `https://sentroid-yourorg.duckdns.org/` (the dashboard) only responds
for requests coming from a device on your tailnet — everyone else gets a
403 from Caddy before it ever reaches the app.

## 5. Point the Android agents at it

- In the app's **MDM Server URL** field (or `DEFAULT_SERVER` in
  `android-agent/app/build.gradle.kts` before building a release APK), set:
  `https://sentroid-yourorg.duckdns.org`
- Phones do **not** need Tailscale — `/api/agent/*` is public HTTPS by
  design, guarded by per-device tokens.
- For fleet rollout via the QR zero-touch flow, host the signed release APK
  at `https://sentroid-yourorg.duckdns.org/agent/sentroid.apk` (drop it in
  `/opt/sentroid/releases/` on the VM — the Caddyfile already serves that
  path publicly) and follow `QR_PROVISIONING_GUIDE.md`.

## Operating it

```bash
sudo systemctl status sentroid        # is it running
sudo journalctl -u sentroid -f        # tail logs
sudo systemctl restart sentroid       # after a config change
sudo systemctl reload caddy           # after editing /etc/caddy/Caddyfile
```

**Backups**: the whole database is one file,
`/opt/sentroid/server/data/sentroid.db` (SQLite + WAL). Cron a copy of it
somewhere off-box:

```cron
0 * * * * cp /opt/sentroid/server/data/sentroid.db /opt/sentroid/backups/sentroid-$(date +\%H).db
```

**Deploying an update**: `rsync` the changed files over (same command as
step 3), then on the VM:

```bash
cd /opt/sentroid
sudo -u sentroid bash -c 'cd server && npm ci --omit=dev'
sudo -u sentroid bash -c 'cd dashboard && npm ci && npm run build'
sudo systemctl restart sentroid
```

## Why not just the Cloudflare Tunnel demo script?

`scripts/start-demo.sh` (Cloudflare quick tunnel) is fine for a same-day demo
from a laptop — it needs no VM at all. It is not appropriate for the
production fleet: the whole app (dashboard included) is on the public
internet with no VPN gate, the tunnel URL changes every restart, and nothing
survives a laptop reboot. This deployment path is the one to use once
devices are actually being managed.
