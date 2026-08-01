#!/usr/bin/env bash
# Launch the SENTROID AVD with hardware acceleration (KVM).
set -e
source "$(dirname "$0")/env.sh"

echo "== Launching emulator '$SENTROID_AVD' =="
exec "$ANDROID_HOME/emulator/emulator" -avd "$SENTROID_AVD" \
  -gpu host -accel on -no-snapshot -no-boot-anim
