# SENTROID Admin Dashboard

React + Vite + Tailwind single-page console for the SENTROID MDM platform.

## Run

```bash
npm install
npm run dev        # http://localhost:5173 (proxies /api to :4000)
```

Production build (served by the backend):

```bash
npm run build      # outputs dist/, which server/ serves at :4000
```

## Pages

| Route | Purpose |
|---|---|
| `/login` | Admin authentication |
| `/` | Operations overview — KPIs, compliance & status charts, recent commands |
| `/devices` | Device inventory (searchable, auto-refreshing) |
| `/devices/:id` | Device detail — remote command bar, telemetry, policy, history |
| `/policies` | Security policy CRUD editor |
| `/alerts` | Monitoring alerts feed |
| `/enrollment` | Generate/revoke enrollment tokens (admin) |
| `/audit` | Audit log with filtering |
| `/users` | Administrator RBAC management (admin/super-admin) |

## Structure

```
src/
├── main.jsx / App.jsx     entry + routing
├── auth.jsx               auth context + role helpers
├── api.js                 fetch wrapper with bearer token
├── ui.jsx                 shared badges/spinner/time helpers
├── components/Layout.jsx  sidebar shell
└── pages/                 one file per route above
```

Role-gated navigation and controls mirror the server's RBAC; the server remains
the source of truth for authorization.
