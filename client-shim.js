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

  function warn() {
    try { console.warn("[shim] " + Array.prototype.join.call(arguments, " ")); } catch (e) { /* ignore */ }
  }

  // Diagnostics: the launcher reads these back so we can tell whether the
  // shim actually ran, and whether the game tried to lock the keyboard.
  var stats = { time: Date.now(), lockCalls: 0, unlockCalls: 0, lockedSeen: false, fullscreenPatched: false };

  function saveStats() {
    try { localStorage.setItem("eaglercraft.shim", JSON.stringify(stats)); } catch (err) { /* ignore */ }
  }

  /* ------------------------------------------------------------------
     1. Never actually lock the keyboard
     ------------------------------------------------------------------ */
  try {
    if (navigator.keyboard) {
      // Patch the instance *and* the prototype: a caller that grabbed
      // Keyboard.prototype.lock before the shim ran would otherwise still
      // reach the real implementation.
      var noLock = function () {
        stats.lockCalls++;
        saveStats();
        warn("keyboard lock blocked — system shortcuts stay available");
        return Promise.resolve();
      };

      try {
        navigator.keyboard.lock = noLock;
      } catch (err) { /* some browsers make the property read-only */ }

      try {
        if (window.Keyboard && Keyboard.prototype) Keyboard.prototype.lock = noLock;
      } catch (err) { /* ignore */ }

      try {
        Object.defineProperty(navigator.keyboard, "lock", {
          value: noLock,
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
      setInterval(function () {
        try {
          if (navigator.keyboard.locked) {
            stats.lockedSeen = true;
            saveStats();
            release("poll");
          }
        } catch (err) { /* ignore */ }
      }, 500);
      window.addEventListener("keydown", function () {
        try {
          if (navigator.keyboard.locked) release("keydown");
        } catch (err) { /* ignore */ }
      }, true);
    }
  } catch (err) { /* ignore */ }

  // Leave a trace so the launcher can confirm the shim actually ran.
  saveStats();

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
    function toggleFullscreen() {
      try {
        var d = document;
        if (d.fullscreenElement || d.webkitFullscreenElement) {
          var exit = d.exitFullscreen || d.webkitExitFullscreen;
          if (exit) { exit.call(d); return; }
        } else {
          var target = d.documentElement;
          var request = target.requestFullscreen || target.webkitRequestFullscreen;
          if (request) { request.call(target); return; }
        }
      } catch (err) { /* ignore */ }
    }

    function backToLauncher() {
      try {
        window.history.back();
      } catch (err) {
        window.location.href = "./index.html";
      }
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
      lines.push("display-mode: " + displayMode());
      lines.push("worker controlling: " + (navigator.serviceWorker.controller ? "yes" : "no"));
      lines.push("audio master: " + (masterGain ? "yes" : "no"));
      return lines.join("\n");
    }

    var panelEl = null;
    var debugEl = null;
    var volumeEl = null;

    function refreshPanel() {
      if (!panelEl || panelEl.style.display === "none") return;
      if (debugEl && debugEl.style.display !== "none") debugEl.textContent = debugText();
      if (volumeEl) volumeEl.textContent = "volume " + Math.round(volume * 100) + "%";
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
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        onClick();
      });
      return b;
    }

    function buildPanel() {
      if (!document.body || document.getElementById("__eagler_panel")) return;

      var button = document.createElement("button");
      button.id = "__eagler_shim_btn";
      button.textContent = "⌨";
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
        "width:min(92vw,330px)",
        "padding:10px 12px",
        "border-radius:10px",
        "border:1px solid rgba(255,255,255,0.16)",
        "background:rgba(11,15,25,0.94)",
        "color:#e5e7eb",
        "font:12px/1.55 ui-monospace,Menlo,Consolas,monospace"
      ].join(";");

      var row = document.createElement("div");
      row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";

      row.appendChild(chip("Fullscreen", toggleFullscreen));
      row.appendChild(chip("Vol -", function () { adjustVolume(-0.1); }));
      row.appendChild(chip("Vol +", function () { adjustVolume(0.1); }));
      row.appendChild(chip("Launcher", backToLauncher));
      row.appendChild(chip("Close", closeTab));
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
      debugEl.style.cssText = "display:none;margin-top:8px;white-space:pre;color:#86efac";

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

      button.addEventListener("click", function (e) {
        e.stopPropagation();
        var open = panelEl.style.display === "none";
        panelEl.style.display = open ? "block" : "none";
        if (open) refreshPanel();
      });
      panelEl.addEventListener("click", function (e) { e.stopPropagation(); });

      setInterval(function () {
        if (panelEl && panelEl.style.display !== "none") refreshPanel();
      }, 1000);
    }

    installAudioMaster();

    // Volume keys, when the browser forwards them to the page.
    window.addEventListener("keydown", function (e) {
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
    }, true);

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
  window.addEventListener("keydown", function (e) {
    // Hardware back button (ChromeOS / Android). The browser's own default
    // for it is history navigation, so prevent it and do it ourselves.
    if (e.code === "BrowserBack" || e.key === "BrowserBack") {
      e.preventDefault();
      e.stopPropagation();
      try {
        window.history.back();
      } catch (err) {
        window.location.href = "./index.html";
      }
      return;
    }

    // F5: the game treats it as a camera shortcut, and a prevented F5 also
    // blocks the browser's reload.
    if (e.code === "F5") {
      e.preventDefault();
      e.stopPropagation();
      window.location.reload();
    }
  }, true);
})();
