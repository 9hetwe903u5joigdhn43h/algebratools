/* Launcher shim for the Eaglercraft clients.
 *
 * The service worker injects this at the top of <head> as it serves the
 * client page, so it runs before the game's own scripts.
 *
 * It fixes two things:
 *
 * 1. Keyboard lock. The game calls navigator.keyboard.lock() to grab the
 *    keyboard exclusively. While that lock is held the browser stops handling
 *    system shortcuts for the page (Ctrl+Shift+Q, Ctrl+W, Ctrl+Tab, and on
 *    ChromeOS even brightness / volume / power), which makes the machine feel
 *    like it has frozen. We let the call succeed but never actually lock, so
 *    gameplay keys keep working while the system stays responsive.
 *    navigator.keyboard.getLayoutMap() is left alone so non-QWERTY layouts
 *    still map key positions correctly.
 *
 * 2. Fullscreen. The game puts its own wrapper div into *element* fullscreen.
 *    Element fullscreen does not resize the layout viewport, so the game's
 *    canvas keeps its old pixel size and renders stretched, and the window's
 *    own fullscreen (the keyboard's fullscreen key, F11) stops working
 *    entirely. We redirect the request to the document element, which gives
 *    real window fullscreen: the viewport resizes, the game re-lays out, and
 *    F11 / Escape toggle it cleanly.
 *
 * On top of that: the hardware Back key goes back to the launcher, and F5
 * reloads the client (the game would otherwise swallow it).
 */
