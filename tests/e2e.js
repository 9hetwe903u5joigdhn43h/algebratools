"use strict";
/* End-to-end test: a real browser, the real launcher.
 *
 * Chromium is driven over the DevTools protocol (no puppeteer needed —
 * node has a WebSocket client built in). The test:
 *
 *   1. loads the launcher over http://localhost,
 *   2. checks that the clients are on screen and the launch button is
 *      usable (the "No clients available" bug),
 *   3. opens the diagnostics panel and waits for it to fill in,
 *   4. fails on any console error or uncaught exception.
 *
 * Run with: node tests/e2e.js [url]
 * It is skipped when there is no chromium on the machine.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

// ?debug lifts the "install the PWA first" block, so the launcher can be
// driven in a plain browser tab.
const URL_ARG = process.argv[2] || "http://localhost:8123/index.html?debug";

/* ----------------------------------------------------------------- */
/* Finding a browser                                                  */
/* ----------------------------------------------------------------- */

function findChromium() {
  const candidates = [
    process.env.CHROME_PATH,
    // Where browser-actions/setup-chrome puts it.
    "/opt/hostedtoolcache/setup-chrome/chromium/stable/x64/chrome",
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
    // The name browser-actions/setup-chrome gives its binary; the action
    // puts its directory on the PATH.
    "chrome",
    "chrome-headless-shell",
  ].filter(Boolean);

  const found = [];
  for (const candidate of candidates) {
    try {
      const path = execFileSync("which", [candidate], { encoding: "utf8" }).trim();
      if (path && !found.includes(path)) found.push(path);
    } catch (err) { /* not on the path */ }
    // A full path does not need to be on the PATH.
    if (candidate.startsWith("/") && fs.existsSync(candidate) && !found.includes(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

/* ----------------------------------------------------------------- */
/* A tiny DevTools protocol client                                    */
/* ----------------------------------------------------------------- */

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.consoleErrors.push(
          message.params.args.map((a) => a.value ?? a.description ?? "").join(" ")
        );
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails || {};
        this.exceptions.push(
          details.exception?.description || details.text || "unknown exception"
        );
      }
    });
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(method + " timed out"));
        }
      }, 30000).unref();
    });
  }

  async evaluate(expression) {
    // The launcher reloads itself when a new service worker takes over
    // (the controllerchange handler). That destroys the execution context
    // mid-test, so a failed evaluation is retried once, after the page
    // has come back.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.send("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails) {
          const details = result.exceptionDetails;
          const description = details.exception?.description || details.text || "";
          // A destroyed context looks like a strange syntax error.
          if (/SyntaxError|context|Cannot find/i.test(description) && attempt === 0) {
            await this.waitForPage();
            continue;
          }
          throw new Error(
            "the page threw: " + description +
              "\n      while evaluating: " +
              expression.replace(/\s+/g, " ").slice(0, 200)
          );
        }
        return result.result.value;
      } catch (err) {
        if (attempt === 0 && /context|Cannot find|SyntaxError/i.test(err.message)) {
          await this.waitForPage();
          continue;
        }
        throw err;
      }
    }
    throw new Error("the evaluation never completed");
  }

  /** Wait until the page is there again after a reload. */
  async waitForPage() {
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        const ready = await this.send("Runtime.evaluate", {
          expression: "!!document.getElementById('launch-btn')",
          returnByValue: true,
        });
        if (ready.result?.result?.value) return;
      } catch (err) { /* still loading */ }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ----------------------------------------------------------------- */
/* The test                                                           */
/* ----------------------------------------------------------------- */

const checks = [];
let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    checks.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    checks.push({ name, ok: false });
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log(`       ${detail}`);
  }
}

/* ----------------------------------------------------------------- */
/* Starting the browser                                               */
/* ----------------------------------------------------------------- */

