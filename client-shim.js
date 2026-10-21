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

  /* ------------------------------------------------------------------
     1. Never actually lock the keyboard
     ------------------------------------------------------------------ */
  try {
    if (navigator.keyboard) {
      navigator.keyboard.lock = function () {
        warn("keyboard lock blocked — system shortcuts stay available");
        return Promise.resolve();
      };
    }
  } catch (err) {
    warn("could not patch keyboard.lock:", err);
  }

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