(function () {
  "use strict";

  if (window.__eaglercraftShim) return;
  window.__eaglercraftShim = true;

  /* ------------------------------------------------------------------
     The log

     The game turns any uncaught error into a crash, so a session that
     ends badly usually has a reason — but the reason is only visible in
     the console, which nobody looks at. The shim keeps the last few
     things that went wrong in localStorage, and the launcher's
     diagnostics panel reads them back.
     ------------------------------------------------------------------ */
  var LOG_KEY = "eaglercraft.shim.log";
  var LOG_MAX = 40;
  var logEntries = [];

  try {
    var rawLog = localStorage.getItem(LOG_KEY);
    if (rawLog) {
      var parsedLog = JSON.parse(rawLog);
      if (Array.isArray(parsedLog)) logEntries = parsedLog.slice(-LOG_MAX);
    }
  } catch (err) { /* no log yet */ }

  function saveLog() {
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(logEntries.slice(-LOG_MAX)));
    } catch (err) { /* ignore */ }
  }

  function logEvent(level, message) {
    try {
      logEntries.push({
        at: Date.now(),
        level: String(level || "info"),
        message: String(message === undefined ? "" : message)
      });
      while (logEntries.length > LOG_MAX) logEntries.shift();
      saveLog();
    } catch (err) { /* ignore */ }
  }

  function warn() {
    try { console.warn("[shim] " + Array.prototype.join.call(arguments, " ")); } catch (e) { /* ignore */ }
  }

  // The client aborts the game on any uncaught script error, so every
  // callback the shim installs is wrapped: a mistake here must never take
  // the game down with it.
  function safe(fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (err) {
        warn("ignored error:", err);
        return undefined;
      }
    };
  }

  // Diagnostics: the launcher reads these back so we can tell whether the
  // shim actually ran, and whether the game tried to lock the keyboard.
  var stats = {
    time: Date.now(), lockCalls: 0, unlockCalls: 0, lockedSeen: false,
    fullscreenPatched: false, fsRequests: 0, fsOk: 0, fsError: "", escapeKeys: 0,
    escLock: false, errors: 0, lastError: ""
  };

  function saveStats() {
    try { localStorage.setItem("eaglercraft.shim", JSON.stringify(stats)); } catch (err) { /* ignore */ }
  }

  // The last thing that went wrong in the page. The game aborts on any
  // uncaught error, so this is usually the reason the session ended.
  try {
    window.addEventListener("error", safe(function (event) {
      var where = event && event.filename ? " (" + event.filename + ":" + event.lineno + ")" : "";
      stats.lastError = String((event && event.message) || "unknown error") + where;
      stats.errors++;
      saveStats();
      logEvent("error", stats.lastError);
    }));

    window.addEventListener("unhandledrejection", safe(function (event) {
      var reason = event && event.reason;
      stats.lastError = "unhandled rejection: " +
        (reason && reason.message ? reason.message : String(reason));
      stats.errors++;
      saveStats();
      logEvent("error", stats.lastError);
    }));
  } catch (err) { /* ignore */ }

  /* ------------------------------------------------------------------
     Keybinds — configurable from the launcher settings. They live in
     localStorage, which the launcher and the client share.
     ------------------------------------------------------------------ */
  var KEYBIND_STORAGE = "eaglercraft.launcher.keybinds";

  function defaultKeybinds() {
    return {
      fullscreenOn: "Alt+]",
      fullscreenOff: "Alt+[",
      launcher: "Alt+\\",
      debug: "Alt+`"
    };
  }

  function loadKeybinds() {
    var binds = defaultKeybinds();
    try {
      var raw = localStorage.getItem(KEYBIND_STORAGE);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          Object.keys(binds).forEach(function (name) {
            if (typeof parsed[name] === "string" && parsed[name]) binds[name] = parsed[name];
          });
        }
      }
    } catch (err) { /* use the defaults */ }
    return binds;
  }

  // Canonical form of a key event: "Ctrl+Alt+Shift+Key".
  function keySignature(event) {
    var parts = [];
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Meta");
    var key = event.key;
    if (key === " ") key = "Space";
    else if (key && key.length === 1) key = key.toUpperCase();
    parts.push(key);
    return parts.join("+");
  }

  var keybinds = loadKeybinds();

  try {
    // Settings changed in another tab: pick them up.
    window.addEventListener("storage", safe(function (e) {
      if (e.key === KEYBIND_STORAGE) keybinds = loadKeybinds();
    }));
  } catch (err) { /* ignore */ }

  /* ------------------------------------------------------------------
     1. Never actually lock the keyboard
     ------------------------------------------------------------------ */
  var realKeyboardLock = null;
  try { realKeyboardLock = window.Keyboard && Keyboard.prototype.lock; }
  catch (err) { /* ignore */ }

  // True while our own scoped Escape lock is engaged: the safety net must
  // not drop it.
  var escLockRequested = false;

  // True only when the requested lock is a single "Escape" key — case
  // insensitive. Everything else (including lock() with no arguments) keeps
  // being blocked.
  function isEscapeOnly(keys) {
    return Array.isArray(keys) && keys.length === 1 &&
      String(keys[0]).toLowerCase() === "escape";
  }

  try {
    if (navigator.keyboard) {
      // Patch the instance *and* the prototype: a caller that grabbed
      // Keyboard.prototype.lock before the shim ran would otherwise still
      // reach the real implementation.
      function patchedLock(keys) {
        if (isEscapeOnly(keys)) {
          escLockRequested = true;
          return realKeyboardLock.call(navigator.keyboard, keys);
        }
        stats.lockCalls++;
        saveStats();
        warn("keyboard lock blocked — system shortcuts stay available");
        logEvent("info", "The game asked for the whole keyboard; it was blocked so " +
          "the system shortcuts keep working.");
        return Promise.resolve();
      }

      try {
        navigator.keyboard.lock = patchedLock;
      } catch (err) { /* some browsers make the property read-only */ }

      try {
        if (window.Keyboard && Keyboard.prototype) Keyboard.prototype.lock = patchedLock;
      } catch (err) { /* ignore */ }

      try {
        Object.defineProperty(navigator.keyboard, "lock", {
          value: patchedLock,
          writable: true,
          configurable: true
        });
      } catch (err) { /* ignore */ }
    }
  } catch (err) {
    warn("could not patch keyboard.lock:", err);
  }

  // Safety net: if anything manages to lock the keyboard anyway, drop it.
  // navigator.keyboard.locked is not implemented everywhere, so this is
  // best-effort — the lock is also released whenever a key event arrives.
  try {
    if (navigator.keyboard && typeof navigator.keyboard.unlock === "function") {
      var release = function (why) {
        try {
          navigator.keyboard.unlock();
          stats.unlockCalls++;
          stats.lockedSeen = false;
          saveStats();
          warn("keyboard lock released (" + why + ")");
        } catch (err) { /* ignore */ }
      };
      setInterval(safe(function () {
        try {
          if (escLockRequested) return;
          if (navigator.keyboard.locked) {
            stats.lockedSeen = true;
            saveStats();
            release("poll");
          }
        } catch (err) { /* ignore */ }
      }), 500);
      window.addEventListener("keydown", safe(function () {
        try {
          if (escLockRequested) return;
          if (navigator.keyboard.locked) release("keydown");
        } catch (err) { /* ignore */ }
      }), true);
    }
  } catch (err) { /* ignore */ }

  // Leave a trace so the launcher can confirm the shim actually ran.
  saveStats();

  // Arm the scoped Escape lock when fullscreen starts, and release it when
  // fullscreen ends. The lock engages silently — Chromium grants the
  // keyboard-lock permission for a scoped single-key lock without a prompt.
  function armEscLock() {
    if (!navigator.keyboard || typeof navigator.keyboard.lock !== "function") return;
    escLockRequested = true;
    try {
      var p = navigator.keyboard.lock(["Escape"]);   // passes through the patch
      if (p && typeof p.then === "function") {
        p.then(function () { stats.escLock = true; saveStats(); },
               function () { stats.escLock = false; saveStats(); });
      }
    } catch (err) { /* ignore */ }
  }

  function disarmEscLock() {
    escLockRequested = false;
    stats.escLock = false;
    try {
      if (navigator.keyboard && typeof navigator.keyboard.unlock === "function") {
        navigator.keyboard.unlock();
      }
    } catch (err) { /* ignore */ }
  }

  /* ------------------------------------------------------------------
     Back to the launcher
     ------------------------------------------------------------------ */
  // The launcher is index.html in the root of the service worker's scope,
  // so that is where "back to launcher" goes when the history cannot help.
  function launcherUrl() {
    try {
      var controller = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (controller) {
        var scope = new URL(controller.scriptURL);
        scope.pathname = scope.pathname.replace(/[^/]*$/, "index.html");
        return scope.href;
      }
    } catch (err) { /* fall back to the relative path */ }
    return "./index.html";
  }

  function goToLauncher() {
    var url = launcherUrl();
    try {
      window.location.replace(url);
    } catch (err) {
      window.location.href = url;
    }
  }

  // Go back to the launcher.
  function backToLauncher() {
    // Straight to the launcher page, never through the history. Stepping
    // back restores the launcher from the back/forward cache — exactly as it
    // was left, with the "Starting <client>…" overlay still frozen on top
    // of it and the launch button still disabled. That is a dead screen:
    // the launcher is visible, but nothing on it can be clicked. A fresh
    // load of the launcher is clean.
    goToLauncher();
  }

  /* ------------------------------------------------------------------
     Controls panel — a small button in the bottom-left corner of the
     client opens it. It carries the controls that the game swallows
     (fullscreen, volume, back, close) and, behind a toggle, the
     diagnostics readout.
     ------------------------------------------------------------------ */
  try {
    function displayMode() {
      try {
        if (window.matchMedia("(display-mode: standalone)").matches) return "standalone";
        if (window.matchMedia("(display-mode: fullscreen)").matches) return "fullscreen";
        if (window.matchMedia("(display-mode: minimal-ui)").matches) return "minimal-ui";
        if (window.matchMedia("(display-mode: window-controls-overlay)").matches) {
          return "window-controls-overlay";
        }
      } catch (err) { /* ignore */ }
      return "browser";
    }

    function isLocked() {
      try {
        return !!(navigator.keyboard && navigator.keyboard.locked);
      } catch (err) {
        return false;
      }
    }

    /* ---- master volume ------------------------------------------- */
    var masterGain = null;
    var masterContext = null;
    var volume = 1;

    function installAudioMaster() {
      var Real = window.AudioContext || window.webkitAudioContext;
      if (!Real || Real.__eaglerShimPatched) return;
      function Wrapped() {
        var ctx = Reflect.construct(Real, Array.prototype.slice.call(arguments), Wrapped);
        try {
          var gain = ctx.createGain();
          gain.gain.value = volume;
          gain.connect(ctx.destination);
          masterGain = gain;
          masterContext = ctx;
          // Expose them: the game wraps AudioContext itself, so this is the
          // only reliable way to find the master gain afterwards.
          window.__eaglerMasterGain = gain;
          window.__eaglerMasterContext = ctx;
        } catch (err) { /* ignore */ }
        return ctx;
      }
      Wrapped.prototype = Real.prototype;
      Wrapped.__eaglerShimPatched = true;
      window.AudioContext = Wrapped;
      if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;

      // Anything that used to go straight to the speakers now goes through
      // the master gain, so the volume buttons scale the game's sound.
      try {
        var proto = window.AudioNode && window.AudioNode.prototype;
        var origConnect = proto.connect;
        proto.connect = function (dest) {
          var args = arguments;
          try {
            if (masterGain && this !== masterGain && dest && masterContext &&
                dest === masterContext.destination) {
              dest = masterGain;
            }
          } catch (err) { /* fall through */ }
          return origConnect.apply(this, args);
        };
      } catch (err) { /* ignore */ }
    }

    function applyVolume() {
      if (!masterGain) return;
      try { masterGain.gain.value = volume; } catch (err) { /* ignore */ }
    }

    function adjustVolume(delta) {
      volume = Math.max(0, Math.min(1, Math.round((volume + delta) * 100) / 100));
      applyVolume();
      refreshPanel();
    }

    /* ---- actions --------------------------------------------------- */
    // Chrome exits fullscreen on Escape and a page cannot prevent that, so
    // fullscreen is "sticky": once it is wanted, an accidental Escape is
    // undone on the next interaction.
    var wantFullscreen = false;
    var reenterPending = false;

    function isFullscreen() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }

    function requestFullscreen() {
      try {
        var target = document.documentElement;
        var request = target.requestFullscreen || target.webkitRequestFullscreen;
        if (request) {
          stats.fsRequests++;
          var result = request.call(target);
          if (result && typeof result.then === "function") {
            result.then(function () {
              stats.fsOk++;
              saveStats();
            }, function (err) {
              stats.fsError = String((err && err.message) || err);
              saveStats();
              logEvent("error", "Fullscreen was refused: " + stats.fsError);
            });
          }
        }
      } catch (err) {
        stats.fsError = String((err && err.message) || err);
        saveStats();
      }
    }

    function exitFullscreen() {
      try {
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
      } catch (err) { /* ignore */ }
    }

    function toggleFullscreen() {
      try {
        var on = isFullscreen();
        wantFullscreen = !on;
        if (on) {
          exitFullscreen();
        } else {
          requestFullscreen();
        }
      } catch (err) { /* ignore */ }
    }

    function reenterFullscreen() {
      if (!wantFullscreen || isFullscreen()) return;
      requestFullscreen();
    }

    function closeTab() {
      try {
        window.close();
      } catch (err) { /* ignore */ }
      // If the browser refused to close the tab, say so.
      setTimeout(function () {
        if (!window.closed) {
          flash("The browser would not close this tab — use the window buttons.");
        }
      }, 600);
    }

    /* ---- panel ---------------------------------------------------- */
    var flashTimer = null;

    function flash(text, ms) {
      var el = document.getElementById("__eagler_flash");
      if (!el) return;
      el.textContent = text;
      el.style.opacity = "1";
      clearTimeout(flashTimer);
      flashTimer = setTimeout(function () { el.style.opacity = "0"; }, ms || 2200);
    }

    function debugText() {
      var lines = [];
      lines.push("shim: active");
      lines.push("keyboard lock attempts: " + stats.lockCalls +
        (stats.lockCalls ? "  (blocked)" : ""));
      lines.push("locks released: " + stats.unlockCalls);
      lines.push("locked right now: " + (isLocked() ? "YES" : "no"));
      lines.push("keyboard api: " + (typeof navigator.keyboard));
      lines.push("lock patched: " + (navigator.keyboard &&
        navigator.keyboard.lock.toString().indexOf("blocked") !== -1 ? "yes" : "no"));
      lines.push("fullscreen patched: " + (stats.fullscreenPatched ? "yes" : "no"));
      lines.push("fullscreen wanted: " + (wantFullscreen ? "yes" : "no"));
      lines.push("fullscreen requests: " + stats.fsRequests +
        " ok " + stats.fsOk + (stats.fsError ? " (" + stats.fsError + ")" : ""));
      lines.push("keybinds:");
      lines.push("  " + keybinds.fullscreenOn + "  fullscreen on");
      lines.push("  " + keybinds.fullscreenOff + "  fullscreen off");
      lines.push("  " + keybinds.launcher + "  back to launcher");
      lines.push("  " + keybinds.debug + "  debug panel");
      lines.push("display-mode: " + displayMode());
      lines.push("worker controlling: " + (navigator.serviceWorker.controller ? "yes" : "no"));
      lines.push("audio master: " + (masterGain ? "yes" : "no"));
      lines.push("esc lock: " + (stats.escLock ? "yes" : "no"));
      lines.push("hold to exit: " + ESC_HOLD_MS + "ms");
      lines.push("errors: " + (stats.errors || 0) +
        (stats.lastError ? "  (" + stats.lastError + ")" : ""));
      return lines.join("\n");
    }

    var panelEl = null;
    var debugEl = null;
    var volumeEl = null;
    var fsLabel = null;

    // The panel is a helper, not part of the game, so it gets out of the way
    // again: it closes itself after five idle seconds. Pressing one of its
    // buttons counts as activity and starts the countdown over.
    var PANEL_IDLE_MS = 5000;
    var panelTimer = null;

    function closePanel() {
      if (panelTimer) {
        clearTimeout(panelTimer);
        panelTimer = null;
      }
      if (panelEl) panelEl.style.display = "none";
    }

    function armPanelTimer() {
      if (panelTimer) clearTimeout(panelTimer);
      panelTimer = setTimeout(safe(closePanel), PANEL_IDLE_MS);
    }

    function refreshPanel() {
      // The client aborts the game on any uncaught script error, so a mistake
      // in the shim must never escape.
      try {
        if (!panelEl || panelEl.style.display === "none") return;
        if (debugEl && debugEl.style.display !== "none") debugEl.textContent = debugText();
        if (volumeEl) volumeEl.textContent = "volume " + Math.round(volume * 100) + "%";
        if (fsLabel) {
          fsLabel.textContent = isFullscreen() ? "Exit fullscreen" : "Fullscreen";
        }
      } catch (err) {
        warn("panel refresh failed:", err);
      }
    }

    function chip(label, onClick) {
      var b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = [
        "font:600 11px/1.2 ui-monospace,Menlo,Consolas,monospace",
        "color:#e5e7eb",
        "background:rgba(255,255,255,0.08)",
        "border:1px solid rgba(255,255,255,0.16)",
        "border-radius:6px",
        "padding:5px 8px",
        "cursor:pointer"
      ].join(";");
      b.addEventListener("click", safe(function (e) {
        e.stopPropagation();
        // Using a button is activity: the panel stays open for another five
        // seconds instead of vanishing under the pointer.
        armPanelTimer();
        onClick();
      }));
      return b;
    }

    function buildPanel() {
      if (!document.body || document.getElementById("__eagler_panel")) return;

      var button = document.createElement("button");
      button.id = "__eagler_shim_btn";
      button.textContent = "⚙";
      button.title = "Controls";
      button.setAttribute("aria-label", "Controls");
      button.style.cssText = [
        "position:fixed",
        "left:12px",
        "bottom:12px",
        "z-index:2147483647",
        "width:30px",
        "height:30px",
        "border-radius:8px",
        "border:1px solid rgba(255,255,255,0.16)",
        "background:rgba(11,15,25,0.72)",
        "color:#9ca3af",
        "font:600 14px/1 ui-monospace,Menlo,Consolas,monospace",
        "cursor:pointer",
        "opacity:0.45",
        "transition:opacity .15s ease"
      ].join(";");
      button.addEventListener("mouseenter", function () { button.style.opacity = "1"; });
      button.addEventListener("mouseleave", function () { button.style.opacity = "0.45"; });

      panelEl = document.createElement("div");
      panelEl.id = "__eagler_panel";
      panelEl.style.cssText = [
        "position:fixed",
        "left:12px",
        "bottom:50px",
        "z-index:2147483647",
        "display:none",
        // Hug the buttons instead of taking a fixed slice of the screen, but
        // never grow past the viewport: the width has to include the padding
        // and the border, or the panel hangs off the side of a phone.
        "box-sizing:border-box",
        "width:auto",
        "max-width:min(92vw,300px)",
        "max-height:calc(100vh - 74px)",
        "max-height:calc(100dvh - 74px)",
        "overflow-y:auto",
        "padding:9px 11px",
        "border-radius:10px",
        "border:1px solid rgba(255,255,255,0.16)",
        "background:rgba(11,15,25,0.94)",
        "color:#e5e7eb",
        "font:12px/1.5 ui-monospace,Menlo,Consolas,monospace"
      ].join(";");

      var row = document.createElement("div");
      row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";

      var fsButton = chip("Fullscreen", toggleFullscreen);
      row.appendChild(fsButton);
      row.appendChild(chip("Launcher", backToLauncher));
      fsLabel = fsButton;

      var debugBtn = chip("Debug", function () {
        if (!debugEl) return;
        debugEl.style.display = debugEl.style.display === "none" ? "block" : "none";
        refreshPanel();
      });
      row.appendChild(debugBtn);

      volumeEl = document.createElement("div");
      volumeEl.style.cssText = "margin-top:8px;color:#9ca3af";
      volumeEl.textContent = "volume 100%";

      debugEl = document.createElement("div");
      // pre-wrap keeps the lines but folds the long ones, so the readout
      // stays inside the panel instead of running off the side of it.
      debugEl.style.cssText =
        "display:none;margin-top:8px;white-space:pre-wrap;overflow-wrap:anywhere;color:#86efac";

      var flashEl = document.createElement("div");
      flashEl.id = "__eagler_flash";
      flashEl.style.cssText =
        "margin-top:8px;color:#fcd34d;opacity:0;transition:opacity .3s ease";

      panelEl.appendChild(row);
      panelEl.appendChild(volumeEl);
      panelEl.appendChild(flashEl);
      panelEl.appendChild(debugEl);

      document.body.appendChild(panelEl);
      document.body.appendChild(button);

      button.addEventListener("click", safe(function (e) {
        e.stopPropagation();
        if (panelEl.style.display === "none") {
          panelEl.style.display = "block";
          refreshPanel();
          armPanelTimer();
        } else {
          closePanel();
        }
      }));
      panelEl.addEventListener("click", function (e) { e.stopPropagation(); });

      setInterval(safe(function () {
        if (panelEl && panelEl.style.display !== "none") refreshPanel();
      }), 1000);
    }

    installAudioMaster();

    // Sticky fullscreen for browsers without the Keyboard Lock API (Firefox):
    // Chrome exits fullscreen on Escape and never delivers that key to the
    // page, so the exit cannot be intercepted. What we can do is notice the
    // exit and put fullscreen back on the next interaction — unless the exit
    // was an intentional Escape hold.
    // With the scoped Escape lock engaged, the page *does* see Escape: a tap
    // opens the in-game menu without leaving fullscreen, and a hold (~0.6 s)
    // leaves fullscreen for good.
    var ESC_HOLD_MS = 600;
    var escHeld = false;      // Escape is physically down
    var escHoldTimer = null;

    document.addEventListener("fullscreenchange", safe(function () {
      if (isFullscreen()) {
        reenterPending = false;
        armEscLock();
      } else {
        disarmEscLock();
        if (wantFullscreen) {
          if (escHeld) {
            // The browser left fullscreen as part of the Escape hold: treat
            // the exit as intentional, do not re-enter.
            wantFullscreen = false;
            reenterPending = false;
          } else {
            // No key was seen (no lock support, or an unrelated exit): keep
            // the old sticky behaviour.
            reenterPending = true;
          }
        }
      }
      refreshPanel();
    }));

    document.addEventListener("keydown", safe(function (e) {
      if (e.key !== "Escape" && e.code !== "Escape") return;
      if (!isFullscreen()) return;

      if (e.repeat) {
        // Swallow the auto-repeat while Esc is held, so the in-game menu
        // does not flicker open and closed during the hold.
        if (escHeld) { e.preventDefault(); e.stopPropagation(); }
        return;
      }

      escHeld = true;
      clearTimeout(escHoldTimer);
      escHoldTimer = setTimeout(safe(function () {
        escHoldTimer = null;
        // An intentional exit: do not let the sticky re-enter undo it.
        wantFullscreen = false;
        reenterPending = false;
        exitFullscreen();
      }), ESC_HOLD_MS);
    }), true);

    document.addEventListener("keyup", safe(function (e) {
      if (e.key !== "Escape" && e.code !== "Escape") return;
      escHeld = false;
      clearTimeout(escHoldTimer);
      escHoldTimer = null;
    }), true);

    function restoreFullscreen() {
      if (!reenterPending) return;
      reenterPending = false;
      if (wantFullscreen && !isFullscreen()) requestFullscreen();
    }

    document.addEventListener("mousedown", safe(restoreFullscreen), true);
    document.addEventListener("touchstart", safe(restoreFullscreen), true);
    document.addEventListener("keydown", safe(restoreFullscreen), true);

    // Auto fullscreen on the first interaction. One-shot capture-phase
    // handlers: requestFullscreen() still runs inside the user gesture, so
    // Chrome allows it. The shim runs before the game's own scripts, so it
    // sees the first click on the game's main menu and goes fullscreen there.
    var autoFullscreenDone = false;

    function autoFullscreen(e) {
      if (autoFullscreenDone) return;
      autoFullscreenDone = true;
      if (isFullscreen()) return;
      wantFullscreen = true;
      requestFullscreen();
    }

    document.addEventListener("pointerdown", safe(autoFullscreen), true);
    document.addEventListener("keydown", safe(autoFullscreen), true);

    // Configurable keybinds for the panel actions.
    window.addEventListener("keydown", safe(function (e) {
      // Never fire while the player is typing (the game's chat box).
      var el = e.target;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
        return;
      }
      var sig = keySignature(e);
      if (sig === keybinds.fullscreenOn) {
        e.preventDefault();
        e.stopPropagation();
        if (!isFullscreen()) {
          wantFullscreen = true;
          requestFullscreen();
        }
        return;
      }
      if (sig === keybinds.fullscreenOff) {
        e.preventDefault();
        e.stopPropagation();
        wantFullscreen = false;
        try {
          var exit = document.exitFullscreen || document.webkitExitFullscreen;
          if (exit) exit.call(document);
        } catch (err) { /* ignore */ }
        return;
      }
      if (sig === keybinds.launcher) {
        e.preventDefault();
        e.stopPropagation();
        backToLauncher();
        return;
      }
      if (sig === keybinds.debug) {
        e.preventDefault();
        e.stopPropagation();
        if (debugEl) {
          debugEl.style.display = debugEl.style.display === "none" ? "block" : "none";
          refreshPanel();
        }
      }
    }), true);

    // Volume keys, when the browser forwards them to the page.
    window.addEventListener("keydown", safe(function (e) {
      var code = e.code || "";
      var key = e.key || "";
      if (code === "VolumeUp" || key === "AudioVolumeUp" || code === "XF86AudioRaiseVolume") {
        e.preventDefault();
        e.stopPropagation();
        adjustVolume(0.1);
      } else if (code === "VolumeDown" || key === "AudioVolumeDown" || code === "XF86AudioLowerVolume") {
        e.preventDefault();
        e.stopPropagation();
        adjustVolume(-0.1);
      }
    }), true);

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", buildPanel, { once: true });
    } else {
      buildPanel();
    }
  } catch (err) { /* ignore */ }

  /* ------------------------------------------------------------------
     2. Element fullscreen -> window fullscreen
     ------------------------------------------------------------------ */
  try {
    var requestFullscreen = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function () {
      try {
        return requestFullscreen.apply(document.documentElement, arguments);
      } catch (err) {
        return requestFullscreen.apply(this, arguments);
      }
    };
    stats.fullscreenPatched = true;
    saveStats();
  } catch (err) {
    warn("could not patch requestFullscreen:", err);
  }

  /* ------------------------------------------------------------------
     3. Back / reload keys
     ------------------------------------------------------------------ */
  window.addEventListener("keydown", safe(function (e) {
    // Hardware back button (ChromeOS / Android). The browser's own default
    // for it is history navigation, so prevent it and do it ourselves.
    if (e.code === "BrowserBack" || e.key === "BrowserBack") {
      e.preventDefault();
      e.stopPropagation();
      backToLauncher();
      return;
    }

    // F5: the game treats it as a camera shortcut, and a prevented F5 also
    // blocks the browser's reload.
    if (e.code === "F5") {
      e.preventDefault();
      e.stopPropagation();
      window.location.reload();
    }
  }), true);
})();
