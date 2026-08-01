# SENTROID — API Reference

Base URL (local): `http://localhost:4000`
From the Android emulator: `http://10.0.2.2:4000`

Two authentication domains:
- **Admin JWT** — `Authorization: Bearer <jwt>` from `POST /api/auth/login`.
- **Device token** — `Authorization: Bearer <device_token>` from enrollment.

All request/response bodies are JSON. Validation errors return `400` with a
`details` array. Auth failures return `401`; RBAC failures return `403`.

---

## Health

### `GET /api/health`
No auth. → `{ status, service, time }`

---

## Authentication (admin)

### `POST /api/auth/login`
Body `{ username, password }` → `{ token, user }`

### `GET /api/auth/me`  *(JWT)*
→ `{ user }`

### `POST /api/auth/logout`  *(JWT)*
→ `{ ok: true }`

---

## Devices *(JWT)*

### `GET /api/devices`
→ `{ devices: [ { …, online } ] }`

### `GET /api/devices/:id`
→ `{ device, policy, commands }`

### `POST /api/devices/:id/commands`
Body `{ type, payload? }` → `{ command }`
Command `type` ∈ `LOCK, UNLOCK, PING, LOCATE, RING, RESET_PASSWORD,
ENFORCE_POLICY, DISABLE, ENABLE, WIPE`. Role required varies (see below).

### `POST /api/devices/:id/policy`  *(admin)*
Body `{ policy_id | null }` → `{ policy }` (also pushes `ENFORCE_POLICY`).

### `DELETE /api/devices/:id`  *(admin)*
Deregister the device. → `{ ok: true }`

**Command role matrix**

| Command | Min role | Destructive |
|---|---|---|
| PING, LOCATE, RING, LOCK, UNLOCK | operator | no |
| RESET_PASSWORD, ENFORCE_POLICY, ENABLE | admin | no |
| DISABLE, WIPE | admin | yes |

---

## Policies *(JWT; writes require admin)*

### `GET /api/policies` → `{ policies, schema }`
### `GET /api/policies/:id` → `{ policy }`
### `POST /api/policies` *(admin)* — Body `{ name, description?, config?, is_default? }`
### `PUT /api/policies/:id` *(admin)*
### `DELETE /api/policies/:id` *(admin)* — cannot delete the default

Policy `config` keys: `min_password_length`, `require_password`,
`password_quality` (`none|numeric|alphanumeric|complex`), `max_failed_passwords`,
`max_screen_timeout_seconds`, `disable_camera`, `require_encryption`,
`block_rooted`.

---

## Alerts *(JWT)*

### `GET /api/alerts` → `{ alerts, unacknowledged }`
### `POST /api/alerts/:id/ack`
### `POST /api/alerts/ack-all`

---

## Audit logs *(JWT)*

### `GET /api/audit-logs?limit=&action=&actor_type=` → `{ logs }`

---

## Enrollment tokens *(JWT; writes require admin)*

### `GET /api/enrollment/tokens` → `{ tokens }`
### `POST /api/enrollment/tokens` *(admin)* — Body `{ label?, department?, expires_in_hours? }`
### `DELETE /api/enrollment/tokens/:id` *(admin)*

---

## Users *(JWT; admin+)*

### `GET /api/users` *(admin)* → `{ users, roles }`
### `POST /api/users` *(super_admin)* — Body `{ username, password, full_name, role }`
### `PATCH /api/users/:id` *(super_admin)* — Body `{ role?, active?, password? }`

---

## Agent API (device token, except enroll)

### `POST /api/agent/enroll`
Body `{ enrollment_token, device_uid, name?, manufacturer?, model?,
os_version?, sdk_int?, serial? }`
→ `{ device_id, device_token, policy, checkin_interval_seconds }`

### `POST /api/agent/checkin`  *(device token)*
Body (all optional) `{ battery_level, battery_charging, network_type,
os_version, admin_active, password_set, encryption_on, is_rooted, latitude,
longitude }`
→ `{ commands: [ { id, type, payload } ], policy, compliance,
checkin_interval_seconds }`

### `POST /api/agent/commands/:id/result`  *(device token)*
Body `{ status: 'completed'|'failed'|'acknowledged', result? }` → `{ ok: true }`

---

## Example: full flow with `curl`

```bash
B=http://localhost:4000
# 1. Admin login
TOKEN=$(curl -s -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"Admin@123"}' | jq -r .token)

# 2. Get an enrollment token
ENR=$(curl -s $B/api/enrollment/tokens -H "Authorization: Bearer $TOKEN" | jq -r '.tokens[0].token')

# 3. Agent enrolls
DTOK=$(curl -s -X POST $B/api/agent/enroll -H 'Content-Type: application/json' \
  -d "{\"enrollment_token\":\"$ENR\",\"device_uid\":\"demo-1\",\"model\":\"Pixel\"}" | jq -r .device_token)

# 4. Admin issues LOCK
curl -s -X POST $B/api/devices/1/commands -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"type":"LOCK"}'

# 5. Agent checks in, receives + completes it
CMD=$(curl -s -X POST $B/api/agent/checkin -H "Authorization: Bearer $DTOK" \
  -H 'Content-Type: application/json' -d '{"battery_level":80}' | jq '.commands[0].id')
curl -s -X POST $B/api/agent/commands/$CMD/result -H "Authorization: Bearer $DTOK" \
  -H 'Content-Type: application/json' -d '{"status":"completed","result":"locked"}'
```
