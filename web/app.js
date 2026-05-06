(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const hostEl = $("host");
  const termEl = $("term");
  const keybar = $("keybar");
  const reconnectBtn = $("reconnect");
  const pasteBtn = $("pasteBtn");
  const copyBtn = $("copyBtn");
  const tokenDialog = $("tokenDialog");
  const tokenInput = $("tokenInput");
  const composer = $("composer");
  const inputArea = $("inputArea");
  const sendBtn = $("sendBtn");
  const newlineBtn = $("newlineBtn");

  let sessionId = new URLSearchParams(location.search).get("session") || "";
  let sessionName = "";

  function updateHeader() {
    hostEl.textContent = sessionName ? sessionName : location.host;
  }
  updateHeader();

  function setStatus(kind, text) {
    statusEl.className = "status-" + kind;
    statusEl.textContent = (kind === "connected" ? "● " : kind === "connecting" ? "◐ " : "○ ") + text;
  }

  function getToken() {
    const u = new URLSearchParams(location.search);
    const t = u.get("token");
    if (t) {
      localStorage.setItem("bridge_token", t);
      // strip token from URL but keep session param for history/share
      u.delete("token");
      const qs = u.toString();
      history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
      return t;
    }
    return localStorage.getItem("bridge_token") || "";
  }

  async function askToken() {
    return new Promise((resolve) => {
      tokenInput.value = "";
      tokenDialog.showModal();
      tokenDialog.addEventListener("close", () => {
        const t = tokenInput.value.trim();
        if (t) localStorage.setItem("bridge_token", t);
        resolve(t);
      }, { once: true });
    });
  }

  const term = new Terminal({
    fontSize: 14,
    // Android WebView has no "SF Mono"/Menlo. Falling through to a proportional
    // font made CJK + ASCII rows misalign. Lead with CSS `monospace` (which
    // maps to Roboto/Droid Sans Mono on Android, Menlo on iOS/Mac).
    fontFamily: 'ui-monospace, "Roboto Mono", "Noto Sans Mono", "DejaVu Sans Mono", "Droid Sans Mono", Menlo, Consolas, monospace',
    letterSpacing: 0,
    cursorBlink: true,
    scrollback: 10000,
    // Bigger multipliers so touch wheel events scroll more lines per gesture.
    scrollSensitivity: 3,
    fastScrollSensitivity: 8,
    theme: {
      background: "#0b1020",
      foreground: "#d7e3ff",
      cursor: "#4f8cff",
      selectionBackground: "#2a3870",
      black: "#1c2548", red: "#ff6b7a", green: "#38d39f", yellow: "#f5c16c",
      blue: "#4f8cff", magenta: "#c678dd", cyan: "#56b6c2", white: "#d7e3ff",
      brightBlack: "#7d8aa8", brightRed: "#ff8a96", brightGreen: "#5be0b2",
      brightYellow: "#ffd48a", brightBlue: "#7aa8ff", brightMagenta: "#d79af0",
      brightCyan: "#7ccbd4", brightWhite: "#ffffff",
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termEl);
  fit.fit();

  // Belt-and-braces: even if the terminal somehow ends up with focus, return
  // false from every key event so xterm doesn't synthesize an onData message.
  // The composer textarea is the sole input path now.
  term.attachCustomKeyEventHandler(() => false);

  // Try the WebGL renderer — on Android WebView, the default canvas renderer
  // is the main source of scroll jank and the "text refreshed twice" flicker.
  // The WebGL addon does the whole grid in a single GPU pass per frame, so
  // long scroll chains stay 60fps and there's no half-painted intermediate
  // state. Fall back silently if the device/driver rejects WebGL — we'd
  // rather have a slow terminal than no terminal.
  let webglAddon = null;
  try {
    if (window.WebglAddon && window.WebglAddon.WebglAddon) {
      webglAddon = new window.WebglAddon.WebglAddon();
      // If the GPU context is lost (Android WebView occasionally does this on
      // app suspend) we have to dispose of the addon — xterm will fall back
      // to its DOM renderer automatically, which is slower but stable.
      webglAddon.onContextLoss(() => {
        try { webglAddon.dispose(); } catch {}
        webglAddon = null;
      });
      term.loadAddon(webglAddon);
    }
  } catch (e) {
    webglAddon = null;
  }

  // xterm measures glyph width at open() time. If the real monospace font
  // isn't loaded yet, it measures a proportional fallback and columns come
  // out wrong. Re-fit once fonts actually resolve.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      try {
        fit.fit();
        term.refresh(0, term.rows - 1);
        sendResize();
      } catch {}
    });
  }

  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 300;

  function sendResize() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  }

  function connect(token) {
    clearTimeout(reconnectTimer);
    setStatus("connecting", "连接中");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const qs = new URLSearchParams({ token });
    if (sessionId) qs.set("session", sessionId);
    // Clear the local scrollback before the server's replay arrives,
    // otherwise reconnects double-print the same output.
    term.reset();
    ws = new WebSocket(`${scheme}://${location.host}/pty?${qs.toString()}`);
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      setStatus("connected", "已连接");
      reconnectDelay = 300;
      sendResize();
      // Deliberately NOT calling term.focus() — focus belongs to the composer
      // textarea now. Calling term.focus() here would steal keyboard events.
    });

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "exit") {
            term.writeln(`\r\n\x1b[33m[进程退出, code=${m.code}]\x1b[0m`);
            return;
          }
          if (m.type === "session") {
            sessionId = m.id;
            sessionName = m.name || "";
            updateHeader();
            // persist the session id into URL for reloads
            const u = new URL(location.href);
            u.searchParams.set("session", sessionId);
            history.replaceState(null, "", u.pathname + u.search);
            return;
          }
          if (m.type === "error" && m.reason === "no_such_session") {
            term.writeln(`\r\n\x1b[31m[找不到会话 ${m.id},将在刷新后新建]\x1b[0m`);
            sessionId = "";
            return;
          }
          if (m.type === "takeover" && m.from === "mac") {
            const n = (m.killed || []).length;
            term.writeln(`\r\n\x1b[33m[已接管 Mac 上的对话 (${n} 个 claude 进程已终止)]\x1b[0m`);
            return;
          }
          if (m.type === "notify") {
            // Server detected either "task done" or a yes/no confirm prompt.
            // We still show a louder in-page toast (with vibration) so the
            // user sees something immediately while they're foreground; the
            // Android NotifyService also fires its own OS notification on its
            // separate WS subscription.
            toast(
              m.kind === "confirm" ? "需要你确认 ✋ Yes / No" : "任务完成 ✓",
              "notify",
            );
            return;
          }
          if (m.type === "pong") return;
        } catch {}
        term.write(ev.data);
      } else {
        term.write(new Uint8Array(ev.data));
      }
    });

    ws.addEventListener("close", (ev) => {
      const reason = ev.code === 1006 ? "连接断开" : `关闭 (${ev.code})`;
      setStatus("disconnected", reason);
      if (ev.code === 1008 || ev.code === 4401) {
        // auth error: clear stored token and ask again
        localStorage.removeItem("bridge_token");
        bootstrap();
        return;
      }
      if (ev.code === 4404) {
        // The server reaped this session (PTY exited + 30s grace). DO NOT
        // silently create a new one — the user's state would be lost.
        term.writeln(`\r\n\x1b[31m[会话已在服务器端结束,请返回列表选择或新建]\x1b[0m`);
        setStatus("disconnected", "会话已结束");
        return;
      }
      scheduleReconnect(token);
    });

    ws.addEventListener("error", () => { /* let close handler run */ });
  }

  function scheduleReconnect(token) {
    // First retry should be near-instant so network blips feel seamless; only
    // back off if repeated attempts fail.
    const next = Math.min(reconnectDelay, 15000);
    reconnectDelay = Math.min(Math.max(reconnectDelay, 300) * 1.7, 15000);
    reconnectTimer = setTimeout(() => connect(token), next);
  }

  // IMPORTANT: we intentionally do NOT wire term.onData → ws.send here.
  //
  // The old design forwarded every keystroke from xterm to the PTY, which
  // forced users to type "into the terminal" — meaning the OS soft keyboard
  // handed each char to xterm directly, with no native cursor positioning,
  // no IME composition, no text-selection menu. The composer textarea below
  // is the input now. The terminal is read/scroll/select only; nothing the
  // user types into xterm itself reaches the shell.

  // Map from symbolic key names (used in data-key attributes) to the actual
  // byte sequence the terminal expects. HTML attribute strings can't carry
  // real control characters, so we indirect through these names.
  const KEY_CODES = {
    "esc":       "\x1b",
    "tab":       "\t",
    "shift-tab": "\x1b[Z",
    "enter":     "\r",
    "up":        "\x1b[A",
    "down":      "\x1b[B",
    "right":     "\x1b[C",
    "left":      "\x1b[D",
    "home":      "\x1b[H",
    "end":       "\x1b[F",
    "pgup":      "\x1b[5~",
    "pgdn":      "\x1b[6~",
    "c-a": "\x01", "c-b": "\x02", "c-c": "\x03", "c-d": "\x04",
    "c-e": "\x05", "c-k": "\x0b", "c-l": "\x0c", "c-n": "\x0e",
    "c-p": "\x10", "c-r": "\x12", "c-u": "\x15", "c-w": "\x17",
    "c-z": "\x1a",
    // Double-ESC: claude CLI opens the conversation history with two quick escs.
    "esc-esc":   "\x1b\x1b",
  };

  // Tiny toast so the user can tell a tap actually went out. Essential on mobile
  // for diagnosing "did my ESC reach the terminal?". `kind === "notify"` adds
  // a louder style + longer duration + Web Vibration so server-side "task
  // done"/"confirm" events feel like a real notification when the page is
  // foreground (the OS-level notification still fires too).
  let toastEl = null, toastTimer = 0;
  function toast(msg, kind = "key") {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "keyToast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = ""; // reset
    toastEl.classList.add("show");
    if (kind === "notify") {
      toastEl.classList.add("notify");
      try { navigator.vibrate && navigator.vibrate([0, 80, 60, 120]); } catch {}
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => toastEl.classList.remove("show"),
      kind === "notify" ? 2500 : 700,
    );
  }

  // Name control bytes for the toast so the user sees "→ ESC" not "→ ".
  const KEY_LABEL = {
    "esc": "ESC", "esc-esc": "ESC×2", "tab": "TAB", "shift-tab": "S-TAB",
    "enter": "⏎", "up": "↑", "down": "↓", "left": "←", "right": "→",
    "home": "HOME", "end": "END", "pgup": "PgUp", "pgdn": "PgDn",
    "c-a": "^A", "c-b": "^B", "c-c": "^C", "c-d": "^D",
    "c-e": "^E", "c-k": "^K", "c-l": "^L", "c-n": "^N",
    "c-p": "^P", "c-r": "^R", "c-u": "^U", "c-w": "^W", "c-z": "^Z",
  };

  // Single dispatcher for all keybar buttons. Called from pointerdown; the
  // click handler is swallowed to avoid double-fire.
  async function dispatchButton(btn) {
    if (!btn) return;

    if (btn.id === "newlineBtn") {
      // Insert a newline into the composer at the caret position. Doesn't
      // submit — the user can still keep typing on the next line.
      insertAtCaret(inputArea, "\n");
      autoGrowComposer();
      inputArea.focus();
      return;
    }
    if (btn.id === "pasteBtn") {
      // Paste into the composer (not directly into the PTY) so the user can
      // edit the pasted text before sending. WeChat does the same.
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          insertAtCaret(inputArea, text);
          autoGrowComposer();
          inputArea.focus();
          toast("已粘贴 " + text.length + " 字到输入框");
        }
      } catch (err) {
        toast("粘贴失败:" + err.message);
      }
      return;
    }
    if (btn.id === "copyBtn") {
      const sel = term.getSelection();
      if (!sel) { toast("请先在终端里选中文字"); return; }
      try {
        await navigator.clipboard.writeText(sel);
        copyBtn.textContent = "已复制";
        setTimeout(() => { copyBtn.textContent = "复制"; }, 1000);
        term.clearSelection();
      } catch (err) {
        toast("复制失败:" + err.message);
      }
      return;
    }

    // Local scrollback buttons (don't hit the PTY; they pan the xterm viewport).
    const scroll = btn.getAttribute("data-scroll");
    if (scroll != null) {
      const n = parseInt(scroll, 10);
      if (!Number.isNaN(n)) term.scrollLines(n);
      return;
    }

    const cmd = btn.getAttribute("data-cmd");
    const key = btn.getAttribute("data-key");
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast("⚠ 未连接,尝试重连中");
      reconnectNow();
      return;
    }
    if (cmd) {
      ws.send(cmd + "\r");
      toast("→ " + cmd);
    } else if (key) {
      const seq = KEY_CODES[key];
      if (seq != null) {
        ws.send(seq);
        toast("→ " + (KEY_LABEL[key] || key));
      }
    }
  }

  function insertAtCaret(el, text) {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const pos = start + text.length;
    el.selectionStart = el.selectionEnd = pos;
  }

  // Fire on *release* (pointerup), not on press. This lets the user:
  //   - scroll the keybar horizontally without triggering buttons
  //   - drag their finger off a button to cancel
  //   - get immediate press feedback (via .pressed style on pointerdown) but
  //     no actual input until they lift.
  // Earlier versions fired on pointerdown, which meant any accidental brush
  // while scrolling dispatched a key.
  let armedBtn = null, armedPid = null, armedX = 0, armedY = 0;
  const DRAG_CANCEL_PX = 12;

  keybar.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    armedBtn = btn;
    armedPid = e.pointerId;
    armedX = e.clientX; armedY = e.clientY;
    btn.classList.add("pressed");
  });
  keybar.addEventListener("pointermove", (e) => {
    if (!armedBtn || e.pointerId !== armedPid) return;
    if (Math.hypot(e.clientX - armedX, e.clientY - armedY) > DRAG_CANCEL_PX) {
      armedBtn.classList.remove("pressed");
      armedBtn = null; armedPid = null;
    }
  });
  keybar.addEventListener("pointerup", (e) => {
    if (!armedBtn || e.pointerId !== armedPid) return;
    const btn = armedBtn;
    armedBtn = null; armedPid = null;
    btn.classList.remove("pressed");
    const rect = btn.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right
                && e.clientY >= rect.top  && e.clientY <= rect.bottom;
    if (inside) dispatchButton(btn);
  });
  keybar.addEventListener("pointercancel", () => {
    if (armedBtn) armedBtn.classList.remove("pressed");
    armedBtn = null; armedPid = null;
  });

  // (Ctrl / 粘贴 / 复制 按钮的行为合并到 dispatchButton 里,避免 click + pointerdown 双触发)

  // Force-reconnect helper used by the status button, visibilitychange, and
  // the Android activity when onResume fires. Skips when a connect is already
  // in flight — Android sometimes fires onResume + visibilitychange back-to-
  // back, and two overlapping connect()s cause a double term.reset()+replay,
  // which shows up as the whole buffer briefly flashing twice.
  function reconnectNow() {
    const t = localStorage.getItem("bridge_token");
    if (!t) return;
    if (ws && ws.readyState === WebSocket.CONNECTING) return;
    clearTimeout(reconnectTimer);
    reconnectDelay = 1000;
    try { if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(); } catch {}
    connect(t);
  }
  window.__reconnectNow = reconnectNow;

  reconnectBtn.addEventListener("click", async () => {
    if (ws) try { ws.close(); } catch {}
    const t = localStorage.getItem("bridge_token") || (await askToken());
    if (t) connect(t);
  });

  // When the phone comes back (unlock, switch apps), immediately reconnect
  // instead of waiting for the exponential backoff to wake up.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      reconnectNow();
    } else if (ws.readyState === WebSocket.OPEN) {
      // Also re-fit — keyboard show/hide during background may have skewed rows.
      try { fit.fit(); sendResize(); } catch {}
    }
  });

  // Composer wiring: WeChat-style input.
  //
  //   - Enter (without Shift, not during IME composition) submits the whole
  //     buffer + "\r" to the PTY and clears the textarea.
  //   - Shift+Enter inserts a newline (most desktop keyboards do this for free).
  //   - The "↵换行" button on the keybar inserts \n for phones whose IME's
  //     Enter key is bound to "send".
  //   - Tap "Send" button = submit. Empty buffer + Send = bare \r (useful for
  //     confirming Claude prompts where Enter alone means "yes default").
  function sendComposer() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast("⚠ 未连接,尝试重连中");
      reconnectNow();
      return;
    }
    const text = inputArea.value;
    if (text.length === 0) {
      ws.send("\r");
      return;
    }
    ws.send(text + "\r");
    inputArea.value = "";
    autoGrowComposer();
  }

  function autoGrowComposer() {
    inputArea.style.height = "auto";
    const h = Math.max(36, Math.min(140, inputArea.scrollHeight));
    inputArea.style.height = h + "px";
    // Composer outer height = textarea h + 16 (padding). Surface it to CSS so
    // the terminal area shrinks/grows accordingly.
    const composerH = Math.max(56, h + 20);
    document.documentElement.style.setProperty("--composer-h", composerH + "px");
    // Re-fit the terminal grid to the new available rows.
    try { fit.fit(); sendResize(); } catch {}
  }

  inputArea.addEventListener("input", autoGrowComposer);
  inputArea.addEventListener("keydown", (e) => {
    // `isComposing` is true while an IME (Sogou pinyin, etc.) is mid-word —
    // pressing Enter to commit the candidate must NOT submit the message.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !e.repeat) {
      e.preventDefault();
      sendComposer();
    }
  });
  sendBtn.addEventListener("click", () => { sendComposer(); inputArea.focus(); });
  // Ensure on first paint the textarea height is in sync with the CSS var.
  autoGrowComposer();

  // Touch-driven scrollback handler. The terminal is read/scroll/select only
  // — typing happens in the composer below.
  //
  // Two things matter for making scroll feel native on Android WebView:
  //
  //  1. Map absolute finger displacement to absolute viewportY, rather than
  //     accumulating per-frame deltas. Rounding errors in incremental mode
  //     stack up during a fast flick and make the scroll look sluggish or
  //     overshoot on the snap-back. Tracking start-of-gesture viewportY
  //     removes drift entirely.
  //
  //  2. Coalesce scrollLines() calls via requestAnimationFrame. touchmove can
  //     fire multiple times per frame; telling xterm to scroll each time
  //     triggers multiple renders per frame — which is where the "text
  //     refreshed twice" flicker came from. One render per frame is enough.
  //
  // Inertia tuning: previously DECAY=0.94 (≈0.2s coast). The user wanted
  // "like scrolling a file" so we now coast much longer:
  //   - DECAY=0.985            (half-life ≈0.77s)
  //   - CANCEL_THRESHOLD=0.003 (line/ms — about 0.18 lines/sec)
  //   - LAUNCH_BOOST=1.6       multiplied into release velocity so even a
  //                            short flick coasts noticeably
  //
  // We don't fight xterm's selection / longpress: tapping without moving
  // never triggers scroll behaviour, leaving native text selection alone.
  (function setupTouch() {
    const LINE_PX = 18;
    const CANCEL_THRESHOLD = 0.003;
    const DECAY = 0.985;
    const LAUNCH_BOOST = 1.6;

    let startY = 0, startX = 0;
    let startViewportY = 0;
    let lastY = 0, lastT = 0;
    let swiping = false;
    let velocity = 0;              // lines/ms, positive = content moves up
    let inertiaRaf = 0;
    let scrollRaf = 0;
    let pendingDelta = 0;

    function cancelInertia() {
      if (inertiaRaf) { cancelAnimationFrame(inertiaRaf); inertiaRaf = 0; }
      velocity = 0;
    }
    function flushScroll() {
      scrollRaf = 0;
      if (pendingDelta !== 0) {
        term.scrollLines(pendingDelta);
        pendingDelta = 0;
      }
    }
    function queueScroll(delta) {
      pendingDelta += delta;
      if (!scrollRaf) scrollRaf = requestAnimationFrame(flushScroll);
    }
    function stepInertia(now) {
      // Cap dt so a background tab freeze doesn't cause a giant jump when we
      // resume animating.
      const dt = Math.min(48, now - lastT); lastT = now;
      const delta = velocity * dt;
      if (Math.abs(delta) >= 1) term.scrollLines(Math.round(delta));
      // Decay scaled by frame duration — keeps the perceived coast length
      // roughly the same regardless of refresh rate (60Hz vs 120Hz).
      velocity *= Math.pow(DECAY, dt / 16);
      // Stop coasting if we hit a viewport boundary; otherwise we waste cycles.
      const buf = term.buffer.active;
      if ((velocity > 0 && buf.viewportY >= buf.length - term.rows) ||
          (velocity < 0 && buf.viewportY <= 0)) {
        inertiaRaf = 0; velocity = 0; return;
      }
      if (Math.abs(velocity) < CANCEL_THRESHOLD) { inertiaRaf = 0; return; }
      inertiaRaf = requestAnimationFrame(stepInertia);
    }

    termEl.addEventListener("touchstart", (e) => {
      cancelInertia();
      if (e.touches.length !== 1) return;
      startY = lastY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      startViewportY = term.buffer.active.viewportY;
      lastT = performance.now();
      swiping = false;
    }, { passive: true });

    termEl.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const x = e.touches[0].clientX;
      const dx = x - startX;
      const dy = y - startY;
      if (!swiping) {
        // Require a mostly-vertical gesture before treating it as a scroll, so
        // a horizontal drag (likely text selection) isn't hijacked.
        if (Math.abs(dy) < 15 || Math.abs(dx) > Math.abs(dy)) return;
        swiping = true;
      }
      const now = performance.now();
      // Absolute mapping: at what viewportY should we be given total finger dy?
      const targetViewportY = startViewportY - Math.round(dy / LINE_PX);
      const wanted = targetViewportY - term.buffer.active.viewportY;
      if (wanted !== 0) queueScroll(wanted);
      // EMA of instantaneous velocity for release inertia.
      const dt = Math.max(1, now - lastT);
      const instV = -(y - lastY) / LINE_PX / dt;
      velocity = velocity * 0.55 + instV * 0.45;
      lastY = y; lastT = now;
    }, { passive: true });

    termEl.addEventListener("touchend", () => {
      if (scrollRaf) { cancelAnimationFrame(scrollRaf); flushScroll(); }
      if (!swiping) return;
      // Boost release velocity so even a quick flick gets a satisfying coast.
      velocity *= LAUNCH_BOOST;
      if (Math.abs(velocity) >= CANCEL_THRESHOLD) {
        lastT = performance.now();
        inertiaRaf = requestAnimationFrame(stepInertia);
      }
    }, { passive: true });

    termEl.addEventListener("touchcancel", cancelInertia, { passive: true });
  })();

  // Custom draggable scrollbar. xterm has its own bar but it's too thin for
  // fingers and doesn't respond well to drag on ColorOS WebView.
  (function setupScrollbar() {
    const bar = $("scrollbar");
    const thumb = $("scrollbarThumb");
    if (!bar || !thumb) return;

    let hideTimer = 0;
    function showBriefly() {
      bar.classList.add("visible");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!bar.classList.contains("dragging")) bar.classList.remove("visible");
      }, 1500);
    }

    // Recompute thumb position/size from term state. Called on scroll + resize.
    function layout() {
      const buf = term.buffer.active;
      const total = buf.length;                 // scrollback + viewport rows
      const rows = term.rows;
      if (total <= rows) {
        bar.classList.add("empty");
        return;
      }
      bar.classList.remove("empty");
      const trackH = bar.clientHeight;
      const thumbH = Math.max(28, Math.round(trackH * rows / total));
      // viewportY is how many lines scrolled down from the top of the scrollback
      const maxScroll = total - rows;
      const scrolled = buf.viewportY;  // 0 = top of scrollback, maxScroll = bottom (newest)
      const trackRange = trackH - thumbH;
      const top = maxScroll === 0 ? 0 : Math.round(trackRange * scrolled / maxScroll);
      thumb.style.height = thumbH + "px";
      thumb.style.top = top + "px";
    }

    term.onScroll(() => { layout(); showBriefly(); });
    // Also refit after resize recomputes rows
    window.addEventListener("resize", layout);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", layout);
    setTimeout(layout, 50);

    // Dragging: map thumb position back to a scrollback line.
    let dragging = false;
    let dragOffset = 0; // pointer offset inside thumb at drag start

    function pointerToScroll(clientY) {
      const rect = bar.getBoundingClientRect();
      const thumbH = thumb.getBoundingClientRect().height;
      const trackRange = rect.height - thumbH;
      if (trackRange <= 0) return;
      let y = clientY - rect.top - dragOffset;
      if (y < 0) y = 0;
      if (y > trackRange) y = trackRange;
      const buf = term.buffer.active;
      const maxScroll = Math.max(0, buf.length - term.rows);
      const target = Math.round(maxScroll * y / trackRange);
      // scrollToLine takes a viewportY (0..buf.length - rows)
      const delta = target - buf.viewportY;
      if (delta !== 0) term.scrollLines(delta);
    }

    thumb.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      const thumbRect = thumb.getBoundingClientRect();
      dragOffset = e.clientY - thumbRect.top;
      bar.classList.add("dragging", "visible");
      thumb.setPointerCapture(e.pointerId);
    });
    thumb.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      e.preventDefault();
      pointerToScroll(e.clientY);
    });
    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove("dragging");
      try { thumb.releasePointerCapture(e.pointerId); } catch {}
      showBriefly();
    };
    thumb.addEventListener("pointerup", endDrag);
    thumb.addEventListener("pointercancel", endDrag);

    // Tap on the track (not the thumb) → jump there in one step.
    bar.addEventListener("pointerdown", (e) => {
      if (e.target === thumb) return;
      e.preventDefault();
      dragOffset = thumb.clientHeight / 2;
      dragging = true;
      bar.classList.add("dragging", "visible");
      pointerToScroll(e.clientY);
      // don't hold the drag; release immediately after the jump
      setTimeout(() => {
        dragging = false;
        bar.classList.remove("dragging");
        showBriefly();
      }, 50);
    });

    // Surface the bar when the user starts touching the terminal too, so they
    // can see it's there.
    termEl.addEventListener("touchstart", showBriefly, { passive: true });
  })();

  let resizeRaf = 0;
  function handleResize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      try { fit.fit(); sendResize(); } catch {}
    });
  }
  window.addEventListener("resize", handleResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", handleResize);
  }

  async function bootstrap() {
    let token = getToken();
    if (!token) token = await askToken();
    if (!token) {
      setStatus("disconnected", "缺少 token");
      return;
    }
    connect(token);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  bootstrap();
})();
