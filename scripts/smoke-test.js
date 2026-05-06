#!/usr/bin/env node
// End-to-end smoke test: connect WS, run a command, check output, resize.
"use strict";
const fs = require("fs");
const path = require("path");
const WebSocket = require(path.resolve(__dirname, "..", "server", "node_modules", "ws"));

const token = fs.readFileSync(require("os").homedir() + "/.phone-mac-bridge/token", "utf8").trim();
const url = `ws://127.0.0.1:7420/pty?token=${encodeURIComponent(token)}`;

const ws = new WebSocket(url);
// Leave default binaryType so Node delivers Buffer, not ArrayBuffer.

function toText(data) {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

let buf = "";
let step = 0;
const steps = [];

function pushStep(name, fn) { steps.push({ name, fn }); }
function runNext() {
  if (step >= steps.length) { console.log("\n✅ all smoke checks passed"); ws.close(); process.exit(0); }
  const s = steps[step++];
  console.log(`\n[${step}/${steps.length}] ${s.name}`);
  s.fn();
}

ws.on("open", () => {
  console.log("ws open");
  ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
  setTimeout(runNext, 300);
});

ws.on("message", (data, isBinary) => {
  const s = toText(data);
  if (!isBinary) {
    // JSON control messages — don't include them in output buffer.
    try { JSON.parse(s); return; } catch {}
  }
  buf += s;
  process.stdout.write(s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
});

function waitFor(re, ms, onHit) {
  const start = Date.now();
  const timer = setInterval(() => {
    if (re.test(buf)) { clearInterval(timer); onHit(); }
    else if (Date.now() - start > ms) { clearInterval(timer); console.error("❌ timeout waiting for", re); process.exit(1); }
  }, 50);
}

pushStep("echo hello via shell", () => {
  buf = "";
  ws.send("echo bridge-ok-$((2+3))\r");
  waitFor(/bridge-ok-5/, 3000, runNext);
});

pushStep("resize to 120x30, query with tput", () => {
  buf = "";
  ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 30 }));
  setTimeout(() => {
    ws.send("printf 'COLS=%d\\n' $(tput cols)\r");
    waitFor(/COLS=120/, 3000, runNext);
  }, 150);
});

pushStep("ctrl-c interrupts sleep", () => {
  // strategy: start sleep 30, press ^C, then echo a unique marker.
  // if marker appears within ~2s the sleep was interrupted.
  ws.send("sleep 30\r");
  setTimeout(() => {
    ws.send("\x03");
    setTimeout(() => {
      buf = "";
      ws.send("echo CTRLC-MARKER-$$\r");
      waitFor(/CTRLC-MARKER-\d+[\r\n]/, 2500, runNext);
    }, 200);
  }, 300);
});

pushStep("bad token is rejected", () => {
  const bad = new WebSocket(`ws://127.0.0.1:7420/pty?token=wrong`);
  bad.on("open", () => { console.error("❌ bad token accepted"); process.exit(1); });
  bad.on("unexpected-response", (_req, res) => {
    if (res.statusCode === 401) { console.log("  401 as expected"); runNext(); }
    else { console.error("❌ expected 401, got", res.statusCode); process.exit(1); }
  });
  bad.on("error", (e) => {
    if (/401/.test(e.message) || /Unexpected server response/.test(e.message)) runNext();
    else { console.error("❌ error:", e.message); process.exit(1); }
  });
});

ws.on("close", () => { /* ignore */ });
ws.on("error", (e) => { console.error("ws error:", e.message); process.exit(1); });

setTimeout(() => { console.error("❌ overall timeout"); process.exit(1); }, 20000);
