#!/usr/bin/env bash
# Install the built APK onto the running emulator/device via adb.
set -e
source "$(dirname "$0")/env.sh"

APK="$SENTROID_ROOT/android-agent/app/build/outputs/apk/debug/app-debug.apk"
[ -f "$APK" ] || { echo "APK not found. Run build-apk.sh first." >&2; exit 1; }

echo "== Waiting for device =="
"$ANDROID_HOME/platform-tools/adb" wait-for-device
echo "== Installing $APK =="
"$ANDROID_HOME/platform-tools/adb" install -r -g "$APK"
echo "Installed. Launch: SENTROID app on the emulator."
