"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");
const { SessionManager, resolveCwd, TMUX_AVAILABLE, TMUX_SOCKET,
        normalizeProvider,
        notifications, recentNotifications,
        pushNotification } = require("./session-manager");
const { ensureClaudeHooksInstalled } = require("./claude-hooks-installer");

const PORT = parseInt(process.env.PORT || "7420", 10);
const HOST = process.env.HOST || "0.0.0.0";
const WEB_DIR = path.resolve(__dirname, "..", "web");
const TOKEN_FILE = path.join(os.homedir(), ".phone-mac-bridge", "token");
const SHELL = process.env.SHELL || "/bin/zsh";

function loadToken() {
  if (process.env.BRIDGE_TOKEN) return process.env.BRIDGE_TOKEN.trim();
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); }
  catch {
    console.error("[fatal] token not found. Run scripts/install.sh first, or set BRIDGE_TOKEN.");
    process.exit(1);
  }
}

const TOKEN = loadToken();
const manager = new SessionManager();

function safeEqual(a, b) {
  const ab = Buffer.from(a || "", "utf8");
  const bb = Buffer.from(b || "", "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isLocalhost(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function isAuthorized(req, url) {
  if (isLocalhost(req)) return true;
  const token = url.searchParams.get("token") || "";
  return safeEqual(token, TOKEN);
}

function sendJSON(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
     .end(JSON.stringify(body));
}

function readJSONBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(new Error("invalid json: " + e.message)); }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const full = path.normalize(path.join(WEB_DIR, rel));
  if (!full.startsWith(WEB_DIR)) { res.writeHead(403).end("forbidden"); return; }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("not found"); return; }
    const ext = path.extname(full).toLowerCase();
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
    };
    res.writeHead(200, headers);
    fs.createReadStream(full).pipe(res);
  });
}

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === "IPv4" && !i.internal && !i.address.startsWith("169.254.")) {
        return { iface: name, ip: i.address };
      }
    }
  }
  return null;
}

function runCmd(cmd, args, timeoutMs = 2500) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || "").toString(), stderr: (stderr || "").toString() });
    });
  });
}

function resolveAgentBinary(name) {
  const candidates = [
    path.join(os.homedir(), ".local", "bin", name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

async function tailscaleInfo() {
  const candidates = [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ];
  let ts = null;
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); ts = p; break; } catch {}
  }
  if (!ts) return { installed: false };
  const r = await runCmd(ts, ["status", "--json"]);
  if (!r.ok) return { installed: true, loggedIn: false };
  try {
    const j = JSON.parse(r.stdout);
    const self = j.Self || {};
    const ip = (self.TailscaleIPs || []).find((x) => /^\d+\./.test(x)) || null;
    const name = self.DNSName ? self.DNSName.replace(/\.$/, "") : null;
    return {
      installed: true,
      loggedIn: j.BackendState === "Running",
      backendState: j.BackendState,
      ip, hostname: name,
      magicDNS: !!(j.MagicDNSSuffix || j.CurrentTailnet?.MagicDNSEnabled),
    };
  } catch { return { installed: true, loggedIn: false }; }
}

