"use strict";

// Finds `claude` processes on this Mac and the JSONL session files they have
// open. Used to enforce "latest-device-wins" — when phone opens a session we
// SIGTERM any Mac-side claude holding the same .jsonl; when Mac opens a
// session we kick the phone's WebSocket.
//
// Nothing here hooks into claude itself; we inspect it from the outside via
// ps + lsof, so it works whether Mac's claude was started via Terminal.app,
// iTerm, a shell script, tmux, or anything else.

const { execFileSync, spawnSync } = require("child_process");
const path = require("path");

function listClaudeProcesses() {
  let out;
  try {
    out = execFileSync("/bin/ps", ["-Ao", "pid,ppid,command"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { return []; }
  const procs = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, cmd] = m;
    // Must reference a `claude` binary somewhere in the command line; exclude
    // anything that's obviously our own tmux wrapper (it appears as `tmux
    // new-session ... command claude` — the word "tmux" won't appear for the
    // child claude process itself, only in our spawn invocation).
    if (!/\bclaude\b/.test(cmd)) continue;
    if (/\btmux\b/.test(cmd)) continue; // skip our wrapper entries
    procs.push({ pid: parseInt(pid, 10), ppid: parseInt(ppid, 10), cmd });
  }
  return procs;
}

// Return the set of JSONL file paths opened by the given PID.
function jsonlsOpenedByPid(pid) {
  let out;
  try {
    out = execFileSync("/usr/sbin/lsof", ["-p", String(pid), "-F", "n"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500,
    });
  } catch { return []; }
  const files = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("n")) continue;
    const p = line.slice(1);
    if (p.endsWith(".jsonl") && p.includes(".claude/projects")) files.push(p);
  }
  return files;
}

// Extract the claude session id from a path like
//   /Users/x/.claude/projects/<project>/<uuid>.jsonl
function sessionIdFromJsonl(jsonlPath) {
  const base = path.basename(jsonlPath);
  if (!base.endsWith(".jsonl")) return null;
  return base.slice(0, -".jsonl".length);
}

// Is this pid a descendant of the given ancestor pid? Walks ppid chain.
// Used to distinguish our own tmux-wrapped claude from a user-spawned one.
function isDescendantOf(pid, ancestor, maxDepth = 8) {
  let cur = pid;
  const seen = new Set();
  while (cur && cur !== 1 && !seen.has(cur) && maxDepth-- > 0) {
    seen.add(cur);
    if (cur === ancestor) return true;
    let parent;
    try {
      parent = execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(cur)], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 500,
      }).trim();
    } catch { return false; }
    cur = parseInt(parent, 10);
  }
  return false;
}

// Enumerate every non-ours claude process + the JSONL it's editing.
//   ourAncestors: an array of pids we own (e.g. our Node process + its spawned
//                 tmux server pid). Descendants of these are OUR claude, not
//                 Mac's user claude, so we exclude them.
function findExternalClaudeHolders(ourAncestors = []) {
  const owners = new Map(); // jsonl path -> [{ pid, sessionId, cmd }]
  for (const p of listClaudeProcesses()) {
    // Skip our own children
    if (ourAncestors.some((a) => isDescendantOf(p.pid, a))) continue;
    const files = jsonlsOpenedByPid(p.pid);
    for (const f of files) {
      const sid = sessionIdFromJsonl(f);
      if (!sid) continue;
      const list = owners.get(sid) || [];
      list.push({ pid: p.pid, cmd: p.cmd, jsonl: f });
      owners.set(sid, list);
    }
  }
  return owners;
}

function sigterm(pid) {
  try { process.kill(pid, "SIGTERM"); return true; }
  catch (e) { return false; }
}

// Block up to timeoutMs waiting for pid to exit. Polls with kill 0.
function waitForExit(pid, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch { return true; } // not running anymore
    // sleep 100ms
    spawnSync("/bin/sleep", ["0.1"]);
  }
  try { process.kill(pid, 0); return false; } catch { return true; }
}

module.exports = {
  listClaudeProcesses,
  jsonlsOpenedByPid,
  sessionIdFromJsonl,
  findExternalClaudeHolders,
  isDescendantOf,
  sigterm,
  waitForExit,
};
