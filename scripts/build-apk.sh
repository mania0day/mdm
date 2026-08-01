#!/usr/bin/env bash
# Build the SENTROID Android agent debug APK using the project Gradle wrapper.
set -e
source "$(dirname "$0")/env.sh"

if [ -z "$JAVA_HOME" ]; then
  echo "ERROR: JAVA_HOME not set (need JDK 17-21). Run setup-android-sdk.sh first." >&2
  exit 1
fi

cd "$SENTROID_ROOT/android-agent"
echo "sdk.dir=$ANDROID_HOME" > local.properties
echo "== Building debug APK with JDK at $JAVA_HOME =="
./gradlew --no-daemon assembleDebug

APK="$SENTROID_ROOT/android-agent/app/build/outputs/apk/debug/app-debug.apk"
echo ""
echo "APK built: $APK"
ls -la "$APK"