async function handleOpenMacTerminal(req, res, url, sessionId) {
  if (!isAuthorized(req, url)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
  if (req.method !== "POST") { sendJSON(res, 405, { error: "method not allowed" }); return; }
  const s = manager.get(sessionId);
  if (!s) { sendJSON(res, 404, { error: "no such session" }); return; }
  if (!s.tmuxName) {
    sendJSON(res, 400, { error: "tmux not available; install tmux to enable Mac sync" });
    return;
  }
  // AppleScript: open Terminal.app and run the attach command in a new tab.
  const attachCmd = `tmux -L ${TMUX_SOCKET} attach -t ${s.tmuxName}`;
  const osa = `tell application "Terminal"
  activate
  do script "${attachCmd.replace(/"/g, '\\"')}"
end tell`;
  const r = await runCmd("/usr/bin/osascript", ["-e", osa]);
  if (!r.ok) { sendJSON(res, 500, { error: "osascript failed", stderr: r.stderr }); return; }
  sendJSON(res, 200, { ok: true, macAttachCommand: attachCmd });
}

async function handleSessionsApi(req, res, url) {
  if (!isAuthorized(req, url)) { sendJSON(res, 401, { error: "unauthorized" }); return; }

  // Nested action: POST /api/sessions/<id>/open-mac-terminal
  const actionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([^/]+)\/?$/);
  if (actionMatch) {
    const [, id, action] = actionMatch;
    if (action === "open-mac-terminal") return handleOpenMacTerminal(req, res, url, id);
    sendJSON(res, 404, { error: "unknown action" });
    return;
  }

  const match = url.pathname.match(/^\/api\/sessions\/?([^/]+)?$/);
  if (!match) { sendJSON(res, 404, { error: "not found" }); return; }
  const id = match[1];

  try {
    if (req.method === "GET" && !id) {
      const requestedProvider = (url.searchParams.get("provider") || "").trim().toLowerCase();
      const provider = ["claude", "codex"].includes(requestedProvider) ? requestedProvider : "";
      let sessions = manager.list();
      if (provider) sessions = sessions.filter((s) => normalizeProvider(s.provider) === provider);
      sendJSON(res, 200, { sessions });
      return;
    }
    if (req.method === "GET" && id) {
      const s = manager.get(id);
      if (!s) { sendJSON(res, 404, { error: "no such session" }); return; }
      sendJSON(res, 200, s.describe());
      return;
    }
    if (req.method === "POST" && !id) {
      const body = await readJSONBody(req);
      const s = manager.create({
        name: body.name,
        provider: body.provider,
        cwd: body.cwd,
        autorun: body.autorun,
        cols: body.cols, rows: body.rows,
      });
      console.log(`[session] created ${s.id} (${s.name}) provider=${s.provider} cwd=${s.cwd} autorun=${JSON.stringify(s.autorun)}`);
      sendJSON(res, 201, s.describe());
      return;
    }
    if (req.method === "PATCH" && id) {
      const body = await readJSONBody(req);
      const d = manager.rename(id, body.name);
      if (!d) { sendJSON(res, 404, { error: "no such session" }); return; }
      sendJSON(res, 200, d);
      return;
    }
    if (req.method === "DELETE" && id) {
      const ok = manager.delete(id);
      console.log(`[session] deleted ${id} (ok=${ok})`);
      sendJSON(res, ok ? 200 : 404, { ok });
      return;
    }
    sendJSON(res, 405, { error: "method not allowed" });
  } catch (e) {
    sendJSON(res, 400, { error: e.message });
  }
}

// ----- filesystem APIs --------------------------------------------------

const MAX_READ_BYTES = 5 * 1024 * 1024;   // 5 MB cap on /api/fs/read
const MAX_WRITE_BYTES = 2 * 1024 * 1024;  // 2 MB cap on /api/fs/write
const MAX_LIST_ENTRIES = 1000;

const EXT_MIME = {
  // text / code
  "txt": "text/plain", "md": "text/markdown", "markdown": "text/markdown",
  "js": "application/javascript", "mjs": "application/javascript", "cjs": "application/javascript",
  "ts": "application/typescript", "tsx": "application/typescript",
  "jsx": "application/javascript",
  "json": "application/json", "jsonc": "application/json",
  "html": "text/html", "htm": "text/html",
  "css": "text/css", "scss": "text/plain", "less": "text/plain",
  "xml": "application/xml", "yaml": "text/yaml", "yml": "text/yaml", "toml": "text/plain",
  "sh": "text/x-shellscript", "bash": "text/x-shellscript", "zsh": "text/x-shellscript",
  "py": "text/x-python", "rb": "text/x-ruby", "go": "text/x-go", "rs": "text/x-rust",
  "c": "text/x-c", "h": "text/x-c", "cpp": "text/x-c++", "hpp": "text/x-c++",
  "java": "text/x-java", "kt": "text/x-kotlin", "kts": "text/x-kotlin",
  "swift": "text/x-swift", "m": "text/x-objc", "mm": "text/x-objc++",
  "sql": "text/x-sql", "ini": "text/plain", "cfg": "text/plain", "conf": "text/plain",
  "env": "text/plain", "gitignore": "text/plain", "dockerfile": "text/plain",
  "lock": "text/plain", "log": "text/plain",
  // images
  "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
  "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp", "svg": "image/svg+xml",
  "heic": "image/heic", "avif": "image/avif",
  // docs / binary
  "pdf": "application/pdf",
  "zip": "application/zip", "tar": "application/x-tar", "gz": "application/gzip",
};

