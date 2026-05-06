"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { EventEmitter } = require("events");
const pty = require("node-pty");
const claudeScan = require("./claude-scan");

// ----- notification bus -------------------------------------------------
// Sessions watch their own PTY output for "task done" and "yes/no confirm"
// moments and push onto this bus. server.js exposes a WebSocket endpoint
// (/notify) the Android foreground service connects to so it can post OS-
// level notifications even while the app is in background.
const notifications = new EventEmitter();
const recentNotifications = [];
const MAX_RECENT = 100;
function pushNotification(note) {
  recentNotifications.push(note);
  if (recentNotifications.length > MAX_RECENT) recentNotifications.shift();
  notifications.emit("notify", note);
}

// Patterns that signal Claude CLI (or any CLI) asking the user to confirm an
// action. Kept conservative — false positives are worse than false negatives.
//
// We require BOTH a "Do you want…" (or equivalent) AND a "1. Yes / 2. No"
// scaffold within the same recent buffer, because Claude's actual approval
// menu always renders all three. Just an arrow `❯` near "Yes" is too loose —
// the user's own prose can match.
const CONFIRM_QUESTION_RE = /(Do you want to (proceed|continue|allow|run)|\(y\/n\)|\[y\/N\]|\[Y\/n\]|press\s+y\s+to\s+confirm)/i;
const CONFIRM_OPTIONS_RE = /1\.\s*Yes[\s\S]{0,80}2\.\s*No/;
const CONFIRM_DEDUP_MS = 30_000;

// "Task done" detection: fired once per request/response cycle.
// A cycle = user sent input → some output → output stopped for DONE_IDLE_MS.
// The threshold is tiny — with composer-based input the cycle is opened only
// when the user actually pressed Send, so even a short Claude reply ("ok.")
// is a legitimate completion. Filtering at 80 bytes still rejects pure cursor
// blinks / single-line redraws.
const DONE_IDLE_MS = 5_000;
const DONE_MIN_RESPONSE_BYTES = 80;
const NOTIFY_TEXT_BUF_MAX = 4000;

// Big fallback buffer (used when tmux isn't available). When tmux IS available
// we ignore this and replay the full tmux scrollback via capture-pane.
const BUFFER_LIMIT = 2 * 1024 * 1024; // 2 MB of raw bytes per session
const PREVIEW_TAIL = 2048;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()][0-9A-Za-z]|\x07/g;

// We back every session on a tmux session living in an isolated tmux server
// (its own socket, -L phonemac) so we don't pollute the user's own tmux
// config/state. Both the web PTY and a local Terminal.app can attach to the
// same tmux session, giving real-time bi-directional mirroring between phone
// and Mac. If tmux isn't installed, we fall back to a raw shell PTY.
const TMUX_SOCKET = "phonemac";
const TMUX_SESSION_PREFIX = "phonemac-";

