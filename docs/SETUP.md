# SENTROID — Setup & Run Guide

This guide covers a full local setup on Linux: backend, dashboard, and the
Android agent in an emulator.

## Prerequisites

- **Node.js ≥ 18** and npm (tested on Node 22).
- **A JDK 17–21** to build the Android app. (Gradle 8.9 / AGP 8.6 do **not**
  support JDK 25.) The setup script installs Temurin JDK 21 locally.
- **KVM** for a fast emulator (`ls /dev/kvm`). Check with
  `egrep -c '(vmx|svm)' /proc/cpuinfo` (should be > 0).
- ~15 GB free disk for the Android SDK + system image (+ ~2.5 GB if you also
  install the full Android Studio IDE).

## 1. Backend server

```bash
cd server
cp .env.example .env         # adjust PORT / secrets if desired
npm install
npm start
```

The server:
- creates `data/sentroid.db` (SQLite) on first run,
- seeds a `super_admin` (`admin` / `Admin@123`), two policies, and a demo
  enrollment token — all printed to the console,
- serves the API on `http://localhost:4000`,
- serves the built dashboard from `dashboard/dist` if present.

## 2. Dashboard

**Dev mode** (hot reload, proxies `/api` to the backend):

```bash
cd dashboard
npm install
npm run dev                  # http://localhost:5173
```

**Production build** (served by the backend at `http://localhost:4000`):

```bash
cd dashboard
npm run build                # outputs dashboard/dist
# restart the server; it now serves the SPA
```

Sign in at the dashboard with `admin` / `Admin@123`.

## 3. Android SDK

The helper script installs the command-line SDK, a platform, build-tools, the
emulator and a Google-APIs system image, and writes `local.properties`:

```bash
./scripts/setup-android-sdk.sh
```

It expects `~/mdm-downloads/cmdline-tools.zip` and a JDK 21 at
`~/.jdks/temurin-21` (both provided by the project bootstrap). It installs the
SDK into `~/Android/Sdk`.

> **JDK note:** `scripts/env.sh` points `JAVA_HOME` at `~/.jdks/temurin-21`
> (falling back to Android Studio's bundled JBR if present). All build scripts
> source it, so they use the correct JDK regardless of the system default.

## 4. Build the agent APK

```bash
./scripts/build-apk.sh
# → android-agent/app/build/outputs/apk/debug/app-debug.apk
```

## 5. Create and boot the emulator

```bash
./scripts/create-avd.sh
./scripts/run-emulator.sh     # keep this terminal open
```

## 6. Install and enroll

```bash
./scripts/install-apk.sh
```

On the emulator:
1. Open **SENTROID**.
2. **Activate Device Administration** → confirm on the system screen.
3. Enter the **server URL** (`http://10.0.2.2:4000`, pre-filled) and the
   **enrollment token** (from the dashboard *Enrollment* page or the server
   startup log), then **Enroll Device**.

Within ~10 s the device appears in the dashboard. Open it and try **Lock**,
**Enforce Policy**, **Ring**, or (careful) **Factory Wipe**.

## Using the full Android Studio IDE (optional)

The user proposal also asks for Android Studio. To install the IDE that was
downloaded to `~/mdm-downloads/android-studio.tar.gz`:

```bash
tar -xzf ~/mdm-downloads/android-studio.tar.gz -C ~/
~/android-studio/bin/studio.sh
```

Then **Open** the `android-agent/` folder. Studio will detect the Gradle
project. Point its Emulator/AVD Manager at the same SDK (`~/Android/Sdk`), or
let Studio manage its own — either works. You can run/debug the agent with the
green **Run** button.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Unsupported class file major version` / Gradle JDK error | Ensure `JAVA_HOME` is JDK 17–21, not 25. The scripts handle this. |
| Agent can't reach server | From the emulator the host is `10.0.2.2`, not `localhost`. Ensure the server binds `0.0.0.0` (default). |
| Emulator very slow | Confirm KVM: `ls -l /dev/kvm`; launch with `-gpu host -accel on`. |
| `adb: no devices` | Start the emulator first; `adb wait-for-device` blocks until ready. |
| Device shows offline in dashboard | It is flagged offline after `DEVICE_OFFLINE_THRESHOLD_SECONDS` (60s) without a check-in. |
