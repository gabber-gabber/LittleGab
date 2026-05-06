#!/usr/bin/env node
// Smoke test for multi-session + API + replay.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require(path.resolve(__dirname, "..", "server", "node_modules", "ws"));

const token = fs.readFileSync(path.join(os.homedir(), ".phone-mac-bridge", "token"), "utf8").trim();
const BASE = "http://127.0.0.1:7420";

async function api(method, url, body) {
  const r = await fetch(`${BASE}${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

function openWs(sessionId) {
  const qs = new URLSearchParams({ token });
  if (sessionId) qs.set("session", sessionId);
  // leave default binaryType (nodebuffer) so data is Buffer
  return new WebSocket(`ws://127.0.0.1:7420/pty?${qs.toString()}`);
}

function toText(data) {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return String(data);
}

// Node's `ws` library passes binary-and-text messages as Buffer; the second
// arg `isBinary` distinguishes them.
function waitFor(stream, re, timeoutMs, onHit) {
  let buf = "";
  const onMsg = (data, isBinary) => {
    const text = toText(data);
    if (!isBinary) {
      // control frame (JSON) — ignore for output-matching
      try { JSON.parse(text); return; } catch {}
    }
    buf += text;
    if (re.test(buf)) { stream.off("message", onMsg); clearTimeout(t); onHit(buf); }
  };
  stream.on("message", onMsg);
  const t = setTimeout(() => {
    stream.off("message", onMsg);
    console.error("❌ timeout waiting for", re, "\nbuf tail:", buf.slice(-200));
    process.exit(1);
  }, timeoutMs);
}

function once(ws, type) {
  return new Promise((resolve) => {
    const h = (data, isBinary) => {
      if (isBinary) return;
      const text = toText(data);
      try {
        const m = JSON.parse(text);
        if (m.type === type) { ws.off("message", h); resolve(m); }
      } catch {}
    };
    ws.on("message", h);
  });
}

(async () => {
  console.log("[1] list sessions initially empty");
  let r = await api("GET", "/api/sessions");
  if (r.status !== 200 || !Array.isArray(r.data.sessions)) throw new Error("list failed: " + JSON.stringify(r));
  console.log("   sessions:", r.data.sessions.length);

  console.log("[2] create session via POST");
  r = await api("POST", "/api/sessions", { name: "测试会话1" });
  if (r.status !== 201 || !r.data.id) throw new Error("create failed: " + JSON.stringify(r));
  const s1 = r.data.id;
  console.log("   created id=" + s1 + " name=" + r.data.name);

  console.log("[3] attach ws to session, send a command, verify output");
  const ws = openWs(s1);
  await new Promise((ok) => ws.once("open", ok));
  const hello = await once(ws, "session");
  if (hello.id !== s1) throw new Error("session mismatch");
  ws.send(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
  ws.send("echo MARKER-$$\r");
  await new Promise((ok) => waitFor(ws, /MARKER-\d+[\r\n]/, 3000, ok));
  console.log("   output confirmed");

  console.log("[4] list shows session with non-empty preview");
  r = await api("GET", "/api/sessions");
  const me = r.data.sessions.find((s) => s.id === s1);
  if (!me) throw new Error("session missing from list");
  console.log("   preview:", JSON.stringify(me.preview));
  if (!me.preview) throw new Error("preview empty");

  console.log("[5] reattach a second client, should see replay");
  const ws2 = openWs(s1);
  await new Promise((ok) => ws2.once("open", ok));
  // Register waitFor BEFORE waiting for the session control msg, otherwise the
  // replay binary (arriving right after the session msg) lands in a window with
  // no handler attached.
  const replayDone = new Promise((ok) => waitFor(ws2, /MARKER-\d+/, 3000, ok));
  await once(ws2, "session");
  await replayDone;
  console.log("   replay contains MARKER");

  console.log("[6] both clients see new output in parallel");
  const p1 = new Promise((ok) => waitFor(ws,  /SYNC-OK/, 3000, ok));
  const p2 = new Promise((ok) => waitFor(ws2, /SYNC-OK/, 3000, ok));
  ws.send("echo SYNC-OK\r");
  await Promise.all([p1, p2]);
  console.log("   both got SYNC-OK");

  console.log("[7] rename session");
  r = await api("PATCH", "/api/sessions/" + s1, { name: "重命名后" });
  if (r.status !== 200 || r.data.name !== "重命名后") throw new Error("rename failed: " + JSON.stringify(r));

  console.log("[8] delete session, ws should close");
  const closed = new Promise((ok) => ws.once("close", (code) => ok(code)));
  r = await api("DELETE", "/api/sessions/" + s1);
  if (r.status !== 200 || !r.data.ok) throw new Error("delete failed: " + JSON.stringify(r));
  const code = await closed;
  console.log("   ws closed with code", code);

  console.log("[9] attaching with unknown session id is rejected (4404)");
  const wsX = openWs("nonexistent-xxxxxxxx");
  const code2 = await new Promise((ok) => wsX.once("close", (c) => ok(c)));
  if (code2 !== 4404) throw new Error("expected 4404, got " + code2);
  console.log("   got 4404 as expected");

  // Note: /api/sessions and /pty allow localhost without a token (for the setup page).
  // Remote-without-token rejection is verified in the Android connectivity tests.

  ws2.close();
  console.log("\n✅ all session-api smoke checks passed");
  process.exit(0);
})().catch((e) => { console.error("❌", e.stack || e.message); process.exit(1); });
