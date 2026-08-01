# SENTROID Android Agent

Kotlin Android app that runs on managed devices as the SENTROID endpoint. It
enrolls with the MDM server, reports telemetry, and executes remote commands via
the Android **Device Administration API**.

## Build

Requires a JDK 17–21 (not 25) and the Android SDK. From the repo root:

```bash
./scripts/setup-android-sdk.sh   # one-time SDK + JDK setup
./scripts/build-apk.sh           # → app/build/outputs/apk/debug/app-debug.apk
```

Or open this folder in **Android Studio** and press **Run**.

## Configuration

- `compileSdk`/`targetSdk` 34, `minSdk` 24, Kotlin 1.9, AGP 8.6, Gradle 8.9.
- Default server URL is `http://10.0.2.2:4000` (the host machine as seen from the
  emulator), editable at runtime on the enrollment screen —
  `BuildConfig.DEFAULT_SERVER` in `app/build.gradle.kts`.

## What it does

| Component | Role |
|---|---|
| `MainActivity` | Enrollment UX: activate device admin → enroll with a token |
| `SentroidDeviceAdminReceiver` | `DeviceAdminReceiver` authorizing lock/wipe/policy |
| `service/SentroidService` | Foreground service running the secure check-in loop |
| `service/CommandExecutor` | Maps each command type to a device action |
| `policy/PolicyManager` | Applies `DevicePolicyManager` restrictions |
| `data/ApiClient` | Dependency-free HTTP client (`HttpURLConnection`) |
| `data/Prefs` | Persistent enrollment state |
| `util/DeviceInfo` | Live telemetry (battery, network, encryption, root, location) |

## Supported remote commands

`LOCK`, `UNLOCK`, `PING`, `LOCATE`, `RING`, `RESET_PASSWORD`, `ENFORCE_POLICY`,
`DISABLE`, `ENABLE`, `WIPE` (factory reset).

## Permissions

Internet, foreground-service (dataSync), post-notifications, boot-completed,
location (coarse/fine, for LOCATE), vibrate. Device administration is granted
interactively by the user on first launch.

> **Note:** the agent uses Device Administration (user-grantable). Lock, wipe,
> password policy, camera control and failed-attempt wipe are real. A production
> deployment could provision it as Device Owner for the full restriction set;
> only `PolicyManager` would change.
