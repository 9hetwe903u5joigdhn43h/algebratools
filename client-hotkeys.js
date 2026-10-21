/* Launcher hotkeys for the Eaglercraft clients.
 *
 * This file is the source of truth; `inject-hotkeys.py` inlines it into each
 * client build (Eagler-*.html) right after the opening <body> tag. The game
 * itself swallows keydown events, so without this the browser-level keys
 * (F11 fullscreen, F5 reload, Alt+Left back) never reach the user.
 *
 * Key map:
 *   F11               toggle fullscreen (Fullscreen API)
 *   F5 / Ctrl+R       reload the client
 *   Alt+Left          back to the launcher
 *   F6 / VolumeDown   volume down
 *   F7 / VolumeUp     volume up
 *   F8 / VolumeMute   mute toggle
 */
(function () {
  "use strict";

  if (window.__eaglerHotkeys) return;

  var VOLUME_STEP = 0.1;
  var state = {
    volume: 1,
    muted: false,
    master: null,
    ctx: null
  };

  /* ------------------------------------------------------------------
     HUD
     ------------------------------------------------------------------ */
  function hud() {
    var el = document.getElementById("__eagler_hotkeys_hud");
    if (el) return el;
    if (!document.body) return null;
    el = document.createElement("div");
    el.id = "__eagler_hotkeys_hud";
    el.style.cssText = [
      "position:fixed",
      "right:12px",
      "bottom:12px",
      "z-index:2147483647",
      "font:600 13px/1.45 ui-monospace,Menlo,Consolas,monospace",
      "color:#e5e7eb",
      "background:rgba(11,15,25,0.85)",
      "border:1px solid rgba(255,255,255,0.14)",
      "border-radius:10px",
      "padding:8px 12px",
      "pointer-events:none",
      "opacity:0",
      "transition:opacity .25s ease",
      "white-space:pre"
    ].join(";");
    document.body.appendChild(el);
    return el;
  }

  var hudTimer = null;

  function flash(text, ms) {
    var el = hud();
    if (!el) return;
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(hudTimer);
    hudTimer = setTimeout(function () { el.style.opacity = "0"; }, ms || 1600);
  }

  /* ------------------------------------------------------------------
     Audio master gain — lets the volume keys scale the game's sound
     ------------------------------------------------------------------ */
  function installAudioMaster() {
    var Real = window.AudioContext || window.webkitAudioContext;
    if (!Real || Real.__eaglerHotkeysPatched) return;

    function Wrapped() {
      var ctx = Reflect.construct(Real, Array.prototype.slice.call(arguments), Wrapped);
      state.ctx = ctx;
      try {
        var master = ctx.createGain();
        master.gain.value = state.muted ? 0 : state.volume;
        master.connect(ctx.destination);
        state.master = master;
      } catch (err) {
        console.warn("[hotkeys] audio master failed:", err);
      }
      return ctx;
    }
    Wrapped.prototype = Real.prototype;
    Wrapped.__eaglerHotkeysPatched = true;
    window.AudioContext = Wrapped;
    if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;

    // Anything that used to go straight to the speakers now goes through the
    // master gain, so the volume keys scale every sound the game plays.
    try {
      var proto = window.AudioNode && window.AudioNode.prototype;
      var origConnect = proto.connect;
      proto.connect = function (dest) {
        var args = arguments;
        try {
          if (state.master && this !== state.master && dest &&
              state.ctx && dest === state.ctx.destination) {
            dest = state.master;
          }
        } catch (err) { /* fall through to the original connect */ }
        return origConnect.apply(this, args);
      };
    } catch (err) {
      console.warn("[hotkeys] connect patch failed:", err);
    }
  }

  function applyVolume() {
    if (!state.master) return;
    try {
      state.master.gain.value = state.muted ? 0 : state.volume;
    } catch (err) { /* context gone */ }
  }

  function volumeLabel() {
    if (state.muted) return "Muted";
    return "Volume " + Math.round(state.volume * 100) + "%";
  }

  function adjustVolume(direction) {
    if (direction > 0) {
      state.volume = Math.min(1, Math.round((state.volume + VOLUME_STEP) * 100) / 100);
      state.muted = false;
    } else {
      state.volume = Math.max(0, Math.round((state.volume - VOLUME_STEP) * 100) / 100);
    }
    applyVolume();
    flash(volumeLabel());
  }

  function toggleMute() {
    state.muted = !state.muted;
    applyVolume();
    flash(volumeLabel());
  }

  /* ------------------------------------------------------------------
     Actions
     ------------------------------------------------------------------ */
  function toggleFullscreen() {
    var d = document;
    try {
      if (d.fullscreenElement || d.webkitFullscreenElement) {
        var exit = d.exitFullscreen || d.webkitExitFullscreen;
        if (exit) {
          Promise.resolve(exit.call(d)).then(
            function () { flash("Fullscreen off"); },
            function () { flash("Fullscreen off"); }
          );
          return;
        }
      } else {
        var target = d.documentElement;
        var request = target.requestFullscreen || target.webkitRequestFullscreen;
        if (request) {
          Promise.resolve(request.call(target)).then(
            function () { flash("Fullscreen on"); },
            function () { flash("Fullscreen blocked"); }
          );
          return;
        }
      }
    } catch (err) {
      console.warn("[hotkeys] fullscreen failed:", err);
    }
    flash("Fullscreen unavailable");
  }

  function reloadClient() {
    flash("Reloading…");
    setTimeout(function () { window.location.reload(); }, 60);
  }

  function backToLauncher() {
    flash("Back to launcher");
    setTimeout(function () {
      try {
        window.history.back();
      } catch (err) {
        window.location.href = "./index.html";
      }
    }, 60);
  }

  /* ------------------------------------------------------------------
     Key handling
     ------------------------------------------------------------------ */
  function volumeDirection(code, key) {
    if (code === "VolumeUp" || key === "AudioVolumeUp" || code === "XF86AudioRaiseVolume") return 1;
    if (code === "VolumeDown" || key === "AudioVolumeDown" || code === "XF86AudioLowerVolume") return -1;
    if (code === "F7") return 1;
    if (code === "F6") return -1;
    return 0;
  }

  function isMuteKey(code, key) {
    return code === "F8" || key === "AudioVolumeMute" || code === "XF86AudioMute";
  }

  function onKeyDown(e) {
    var code = e.code || "";
    var key = e.key || "";

    if (code === "F11" || key === "F11") {
      e.preventDefault();
      e.stopPropagation();
      toggleFullscreen();
      return;
    }

    if (code === "F5" || (e.ctrlKey && (key === "r" || key === "R"))) {
      e.preventDefault();
      e.stopPropagation();
      reloadClient();
      return;
    }

    if ((e.altKey && key === "ArrowLeft") || code === "BrowserBack") {
      e.preventDefault();
      e.stopPropagation();
      backToLauncher();
      return;
    }

    var direction = volumeDirection(code, key);
    if (direction !== 0) {
      e.preventDefault();
      e.stopPropagation();
      adjustVolume(direction);
      return;
    }

    if (isMuteKey(code, key)) {
      e.preventDefault();
      e.stopPropagation();
      toggleMute();
    }
  }

  /* ------------------------------------------------------------------
     Boot
     ------------------------------------------------------------------ */
  installAudioMaster();
  window.addEventListener("keydown", onKeyDown, true);

  window.__eaglerHotkeys = {
    state: state,
    toggleFullscreen: toggleFullscreen,
    reloadClient: reloadClient,
    backToLauncher: backToLauncher,
    adjustVolume: adjustVolume,
    toggleMute: toggleMute,
    volumeLabel: volumeLabel
  };

  function showHints() {
    var el = hud();
    if (!el) return;
    el.textContent = [
      "F11 fullscreen · F5 reload · Alt+← back",
      "F7 / F6 volume · F8 mute"
    ].join("\n");
    el.style.opacity = "1";
    setTimeout(function () { el.style.opacity = "0"; }, 5000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", showHints, { once: true });
  } else {
    showHints();
  }
})();