let TMUX_BIN = null;
function resolveTmux() {
  // Launchd's PATH is minimal; check common install locations.
  for (const c of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  try {
    const out = execFileSync("/usr/bin/env", ["which", "tmux"], { encoding: "utf8" }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return null;
}
TMUX_BIN = resolveTmux();
const TMUX_AVAILABLE = !!TMUX_BIN;

function tmux(args, opts = {}) {
  return execFileSync(TMUX_BIN, ["-L", TMUX_SOCKET, ...args], { stdio: "ignore", ...opts });
}
function tmuxSafe(args) { try { tmux(args); return true; } catch { return false; } }

if (TMUX_AVAILABLE) {
  // Tmux config for the shared phone/Mac setup. Each option picked for a
  // specific reason — don't delete without understanding.
  //   status off:         phone screen is short, status bar wastes a row.
  //   default-terminal:   tmux-256color exposes all features (italics, true
  //                       color, mouse) to programs inside the pane.
  //   terminal-overrides *:RGB: advertise 24-bit color so Claude CLI emits
  //                       truecolor escapes for its code blocks.
  //   window-size smallest: lock to smallest attached client. Stops the
  //                       resize churn that was breaking Mac Terminal redraw.
  //                       Both clients always see the same grid → consistent.
  //   aggressive-resize:  resize *window* (not session) when a client
  //                       attaches so the visible grid matches immediately.
  //   escape-time 0:      no 500 ms delay before ESC reaches the app — key
  //                       to making /status / vim / fzf / etc feel snappy.
  //   history-limit 50000: deep scrollback so the full conversation stays
  //                       visible when phone reconnects.
  //   mouse on:           wheel scroll + click-to-focus-pane work everywhere.
  //   focus-events on:    editors inside tmux get focus in/out pings.
  tmuxSafe(["set-option", "-g", "status", "off"]);
  tmuxSafe(["set-option", "-g", "default-terminal", "tmux-256color"]);
  tmuxSafe(["set-option", "-ga", "terminal-overrides", ",xterm-256color:RGB,tmux-256color:RGB,*:RGB"]);
  tmuxSafe(["set-option", "-g", "window-size", "smallest"]);
  tmuxSafe(["set-option", "-g", "aggressive-resize", "on"]);
  tmuxSafe(["set-option", "-g", "escape-time", "0"]);
  tmuxSafe(["set-option", "-g", "history-limit", "50000"]);
  tmuxSafe(["set-option", "-g", "mouse", "on"]);
  tmuxSafe(["set-option", "-g", "focus-events", "on"]);
  console.log(`[tmux] using ${TMUX_BIN} (socket=${TMUX_SOCKET})`);
} else {
  console.log("[tmux] not found — Mac/phone sync disabled, falling back to raw PTY");
}

function now() { return Date.now(); }

function shortId() { return crypto.randomBytes(6).toString("base64url"); }

const AGENT_PROVIDERS = new Set(["claude", "codex"]);

function normalizeProvider(provider) {
  const p = String(provider || "").trim().toLowerCase();
  return AGENT_PROVIDERS.has(p) ? p : "claude";
}

function tokenizeAutorun(autorun) {
  return String(autorun || "").match(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|\S+/g) || [];
}

function commandName(word) {
  const unquoted = String(word || "").replace(/^["']|["']$/g, "");
  return path.basename(unquoted);
}

function inferProviderFromAutorun(autorun) {
  const cmd = commandName(tokenizeAutorun(autorun)[0] || "");
  return cmd === "codex" ? "codex" : "claude";
}

function agentLabel(provider) {
  return normalizeProvider(provider) === "codex" ? "Codex" : "Claude";
}

// Pull the session id out of resume autorun commands:
//   claude --resume abc-123
//   codex --no-alt-screen resume abc-123
function extractResumeId(autorun, provider = "claude") {
  if (!autorun) return null;
  provider = normalizeProvider(provider);
  if (provider === "claude") {
    const m = autorun.match(/--resume(?:=|\s+)([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }
  const words = tokenizeAutorun(autorun);
  if (commandName(words[0] || "") !== "codex") return null;
  const idx = words.findIndex((w) => w === "resume");
  if (idx < 0) return null;
  const optsWithValue = new Set([
    "-c", "--config", "-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval",
    "-C", "--cd", "-p", "--profile", "--remote", "--remote-auth-token-env",
    "-i", "--image", "--add-dir",
  ]);
  for (let i = idx + 1; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    if (w.startsWith("-")) {
      if (optsWithValue.has(w)) i++;
      continue;
    }
    return w.replace(/^["']|["']$/g, "");
  }
  return null;
}

// Poll ~/.claude/projects/*/*.jsonl for 30s after session start, picking up
// the newest file whose mtime is after the session's startAt. That file is
// the jsonl claude just created — its basename (minus .jsonl) is the id we
// need for takeover detection.
function discoverJsonlIdLater(session) {
  const CLAUDE_HOME = path.join(os.homedir(), ".claude", "projects");
  const startAt = Date.now();
  const deadline = startAt + 30_000;
  const tick = () => {
    if (session.claudeJsonlId || !session.alive) return;
    if (Date.now() > deadline) return;
    try {
      let newest = null;
      for (const proj of fs.readdirSync(CLAUDE_HOME)) {
        const pdir = path.join(CLAUDE_HOME, proj);
        let files;
        try { files = fs.readdirSync(pdir); } catch { continue; }
        for (const f of files) {
          if (!f.endsWith(".jsonl")) continue;
          const full = path.join(pdir, f);
          let st; try { st = fs.statSync(full); } catch { continue; }
          if (st.mtimeMs < startAt) continue;
          if (!newest || st.mtimeMs > newest.mtime) newest = { path: full, mtime: st.mtimeMs, id: f.slice(0, -6) };
        }
      }
      if (newest) {
        session.claudeJsonlId = newest.id;
        console.log(`[session] ${session.id} learned jsonl id ${newest.id}`);
        return;
      }
    } catch {}
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 2000); // give claude a moment to create the file
}

// Persist the metadata side of each session (name, cwd, autorun, createdAt).
// The tmux *server* already persists the actual PTY state + scrollback across
// our Node process lifetime, so on a server restart we recover full fidelity
// by joining tmux's live-sessions with this JSON. Without this, our in-memory
// Map would empty on restart, the phone would 4404, and reconnect would spawn
// a NEW tmux session leaving the Mac Terminal dangling on the old one — which
// is exactly what "sync seems broken" symptom looks like from the outside.
const PERSIST_DIR = path.join(os.homedir(), ".phone-mac-bridge");
const PERSIST_FILE = path.join(PERSIST_DIR, "sessions.json");

function loadPersisted() {
  try { return JSON.parse(fs.readFileSync(PERSIST_FILE, "utf8")); }
  catch { return {}; }
}
function savePersisted(obj) {
  try {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    const tmp = PERSIST_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, PERSIST_FILE);
  } catch (e) { console.warn(`[persist] save failed: ${e.message}`); }
}

function listLiveTmuxSessions() {
  if (!TMUX_AVAILABLE) return [];
  try {
    const out = execFileSync(TMUX_BIN, [
      "-L", TMUX_SOCKET,
      "list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_activity}\t#{session_attached}",
    ], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
    return out.trim().split("\n").filter(Boolean).map((line) => {
      const [name, created, activity, attached] = line.split("\t");
      return {
        name,
        createdAt: parseInt(created, 10) * 1000 || Date.now(),
        lastActivityAt: parseInt(activity, 10) * 1000 || Date.now(),
        attached: parseInt(attached, 10) || 0,
      };
    }).filter((s) => s.name.startsWith(TMUX_SESSION_PREFIX));
  } catch { return []; }
}

function resolveCwd(raw) {
  if (!raw) return os.homedir();
  let p = String(raw);
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  try { p = fs.realpathSync(p); } catch { return os.homedir(); }
  try { if (!fs.statSync(p).isDirectory()) return os.homedir(); } catch { return os.homedir(); }
  return p;
}

function buildCliPath() {
  const extras = [
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return [...extras, process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin"].join(":");
}

class Session {
  constructor(opts = {}) {
    this.id = opts.id || shortId();
    this.name = opts.name && opts.name.trim() ? opts.name.trim() : `会话 ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    this.createdAt = now();
    this.lastActivityAt = this.createdAt;
    this.cols = opts.cols || 80;
    this.rows = opts.rows || 24;
    this.cwd = resolveCwd(opts.cwd);
    this.autorun = (typeof opts.autorun === "string" && opts.autorun.trim()) ? opts.autorun.trim() : "";
    this.provider = normalizeProvider(opts.provider || inferProviderFromAutorun(this.autorun));
    this.shell = opts.shell || process.env.SHELL || "/bin/zsh";
    this.bufferChunks = [];     // Array<Buffer> of recent output
    this.bufferSize = 0;
    this.clients = new Set();   // attached WebSocket connections
    // If autorun was `claude --resume <id>` we remember that jsonl id so we
    // can detect "Mac opened the same conversation" later. If autorun is a
    // plain `claude`, the jsonl id is unknown until claude creates a file —
    // we'll set it lazily by watching `~/.claude/projects/*/<file>.jsonl`
    // that first appears with a recent mtime after this session starts.
    this.claudeJsonlId = this.provider === "claude"
      ? (opts.claudeJsonlId || extractResumeId(this.autorun, "claude") || null)
      : (opts.claudeJsonlId || null);
    this.codexSessionId = this.provider === "codex"
      ? (opts.codexSessionId || extractResumeId(this.autorun, "codex") || null)
      : (opts.codexSessionId || null);

    this.tmuxName = TMUX_AVAILABLE ? `${TMUX_SESSION_PREFIX}${this.id}` : null;
    const existedBefore = this.tmuxName && tmuxSafe(["has-session", "-t", this.tmuxName]);
    // Explicit override: manager sets this when rebuilding after a server
    // restart so we never re-inject autorun into a live shell.
    this.reattached = !!opts.reattach && existedBefore;
    if (this.reattached && typeof opts.createdAt === "number") this.createdAt = opts.createdAt;
    if (this.reattached && typeof opts.lastActivityAt === "number") this.lastActivityAt = opts.lastActivityAt;

    // TERM matches what tmux advertises inside the pane; COLORTERM tells
    // programs (Claude CLI, bat, eza, …) that 24-bit color is available so
    // their code blocks render with real syntax-highlight colors instead of
    // ANSI-16 approximations.
    const envBase = {
      ...process.env,
      TERM: TMUX_AVAILABLE ? "tmux-256color" : "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG || "en_US.UTF-8",
      PATH: buildCliPath(),
    };

    if (TMUX_AVAILABLE) {
      // Create (or attach to) a tmux session; tmux itself spawns the shell
      // inside. Both this PTY and any `tmux -L phonemac attach -t <name>`
      // from Mac Terminal will be clients of the same window.
      this.pty = pty.spawn(TMUX_BIN, [
        "-L", TMUX_SOCKET,
        "new-session", "-A",
        "-s", this.tmuxName,
        "-x", String(this.cols),
        "-y", String(this.rows),
        "-c", this.cwd,
      ], {
        name: "xterm-256color",
        cols: this.cols, rows: this.rows,
        cwd: this.cwd,
        env: envBase,
      });
    } else {
      this.pty = pty.spawn(this.shell, ["-l"], {
        name: "xterm-256color",
        cols: this.cols, rows: this.rows,
        cwd: this.cwd,
        env: envBase,
      });
    }

    // If autorun doesn't declare a resume id, watch ~/.claude/projects for a
    // newly-written jsonl and learn the id lazily. This lets takeover
    // detection work for sessions started with plain `claude`.
    if (this.provider === "claude" && !this.claudeJsonlId && this.autorun && /\bclaude\b/.test(this.autorun) && !this.reattached) {
      discoverJsonlIdLater(this);
    }

    if (this.autorun && !existedBefore && !this.reattached) {
      // Let the shell finish printing its prompt before we feed a command in.
      // Slightly longer under tmux — tmux itself draws an initial screen first.
      const delay = TMUX_AVAILABLE ? 800 : 500;
      setTimeout(() => { try { this.pty.write(this.autorun + "\n"); } catch {} }, delay);
    }

    // Output-watcher state for notification detection. The model is:
    //   - user sends input (Enter/newline) → cycle starts (_awaitingResponse=true)
    //   - PTY emits output → counts toward _responseBytes for this cycle
    //   - DONE_IDLE_MS of silence + _responseBytes >= threshold → fire "done"
    //   - "done" closes the cycle so the next user input opens a new one.
    // This is much quieter than a pure "idle for N seconds" detector, which
    // fires after every shell prompt redraw and every micro-pause.
    this._recentTextBuf = "";
    this._notifyIdleTimer = null;
    this._awaitingResponse = false;
    this._responseBytes = 0;
    this._lastConfirmAt = 0;

    this.pty.onData((data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
      this._appendBuffer(buf);
      this.lastActivityAt = now();
      this._watchForNotify(buf);
      for (const ws of this.clients) {
        if (ws.readyState === ws.OPEN) ws.send(buf);
      }
    });

    this.pty.onExit(({ exitCode }) => {
      this._broadcastControl({ type: "exit", code: exitCode });
      this.alive = false;
      // leave clients attached so they can read the final state; caller will sweep it.
    });

    this.alive = true;
  }

  _appendBuffer(buf) {
    this.bufferChunks.push(buf);
    this.bufferSize += buf.length;
    while (this.bufferSize > BUFFER_LIMIT && this.bufferChunks.length > 0) {
      const dropped = this.bufferChunks.shift();
      this.bufferSize -= dropped.length;
    }
  }

  // Scan each chunk of PTY output for notification triggers. Maintains a
  // rolling ANSI-stripped text window so patterns that span chunks still
  // match.
  //
  // Two kinds fire:
  //   - "confirm": the recent buffer contains both a "Do you want…" question
  //                and a "1. Yes / 2. No" option list. This is exactly Claude
  //                CLI's tool-approval menu shape. Deduped per CONFIRM_DEDUP_MS.
  //   - "done":    user has sent input (cycle is open), enough output has
  //                streamed back, and the PTY went quiet for DONE_IDLE_MS.
  //                A "done" closes the cycle — a fresh user input is required
  //                to arm another, so we don't spam on shell idle.
  _watchForNotify(buf) {
    const stripped = buf.toString("utf8").replace(ANSI_RE, "");
    if (stripped) {
      this._recentTextBuf = (this._recentTextBuf + stripped).slice(-NOTIFY_TEXT_BUF_MAX);
    }
    if (this._awaitingResponse) this._responseBytes += buf.length;
    const nowMs = Date.now();

    if (CONFIRM_QUESTION_RE.test(this._recentTextBuf) &&
        CONFIRM_OPTIONS_RE.test(this._recentTextBuf)) {
      if (nowMs - this._lastConfirmAt > CONFIRM_DEDUP_MS) {
        this._lastConfirmAt = nowMs;
        // After surfacing a confirm we drop the matched text from the buffer
        // so the same banner re-appearing on a redraw doesn't re-match.
        this._recentTextBuf = "";
        this._emitNotify("confirm", `${agentLabel(this.provider)} 在等你点 Yes / No`);
      }
    }

    if (this._notifyIdleTimer) clearTimeout(this._notifyIdleTimer);
    if (this._awaitingResponse) {
      this._notifyIdleTimer = setTimeout(() => this._maybeEmitDone(), DONE_IDLE_MS);
    }
  }

  // Called from server.js whenever data flows OUT to the PTY (i.e. the user
  // typed something). We only care about ENTER — a ready prompt is what opens
  // a request/response cycle.
  noteUserInput(data) {
    const text = typeof data === "string" ? data : data.toString("utf8");
    if (!text) return;
    if (text.indexOf("\r") < 0 && text.indexOf("\n") < 0) return;
    this._awaitingResponse = true;
    this._responseBytes = 0;
  }

  _maybeEmitDone() {
    if (!this._awaitingResponse) return;
    if (this._responseBytes < DONE_MIN_RESPONSE_BYTES) {
      // Not enough output to call this a real response — likely just shell
      // prompt redraws. Re-arm; the next input will start a fresh cycle.
      this._awaitingResponse = false;
      this._responseBytes = 0;
      return;
    }
    if (Date.now() - this._lastConfirmAt < 4000) {
      // We just surfaced a confirm — don't follow up with a "done" 4s later.
      this._awaitingResponse = false;
      this._responseBytes = 0;
      return;
    }
    this._awaitingResponse = false;
    this._responseBytes = 0;
    this._emitNotify("done", this._recentTextBuf.trim().slice(-200));
  }

  _emitNotify(kind, snippet) {
    // Always do both: in-page toast for foreground, OS push for everywhere.
    // Earlier we suppressed the OS push when a viewer was attached, but the
    // user pointed out that the in-page toast alone is too easy to miss when
    // they're not staring at the screen — they want WeChat-style behaviour
    // where the system notification fires regardless and they can decide
    // whether to ignore it.
    this._broadcastControl({ type: "notify", kind, at: Date.now() });
    pushNotification({
      id: crypto.randomBytes(6).toString("base64url"),
      sessionId: this.id,
      sessionName: this.name,
      provider: this.provider,
      kind,
      at: Date.now(),
      snippet,
    });
  }

  // Pull the full scrollback + current screen out of tmux as ANSI-escaped text.
  // Beats our bufferChunks because tmux keeps `history-limit` lines (50000) and
  // the text already includes cursor positioning / colors so xterm can render
  // it identically to what Mac Terminal sees.
  captureTmuxHistory() {
    if (!this.tmuxName) return null;
    try {
      const out = execFileSync(TMUX_BIN, [
        "-L", TMUX_SOCKET,
        "capture-pane", "-t", this.tmuxName,
        "-e",           // preserve escape sequences
        "-p",           // print to stdout
        "-J",           // join wrapped lines
        "-S", "-",      // from top of scrollback
        "-E", "-",      // to end of visible pane
      ], { stdio: ["ignore", "pipe", "ignore"], encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
      // capture-pane emits lines separated by \n; xterm needs \r\n to reset the
      // cursor to column 0, otherwise the second line starts where the first
      // ended (stair-stepping).
      const text = out.toString("utf8").replace(/\n/g, "\r\n");
      return Buffer.from(text, "utf8");
    } catch (e) {
      console.warn(`[tmux] capture-pane failed for ${this.tmuxName}: ${e.message}`);
      return null;
    }
  }

  replayTo(ws) {
    // Prefer tmux's full scrollback when available — survives server restarts
    // and captures 50k lines instead of our 2MB byte buffer.
    const fullHistory = this.captureTmuxHistory();
    if (fullHistory && fullHistory.length > 0) {
      if (ws.readyState === ws.OPEN) ws.send(fullHistory);
      return;
    }
    if (this.bufferChunks.length === 0) return;
    const combined = Buffer.concat(this.bufferChunks, this.bufferSize);
    if (ws.readyState === ws.OPEN) ws.send(combined);
  }

  write(data) {
    this.lastActivityAt = now();
    this.noteUserInput(data);
    this.pty.write(data);
  }

  resize(cols, rows) {
    cols = Math.max(1, cols | 0);
    rows = Math.max(1, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols; this.rows = rows;
    try { this.pty.resize(cols, rows); } catch {}
    // Also tell tmux the window size so a separately-attached Mac client
    // doesn't force us back to a smaller size.
    if (this.tmuxName) {
      tmuxSafe(["refresh-client", "-t", this.tmuxName, "-S"]);
    }
  }

  attach(ws) { this.clients.add(ws); }
  detach(ws) { this.clients.delete(ws); }

  _broadcastControl(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.clients) {
      try { if (ws.readyState === ws.OPEN) ws.send(s); } catch {}
    }
  }

  preview() {
    if (this.bufferChunks.length === 0) return "";
    // Only inspect the tail to keep this cheap.
    const total = this.bufferSize;
    const tailSize = Math.min(PREVIEW_TAIL, total);
    const parts = [];
    let remaining = tailSize;
    for (let i = this.bufferChunks.length - 1; i >= 0 && remaining > 0; i--) {
      const chunk = this.bufferChunks[i];
      if (chunk.length <= remaining) {
        parts.unshift(chunk);
        remaining -= chunk.length;
      } else {
        parts.unshift(chunk.subarray(chunk.length - remaining));
        remaining = 0;
      }
    }
    const text = Buffer.concat(parts).toString("utf8").replace(ANSI_RE, "");
    // Skip pure shell-prompt lines (ending with % $ # >) to show real output.
    const promptRe = /[%#$>]\s*$/;
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!promptRe.test(lines[i])) return lines[i].slice(0, 120);
    }
    return lines.length ? lines[lines.length - 1].slice(0, 120) : "";
  }

  kill() {
    this.alive = false;
    if (this._notifyIdleTimer) { clearTimeout(this._notifyIdleTimer); this._notifyIdleTimer = null; }
    // Kill the tmux session too so it doesn't linger after the PTY dies.
    if (this.tmuxName) tmuxSafe(["kill-session", "-t", this.tmuxName]);
    try { this.pty.kill("SIGHUP"); } catch {}
    for (const ws of this.clients) {
      try { ws.close(1000, "session deleted"); } catch {}
    }
    this.clients.clear();
  }

  describe() {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      cwd: this.cwd,
      autorun: this.autorun,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      cols: this.cols, rows: this.rows,
      clientCount: this.clients.size,
      alive: this.alive,
      preview: this.preview(),
      tmuxName: this.tmuxName,
      claudeJsonlId: this.claudeJsonlId,
      codexSessionId: this.codexSessionId,
      // One-liner for the user to type in Mac Terminal to mirror this session.
      macAttachCommand: this.tmuxName ? `tmux -L ${TMUX_SOCKET} attach -t ${this.tmuxName}` : null,
    };
  }
}

// Our own Node pid + the tmux server pid under our socket — any claude that
// sits under these is OUR managed claude, not Mac's native one.
function ourAncestorPids() {
  const pids = [process.pid];
  if (TMUX_AVAILABLE) {
    try {
      const out = execFileSync(TMUX_BIN, ["-L", TMUX_SOCKET, "display-message", "-pF", "#{pid}"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 500,
      }).trim();
      const n = parseInt(out, 10);
      if (n) pids.push(n);
    } catch {}
  }
  return pids;
}

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.persisted = loadPersisted();
    this._reattachLiveTmuxSessions();
    // Consistency rule (deliberately asymmetric, single direction):
    //   - Phone opens a session  → may SIGTERM any Mac-side claude holding
    //                              the same .jsonl (via claimSessionForPhone).
    //   - Mac opens a session    → we DO NOT TOUCH anything on the phone.
    // Consequence: the phone can keep multiple conversations running in
    // parallel (foreground + backgrounded). Even if Mac separately opens one
    // of them, our phone-side tmux/claude stays alive. The only risk is a
    // temporary jsonl interleaving if the user actively types on both sides
    // at the same time — that's on the user.
    // Because Mac never kicks us, there's no background detector; the manager
    // has no ticking timer.
  }

  // On startup, walk tmux's live session list. For every phonemac-<id> that's
  // still alive, spin up a Session in reattach mode (no autorun, preserve
  // createdAt) so the phone's old session ID still works and the Mac Terminal
  // that was attached before we restarted stays consistent.
  _reattachLiveTmuxSessions() {
    if (!TMUX_AVAILABLE) return;
    const live = listLiveTmuxSessions();
    for (const info of live) {
      const id = info.name.slice(TMUX_SESSION_PREFIX.length);
      if (!id || this.sessions.has(id)) continue;
      const meta = this.persisted[id] || {};
      try {
        const s = new Session({
          id,
          name: meta.name,
          provider: meta.provider,
          cwd: meta.cwd,
          autorun: "", // never re-run on reattach
          createdAt: meta.createdAt || info.createdAt,
          lastActivityAt: info.lastActivityAt,
          claudeJsonlId: meta.claudeJsonlId,
          codexSessionId: meta.codexSessionId,
          reattach: true,
        });
        this.sessions.set(id, s);
        this._wirePtyExit(s);
      } catch (e) {
        console.warn(`[reattach] failed for ${info.name}: ${e.message}`);
      }
    }
    if (live.length) console.log(`[reattach] recovered ${this.sessions.size} tmux-backed session(s) across restart`);
  }

  _wirePtyExit(s) {
    s.pty.onExit(() => {
      setTimeout(() => {
        if (s.clients.size === 0) this.delete(s.id);
      }, 30_000);
    });
  }

  _savePersisted() {
    const obj = {};
    for (const s of this.sessions.values()) {
      obj[s.id] = {
        name: s.name,
        provider: s.provider,
        cwd: s.cwd,
        autorun: s.autorun,
        createdAt: s.createdAt,
        lastActivityAt: s.lastActivityAt,
        claudeJsonlId: s.claudeJsonlId,
        codexSessionId: s.codexSessionId,
      };
    }
    savePersisted(obj);
    this.persisted = obj;
  }

  create(opts = {}) {
    const s = new Session(opts);
    this.sessions.set(s.id, s);
    this._wirePtyExit(s);
    this._savePersisted();
    return s;
  }

  get(id) { return this.sessions.get(id) || null; }

  // If the phone hands us a session id we don't know about, check whether
  // tmux still has the underlying session — if so, reattach to it instead of
  // creating a fresh one. Returns the Session or null.
  getOrReattach(id) {
    const existing = this.get(id);
    if (existing) return existing;
    if (!TMUX_AVAILABLE || !id) return null;
    const tmuxName = `${TMUX_SESSION_PREFIX}${id}`;
    if (!tmuxSafe(["has-session", "-t", tmuxName])) return null;
    const meta = this.persisted[id] || {};
    try {
      const s = new Session({
        id,
        name: meta.name,
        provider: meta.provider,
        cwd: meta.cwd,
        autorun: "",
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        claudeJsonlId: meta.claudeJsonlId,
        codexSessionId: meta.codexSessionId,
        reattach: true,
      });
      this.sessions.set(id, s);
      this._wirePtyExit(s);
      console.log(`[reattach] on-demand recovery of ${tmuxName}`);
      return s;
    } catch (e) {
      console.warn(`[reattach] on-demand failed for ${tmuxName}: ${e.message}`);
      return null;
    }
  }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((s) => s.describe());
  }

  rename(id, name) {
    const s = this.get(id);
    if (!s) return null;
    if (typeof name === "string" && name.trim()) s.name = name.trim().slice(0, 60);
    this._savePersisted();
    return s.describe();
  }

  delete(id) {
    const s = this.get(id);
    if (!s) return false;
    s.kill();
    this.sessions.delete(id);
    this._savePersisted();
    return true;
  }

  // Called by server.js right before a phone WebSocket is attached to session
  // `id`. Looks for any external claude (Mac Terminal etc.) that currently
  // holds the same jsonl file and SIGTERMs it so the two processes don't end
  // up both appending to the jsonl.
  //
  // Returns { killed: [{pid,cmd}], waited: true|false } for logging.
  claimSessionForPhone(id) {
    const s = this.get(id);
    if (!s || s.provider !== "claude" || !s.claudeJsonlId) return { killed: [], waited: false };
    const owners = claudeScan.findExternalClaudeHolders(ourAncestorPids());
    const matches = owners.get(s.claudeJsonlId) || [];
    const killed = [];
    for (const m of matches) {
      console.log(`[takeover] phone opening ${id} — SIGTERM external claude pid=${m.pid} (${m.cmd})`);
      if (claudeScan.sigterm(m.pid)) {
        const ok = claudeScan.waitForExit(m.pid, 2500);
        killed.push({ pid: m.pid, cmd: m.cmd, exited: ok });
      }
    }
    return { killed, waited: killed.length > 0 };
  }

}

module.exports = {
  SessionManager, Session, resolveCwd, normalizeProvider,
  TMUX_AVAILABLE, TMUX_SOCKET,
  notifications, recentNotifications,
  pushNotification,
};
