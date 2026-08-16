# SENTROID Agent — installable APK

`sentroid-agent.apk` is the built Android agent, ready to sideload onto a phone.

| | |
|---|---|
| Package | `com.sentroid.agent` |
| Version | 1.5 (versionCode 6) |
| Supported Android | **10 (API 29) → 16** |
| Build type | debug (debug-signed, sideload-installable) |

## Put it on your phone

1. **Connect the phone** by USB (or use any file transfer you like) and copy
   `sentroid-agent.apk` onto the device — Downloads is fine.
   - Or, over ADB from this folder: `adb install -r sentroid-agent.apk`
2. On the phone, open the file and tap **Install**. If prompted, allow
   *"Install unknown apps"* for the app you're installing from (Files/Chrome).
3. Open **SENTROID**, point it at the server, and enroll.
   - Server URL on the same Wi-Fi/hotspot as this machine:
     `http://<this-machine-LAN-IP>:4000` (the server prints its LAN URL on start).
   - Grant device-admin (and location) when asked.

## What enforces what

- **Device Admin** (normal sideload): lock, wipe, password policy, tamper/
  removal logging all work.
- **Device Owner** (factory-reset + QR provisioning) is required for the
  *"Block airplane mode"* and *"Force location always-on"* policies — Android
  forbids those controls for a plain device-admin app, and the agent will
  report them as *"requires Device Owner"* until provisioned that way.

## Rebuilding

From `../android-agent`, run `./build-apk.sh`. It rebuilds and refreshes this
APK (it pins a JDK 17-21 because Gradle can't run under the system Java 25).
