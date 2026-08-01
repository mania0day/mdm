# SENTROID — Real-Device Validation Checklist

Everything in SENTROID has been tested on an Android 11 emulator configured to
match the **Xiaomi Redmi Note 9**. Two Device-Owner actions **cannot be fully
validated on an emulator** and MUST be confirmed on a physical device before the
client relies on them:

1. **Reset Password** — emulator returns *"Escrow token is disabled"* (an AOSP
   emulator limitation, not a code defect).
2. **Factory Wipe** — the emulator's OS cannot perform the recovery reboot
   (*"Reboot failed (no permissions?)"*), so an agent-triggered wipe does not
   execute on the emulator. On real hardware the standard Device-Owner
   `wipeData()` path works.

Everything else (enrollment, telemetry, live location + maps, force-location,
lock/unlock, disable/enable, ping/locate/ring, policy enforcement, alerts, audit,
RBAC) is verified working and does **not** need real-device retesting to trust.

---

## 0. Prerequisites (one-time, on the physical Redmi Note 9)

> ⚠️ Device Owner can only be set on a **factory-fresh device with no Google
> account added**. Factory reset the phone first and skip account sign-in.

1. On a computer, enable **USB debugging** on the phone (Settings → About →
   tap Build number 7×; then Developer options → USB debugging).
2. Point the agent at your server. Either edit
   `DEFAULT_SERVER` in `android-agent/app/build.gradle` to your server's LAN IP
   (e.g. `http://192.168.1.50:4000`) and rebuild, or type the URL into the app's
   "MDM Server URL" field at enrollment.
3. Install the agent:
   ```
   adb install -r android-agent/app/build/outputs/apk/debug/app-debug.apk
   ```
4. Make it Device Owner:
   ```
   adb shell dpm set-device-owner com.sentroid.agent/.admin.SentroidDeviceAdminReceiver
   ```
   Expect: `Success: Device owner set to package com.sentroid.agent`.
   (If it errors with "already has an account" → factory reset & retry.)
5. Grant location so live tracking works:
   ```
   adb shell pm grant com.sentroid.agent android.permission.ACCESS_FINE_LOCATION
   adb shell pm grant com.sentroid.agent android.permission.ACCESS_BACKGROUND_LOCATION
   ```
6. Open the app → create an enrollment token in the console (Enrollment page) →
   paste it → **Enroll**. Confirm the device appears **online / compliant** in
   the dashboard.

---

## 1. TEST: Reset Password  ✅ / ❌

**Goal:** admin sets a new lock-screen password remotely.

1. In the console → device → **Reset Password** (or issue a `RESET_PASSWORD`
   command). On real hardware the agent uses the Device-Owner
   `resetPasswordWithToken` flow.
2. On the phone, lock the screen and try to unlock.

**PASS if:** the old PIN no longer works and the new one does, and the command
shows **completed** with a success result (not "Escrow token is disabled").

**If it fails on a real device:** confirm the phone has no other conflicting
lock-credential policy and that the device is truly Device Owner
(`adb shell dumpsys device_policy | grep "Device Owner"`).

---

## 2. TEST: Factory Wipe  ✅ / ❌

> ⚠️ **Destructive.** This erases the phone. Use a test device.

1. Note the device is **online** in the console.
2. Console → device → **Factory Wipe** (confirm the dialog) — issues a `WIPE`.
3. Watch the phone.

**PASS if:** within ~10–20s the phone **factory-resets and reboots** to the
out-of-box setup screen, and in the console the device goes **offline** and
stops checking in.

**Note on reporting:** a successful wipe means the phone is erased mid-command,
so it will **not** report "completed" back — the device permanently going
**offline** is the real confirmation. (A "completed / wipe requested" result
without the device disappearing indicates the OS refused the wipe, which is what
happens on the emulator.)

---

## 3. Quick regression (optional, ~2 min on the real device)

Issue each and confirm the phone reacts + the command shows **completed**:

- [ ] **Ping** → result `pong`
- [ ] **Locate** → coordinates appear + Google Maps link opens the real location
- [ ] **Ring** → phone plays the ringtone for ~5s
- [ ] **Lock** → screen locks immediately
- [ ] **Disable** → device shows the org-lock screen; **Enable** restores it
- [ ] **Enforce Policy (High-Security)** → camera disabled; try to turn location
      off in Settings → it's blocked (force-location)

---

*Generated as part of honest delivery: these are the only items that could not be
proven on the emulator and require physical-device sign-off.*
