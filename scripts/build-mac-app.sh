#!/usr/bin/env bash
# Build PhoneMacBridge.app — a double-clickable macOS bundle that
# handles first-run install, launchd registration, and opens the setup console.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/PhoneMacBridge.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"
BRIDGE="$RES/bridge"

echo "==> cleaning $APP"
rm -rf "$APP"
mkdir -p "$MACOS" "$BRIDGE"

echo "==> regenerating icons"
node "$ROOT/scripts/make-icons.js" >/dev/null

echo "==> building AppIcon.icns"
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET"
SRC="$ROOT/web/icon-1024.png"
sips -z 16 16     "$SRC" --out "$ICONSET/icon_16x16.png"      >/dev/null
sips -z 32 32     "$SRC" --out "$ICONSET/icon_16x16@2x.png"   >/dev/null
sips -z 32 32     "$SRC" --out "$ICONSET/icon_32x32.png"      >/dev/null
sips -z 64 64     "$SRC" --out "$ICONSET/icon_32x32@2x.png"   >/dev/null
sips -z 128 128   "$SRC" --out "$ICONSET/icon_128x128.png"    >/dev/null
sips -z 256 256   "$SRC" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256   "$SRC" --out "$ICONSET/icon_256x256.png"    >/dev/null
sips -z 512 512   "$SRC" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512   "$SRC" --out "$ICONSET/icon_512x512.png"    >/dev/null
cp                "$SRC" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"

echo "==> copying bridge payload"
# Copy source (without node_modules — launcher installs them per-user on first run)
rsync -a --delete \
  --exclude 'node_modules' --exclude 'dist' --exclude '.DS_Store' --exclude '.git' \
  "$ROOT/server/"  "$BRIDGE/server/"
rsync -a --delete \
  --exclude '.DS_Store' \
  "$ROOT/web/"     "$BRIDGE/web/"
rsync -a --delete \
  --exclude 'build-mac-app.sh' --exclude 'smoke-test.js' --exclude '.DS_Store' \
  "$ROOT/scripts/" "$BRIDGE/scripts/"

# Version stamp lets the launcher decide when to resync App Support copy
date +%s > "$BRIDGE/VERSION"

echo "==> writing Info.plist"
cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>             <string>LittleGab</string>
  <key>CFBundleDisplayName</key>      <string>LittleGab</string>
  <key>CFBundleIdentifier</key>       <string>com.local.phone-mac-bridge</string>
  <key>CFBundleVersion</key>          <string>0.6.0</string>
  <key>CFBundleShortVersionString</key><string>0.6.0</string>
  <key>CFBundleExecutable</key>       <string>PhoneMacBridge</string>
  <key>CFBundleIconFile</key>         <string>AppIcon</string>
  <key>CFBundlePackageType</key>      <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key>   <string>12.0</string>
  <key>LSUIElement</key>              <false/>
  <key>NSHighResolutionCapable</key>  <true/>
  <key>NSHumanReadableCopyright</key> <string>Local tooling · MIT</string>
</dict>
</plist>
PLIST

echo "==> writing launcher"
cat > "$MACOS/PhoneMacBridge" <<'LAUNCHER'
#!/bin/bash
# Launcher for PhoneMacBridge.app.
# Idempotent: first run installs, later runs just re-open the console.
set -euo pipefail

APP_CONTENTS="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLED_BRIDGE="$APP_CONTENTS/Resources/bridge"
SUPPORT="$HOME/Library/Application Support/PhoneMacBridge"
LOG_DIR="$HOME/.phone-mac-bridge"
INSTALL_LOG="$LOG_DIR/install.log"
PLIST="$HOME/Library/LaunchAgents/com.local.phone-mac-bridge.plist"
PORT=7420

mkdir -p "$SUPPORT" "$LOG_DIR"

# Find node (Finder/Launchpad launches with a minimal PATH)
NODE_BIN=""
for candidate in \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node" \
  "/usr/bin/node" \
  "$(command -v node 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  /usr/bin/osascript -e 'display dialog "未找到 Node.js。\n\n安装方法:打开「终端」运行\n\n    brew install node\n\n装好后再双击本 App。" with title "PhoneMacBridge" buttons {"好"} default button 1'
  exit 1
fi

# Sync bundled bridge into App Support (once, or when bundle is newer).
# NEED_SYNC also forces a launchd reload below — without that, the running
# node process keeps the *old* server.js loaded in memory even after the new
# files land on disk.
NEED_SYNC=1
if [ -f "$SUPPORT/VERSION" ] && [ -f "$BUNDLED_BRIDGE/VERSION" ]; then
  if [ "$(cat "$BUNDLED_BRIDGE/VERSION")" = "$(cat "$SUPPORT/VERSION")" ]; then
    NEED_SYNC=0
  fi
fi
if [ "$NEED_SYNC" = "1" ]; then
  /usr/bin/rsync -a --delete \
    --exclude 'node_modules' \
    "$BUNDLED_BRIDGE/" "$SUPPORT/"
fi

# First-time deps install
if [ ! -d "$SUPPORT/server/node_modules" ]; then
  /usr/bin/osascript -e 'display notification "正在安装依赖,大约 15 秒…" with title "PhoneMacBridge"'
  (
    cd "$SUPPORT"
    "$NODE_BIN" --version >/dev/null
    export PATH="$(dirname "$NODE_BIN"):$PATH"
    bash scripts/install.sh
  ) > "$INSTALL_LOG" 2>&1 || {
    /usr/bin/osascript -e "display dialog \"依赖安装失败。日志:\n$INSTALL_LOG\" with title \"PhoneMacBridge\" buttons {\"好\"} default button 1"
    exit 1
  }
fi

# Build desired plist content; only reload launchd if it changed.
NEW_PLIST="$(mktemp)"
cat > "$NEW_PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.phone-mac-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SUPPORT/server/server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>SHELL</key><string>${SHELL:-/bin/zsh}</string>
    <key>LANG</key><string>${LANG:-en_US.UTF-8}</string>
  </dict>
  <key>WorkingDirectory</key><string>$SUPPORT/server</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/bridge.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/bridge.err.log</string>
</dict>
</plist>
PL

# Reload launchd if: plist changed, agent isn't running, or the bridge code
# itself changed (NEED_SYNC=1). The third case is critical — node loads
# server.js into memory at start, so freshly-rsync'd files don't take effect
# until the process restarts.
NEED_RELOAD=0
if [ "$NEED_SYNC" = "1" ]; then NEED_RELOAD=1; fi
if [ ! -f "$PLIST" ] || ! /usr/bin/cmp -s "$NEW_PLIST" "$PLIST"; then NEED_RELOAD=1; fi
if ! /bin/launchctl list com.local.phone-mac-bridge >/dev/null 2>&1; then NEED_RELOAD=1; fi

if [ "$NEED_RELOAD" = "1" ]; then
  mv "$NEW_PLIST" "$PLIST"
  /bin/launchctl unload "$PLIST" 2>/dev/null || true
  /bin/launchctl load -w "$PLIST"
else
  rm -f "$NEW_PLIST"
fi

# Wait (max ~6s) for the server to come up
for _ in $(seq 1 30); do
  if /usr/bin/nc -z 127.0.0.1 "$PORT" 2>/dev/null; then break; fi
  sleep 0.2
done

# Open setup console in default browser
/usr/bin/open "http://127.0.0.1:$PORT/setup"
LAUNCHER
chmod +x "$MACOS/PhoneMacBridge"

echo "==> done: $APP"
echo
echo "Open it:  open \"$APP\""
echo "Install:  mv \"$APP\" /Applications/"
