"use strict";
/* Behaviour tests for the launcher UI (index.html).
 *
 * The launcher is one inline <script> in index.html, so these tests run it
 * for real inside a small DOM stub and then look at what it did.
 *
 * The first test in this file is the regression test for the "No clients
 * available" bug: the catalog arrived after the first fetch failed, the
 * client list appeared on screen, and the launch button stayed disabled
 * with the message "No clients available" — so the user could see the
 * clients but could not play them.
 *
 * Run with: node tests/test_launcher.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { createEnv, extractInlineScript, extractSeed } = require("./dom-stub.js");

const INDEX = path.join(__dirname, "..", "index.html");
const HTML = fs.readFileSync(INDEX, "utf8");
const SCRIPT = extractInlineScript(HTML);
const SEED = extractSeed(HTML);

/* ----------------------------------------------------------------- */
/* A tiny test harness (no dependencies)                              */
/* ----------------------------------------------------------------- */

const tests = [];
let failures = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "assertion failed");
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      (message || "values differ") +
        `\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`
    );
  }
}

async function run() {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (err) {
      failures++;
      console.log(`  FAIL ${name}`);
      console.log(`       ${err && err.message}`);
      if (process.env.VERBOSE) console.log(err && err.stack);
    }
  }
  const total = tests.length;
  console.log(`\n${total - failures}/${total} launcher tests passed`);
  process.exit(failures ? 1 : 0);
}

/* ----------------------------------------------------------------- */
/* Fixtures                                                           */
/* ----------------------------------------------------------------- */

function catalog(overrides) {
  return Object.assign(
    {
      generated: "2026-10-22T01:33:42Z",
      defaultClient: "vanilla/26.2-dev-0.6",
      groups: [
        { path: "vanilla", label: "Vanilla", icon: "", order: 0, count: 1, total: 1 },
        { path: "modded", label: "Modded", icon: "", order: 1, count: 1, total: 1 },
      ],
      clients: [
        {
          id: "vanilla/26.2-dev-0.6",
          url: "clients/vanilla/26.2-dev-0.6.html",
          name: "Eaglercraft 26.2 Dev 0.6",
          version: "26.2 Dev 0.6",
          author: "o_xer",
          description: "Minecraft 26.2 in the browser",
          icon: "",
          groupPath: ["vanilla"],
          groupLabel: "Vanilla",
          recommended: true,
          size: 75606468,
        },
        {
          id: "modded/Voltan-26.2-U2.1",
          url: "clients/modded/Voltan-26.2-U2.1.html",
          name: "Voltan 26.2 U2.1",
          version: "U2.1",
          author: "Voltan",
          description: "Voltan build of Eaglercraft 26.2",
          icon: "",
          groupPath: ["modded"],
          groupLabel: "Modded",
          recommended: true,
          size: 81297756,
        },
      ],
    },
    overrides || {}
  );
}

async function boot(options) {
  const env = createEnv(
    Object.assign({ script: SCRIPT, standalone: true, seed: SEED }, options || {})
  );
  await env.settle();
  return env;
}

/* ----------------------------------------------------------------- */
/* The tests                                                           */
/* ----------------------------------------------------------------- */

test("the launch button is ready when the catalog loads", async () => {
  const env = await boot({ catalog: catalog() });
  const button = env.launchButton();
  assertEqual(button.disabled, false, "the launch button must be enabled");
  assertEqual(button.label, "Launch Client", "the launch button must say what it does");
  assertEqual(env.cards().length, 2, "both clients must be on screen");
});

test("REGRESSION: the launch button recovers when the catalog arrives late", async () => {
  // The first fetch fails (offline, flaky network, a cold service worker).
  const env = await boot({ catalog: catalog(), fetchFails: true });

  const button = env.launchButton();
  assertEqual(button.disabled, true, "without a catalog the button must be disabled");
  assert(
    /Catalog unavailable|No clients available/.test(button.label),
    `unexpected label: ${button.label}`
  );

  // The network comes back and the worker announces a fresh catalog.
  env.goOnline();
  await env.fromWorker({ type: "catalog-updated" });

  const after = env.launchButton();
  assertEqual(after.disabled, false, "the button must be usable once the catalog arrives");
  assertEqual(after.label, "Launch Client", "the button must no longer claim there are no clients");
  assertEqual(env.cards().length, 2, "the clients must be on screen");
});

