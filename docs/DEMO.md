# SENTROID — Demo Walkthrough

A ~10-minute script to demonstrate every capability from the proposal. Assumes
the backend, dashboard, and emulator with the agent installed are all running
(see [SETUP.md](SETUP.md)).

## 0. Sign in
Open the dashboard, log in as `admin` / `Admin@123`. You land on **Operations
Overview** — KPIs are zero until a device enrolls.

## 1. Secure enrollment  *(proposal 5.1)*
1. Go to **Enrollment → Generate Enrollment Token** (add a label like
   "Officer J. Khan", dept "Field Ops"). Copy the token.
2. On the emulator, open **SENTROID**:
   - **Activate Device Administration** → confirm.
   - Paste the token → **Enroll Device**.
3. Back in the dashboard, **Devices** now lists the device as **online** with a
   baseline policy assigned. → *Centralized, token-based onboarding.*

## 2. Real-time monitoring  *(proposal 5.4)*
- The **Overview** compliance donut and status chart update automatically.
- Open the device: watch **battery**, **network**, **encryption**, **rooted**,
  and **last-seen** refresh every few seconds as the agent checks in.

## 3. Policy enforcement  *(proposal 5.3)*
1. Go to **Policies → High-Security (Field Ops)** to review a hardened policy
   (complex password, camera disabled, wipe after 5 failed unlocks).
2. On the device page, assign it via the **Assigned Policy** dropdown.
3. SENTROID pushes an `ENFORCE_POLICY` command; the agent applies it through
   `DevicePolicyManager`. On the emulator, note the camera is now disabled
   (open the Camera app → "Camera disabled").

## 4. Remote command execution  *(proposal 5.2 / 6.2)*
On the device detail page, use the **Remote Actions** bar:

| Action | What to observe |
|---|---|
| **Ping** | Command history shows `PING → completed` within ~10 s. |
| **Ring** | The emulator plays an alarm tone for 5 s. |
| **Lock** | The emulator screen locks immediately. |
| **Locate** | Reported coordinates appear under Device Information (set a location in the emulator's *Extended controls → Location*). |
| **Disable** | Device is marked *disabled* and kept locked each cycle. **Re-enable** restores it. |
| **Factory Wipe** | ⚠ The emulator factory-resets. Great finale, but re-enroll afterwards. |

Each command flows: queued → delivered on next check-in → executed on device →
result reported → reflected in the dashboard and audit log.

## 5. Alerts  *(proposal 6.4)*
- Enrollment raised an **info** alert.
- Assign the high-security policy to a device whose storage isn't encrypted, or
  use a rooted image, to see **warning/critical** compliance and
  **ROOT_DETECTED** alerts. The sidebar badge counts unacknowledged alerts.

## 6. Administrative control, RBAC & logging  *(proposal 5.5)*
1. **Users → Add Administrator**: create an `operator` (e.g. `field_op`).
2. Sign out, sign in as the operator. Notice:
   - **Users** and **Enrollment** are hidden.
   - On a device, destructive buttons (**Disable**, **Factory Wipe**) are gone —
     RBAC is enforced both in the UI and on the server.
3. Sign back in as `admin` → **Audit Logs**: every login, command, policy change,
   and device response is recorded with actor, target, details, IP and time.
   Filter by `COMMAND_WIPE` or `LOGIN` to demonstrate traceability.

## 7. Talking points
- **Security-by-design**: RBAC, separate admin/device credentials, single-use
  enrollment tokens, bcrypt, rate limiting, full audit trail.
- **Real device control**: lock and wipe are genuine `DevicePolicyManager`
  actions, not simulations.
- **Self-contained**: HTTP polling means no cloud/push dependency — the entire
  system runs on one laptop plus an emulator, ideal for a lab demo.
- **Scalable & modular**: adding a command type touches one enum + one
  `when` branch; policy keys flow straight through to the agent.
