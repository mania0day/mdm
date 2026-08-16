# SENTROID — Secure Remote Support Terminal for Android

> **Mobile Device Management (MDM) platform** with a centralized admin dashboard,
> secure Android agent, policy enforcement, and remote command execution.
>
> Implementation of the *"Secure Remote Support Terminal for Android with Admin
> Dashboard and Command Execution"* proposal (Air University / National Cyber
> Security Academy).

---

## What SENTROID does

SENTROID gives an organization centralized, secure control over a fleet of
Android devices — exactly the capabilities described in the project proposal:

| Proposal capability | Where it lives |
|---|---|
| **Device Enrollment & Registration** (secure onboarding, token-based) | Android agent → `POST /api/agent/enroll` |
| **Remote Lock, Disable & Reset** | Dashboard command bar → `DevicePolicyManager.lockNow()/wipeData()` |
| **Policy Enforcement** (password, camera, encryption, failed-attempt wipe) | Policy engine → agent `PolicyManager.applyPolicy()` |
| **Device Status Monitoring** (real-time health & compliance) | Agent check-in → dashboard Overview/Devices |
| **Administrative Control & Logging** (RBAC + full audit trail) | JWT + roles + `audit_logs` |
| **Device Monitoring & Alerts** | Compliance/root/enrollment alerts feed |
| **Centralized Management Dashboard** | React console |

## Architecture

```
┌──────────────────────┐        HTTPS/JSON        ┌───────────────────────────┐
│   Android Agent       │  ───────────────────────▶│    MDM Management Server   │
│  (Kotlin, Device      │   enroll / check-in /    │  Node.js + Express + SQLite │
│   Admin API)          │◀───  command results  ───│  • Auth + RBAC (JWT)        │
│  • Foreground service │        commands ↓        │  • Command queue            │
│  • DevicePolicyManager│                          │  • Policy engine            │
│  • Telemetry + policy │                          │  • Audit log + alerts       │
└──────────────────────┘                          └─────────────┬─────────────┘
                                                                 │ REST
                                                    ┌────────────▼────────────┐
                                                    │   Admin Dashboard (SPA)  │
                                                    │   React + Vite + Tailwind│
                                                    └──────────────────────────┘
```

The agent **polls** the server over HTTP (default every 10s): it reports
telemetry and pulls any queued commands, executes them via the Android Device
Administration API, and reports the result back for the audit trail. No cloud
push service is required, so the whole stack runs self-contained on one machine
plus an emulator.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the full design.

## Repository layout

```
MDM_PROJECT/
├── server/            Node.js + Express + SQLite MDM backend (REST API)
├── dashboard/         React + Vite + Tailwind admin console
├── android-agent/     Kotlin Android agent (Gradle project)
├── scripts/           Build / run / emulator helper scripts
├── docs/              Architecture, setup, API reference, demo walkthrough
└── README.md
```

## Quick start

### 1. Backend + dashboard (host machine)

```bash
# Terminal 1 — API server (also serves the built dashboard)
cd server && npm install && npm start          # http://localhost:4000

# Terminal 2 — dashboard dev server (hot reload)
cd dashboard && npm install && npm run dev      # http://localhost:5173
```

Open **http://localhost:5173** and sign in with the seeded admin:

```
username: admin
password: Admin@123
```

The server prints a ready-to-use **enrollment token** on startup.

### 2. Android agent (emulator)

```bash
# One-time SDK setup (installs cmdline-tools, platform, emulator, image)
./scripts/setup-android-sdk.sh

# Build the APK, create + boot the emulator, install the agent
./scripts/build-apk.sh
./scripts/create-avd.sh
./scripts/run-emulator.sh        # in its own terminal
./scripts/install-apk.sh
```

In the emulator, open **SENTROID**, then:
1. Tap **Activate Device Administration** and confirm.
2. Paste the enrollment token (from the dashboard **Enrollment** page or the
   server startup log) and tap **Enroll Device**.

The device appears in the dashboard within ~10s. Issue **Lock / Wipe / Policy**
commands from the device detail page and watch the agent execute them.

Full step-by-step: **[docs/SETUP.md](docs/SETUP.md)** ·
Demo script: **[docs/DEMO.md](docs/DEMO.md)** ·
Production deployment (free cloud VM + VPN): **[docs/DEPLOY.md](docs/DEPLOY.md)**

## Security model (summary)

- **RBAC**: `auditor < operator < admin < super_admin`. Destructive commands
  (wipe/disable) require `admin`; user management requires `super_admin`.
- **Two token types**: admin JWTs for the console; per-device bearer tokens for
  agents (rotated on re-enrollment).
- **Secure onboarding**: single-use, optionally expiring enrollment tokens.
- **Full audit trail**: every admin action and device response is logged with
  actor, target, details, IP and timestamp.
- **Hardening**: `helmet`, CORS, rate limiting on login/enroll, `bcrypt`
  password hashing, input validation with `zod`.

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express, better-sqlite3, JWT, bcryptjs, zod, helmet |
| Dashboard | React 18, Vite, Tailwind CSS, React Router, Recharts |
| Agent | Kotlin, Android SDK 34, Device Administration API, HttpURLConnection |
| Tooling | Gradle 8.9, AGP 8.6, JDK 21, Android Emulator (KVM) |

## License

MIT — academic project for Air University / NCSA. See proposal for context.