test("REGRESSION: a failed refresh does not wipe the list", async () => {
  const env = await boot({ catalog: catalog() });
  assertEqual(env.cards().length, 2, "the catalog loads");

  // A background refresh fails. The list that is already on screen must
  // survive — a failed refetch means "no news", not "no clients".
  env.goOffline();
  await env.fromWorker({ type: "catalog-updated" });

  assertEqual(env.cards().length, 2, "the clients must still be on screen");
  assertEqual(env.launchButton().disabled, false, "the button must stay usable");
  assertEqual(env.launchButton().label, "Launch Client", "the label must stay correct");
});

test("the selected client survives a catalog refresh", async () => {
  const cat = catalog();
  const env = await boot({ catalog: cat });

  env.run('selectClient("modded/Voltan-26.2-U2.1")');
  assertEqual(env.get("selectedClientId"), "modded/Voltan-26.2-U2.1", "the selection changed");

  // A new build shows up in the catalog.
  cat.clients.push({
    id: "wisp/26.2-u2-wisp",
    url: "clients/wisp/26.2-u2-wisp.html",
    name: "Eaglercraft 26.2 U2 Wispcraft",
    version: "26.2 U2",
    author: "o_xer",
    description: "Update 2 build",
    icon: "",
    groupPath: ["wisp"],
    groupLabel: "Wisp",
    recommended: false,
    size: 77599527,
  });
  await env.fromWorker({ type: "catalog-updated" });

  assertEqual(env.cards().length, 3, "the new client must show up");
  assertEqual(
    env.get("selectedClientId"),
    "modded/Voltan-26.2-U2.1",
    "the selection must not jump back to the default when the catalog changes"
  );
});

test("an empty catalog says so", async () => {
  const env = await boot({ catalog: { clients: [], groups: [], defaultClient: "" } });
  assertEqual(env.launchButton().disabled, true, "the button must be disabled");
  assertEqual(env.launchButton().label, "No clients available", "the label must be clear");
});

test("a catalog that cannot be fetched says so", async () => {
  const env = await boot({ catalog: catalog(), fetchFails: true });
  assertEqual(env.launchButton().disabled, true, "the button must be disabled");
  assertEqual(env.launchButton().label, "Catalog unavailable", "the label must be clear");
  assert(
    /could not be loaded/.test(env.emptyState()),
    `unexpected empty state: ${env.emptyState()}`
  );
});

test("without the app installed the button asks for the install", async () => {
  const env = await boot({ catalog: catalog(), standalone: false });
  assertEqual(env.launchButton().disabled, true, "the button must be disabled");
  assertEqual(env.launchButton().label, "Install required", "the label must be clear");
});

test("going offline without a cached build refuses to launch", async () => {
  const env = await boot({ catalog: catalog() });
  const before = env.location.href;

  env.navigator.onLine = false;
  env.document.getElementById("launch-btn").dispatch("click", { type: "click" });
  await env.settle();

  assertEqual(env.location.href, before, "the launcher must not navigate when it cannot deliver");
  const toast = env.document.getElementById("toast");
  assert(toast.classList.contains("show"), "the user must be told why");
  assert(
    /offline/i.test(toast.innerHTML),
    `the toast must mention the offline state: ${toast.innerHTML}`
  );
});

test("the launch button follows the selection", async () => {
  const env = await boot({ catalog: catalog() });
  assertEqual(env.launchButton().disabled, false, "a client is selected by default");

  // No selection at all: there is nothing to launch.
  env.run("selectedClientId = null; updateLaunchButton();");
  assertEqual(env.launchButton().disabled, true, "with no selection the button must be disabled");
  assertEqual(env.launchButton().label, "Launch Client", "the label stays the same");
});

run();
