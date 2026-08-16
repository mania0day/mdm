#!/usr/bin/env bash
# Build the SENTROID agent DEBUG apk and drop it in ../apk/sentroid-agent.apk.
#
# Why this wrapper exists: Gradle 8.9 / AGP 8.6 cannot run under the system's
# Java 25, so we pin the build to a JDK 17-21 (Android Studio ships a good one).
# Pass any extra gradle args through, e.g.  ./build-apk.sh --offline
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$(cd "$ROOT/.." && pwd)/apk"

java_major() { "$1/bin/java" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1; }

# Use $JAVA_HOME if it already points at a 17/21 JDK; otherwise auto-detect one.
JDK="${JAVA_HOME:-}"
if [ -z "$JDK" ] || [ ! -x "$JDK/bin/java" ] || ! echo "$(java_major "$JDK")" | grep -qE '^(17|18|19|20|21)$'; then
  JDK=""
  for c in /opt/android-studio/jbr "$HOME/android-studio/jbr" \
           /usr/lib/jvm/java-21-openjdk /usr/lib/jvm/java-17-openjdk \
           /usr/lib/jvm/java-21 /usr/lib/jvm/java-17; do
    if [ -x "$c/bin/java" ] && echo "$(java_major "$c")" | grep -qE '^(17|18|19|20|21)$'; then
      JDK="$c"; break
    fi
  done
fi
[ -n "$JDK" ] || { echo "No JDK 17-21 found (Gradle can't use Java 25). Set JAVA_HOME to one." >&2; exit 1; }

export JAVA_HOME="$JDK"
echo "[build-apk] JAVA_HOME=$JAVA_HOME  (java $(java_major "$JDK"))"

cd "$ROOT"
./gradlew "$@" assembleDebug

mkdir -p "$OUT_DIR"
cp app/build/outputs/apk/debug/app-debug.apk "$OUT_DIR/sentroid-agent.apk"
echo "[build-apk] APK updated -> $OUT_DIR/sentroid-agent.apk"

# Write the signing-certificate checksum next to the APK so the server's Device
# Owner provisioning QR always advertises the correct
# PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM for whatever key just signed this
# build (the debug keystore by default). The server reads this file at request
# time; if absent it falls back to config.provisioning.apkSignatureChecksum.
APKSIGNER="$(command -v apksigner || true)"
if [ -z "$APKSIGNER" ]; then
  for bt in "${ANDROID_HOME:-$HOME/Android/Sdk}/build-tools"/*/apksigner "$HOME/Android/Sdk/build-tools"/*/apksigner; do
    [ -x "$bt" ] && APKSIGNER="$bt"
  done
fi
if [ -n "$APKSIGNER" ]; then
  HEX="$("$APKSIGNER" verify --print-certs "$OUT_DIR/sentroid-agent.apk" 2>/dev/null \
        | sed -n 's/.*certificate SHA-256 digest: *//p' | head -1 | tr -d ' \r\n')"
  if [ -n "$HEX" ]; then
    CK="$(node -e 'process.stdout.write(Buffer.from(process.argv[1],"hex").toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""))' "$HEX")"
    printf '%s' "$CK" > "$OUT_DIR/sentroid-agent.apk.checksum"
    echo "[build-apk] signature checksum -> $CK"
  fi
else
  echo "[build-apk] apksigner not found — provisioning QR will use the checksum in server config" >&2
fi
