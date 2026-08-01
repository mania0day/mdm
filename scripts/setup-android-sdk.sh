#!/usr/bin/env bash
# One-time setup of the Android SDK command-line tools, platform, build-tools,
# emulator and a system image needed to build and run the SENTROID agent.
#
# Prereqs (downloaded by the project bootstrap):
#   ~/mdm-downloads/cmdline-tools.zip   (Android command-line tools)
#   ~/.jdks/temurin-21                  (JDK 21 for Gradle)
set -e
source "$(dirname "$0")/env.sh"

DL="$HOME/mdm-downloads"

echo "== Installing Android command-line tools into $ANDROID_HOME =="
mkdir -p "$ANDROID_HOME/cmdline-tools"
if [ ! -d "$ANDROID_HOME/cmdline-tools/latest" ]; then
  rm -rf "$ANDROID_HOME/cmdline-tools/tmp"
  unzip -q "$DL/cmdline-tools.zip" -d "$ANDROID_HOME/cmdline-tools/tmp"
  mv "$ANDROID_HOME/cmdline-tools/tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rmdir "$ANDROID_HOME/cmdline-tools/tmp"
fi

SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"

echo "== Accepting SDK licenses =="
yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses >/dev/null || true

echo "== Installing SDK packages (this downloads ~2GB) =="
"$SDKMANAGER" --sdk_root="$ANDROID_HOME" \
  "platform-tools" \
  "platforms;android-$SENTROID_API" \
  "build-tools;34.0.0" \
  "emulator" \
  "$SENTROID_IMAGE"

echo "== Writing android-agent/local.properties =="
echo "sdk.dir=$ANDROID_HOME" > "$SENTROID_ROOT/android-agent/local.properties"

echo "Done. SDK ready at $ANDROID_HOME"
