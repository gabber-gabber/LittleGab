#!/usr/bin/env bash
# Download + install the minimum Android build toolchain without sudo.
# Layout:
#   ~/opt/jdk-17/            JDK 17 (Temurin)
#   ~/opt/gradle-8.9/        Gradle distribution
#   ~/Library/Android/sdk/   Android SDK root (cmdline-tools/latest, platform-tools, platforms/android-34, build-tools/34.0.0)
# Emits ~/.phone-mac-bridge/android.env that the build script will source.
set -euo pipefail

OPT_DIR="$HOME/opt"
JDK_DIR="$OPT_DIR/jdk-17"
GRADLE_DIR="$OPT_DIR/gradle-8.9"
SDK_DIR="$HOME/Library/Android/sdk"
CMDL_DIR="$SDK_DIR/cmdline-tools/latest"
ENV_FILE="$HOME/.phone-mac-bridge/android.env"
DL_DIR="$HOME/.cache/phone-mac-bridge"

mkdir -p "$OPT_DIR" "$SDK_DIR/cmdline-tools" "$(dirname "$ENV_FILE")" "$DL_DIR"

have_cmd() { command -v "$1" >/dev/null 2>&1; }

echo "==> step 1/5: JDK 17"
if [ ! -x "$JDK_DIR/bin/java" ]; then
  JDK_TAR="$DL_DIR/temurin-17.tar.gz"
  if [ ! -s "$JDK_TAR" ]; then
    # Adoptium API always redirects to the latest 17 LTS for mac arm64
    echo "    downloading Temurin 17 (arm64 macOS) …"
    curl -fsSL -o "$JDK_TAR" \
      "https://api.adoptium.net/v3/binary/latest/17/ga/mac/aarch64/jdk/hotspot/normal/eclipse"
  fi
  echo "    extracting JDK …"
  rm -rf "$JDK_DIR.tmp" && mkdir "$JDK_DIR.tmp"
  tar -xzf "$JDK_TAR" -C "$JDK_DIR.tmp"
  INNER="$(ls "$JDK_DIR.tmp")"
  rm -rf "$JDK_DIR"
  mv "$JDK_DIR.tmp/$INNER/Contents/Home" "$JDK_DIR"
  rm -rf "$JDK_DIR.tmp"
  # On macOS, Temurin has a quarantine xattr; strip it so launchd-launched gradle can execute.
  xattr -dr com.apple.quarantine "$JDK_DIR" 2>/dev/null || true
fi
export JAVA_HOME="$JDK_DIR"
"$JDK_DIR/bin/java" -version 2>&1 | head -1 | sed 's/^/    /'

echo "==> step 2/5: Android cmdline-tools"
if [ ! -x "$CMDL_DIR/bin/sdkmanager" ]; then
  CMDL_ZIP="$DL_DIR/commandlinetools.zip"
  if [ ! -s "$CMDL_ZIP" ]; then
    echo "    downloading commandlinetools-mac …"
    curl -fsSL -o "$CMDL_ZIP" \
      "https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip"
  fi
  echo "    extracting cmdline-tools …"
  rm -rf "$SDK_DIR/cmdline-tools.tmp" && mkdir -p "$SDK_DIR/cmdline-tools.tmp"
  unzip -q "$CMDL_ZIP" -d "$SDK_DIR/cmdline-tools.tmp"
  rm -rf "$CMDL_DIR"
  mv "$SDK_DIR/cmdline-tools.tmp/cmdline-tools" "$CMDL_DIR"
  rm -rf "$SDK_DIR/cmdline-tools.tmp"
  xattr -dr com.apple.quarantine "$CMDL_DIR" 2>/dev/null || true
fi
export ANDROID_HOME="$SDK_DIR"
export ANDROID_SDK_ROOT="$SDK_DIR"
export PATH="$JDK_DIR/bin:$CMDL_DIR/bin:$SDK_DIR/platform-tools:$PATH"
sdkmanager --version | sed 's/^/    sdkmanager /'

echo "==> step 3/5: accepting SDK licenses"
yes | sdkmanager --licenses >/dev/null || true

echo "==> step 4/5: installing platform-tools / platforms;android-34 / build-tools;34.0.0"
sdkmanager --install "platform-tools" "platforms;android-34" "build-tools;34.0.0" >/dev/null
echo "    done"

echo "==> step 5/5: Gradle 8.9"
if [ ! -x "$GRADLE_DIR/bin/gradle" ]; then
  GRADLE_ZIP="$DL_DIR/gradle-8.9-bin.zip"
  if [ ! -s "$GRADLE_ZIP" ]; then
    echo "    downloading Gradle 8.9 …"
    curl -fsSL -o "$GRADLE_ZIP" "https://services.gradle.org/distributions/gradle-8.9-bin.zip"
  fi
  echo "    extracting gradle …"
  rm -rf "$GRADLE_DIR.tmp" && mkdir "$GRADLE_DIR.tmp"
  unzip -q "$GRADLE_ZIP" -d "$GRADLE_DIR.tmp"
  rm -rf "$GRADLE_DIR"
  mv "$GRADLE_DIR.tmp/gradle-8.9" "$GRADLE_DIR"
  rm -rf "$GRADLE_DIR.tmp"
  xattr -dr com.apple.quarantine "$GRADLE_DIR" 2>/dev/null || true
fi
"$GRADLE_DIR/bin/gradle" -v 2>/dev/null | grep -E '^Gradle ' | sed 's/^/    /'

cat > "$ENV_FILE" <<EOF
# Source this to use the Android toolchain installed by setup-android.sh.
export JAVA_HOME="$JDK_DIR"
export ANDROID_HOME="$SDK_DIR"
export ANDROID_SDK_ROOT="$SDK_DIR"
export GRADLE_HOME="$GRADLE_DIR"
export PATH="\$JAVA_HOME/bin:\$GRADLE_HOME/bin:$CMDL_DIR/bin:\$ANDROID_HOME/platform-tools:\$PATH"
EOF

echo
echo "==============================================================="
echo "  Android toolchain ready."
echo "  Environment written to: $ENV_FILE"
echo "  Build now:              bash scripts/build-apk.sh"
echo "==============================================================="
