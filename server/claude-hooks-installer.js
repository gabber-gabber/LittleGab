"use strict";
// Idempotent installer for Claude Code's `Stop` and `Notification` hooks.
//
// Claude Code reads ~/.claude/settings.json at session start and runs any
// configured hook command on the corresponding event. We use that to forward
// "task done" / "needs your input" events to the bridge server, which fans
// them out to the phone's NotifyService.
//
// Design constraints:
//   1. Never destroy unrelated user config — merge, don't replace.
//   2. Detect already-installed entries by command path so re-running is safe.
//   3. Drop stale entries whose path no longer points at us (after the user
//      moves the bridge bundle around).
//   4. Run synchronously at server startup; failure is logged but never
//      crashes the server.

const fs = require("fs");
const path = require("path");
const os = require("os");

const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const MARKER = "PhoneMacBridge"; // present in the absolute hook path

function buildEntry(hookScript, kindArg) {
  return {
    matcher: "*",
    hooks: [
      {
        type: "command",
        // Use absolute node + script path so PATH-less environments (Claude
        // Code spawns hooks with a minimal env) still work.
        command: `${process.execPath} ${shellEscape(hookScript)} ${kindArg}`,
        timeout: 5,
      },
    ],
  };
}

function shellEscape(p) {
  // Single-arg path may contain spaces (Application Support). Wrap in single
  // quotes; bridge install path doesn't contain single quotes.
  return `'${p.replace(/'/g, "'\\''")}'`;
}

function ensureClaudeHooksInstalled(hookScriptAbs, log = console.log) {
  try {
    if (!fs.existsSync(hookScriptAbs)) {
      log(`[hook-installer] hook script missing at ${hookScriptAbs}; skipping`);
      return false;
    }
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let cfg = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      try { cfg = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) || {}; }
      catch (e) {
        log(`[hook-installer] settings.json parse failed: ${e.message}; aborting (refusing to overwrite unreadable config)`);
        return false;
      }
    }
    cfg.hooks = cfg.hooks || {};

    const wantStop = buildEntry(hookScriptAbs, "stop");
    const wantNotif = buildEntry(hookScriptAbs, "notification");

    let changed = false;
    changed = mergeEvent(cfg.hooks, "Stop", wantStop, hookScriptAbs) || changed;
    changed = mergeEvent(cfg.hooks, "Notification", wantNotif, hookScriptAbs) || changed;

    if (!changed) {
      log("[hook-installer] hooks already up to date");
      return false;
    }
    // Backup once per change so the user can always recover.
    try {
      if (fs.existsSync(SETTINGS_PATH)) {
        fs.copyFileSync(SETTINGS_PATH, SETTINGS_PATH + ".phone-mac-bak");
      }
    } catch {}
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(cfg, null, 2) + "\n");
    log(`[hook-installer] updated ${SETTINGS_PATH}`);
    return true;
  } catch (e) {
    log(`[hook-installer] error: ${e.message}`);
    return false;
  }
}

// Within a single event ("Stop" or "Notification") slot:
//  - drop existing entries that look like ours but point at a stale path
//  - if no current ours-entry remains, append the wanted entry
function mergeEvent(hooks, eventName, wantedEntry, hookScriptAbs) {
  const arr = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
  let changed = false;

  // Filter: keep entries that (a) aren't ours OR (b) are ours and current
  const filtered = [];
  let foundCurrent = false;
  for (const entry of arr) {
    const isOurs = isOursEntry(entry);
    if (!isOurs) { filtered.push(entry); continue; }
    const matchesCurrent = (entry.hooks || []).some((h) =>
      typeof h.command === "string" && h.command.includes(hookScriptAbs)
    );
    if (matchesCurrent && !foundCurrent) {
      filtered.push(entry);
      foundCurrent = true;
    } else {
      changed = true; // drop stale ours-entry
    }
  }
  if (!foundCurrent) {
    filtered.push(wantedEntry);
    changed = true;
  }
  hooks[eventName] = filtered;
  return changed;
}

function isOursEntry(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) =>
    typeof h.command === "string" && h.command.includes(MARKER)
  );
}

module.exports = { ensureClaudeHooksInstalled, SETTINGS_PATH };
