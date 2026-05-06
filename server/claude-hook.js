#!/usr/bin/env node
// Claude Code hook → bridge server bridge.
//
// Installed at the user's ~/.claude/settings.json by claude-hooks-installer.js.
// Claude invokes this with one argv ("stop" | "notification") and pipes the
// hook event payload (JSON) on stdin. We forward it to the local bridge
// server's /api/event, which then fans out to /notify subscribers (the
// phone's NotifyService).
//
// Must be fast and tolerant: Claude waits for hook exit before continuing.
// Any error → exit 0 silently so we never break the user's Claude session.

"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");

const KIND = (process.argv[2] || "done").toLowerCase();
const TOKEN_PATH = path.join(os.homedir(), ".phone-mac-bridge", "token");
const PORT = parseInt(process.env.PHONE_MAC_BRIDGE_PORT || "7420", 10);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; if (raw.length > 1024 * 1024) process.exit(0); });
process.stdin.on("end", () => {
  // Don't let stdin parsing failures kill Claude — fail soft everywhere.
  let payload = {};
  try { payload = JSON.parse(raw || "{}"); } catch {}
  let token = "";
  try { token = fs.readFileSync(TOKEN_PATH, "utf8").trim(); } catch {}
  if (!token) process.exit(0);

  const sessionId = payload.session_id || payload.sessionId || "";
  const transcript = payload.transcript_path || payload.transcriptPath || "";

  let snippet = "";
  let sessionName = "";
  if (transcript && fs.existsSync(transcript)) {
    try {
      const data = fs.readFileSync(transcript, "utf8");
      const lines = data.split("\n");
      // Walk backward to find the most recent assistant text and a session
      // title (ai-title or first user prompt) for nicer notification copy.
      for (let i = lines.length - 1; i >= 0 && i > lines.length - 80; i--) {
        const line = lines[i];
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (!snippet && obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
          for (const block of obj.message.content) {
            if (block.type === "text" && block.text) {
              snippet = block.text.replace(/\s+/g, " ").trim().slice(0, 220);
              break;
            }
          }
        }
        if (!sessionName && obj.type === "ai-title" && obj.aiTitle) sessionName = obj.aiTitle;
        if (snippet && sessionName) break;
      }
      // Fallback: first user prompt scanned forward.
      if (!sessionName) {
        for (let i = 0; i < Math.min(20, lines.length); i++) {
          let obj; try { obj = JSON.parse(lines[i]); } catch { continue; }
          if (obj.type === "user" && obj.message && obj.message.content) {
            const c = obj.message.content;
            const text = typeof c === "string" ? c : (Array.isArray(c) ? c.map((b) => b.text || "").join(" ") : "");
            if (text) { sessionName = text.replace(/\s+/g, " ").trim().slice(0, 60); break; }
          }
        }
      }
    } catch {}
  }

  const kindNorm = KIND === "notification" ? "confirm" : "done";
  const body = JSON.stringify({
    kind: kindNorm,
    sessionId: sessionId.slice(0, 80),
    sessionName,
    snippet,
    source: "claude-hook",
  });

  const req = http.request({
    hostname: "127.0.0.1",
    port: PORT,
    path: "/api/event?token=" + encodeURIComponent(token),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    timeout: 2500,
  }, (res) => { res.resume(); res.on("end", () => process.exit(0)); });
  req.on("error", () => process.exit(0));
  req.on("timeout", () => { try { req.destroy(); } catch {} process.exit(0); });
  req.write(body);
  req.end();
});

// Hard ceiling: even if everything hangs, don't keep Claude blocked.
setTimeout(() => process.exit(0), 3000).unref();
