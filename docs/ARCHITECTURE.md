# SENTROID — System Architecture

This document describes the layered, modular architecture of SENTROID as
proposed in Section 7 of the project proposal, and how each proposal component
maps onto the implementation.

## 1. Layered architecture

SENTROID follows the three architectural layers defined in the proposal:

| Layer (proposal 7.1) | Responsibility | Implementation |
|---|---|---|
| **Core Enrollment** | Secure device authentication, token-based enrollment, validation against policy before access | `server/src/routes/agent.js` (`/enroll`), `enrollment_tokens`, per-device tokens |
| **Management & Control** | Centralized lifecycle management, monitoring, remote command execution over secure channels | `commands` queue, `routes/devices.js`, `routes/agent.js` (`/checkin`, `/commands/:id/result`) |
| **Policy Enforcement** | Continuous compliance via rule-based policies, automated enforcement, real-time violation detection | `services/policyEngine.js`, agent `PolicyManager.kt`, `alerts` |

## 2. Components

### 2.1 MDM Management Server (`server/`)

Node.js + Express application. Responsibilities:

- **Authentication & RBAC** — JWT-based admin sessions; four roles ranked
  `auditor < operator < admin < super_admin` (`middleware/auth.js`, `config.js`).
- **Device registry** — inventory + live status/compliance (`devices` table).
- **Command queue** — commands are rows with a lifecycle
  `pending → sent → completed/failed` (`commands` table, `services/commandService.js`).
- **Policy engine** — resolves the effective policy per device and evaluates
  reported telemetry for compliance (`services/policyEngine.js`).
- **Alerts** — enrollment, compliance, and root-detection events
  (`services/alertService.js`).
- **Audit log** — every administrative and device action
  (`utils/audit.js`, `audit_logs` table).
- **Static hosting** — serves the built dashboard SPA in production.

### 2.2 Admin Dashboard (`dashboard/`)

React single-page app (Vite build, Tailwind styling):

- **Overview** — fleet KPIs, compliance donut, status distribution, recent
  command activity (auto-refreshing).
- **Devices / Device detail** — inventory table and per-device control surface
  with the remote command bar and policy assignment.
- **Policies** — CRUD editor for rule-based security policies.
- **Alerts / Audit Logs / Enrollment / Users** — monitoring and administration.

### 2.3 Android Agent (`android-agent/`)

Kotlin app acting as the on-device SENTROID endpoint:

- **`MainActivity`** — enrollment UX: activate device admin → enroll with token.
- **`SentroidDeviceAdminReceiver`** — a `DeviceAdminReceiver`; being an active
  device administrator is what authorizes remote lock/wipe/policy.
- **`SentroidService`** — a foreground service running the secure check-in loop.
- **`PolicyManager`** — applies `DevicePolicyManager` restrictions and executes
  lock/wipe/password/camera actions.
- **`CommandExecutor`** — maps each remote command type to a concrete action.
- **`ApiClient`** — dependency-free HTTP client (`HttpURLConnection` + `org.json`).

## 3. Operational workflow (proposal 7.2)

```
1. Device Enrollment      Agent authenticates with a single-use token; server
                          registers the device, issues a device token + policy.
2. Policy Assignment      A default/assigned policy is pushed on enroll and on
                          each check-in; the agent applies it via DPM.
3. Remote Command Exec.   Admin queues a command in the console; it is delivered
                          on the device's next check-in.
4. Device Response        The agent executes the command and POSTs the result;
                          server updates device state + audit log.
5. Status Monitoring      Continuous telemetry (battery, network, encryption,
                          root, location, compliance) drives dashboards & alerts.
```

### Sequence: remote lock

```
Admin (browser)        Server                       Agent (device)
     │  POST /devices/1/commands {LOCK}             │
     │ ───────────────▶ │  insert command(pending)  │
     │                  │  device.status=locked     │
     │ ◀─────────────── │  201 {command}            │
     │                  │                            │
     │                  │ ◀── POST /agent/checkin ── │  (every ~10s)
     │                  │  mark command 'sent' ────▶ │  returns [{LOCK}]
     │                  │                            │  DevicePolicyManager.lockNow()
     │                  │ ◀ POST /commands/1/result  │  {completed}
     │                  │  command=completed         │
     │                  │  audit COMMAND_RESULT_LOCK │
```

## 4. Data model

```
users(id, username, password_hash, full_name, role, active, last_login)
enrollment_tokens(id, token, label, department, used, device_id, expires_at)
devices(id, device_uid, device_token, name, owner_name, department,
        manufacturer, model, os_version, sdk_int, serial, status, admin_active,
        compliance, battery_level, battery_charging, network_type, is_rooted,
        encryption_on, latitude, longitude, last_seen, enrolled_at)
policies(id, name, description, config(JSON), is_default)
device_policies(device_id, policy_id)
commands(id, device_id, type, payload(JSON), status, result, issued_by,
         issued_at, sent_at, completed_at)
alerts(id, device_id, severity, type, message, acknowledged, acked_by)
audit_logs(id, actor_type, actor_id, actor_label, action, target_type,
           target_id, details(JSON), ip, created_at)
```

## 5. Security architecture

- **Transport** — the agent talks JSON over HTTP; in production this terminates
  behind TLS (the proposal's "encrypted/VPN communication"). For local testing
  the emulator reaches the host at `http://10.0.2.2:4000`.
- **Two credential domains** — admin JWTs vs. per-device bearer tokens; neither
  can use the other's endpoints.
- **Least privilege** — command authorization is enforced server-side by role,
  independent of what the UI exposes.
- **Accountability** — append-only audit log with actor, target, and IP.
- **Input validation** — all request bodies validated with `zod`.
- **Abuse resistance** — rate limiting on `/auth/login` and `/agent/enroll`.

## 6. Why Device Administration (not Device Owner)

The agent uses the **Device Administration API**, which a normal user can enable
without factory-resetting the device. This is sufficient for the proposal's core
remote actions — **lock**, **wipe/factory-reset**, **password policy**,
**camera control**, and **failed-attempt wipe**. A production fleet deployment
could provision the app as a **Device Owner** (via QR/zero-touch enrollment) to
unlock the full restriction set; the code is structured so `PolicyManager` is the
single place that would change.
