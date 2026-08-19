# SENTROID — Device Owner test runbook

A step-by-step provisioning and acceptance test for a **freshly factory-reset,
company-owned handset**. Written against the first test device (Redmi 9A,
Android 10 / API 29, MIUI) because that is the *floor* of the supported range —
every version-gated fallback in the agent is exercised there. On Android 11+
handsets strictly more will work, never less.

> **The one rule that matters:** do not add a Google or Mi account before
> provisioning. Android only allows Device Owner on a device with **no
> accounts**, and it is a one-shot window at first boot. If an account is added
> you must factory reset again.

---

## 0. Before touching the phone

```bash
# Server reachable from the phone's network (note the LAN IP, not localhost)
hostname -I                       # e.g. 192.168.1.11
cd server && npm start            # listens on 0.0.0.0:4000

# Dashboard built and served by the server at http://<LAN-IP>:4000
cd dashboard && npm run build

# Agent APK present and its signing checksum known
cd android-agent && ./build-apk.sh
cat ../apk/sentroid-agent.apk.checksum
```

Open `http://<LAN-IP>:4000` (use the LAN IP, **not** `localhost`, so the QR the
dashboard generates points somewhere the phone can actually reach) and create an
enrollment token under **Enrollment**.

---

## 1. Provision as Device Owner

Factory reset the phone, then on the setup wizard **skip every sign-in prompt**.
Connect to Wi-Fi only.

### Method A — ADB (try first; simplest)

```bash
adb devices                       # authorise the RSA prompt on the phone
adb install -r apk/sentroid-agent.apk
adb shell dpm set-device-owner com.sentroid.agent/.admin.SentroidDeviceAdminReceiver
```

Expect `Success: Device owner set to package com.sentroid.agent`.

**MIUI catch-22:** Xiaomi gates some ADB operations behind *USB debugging
(Security settings)*, which demands a Mi account — but adding an account is
exactly what kills Device Owner. If ADB refuses, do **not** sign in. Use
Method B.

### Method B — QR at the setup wizard (bypasses ADB entirely)

1. Factory reset again if an account was added.
2. On the very first "Welcome" screen, **tap 6 times** on the same spot — the
   QR scanner opens.
3. Connect to Wi-Fi when prompted.
4. Scan the QR from the dashboard: **Enrollment → the token → Provision (QR)**.
5. The phone downloads the APK, verifies it against the signature checksum, and
   installs SENTROID as Device Owner, auto-enrolling with the embedded token.

If provisioning fails with a checksum error, the APK being served is not the one
the QR was generated for — rebuild and regenerate.

---

## 2. Confirm the management mode

The console must show the device as **device_owner**, not `device_admin`. Nearly
every control below is Device-Owner-only; on `device_admin` the agent reports
"requires Device Owner" instead of enforcing, which is correct behaviour but
means the fleet controls are not actually in place.

---

## 3. Acceptance tests

### 3.1 Ownership lockdown — the core requirement
| Check | Expected on Android 10 |
|---|---|
| Settings → Apps → SENTROID → Uninstall | **Blocked / greyed out** |
| Settings → Security → Device admin apps → deactivate | **Blocked** |
| Settings → Apps → SENTROID → **Force stop** | ⚠️ *Still available* — needs API 30. Uninstall block still holds. |
| Server → **WIPE** | Device factory-resets — the only removal path |

### 3.2 Remote actions
- **RESTART** → device reboots, then checks back in.
- **LOCK** → screen locks immediately.
- **LOCATE** → a fix appears on the map.
- **LOCATION_ON** → ⚠️ *Not enforceable on Android 10* (needs API 30). Agent
  reports so honestly and prompts the user on-device instead. `LOCATION_OFF`
  does work (via a user restriction).
- **No power-off button exists** — Android has no such API at any privilege
  level. Powering the phone off manually should raise a
  `DEVICE_POWERING_OFF` alert.

### 3.3 Lock-screen recovery (unlock without data loss)
This is the flow that must be armed **before** a lockout, so verify it early.

1. On the device, set a lock PIN and unlock once — this *activates* the reset
   token the agent registered at enrollment.
2. In the console, issue **RESET_PASSWORD** with a new PIN.
3. Expect: `lock screen reset to the new PIN — all data preserved, no factory
   reset`, and the new PIN works on the device.

If it reports *"recovery must be armed BEFORE a lockout"*, the user never
unlocked the device after enrollment — that is the honest failure, and the only
way in at that point is a wipe.

### 3.4 Policy: enforce vs monitor
Create a policy and set individual rules to **enforce** or **monitor**.

| Rule | `enforce` | `monitor` |
|---|---|---|
| `block_outgoing_calls` | Dialling is blocked (emergency numbers always work — Android never lets an admin block those) | Call connects, then a **violation** appears |
| `disable_camera` | Camera app fails to open | Camera works |
| `wifi_ssid_allowlist` | ⚠️ *Cannot enforce on Android 10* (needs API 33) — reported as monitor-only | Joining an off-list network raises a **critical** violation |
| `block_new_app_installs` | Play Store / sideload install blocked | Install allowed (⚠️ not currently detected — reported as unwatched) |

Each breach must appear in the device's **Violations** tab *and* raise an alert.
A `monitor` row reads "Allowed by design"; an `enforce` row reads "Not blocked",
meaning the handset could not enforce it — a stronger signal.

### 3.5 Kiosk (opt-in only)
Confirm a normal policy leaves the phone unrestricted. Only a policy with
`kiosk_mode` enabled should pin the device. With the power menu suppressed, a
**long-press power-off still works** — that is firmware-level and unblockable.

---

## 4. Known Android 10 ceilings (expected, not bugs)

| Capability | Needs | Behaviour on Android 10 |
|---|---|---|
| Block Force-stop / Clear storage | API 30 | Not applied; reported honestly |
| Remote location **ON** | API 30 | Cannot switch on; user prompted instead |
| Wi-Fi SSID allowlist **enforcement** | API 33 | Monitor-only; violations still raised |
| Power off remotely / block power off | — | Impossible at any API level |

The agent reports each of these as *"requires Android N+"* — deliberately
distinct from *"requires Device Owner"*, because re-provisioning fixes the
latter and can never fix the former.
