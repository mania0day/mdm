#!/usr/bin/env bash
# Shared environment for SENTROID build/run scripts.
# Source this from the other scripts:  source "$(dirname "$0")/env.sh"

# Root of the project (parent of scripts/)
export SENTROID_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Android SDK location (installed by setup-android-sdk.sh)
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

# JDK 21 used to build the Android app (Gradle 8.9 / AGP 8.6 need JDK 17-21,
# not the system JDK 25). setup-android-sdk.sh installs it here.
if [ -d "$HOME/.jdks/temurin-21" ]; then
  export JAVA_HOME="$HOME/.jdks/temurin-21"
elif [ -d "$HOME/android-studio/jbr" ]; then
  export JAVA_HOME="$HOME/android-studio/jbr"
fi

export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:${JAVA_HOME:+$JAVA_HOME/bin:}$PATH"

# Target emulator = Xiaomi Redmi Note 9 profile (Android 11 / API 30, its real OS).
# AOSP ('default') image is used so GPS/`geo fix` works reliably in the emulator.
export SENTROID_API=30
export SENTROID_IMAGE="system-images;android-30;default;x86_64"
export SENTROID_AVD="redmi_note_9"
