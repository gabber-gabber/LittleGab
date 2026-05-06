#!/usr/bin/env bash
# Build the signed release APK for the phone app.
# Assumes scripts/setup-android.sh has been run (writes ~/.phone-mac-bridge/android.env).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT/android"
DIST_DIR="$ROOT/dist"
ENV_FILE="$HOME/.phone-mac-bridge/android.env"
KS_DIR="$HOME/.phone-mac-bridge"
KS_FILE="$KS_DIR/release.keystore"
KS_PASS="${KEYSTORE_PASSWORD:-phonemacbridge}"
KEY_ALIAS="${KEY_ALIAS:-phonemacbridge}"
KEY_PASS="${KEY_PASSWORD:-phonemacbridge}"

if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE missing; run scripts/setup-android.sh first" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

# 1. Keystore (generate once)
if [ ! -f "$KS_FILE" ]; then
  echo "==> generating self-signed keystore at $KS_FILE"
  mkdir -p "$KS_DIR"
  umask 077
  "$JAVA_HOME/bin/keytool" -genkeypair -noprompt \
    -keystore "$KS_FILE" \
    -storetype PKCS12 \
    -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 \
    -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KEY_PASS" \
    -dname "CN=Phone-Mac Bridge, OU=Personal, O=Local, L=Local, S=Local, C=CN"
  chmod 600 "$KS_FILE"
fi

# 2. Build
export KEYSTORE_PATH="$KS_FILE"
export KEYSTORE_PASSWORD="$KS_PASS"
export KEY_ALIAS KEY_PASSWORD="$KEY_PASS"

echo "==> running gradle :app:assembleRelease"
cd "$ANDROID_DIR"
# This machine's system HTTP proxy (Clash on 127.0.0.1:7890) breaks Maven Central TLS
# handshakes from the JVM. Direct connection works, so strip the proxy for Gradle only.
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY
gradle --no-daemon :app:assembleRelease "$@"

# 3. Copy APK to dist/
APK_SRC="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
mkdir -p "$DIST_DIR"
DEST="$DIST_DIR/PhoneMacBridge.apk"
cp "$APK_SRC" "$DEST"

# 4. Verify signature
echo "==> verifying signature"
BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)"
"$BUILD_TOOLS/apksigner" verify --verbose "$DEST" | head -8

SIZE="$(stat -f%z "$DEST")"
echo
echo "==============================================================="
echo "  APK built:  $DEST"
echo "  Size:       $((SIZE / 1024)) KB"
echo "==============================================================="
