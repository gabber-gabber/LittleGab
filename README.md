# LittleGab

LittleGab is a local phone-to-Mac bridge for controlling command-line coding agents from an Android phone.

The Mac side runs a Node.js server with PTY/WebSocket sessions. The Android app connects to it over a private network such as Tailscale, shows a terminal-style session UI, and can browse or edit files inside a session workspace.

## Layout

- `server/` - Mac bridge server, session manager, Claude hook integration.
- `web/` - xterm.js terminal UI loaded by the Android WebView.
- `android/` - native Android app source.
- `scripts/` - install, start, smoke test, and build scripts.
- `Demand.md` / `DemandDone.md` - pending and completed product notes.

## Build

```sh
bash scripts/install.sh
bash scripts/build-apk.sh
bash scripts/build-mac-app.sh
```

Generated artifacts are intentionally ignored by Git.