function classifyByExt(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  const mime = EXT_MIME[ext] || "application/octet-stream";
  let kind = "binary";
  if (mime.startsWith("text/") || mime.includes("javascript") || mime.includes("typescript") ||
      mime === "application/json" || mime === "application/xml") kind = "text";
  else if (mime.startsWith("image/")) kind = "image";
  else if (mime === "application/pdf") kind = "pdf";
  return { ext, mime, kind };
}

function entryDescribe(dir, name) {
  try {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    const isSymlink = st.isSymbolicLink();
    let real = st;
    if (isSymlink) { try { real = fs.statSync(full); } catch {} }
    const isDir = real.isDirectory();
    const { ext, mime, kind } = isDir ? { ext: "", mime: "", kind: "dir" } : classifyByExt(name);
    return {
      name, isDir, isSymlink,
      size: isDir ? 0 : real.size,
      mtime: Math.floor(real.mtimeMs),
      ext, mime, kind,
    };
  } catch (e) {
    return { name, isDir: false, error: e.code || e.message };
  }
}

function listDir(dir, { showHidden = false } = {}) {
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { const err = new Error(`${e.code || "ENOENT"}: ${dir}`); err.status = e.code === "EACCES" ? 403 : 404; throw err; }

  let entries = names;
  if (!showHidden) entries = entries.filter((n) => !n.startsWith("."));
  entries.sort((a, b) => a.localeCompare(b));
  const truncated = entries.length > MAX_LIST_ENTRIES;
  if (truncated) entries = entries.slice(0, MAX_LIST_ENTRIES);

  const items = entries.map((n) => entryDescribe(dir, n));
  // directories first
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries: items, truncated };
}