// The flags every candidate gets. "--headless" on its own works on every
// version of Chrome and Chromium; the newer "--headless=new" is not
// accepted everywhere.
const BROWSER_FLAGS = [
  "--headless",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--remote-debugging-port=0",
];

/**
 * Start a browser and wait for it to open its debugging port.
 *
 * Returns { proc, profile, port } or null when the browser would not
 * start — a machine without a usable browser is not a broken launcher.
 */
async function startBrowser(binary) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "algebratools-e2e-"));
  const portFile = path.join(profile, "DevToolsActivePort");

  const proc = spawn(
    binary,
    [...BROWSER_FLAGS, "--user-data-dir=" + profile, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  proc.on("error", () => { /* the spawn failed; the port never comes */ });

  for (let i = 0; i < 150; i++) {
    await sleep(100);
    if (fs.existsSync(portFile)) {
      const content = fs.readFileSync(portFile, "utf8").split("\n");
      if (content[0] && content[0].trim()) {
        return { proc, profile, port: content[0].trim(), stderr: () => stderr };
      }
    }
    if (proc.exitCode !== null) break;   // it gave up
  }

  try {
    proc.kill("SIGKILL");
  } catch (err) { /* already gone */ }
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch (err) { /* ignore */ }
  return null;
}

async function main() {
  const candidates = findChromium();
  if (!candidates.length) {
    console.log("no browser found — skipping the browser test");
    return 0;
  }

  let browser = null;
  for (const binary of candidates) {
    browser = await startBrowser(binary);
    if (browser) break;
    console.log(`  ..   ${binary} would not start, trying the next one`);
  }

  if (!browser) {
    console.log("no browser would start — skipping the browser test");
    return 0;
  }

  const { proc, profile, port } = browser;

  const cleanup = () => {
    try {
      proc.kill("SIGKILL");
    } catch (err) { /* already gone */ }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (err) { /* ignore */ }
  };

  try {
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");

    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", () => reject(new Error("the socket failed")));
    });

    const cdp = new Cdp(socket);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    // 1. Load the launcher.
    await cdp.send("Page.navigate", { url: URL_ARG });
    await sleep(2500);

    const state = await cdp.evaluate(`(function () {
      var btn = document.getElementById("launch-btn");
      return {
        cards: document.querySelectorAll(".client-card").length,
        label: btn ? btn.textContent : null,
        disabled: btn ? !!btn.disabled : null,
        title: document.title
      };
    })()`);

    check("the launcher loads", state.title.includes("Eaglercraft"), state.title);
    check("the clients are on screen", state.cards > 0, `${state.cards} cards`);
    check(
      "the launch button is usable",
      state.disabled === false && state.label === "Launch Client",
      `label=${state.label} disabled=${state.disabled}`
    );

    // 2. The button follows the client list — the bug that made the
    //    launcher say "No clients available" while the clients were
    //    right there on the screen.
    const emptyState = await cdp.evaluate(`(function () {
      clients = [];
      renderClients();
      var btn = document.getElementById("launch-btn");
      return { label: btn.textContent, disabled: !!btn.disabled };
    })()`);
    check(
      "an empty catalog disables the button",
      emptyState.disabled === true && /No clients|Catalog/.test(emptyState.label),
      `label=${emptyState.label} disabled=${emptyState.disabled}`
    );

    const recovered = await cdp.evaluate(`(function () {
      return loadClients().then(function () {
        var btn = document.getElementById("launch-btn");
        return {
          label: btn.textContent,
          disabled: !!btn.disabled,
          cards: document.querySelectorAll(".client-card").length
        };
      });
    })()`);
    check(
      "the button comes back when the catalog arrives",
      recovered.disabled === false && recovered.label === "Launch Client" &&
        recovered.cards > 0,
      `label=${recovered.label} disabled=${recovered.disabled} cards=${recovered.cards}`
    );

    // 3. The diagnostics panel.
    await cdp.evaluate("openDiagnostics()");
    let body = "";
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      body = await cdp.evaluate(
        'document.getElementById("diag-body").textContent.trim().slice(0, 400)'
      );
      if (body && body !== "Collecting…" && body !== "Loading…") break;
    }
    check(
      "the diagnostics panel fills in",
      body.length > 20 && body !== "Collecting…",
      `body=${JSON.stringify(body)}`
    );
    check(
      "the diagnostics show the catalog",
      /clients/.test(body),
      body.slice(0, 200)
    );

    // 3b. The worker has to answer the questions the panel asks.
    const worker = await cdp.evaluate(`collectDiagnostics().then(function (r) {
      return { details: r.worker.details, caches: r.worker.caches, persisted: r.storage.persisted };
    })`);
    check(
      "the service worker answers the diagnostics",
      !!(worker.details && worker.details.cacheName),
      JSON.stringify(worker.details)
    );
    check(
      "the diagnostics list the caches",
      Array.isArray(worker.caches),
      JSON.stringify(worker.caches)
    );

    const cleared = await cdp.evaluate(
      'askWorker({ type: "clear-caches", what: "clients" }, 20000)'
    );
    check(
      "the worker can clear a cache on request",
      !!(cleared && cleared.ok),
      JSON.stringify(cleared)
    );

    // Clearing the launcher cache has to leave the launcher working: the
    // shell is put straight back.
    const clearedShell = await cdp.evaluate(
      'askWorker({ type: "clear-caches", what: "launcher" }, 20000)'
    );
    check(
      "the worker can clear the launcher cache",
      !!(clearedShell && clearedShell.ok),
      JSON.stringify(clearedShell)
    );
    const shell = await cdp.evaluate(`askWorker({ type: "worker-info" }).then(function (info) {
      if (!info) return 0;
      return caches.open(info.cacheName).then(function (cache) {
        return cache.keys().then(function (keys) { return keys.length; });
      });
    })`);
    check(
      "the shell is precached again afterwards",
      shell !== null && shell > 0,
      String(shell)
    );

    // 4. The client shim: it has to run, patch what it patches, and
    //    remember the errors it sees so the launcher can show them.
    const shimPage = URL_ARG.split("?")[0].replace(/index\.html$/, "tests/shim-test.html");
    await cdp.send("Page.navigate", { url: shimPage });
    await sleep(2000);

    const shim = await cdp.evaluate(`(function () {
      return {
        title: document.title,
        stats: window.__shimStats || null,
        log: window.__shimLog || null,
        panel: !!document.getElementById("__eagler_shim_btn"),
        panelVisible: !!document.getElementById("__eagler_panel")
      };
    })()`);

    check("the shim runs on a client page", shim.title === "shim ran", shim.title);
    check("the shim builds its panel", shim.panel && shim.panelVisible);
    check(
      "the shim patches the fullscreen request",
      !!(shim.stats && shim.stats.fullscreenPatched),
      JSON.stringify(shim.stats)
    );
    check(
      "the shim remembers the errors it sees",
      Array.isArray(shim.log) && shim.log.some((e) => /shim test error/.test(e.message || "")),
      JSON.stringify(shim.log)
    );

    // 5. Nothing blew up on the way.
    // The shim test throws an error on purpose — that one is expected, so
    // the log is cleared before the launcher is judged.
    cdp.exceptions = [];
    cdp.consoleErrors = [];

    await cdp.send("Page.navigate", { url: URL_ARG });
    await sleep(1500);

    check(
      "no uncaught exceptions",
      cdp.exceptions.length === 0,
      cdp.exceptions.join("\n")
    );
    check(
      "no console errors",
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join("\n")
    );

    socket.close();
  } catch (err) {
    failures++;
    console.log(`  FAIL the browser test could not run: ${err.message}`);
  } finally {
    cleanup();
  }

  const total = checks.length;
  console.log(`\n${total - failures}/${total} browser checks passed`);
  return failures ? 1 : 0;
}

main().then((code) => process.exit(code));
