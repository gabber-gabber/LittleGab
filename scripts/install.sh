#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$ROOT/server"
TOKEN_DIR="$HOME/.phone-mac-bridge"
TOKEN_FILE="$TOKEN_DIR/token"
PLIST="$HOME/Library/LaunchAgents/com.local.phone-mac-bridge.plist"
NODE_BIN="$(command -v node)"

if [[ -z "$NODE_BIN" ]]; then
  echo "error: node not found in PATH" >&2
  exit 1
fi

echo "==> installing npm deps in $SERVER_DIR"
cd "$SERVER_DIR"
npm install --no-audit --no-fund

# tmux enables the "Mac-terminal ↔ phone" sync feature. Server still works
# without it (falls back to a raw PTY), but we try to install it so users
# get the feature out of the box.
if ! command -v tmux >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "==> tmux not found, installing via Homebrew (needed for Mac/phone sync)"
    brew install tmux || echo "    warn: brew install tmux failed; sync feature will be unavailable"
  else
    echo "==> tmux not installed and Homebrew not present."
    echo "    Mac/phone terminal sync needs tmux. Install with:  brew install tmux"
  fi
fi

# node-pty's prebuilt spawn-helper ships without the exec bit on some npm versions.
# Fix it for whatever arch we actually run on.
for helper in node_modules/node-pty/prebuilds/*/spawn-helper; do
  [[ -f "$helper" ]] && chmod +x "$helper"
done

mkdir -p "$TOKEN_DIR"
if [[ ! -s "$TOKEN_FILE" ]]; then
  TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
  umask 077
  printf '%s\n' "$TOKEN" > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "==> generated token (saved to $TOKEN_FILE)"
else
  echo "==> reusing existing token in $TOKEN_FILE"
fi

cat <<EOF

==============================================================
  Installed.
  Token file : $TOKEN_FILE
  Token      : $(cat "$TOKEN_FILE")
==============================================================

To run in the foreground:
  $ROOT/scripts/start.sh

To install as a launchd agent (starts at login, restarts on crash):
  $ROOT/scripts/install.sh --launchd

EOF

if [[ "${1:-}" == "--launchd" ]]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.phone-mac-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SERVER_DIR/server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH</string>
    <key>SHELL</key><string>${SHELL:-/bin/zsh}</string>
    <key>LANG</key><string>${LANG:-en_US.UTF-8}</string>
  </dict>
  <key>WorkingDirectory</key><string>$SERVER_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$TOKEN_DIR/bridge.out.log</string>
  <key>StandardErrorPath</key><string>$TOKEN_DIR/bridge.err.log</string>
</dict>
</plist>
PL
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
  echo "==> launchd agent loaded: com.local.phone-mac-bridge"
  echo "    logs: $TOKEN_DIR/bridge.{out,err}.log"
  echo "    stop: launchctl unload \"$PLIST\""
fi