async function handleBrowseApi(req, res, url) {
  if (!isAuthorized(req, url)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
  if (req.method !== "GET") { sendJSON(res, 405, { error: "method not allowed" }); return; }
  const showHidden = url.searchParams.get("hidden") === "1";
  const raw = url.searchParams.get("path") || "";
  let dir = resolveCwd(raw);  // returns homedir on invalid, a valid absolute dir on success
  try {
    const { entries, truncated } = listDir(dir, { showHidden });
    const parent = path.dirname(dir);
    sendJSON(res, 200, {
      path: dir,
      parent: parent === dir ? null : parent,
      home: os.homedir(),
      entries, truncated,
    });
  } catch (e) {
    sendJSON(res, e.status || 500, { error: e.message });
  }
}

// Resolve a user-supplied relative path against a session's cwd, rejecting any
// attempt to escape via ".." or symlinks. Returns the absolute resolved path.
function resolveInsideSession(sessionCwd, relPath, mustExist = true) {
  const base = fs.realpathSync(sessionCwd);
  const joined = path.resolve(base, relPath || ".");
  let real;
  try { real = fs.realpathSync(joined); }
  catch (e) {
    if (mustExist) { const err = new Error(e.code || "ENOENT"); err.status = 404; throw err; }
    // For writes: require the parent dir to exist and resolve safely, then
    // append the basename back on.
    const parentReal = fs.realpathSync(path.dirname(joined));
    if (parentReal !== base && !parentReal.startsWith(base + path.sep)) {
      const err = new Error("path escapes session cwd"); err.status = 403; throw err;
    }
    return path.join(parentReal, path.basename(joined));
  }
  if (real !== base && !real.startsWith(base + path.sep)) {
    const err = new Error("path escapes session cwd"); err.status = 403; throw err;
  }
  return real;
}

async function handleFsApi(req, res, url) {
  if (!isAuthorized(req, url)) { sendJSON(res, 401, { error: "unauthorized" }); return; }

  const sub = url.pathname.slice("/api/fs/".length); // list | read | write
  const sessionId = url.searchParams.get("session") || "";
  const relPath = url.searchParams.get("path") || "";
  const session = sessionId ? manager.get(sessionId) : null;
  if (!session) { sendJSON(res, 404, { error: "no such session" }); return; }

  try {
    if (sub === "list" && req.method === "GET") {
      const showHidden = url.searchParams.get("hidden") === "1";
      const dir = resolveInsideSession(session.cwd, relPath, true);
      if (!fs.statSync(dir).isDirectory()) { sendJSON(res, 400, { error: "not a directory" }); return; }
      const { entries, truncated } = listDir(dir, { showHidden });
      const relDir = path.relative(session.cwd, dir) || ".";
      sendJSON(res, 200, { cwd: session.cwd, path: relDir, absPath: dir, entries, truncated });
      return;
    }

    if (sub === "read" && req.method === "GET") {
      const file = resolveInsideSession(session.cwd, relPath, true);
      const st = fs.statSync(file);
      if (st.isDirectory()) { sendJSON(res, 400, { error: "is a directory" }); return; }
      if (st.size > MAX_READ_BYTES) {
        sendJSON(res, 413, { error: `file too large (${st.size} > ${MAX_READ_BYTES})` });
        return;
      }
      const { mime, kind } = classifyByExt(path.basename(file));
      res.writeHead(200, {
        "Content-Type": kind === "text" ? (mime + "; charset=utf-8") : mime,
        "Content-Length": String(st.size),
        "X-File-Kind": kind,
        "X-File-Size": String(st.size),
        "X-File-Mtime": String(Math.floor(st.mtimeMs)),
        "Cache-Control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (sub === "write" && req.method === "PUT") {
      const file = resolveInsideSession(session.cwd, relPath, false);
      const { kind } = classifyByExt(path.basename(file));
      if (kind !== "text") { sendJSON(res, 415, { error: "only text files are editable via this API" }); return; }

      const chunks = [];
      let size = 0;
      await new Promise((resolve, reject) => {
        req.on("data", (c) => {
          size += c.length;
          if (size > MAX_WRITE_BYTES) { req.destroy(); reject(new Error("body too large")); return; }
          chunks.push(c);
        });
        req.on("end", resolve);
        req.on("error", reject);
      });
      const body = Buffer.concat(chunks);
      fs.writeFileSync(file, body);
      const st = fs.statSync(file);
      sendJSON(res, 200, { ok: true, size: st.size, mtime: Math.floor(st.mtimeMs) });
      return;
    }

    if (sub === "mkdir" && req.method === "POST") {
      const target = resolveInsideSession(session.cwd, relPath, false);
      fs.mkdirSync(target, { recursive: true });
      sendJSON(res, 201, { ok: true, path: path.relative(session.cwd, target) });
      return;
    }

    if (sub === "touch" && req.method === "POST") {
      // Create an empty file if it doesn't exist. Refuses overwrite.
      const target = resolveInsideSession(session.cwd, relPath, false);
      if (fs.existsSync(target)) { sendJSON(res, 409, { error: "already exists" }); return; }
      fs.writeFileSync(target, "", { flag: "wx" });
      const st = fs.statSync(target);
      sendJSON(res, 201, { ok: true, path: path.relative(session.cwd, target), size: st.size });
      return;
    }

    if (sub === "delete" && req.method === "DELETE") {
      const target = resolveInsideSession(session.cwd, relPath, true);
      if (target === fs.realpathSync(session.cwd)) {
        sendJSON(res, 400, { error: "cannot delete session cwd itself" }); return;
      }
      const st = fs.statSync(target);
      const recursive = url.searchParams.get("recursive") === "1";
      if (st.isDirectory()) {
        const entries = fs.readdirSync(target);
        if (entries.length > 0 && !recursive) {
          sendJSON(res, 400, { error: "directory not empty; pass recursive=1 to delete" });
          return;
        }
        fs.rmSync(target, { recursive: true, force: false });
      } else {
        fs.unlinkSync(target);
      }
      sendJSON(res, 200, { ok: true });
      return;
    }

    sendJSON(res, 405, { error: "method not allowed" });
  } catch (e) {
    sendJSON(res, e.status || 500, { error: e.message });
  }
}

// ----- Claude CLI history -----------------------------------------------
// Scans ~/.claude/projects/*/*.jsonl and surfaces each session's first user
// prompt + cwd + stats so the phone can resume an old conversation.

const CLAUDE_HOME = path.join(os.homedir(), ".claude", "projects");
const CLAUDE_MAX_SCAN_LINES = 40;    // first user prompt usually within first few lines
const CLAUDE_MAX_FILE_SIZE  = 50 * 1024 * 1024; // skip pathological files
const CODEX_HOME = path.join(os.homedir(), ".codex");
const CODEX_SESSIONS_HOME = path.join(CODEX_HOME, "sessions");
const CODEX_INDEX_FILE = path.join(CODEX_HOME, "session_index.jsonl");
const CODEX_MAX_SCAN_LINES = 120;
const CODEX_MAX_FILE_SIZE = 50 * 1024 * 1024;

function extractTextContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Claude messages are arrays of {type:"text", text:"..."} or tool-use blocks
    return content.map((c) => {
      if (!c) return "";
      if (typeof c === "string") return c;
      if (c.type === "text" && typeof c.text === "string") return c.text;
      return "";
    }).filter(Boolean).join(" ");
  }
  return "";
}

function compactPrompt(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function cleanCodexPrompt(text) {
  let t = String(text || "");
  const marker = "## My request for Codex:";
  const idx = t.indexOf(marker);
  if (idx >= 0) t = t.slice(idx + marker.length);
  t = t.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, " ");
  return compactPrompt(t);
}

function isInternalCodexPrompt(text) {
  return text.startsWith("The following is the Codex agent history");
}

function scanClaudeSessionFile(filePath) {
  let st; try { st = fs.statSync(filePath); } catch { return null; }
  if (st.size > CLAUDE_MAX_FILE_SIZE) return null;
  const id = path.basename(filePath, ".jsonl");
  let cwd = "", firstPrompt = "", messageCount = 0, gitBranch = "";
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n");
    let scanned = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (scanned < CLAUDE_MAX_SCAN_LINES) {
        scanned++;
        try {
          const o = JSON.parse(line);
          if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
          if (!gitBranch && typeof o.gitBranch === "string") gitBranch = o.gitBranch;
          if (!firstPrompt && o.type === "user" && o.message) {
            const t = extractTextContent(o.message.content);
            if (t) firstPrompt = compactPrompt(t);
          }
        } catch {}
      }
      // cheap: count every non-empty line as a "message" upper bound
      messageCount++;
    }
  } catch {}
  return {
    id,
    provider: "claude",
    cwd, gitBranch,
    firstPrompt,
    messageCount,
    lastModified: Math.floor(st.mtimeMs),
    size: st.size,
  };
}

