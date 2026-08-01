# SENTROID MDM Server

Node.js + Express + SQLite backend for the SENTROID MDM platform. Exposes the
admin REST API, the device-agent API, policy engine, audit log and alerts, and
(optionally) serves the built dashboard.

## Run

```bash
npm install
cp .env.example .env
npm start        # http://localhost:4000
```

On first start it creates `data/sentroid.db`, seeds a super-admin
(`admin` / `Admin@123`), two policies, and a demo enrollment token (printed to
the console).

## Scripts

- `npm start` — run the server
- `npm run dev` — run with `--watch` (auto-restart)
- `npm run seed` — (re)seed admin/policy/token without starting the server

## Layout

```
src/
├── index.js            Express app, middleware, route mounting, static SPA
├── config.js           env config, roles, command matrix
├── db.js               SQLite connection + schema (created at load)
├── seed.js             idempotent bootstrap (admin, policies, token)
├── middleware/         auth (JWT + device token + RBAC), error handling
├── routes/             auth, devices, agent, policies, alerts, audit, users,
│                       enrollment, stats
├── services/           commandService, policyEngine, alertService
└── utils/              audit logger
```

See [../docs/API.md](../docs/API.md) for the full endpoint reference.

## Configuration (`.env`)

| Key | Default | Purpose |
|---|---|---|
| `PORT` | 4000 | HTTP port |
| `HOST` | 0.0.0.0 | bind address (lets the emulator reach it via 10.0.2.2) |
| `JWT_SECRET` | dev secret | **change in production** |
| `JWT_EXPIRES_IN` | 12h | admin token lifetime |
| `SEED_ADMIN_USERNAME/PASSWORD/NAME` | admin / Admin@123 | first-run super-admin |
| `DEVICE_OFFLINE_THRESHOLD_SECONDS` | 60 | offline cutoff |
