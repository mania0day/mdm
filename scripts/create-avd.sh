#!/usr/bin/env bash
# Create (if needed) the SENTROID emulator AVD.
set -e
source "$(dirname "$0")/env.sh"

AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"

if "$AVDMANAGER" list avd | grep -q "$SENTROID_AVD"; then
  echo "AVD '$SENTROID_AVD' already exists."
else
  echo "== Creating AVD '$SENTROID_AVD' =="
  echo "no" | "$AVDMANAGER" create avd \
    --name "$SENTROID_AVD" \
    --package "$SENTROID_IMAGE" \
    --device "pixel_6" \
    --force
fi
echo "AVD ready."