function readCodexIndex() {
  const out = new Map();
  try {
    const raw = fs.readFileSync(CODEX_INDEX_FILE, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.id) out.set(String(o.id), {
          threadName: String(o.thread_name || ""),
          updatedAt: String(o.updated_at || ""),
        });
      } catch {}
    }
  } catch {}
  return out;
}

function walkJsonlFiles(root, limit = 5000) {
  const files = [];
  const walk = (dir) => {
    if (files.length >= limit) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (files.length >= limit) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

function codexIdFromPath(filePath) {
  const base = path.basename(filePath, ".jsonl");
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1] : base;
}

function extractCodexUserText(payload) {
  if (!payload) return "";
  if (payload.type === "user_message" && typeof payload.message === "string") return payload.message;
  if (payload.type === "message" && payload.role === "user") return extractTextContent(payload.content);
  if (payload.role === "user") return extractTextContent(payload.content);
  return "";
}

function scanCodexSessionFile(filePath, index) {
  let st; try { st = fs.statSync(filePath); } catch { return null; }
  if (st.size > CODEX_MAX_FILE_SIZE) return null;
  let id = codexIdFromPath(filePath);
  let cwd = "", firstPrompt = "", messageCount = 0;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const lines = raw.split("\n");
    let scanned = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      messageCount++;
      if (scanned >= CODEX_MAX_SCAN_LINES && firstPrompt && cwd) continue;
      scanned++;
      try {
        const o = JSON.parse(line);
        if (o.type === "session_meta" && o.payload) {
          if (o.payload.id) id = String(o.payload.id);
          if (!cwd && typeof o.payload.cwd === "string") cwd = o.payload.cwd;
          continue;
        }
        const payload = o.payload || {};
        if (!firstPrompt && (o.type === "event_msg" || o.type === "response_item")) {
          const t = cleanCodexPrompt(extractCodexUserText(payload));
          if (t && !isInternalCodexPrompt(t)) firstPrompt = t;
        }
      } catch {}
    }
  } catch {}

  const indexed = index.get(id) || {};
  const updatedAtMs = Date.parse(indexed.updatedAt || "");
  const threadName = indexed.threadName || "";
  if (!firstPrompt && !threadName) return null;
  const lastModified = Math.floor(Math.max(st.mtimeMs, Number.isFinite(updatedAtMs) ? updatedAtMs : 0));
  return {
    id,
    provider: "codex",
    cwd,
    gitBranch: "",
    firstPrompt: firstPrompt || compactPrompt(threadName),
    threadName,
    messageCount,
    lastModified,
    size: st.size,
  };
}

async function handleNotificationsApi(req, res, url) {
  if (!isAuthorized(req, url)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
  if (req.method !== "GET") { sendJSON(res, 405, { error: "method not allowed" }); return; }
  const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
  const out = recentNotifications.filter((n) => n.at > since);
  sendJSON(res, 200, { notifications: out, now: Date.now() });
}

// Real notification ingestion — Claude Code hooks (Stop / Notification) call
// this when a turn completes or Claude needs the user. Same effect as
// session-manager's PTY-output detection, but works for ANY Claude Code
// session on the Mac, not just ones the phone has opened.
async function handleEventApi(req, res, url) {
  if (!isAuthorized(req, url)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
  if (req.method !== "POST") { sendJSON(res, 405, { error: "method not allowed" }); return; }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString("utf8");
    if (raw.length > 64 * 1024) { sendJSON(res, 413, { error: "payload too large" }); return; }
  }
  let body = {};
  try { body = JSON.parse(raw || "{}"); } catch (e) {
    sendJSON(res, 400, { error: "invalid json", detail: e.message }); return;
  }
  const kind = (body.kind || "done").toString().toLowerCase() === "confirm" ? "confirm" : "done";
  const sessionId = (body.sessionId || "claude").toString().slice(0, 80);
  const sessionName = (body.sessionName || "").toString().slice(0, 120);
  const snippet = (body.snippet || "").toString().slice(0, 300);

  const note = {
    id: crypto.randomBytes(6).toString("base64url"),
    sessionId,
    sessionName,
    provider: normalizeProvider(body.provider || "claude"),
    kind,
    at: Date.now(),
    snippet,
    source: (body.source || "api").toString().slice(0, 32),
  };
  pushNotification(note);
  console.log(`[event] kind=${kind} session=${sessionId} src=${note.source}`);
  sendJSON(res, 200, { ok: true, posted: note });
}

// Diagnostic endpoint: synthesise a notification end-to-end without waiting
// for a real `claude` task to ask y/n or go idle. Hit this from the phone
// (or curl) when verifying that NotifyService → tray is wired up.
async function handleNotifyTestApi(req, res, url) {
  if (!isAuthorized(req, url)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
  if (req.method !== "POST" && req.method !== "GET") {
    sendJSON(res, 405, { error: "method not allowed" }); return;
  }
  const kind = (url.searchParams.get("kind") || "confirm").toLowerCase();
  const note = {
    id: crypto.randomBytes(6).toString("base64url"),
    sessionId: "test",
    sessionName: "测试会话",
    provider: "claude",
    kind: kind === "done" ? "done" : "confirm",
    at: Date.now(),
    snippet: kind === "done" ? "测试:任务完成事件" : "测试:需要你确认 y/n",
  };
  pushNotification(note);
  console.log(`[notify] test event injected (kind=${note.kind}) id=${note.id}`);
  sendJSON(res, 200, { ok: true, posted: note });
}

async function handleClaudeSessionsApi(req, res, url) {
  if (!isAuthorized(req, url)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
  if (req.method !== "GET") { sendJSON(res, 405, { error: "method not allowed" }); return; }
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);

  if (!fs.existsSync(CLAUDE_HOME)) { sendJSON(res, 200, { sessions: [], claudeHome: CLAUDE_HOME, warning: "no ~/.claude/projects" }); return; }

  const sessions = [];
  try {
    const projectDirs = fs.readdirSync(CLAUDE_HOME);
    for (const pd of projectDirs) {
      const full = path.join(CLAUDE_HOME, pd);
      let isDir; try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      let files; try { files = fs.readdirSync(full); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const info = scanClaudeSessionFile(path.join(full, f));
        if (info) {
          info.projectDir = pd;
          sessions.push(info);
        }
      }
    }
  } catch (e) {
    sendJSON(res, 500, { error: e.message }); return;
  }

  // newest first
  sessions.sort((a, b) => b.lastModified - a.lastModified);

  let filtered = sessions;
  if (q) {
    filtered = sessions.filter((s) =>
      s.firstPrompt.toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      (s.gitBranch || "").toLowerCase().includes(q)
    );
  }
  const truncated = filtered.length > limit;
  if (truncated) filtered = filtered.slice(0, limit);

  sendJSON(res, 200, {
    sessions: filtered,
    totalCount: sessions.length,
    filteredCount: filtered.length,
    truncated,
    claudeHome: CLAUDE_HOME,
    query: q,
  });
}

async function handleCodexSessionsApi(req, res, url) {
  if (!isAuthorized(req, url)) { sendJSON(res, 401, { error: "unauthorized" }); return; }
  if (req.method !== "GET") { sendJSON(res, 405, { error: "method not allowed" }); return; }
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);

  if (!fs.existsSync(CODEX_SESSIONS_HOME)) {
    sendJSON(res, 200, {
      sessions: [],
      codexHome: CODEX_HOME,
      warning: "no ~/.codex/sessions",
    });
    return;
  }

  const sessions = [];
  try {
    const index = readCodexIndex();
    for (const file of walkJsonlFiles(CODEX_SESSIONS_HOME)) {
      const info = scanCodexSessionFile(file, index);
      if (info) {
        info.projectDir = path.relative(CODEX_SESSIONS_HOME, path.dirname(file));
        sessions.push(info);
      }
    }
  } catch (e) {
    sendJSON(res, 500, { error: e.message }); return;
  }

  sessions.sort((a, b) => b.lastModified - a.lastModified);

  let filtered = sessions;
  if (q) {
    filtered = sessions.filter((s) =>
      s.firstPrompt.toLowerCase().includes(q) ||
      (s.threadName || "").toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      (s.projectDir || "").toLowerCase().includes(q)
    );
  }
  const truncated = filtered.length > limit;
  if (truncated) filtered = filtered.slice(0, limit);

  sendJSON(res, 200, {
    sessions: filtered,
    totalCount: sessions.length,
    filteredCount: filtered.length,
    truncated,
    codexHome: CODEX_HOME,
    query: q,
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (url.pathname === "/api/info") {
    if (!isLocalhost(req)) { sendJSON(res, 403, { error: "localhost only" }); return; }
    const ts = await tailscaleInfo();
    sendJSON(res, 200, {
      port: PORT, host: HOST, token: TOKEN,
      lan: getLanIp(), tailscale: ts,
      shell: SHELL,
      agents: {
        claude: { available: !!resolveAgentBinary("claude"), path: resolveAgentBinary("claude") },
        codex: { available: !!resolveAgentBinary("codex"), path: resolveAgentBinary("codex") },
      },
      tmuxAvailable: TMUX_AVAILABLE, tmuxSocket: TMUX_AVAILABLE ? TMUX_SOCKET : null,
      hostname: os.hostname(), platform: `${os.platform()} ${os.arch()}`,
    });
    return;
  }
  if (url.pathname.startsWith("/api/sessions")) {
    await handleSessionsApi(req, res, url);
    return;
  }
  if (url.pathname === "/api/browse") {
    await handleBrowseApi(req, res, url);
    return;
  }
  if (url.pathname.startsWith("/api/fs/")) {
    await handleFsApi(req, res, url);
    return;
  }
  if (url.pathname === "/api/claude/sessions") {
    await handleClaudeSessionsApi(req, res, url);
    return;
  }
  if (url.pathname === "/api/codex/sessions") {
    await handleCodexSessionsApi(req, res, url);
    return;
  }
  if (url.pathname === "/api/notifications") {
    await handleNotificationsApi(req, res, url);
    return;
  }
  if (url.pathname === "/api/notify-test") {
    await handleNotifyTestApi(req, res, url);
    return;
  }
  if (url.pathname === "/api/event") {
    await handleEventApi(req, res, url);
    return;
  }
  if (url.pathname === "/setup" || url.pathname === "/setup/") {
    if (!isLocalhost(req)) { res.writeHead(302, { Location: "/" }).end(); return; }
    req.url = "/setup.html";
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });
const notifyWss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token") || "";

  if (url.pathname === "/pty") {
    if (!safeEqual(token, TOKEN)) {
      console.warn(`[auth] reject ws from ${req.socket.remoteAddress} (bad token)`);
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get("session") || "";
    wss.handleUpgrade(req, socket, head, (ws) => { attachWs(ws, req, sessionId); });
    return;
  }

  if (url.pathname === "/notify") {
    if (!safeEqual(token, TOKEN)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;
    notifyWss.handleUpgrade(req, socket, head, (ws) => { attachNotifyWs(ws, req, since); });
    return;
  }

  socket.destroy();
});

// Per-client forwarder: replay recent notifications (so the phone doesn't miss
// events that fired while the service was reconnecting), then subscribe to
// live ones for as long as the socket is open.
function attachNotifyWs(ws, req, since) {
  const peer = req.socket.remoteAddress;
  console.log(`[notify] ${peer} subscribed (since=${since})`);

  for (const n of recentNotifications) {
    if (n.at > since) {
      try { ws.send(JSON.stringify(n)); } catch {}
    }
  }

  const onNotify = (n) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(n)); } catch {}
  };
  notifications.on("notify", onNotify);

  // Application-level ping so NAT / mobile radios don't silently drop the
  // idle socket. 25s < most carrier NAT timeouts (~60s).
  const iv = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.ping(); } catch {}
  }, 25_000);

  // Phone NotifyService sends back an ack JSON every time it tries to display
  // a notification. status="ok" means it landed in the tray, anything else
  // (e.g. "blocked:post_notifications_denied", "blocked:event_channel_off")
  // points right at the OS-level reason notifications aren't showing — saves
  // having to plug in adb to debug.
  ws.on("message", (data) => {
    try {
      const txt = data.toString();
      if (txt.length > 1024) return;
      const j = JSON.parse(txt);
      if (j && j.ack) {
        console.log(`[notify] ack from ${peer} kind=${j.kind} status=${j.status}`);
      }
    } catch {}
  });

  const cleanup = () => {
    clearInterval(iv);
    notifications.off("notify", onNotify);
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

function attachWs(ws, req, requestedId) {
  const peer = req.socket.remoteAddress;
  // Try the in-memory map first, then ask the manager to reattach from tmux
  // if the session lived through a server restart.
  let session = requestedId ? manager.getOrReattach(requestedId) : null;

  if (requestedId && !session) {
    try { ws.send(JSON.stringify({ type: "error", reason: "no_such_session", id: requestedId })); } catch {}
    ws.close(4404, "session not found");
    return;
  }

  if (!session) {
    session = manager.create({});
    console.log(`[session] implicit-create ${session.id} for ${peer}`);
  }

  // Enforce latest-device-wins: if a Mac-native claude is currently holding
  // the same jsonl, SIGTERM it before we let the phone take over. Safe to
  // block briefly — the alternative is two claude processes fighting over
  // one file.
  const claim = manager.claimSessionForPhone(session.id);
  if (claim.killed.length) {
    ws.send(JSON.stringify({ type: "takeover", from: "mac", killed: claim.killed.map((k) => ({ pid: k.pid })) }));
  }

  console.log(`[conn] ${peer} attach ${session.id}`);
  ws.send(JSON.stringify({ type: "session", id: session.id, name: session.name, createdAt: session.createdAt, cols: session.cols, rows: session.rows }));
  session.replayTo(ws);
  session.attach(ws);

  ws.on("message", (data, isBinary) => {
    if (isBinary) { session.write(data); return; }
    const text = data.toString("utf8");
    if (text.length && text[0] === "{") {
      try {
        const msg = JSON.parse(text);
        if (msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          session.resize(msg.cols, msg.rows);
          return;
        }
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
          return;
        }
      } catch {}
    }
    session.write(text);
  });

  ws.on("close", () => {
    console.log(`[conn] ${peer} detach ${session.id}`);
    session.detach(ws);
  });
  ws.on("error", (e) => {
    console.log(`[conn] ${peer} ws error on ${session.id}: ${e.message}`);
    session.detach(ws);
  });
}

httpServer.listen(PORT, HOST, () => {
  console.log(`[ready] http://${HOST}:${PORT}  (shell=${SHELL})`);
  console.log(`[ready] token loaded`);
  // Idempotent: ensure Claude Code's hook config points at our bridge so any
  // claude session on this Mac (even ones opened outside the phone app)
  // pushes Stop / Notification events to /api/event automatically.
  try {
    const hookScript = path.resolve(__dirname, "claude-hook.js");
    ensureClaudeHooksInstalled(hookScript);
  } catch (e) {
    console.warn(`[hook-installer] failed: ${e.message}`);
  }
});

process.on("SIGINT", () => { console.log("\n[shutdown]"); process.exit(0); });
process.on("SIGTERM", () => process.exit(0));
