"use strict";
/* A very small DOM stub.
 *
 * The launcher lives in one big <script> block inside index.html, so the
 * only way to test it is to run it. This stub provides just enough of the
 * browser for that: elements, a document, a window, localStorage, a
 * fetch() that answers with a catalog, and a service worker whose
 * messages the test can send.
 *
 * It is deliberately dumb — it records what the launcher did instead of
 * rendering anything. The tests then look at the recorded state.
 */

const vm = require("node:vm");

class ClassList {
  constructor() {
    this._set = new Set();
  }
  add(...names) {
    names.forEach((n) => this._set.add(n));
  }
  remove(...names) {
    names.forEach((n) => this._set.delete(n));
  }
  contains(name) {
    return this._set.has(name);
  }
  toggle(name, force) {
    const has = this._set.has(name);
    const want = force === undefined ? !has : !!force;
    if (want) this._set.add(name);
    else this._set.delete(name);
    return want;
  }
  get value() {
    return [...this._set].join(" ");
  }
  set value(text) {
    this._set = new Set(String(text).split(/\s+/).filter(Boolean));
  }
  toString() {
    return this.value;
  }
}

function matches(el, selector) {
  if (!el || !el.classList) return false;
  const sel = String(selector).trim();
  if (sel.startsWith(".")) return el.classList.contains(sel.slice(1));
  if (sel.startsWith("#")) return el.id === sel.slice(1);
  return el.tagName === sel.toUpperCase();
}

function createElement(tag, doc) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    childNodes: [],
    parentNode: null,
    style: {},
    dataset: {},
    attributes: {},
    disabled: false,
    checked: false,
    value: "",
    title: "",
    id: "",
    hidden: false,
    classList: new ClassList(),
    _listeners: new Map(),
    _text: "",
    _html: "",
  };

  Object.defineProperty(el, "className", {
    get() {
      return el.classList.value;
    },
    set(value) {
      el.classList.value = value;
    },
  });

  Object.defineProperty(el, "textContent", {
    get() {
      return el._text;
    },
    set(value) {
      el._text = value === null || value === undefined ? "" : String(value);
      el.childNodes.length = 0;
    },
  });

  Object.defineProperty(el, "innerHTML", {
    get() {
      return el._html;
    },
    set(value) {
      el._html = value === null || value === undefined ? "" : String(value);
      el.childNodes.length = 0;
    },
  });

  el.appendChild = (child) => {
    if (!child) return child;
    child.parentNode = el;
    el.childNodes.push(child);
    return child;
  };
  el.append = (...children) => {
    children.forEach((child) => {
      if (child === null || child === undefined) return;
      child.parentNode = el;
      el.childNodes.push(child);
    });
  };
  el.prepend = (...children) => {
    children.forEach((child) => {
      if (child === null || child === undefined) return;
      child.parentNode = el;
      el.childNodes.unshift(child);
    });
  };
  el.replaceChildren = (...children) => {
    el.childNodes.length = 0;
    el.append(...children);
  };
  el.removeChild = (child) => {
    const at = el.childNodes.indexOf(child);
    if (at !== -1) el.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  };
  el.remove = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  el.setAttribute = (name, value) => {
    el.attributes[name] = String(value);
    if (name === "id") {
      el.id = String(value);
      if (doc) doc._register(el);
    }
  };
  el.getAttribute = (name) =>
    Object.prototype.hasOwnProperty.call(el.attributes, name)
      ? el.attributes[name]
      : null;
  el.removeAttribute = (name) => {
    delete el.attributes[name];
  };
  el.addEventListener = (type, fn) => {
    if (!el._listeners.has(type)) el._listeners.set(type, []);
    el._listeners.get(type).push(fn);
  };
  el.removeEventListener = (type, fn) => {
    const list = el._listeners.get(type) || [];
    const at = list.indexOf(fn);
    if (at !== -1) list.splice(at, 1);
  };
  el.dispatch = (type, event) => {
    (el._listeners.get(type) || []).forEach((fn) => fn(event || { type }));
  };
  el.focus = () => {};
  el.blur = () => {};
  el.click = () => el.dispatch("click", { type: "click", target: el });
  el.closest = (selector) => {
    let node = el;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  };
  el.matches = (selector) => matches(el, selector);
  el.querySelectorAll = (selector) => {
    const out = [];
    const walk = (node) => {
      node.childNodes.forEach((child) => {
        if (matches(child, selector)) out.push(child);
        walk(child);
      });
    };
    walk(el);
    return out;
  };
  el.querySelector = (selector) => el.querySelectorAll(selector)[0] || null;

  return el;
}

/**
 * Build a browser-ish environment and run the launcher's script in it.
 *
 * @param {object} options
 *   script      the launcher source to run (required)
 *   catalog     the catalog the fake fetch() answers with
 *   offline     when true, every fetch() fails (the "no network" case)
 *   standalone  whether the page looks like an installed PWA (default true)
 *   withWorker  whether navigator.serviceWorker exists (default true)
 *   stored      { key: value } to preload into localStorage
 */
function createEnv(options) {
  const opts = options || {};
  const catalog = opts.catalog || { clients: [], groups: [], defaultClient: "" };
  const listeners = { window: new Map(), document: new Map() };

  const fetchLog = [];
  let fetchShouldFail = !!opts.fetchFails;

  const document = {
    hidden: false,
    visibilityState: "visible",
    _byId: new Map(),
    _register(el) {
      if (el.id) this._byId.set(el.id, el);
    },
    getElementById(id) {
      if (!this._byId.has(id)) {
        const el = createElement("div", this);
        el.id = id;
        const seed = opts.seed && opts.seed.get(id);
        if (seed) el.textContent = seed;
        this._byId.set(id, el);
      }
      return this._byId.get(id);
    },
    createElement(tag) {
      return createElement(tag, this);
    },
    querySelector(selector) {
      if (selector === ".hint") {
        const el = this.createElement("p");
        return el;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener(type, fn) {
      if (!listeners.document.has(type)) listeners.document.set(type, []);
      listeners.document.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type, event) {
      (listeners.document.get(type) || []).forEach((fn) => fn(event || { type }));
    },
  };
  document.body = createElement("body", document);
  document.documentElement = createElement("html", document);
  document.head = createElement("head", document);

  const storage = new Map(Object.entries(opts.stored || {}));
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
    get length() {
      return storage.size;
    },
    key: (i) => [...storage.keys()][i] ?? null,
  };

  const swListeners = [];
  const registration = {
    scope: "https://example.test/",
    addEventListener() {},
    removeEventListener() {},
    update() {
      return Promise.resolve();
    },
  };
  const serviceWorker = {
    controller: {
      scriptURL: "https://example.test/sw.js",
      postMessage() {},
    },
    register() {
      return Promise.resolve(registration);
    },
    ready: Promise.resolve(registration),
    addEventListener(type, fn) {
      if (type === "message") swListeners.push(fn);
    },
    removeEventListener() {},
  };

  const navigator = {
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/154.0.0.0",
    platform: "Linux x86_64",
    language: "en-US",
    languages: ["en-US"],
    onLine: !opts.offline,
    hardwareConcurrency: 4,
    deviceMemory: 8,
    maxTouchPoints: 0,
    serviceWorker: opts.withWorker === false ? undefined : serviceWorker,
  };

  const location = {
    protocol: "https:",
    href: "https://example.test/index.html",
    origin: "https://example.test",
    pathname: "/index.html",
    search: opts.search || "",
    assign(url) {
      location.href = new URL(url, location.href).href;
    },
    replace(url) {
      location.href = new URL(url, location.href).href;
    },
  };

  const window = {
    location,
    navigator,
    localStorage,
    sessionStorage: localStorage,
    document,
    console,
    setTimeout: (fn, ms, ...args) => {
      const timer = setTimeout(fn, ms, ...args);
      // Unref: a pending toast timer must not keep the test process alive.
      if (timer && timer.unref) timer.unref();
      return timer;
    },
    clearTimeout: (id) => clearTimeout(id),
    // The launcher polls the catalog every minute; the tests never want to
    // wait for that, and a live interval would keep node running.
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    matchMedia(query) {
      const standalone = query.includes("standalone");
      return {
        media: query,
        matches: standalone ? !!opts.standalone : false,
        addEventListener() {},
        removeEventListener() {},
      };
    },
    addEventListener(type, fn) {
      if (!listeners.window.has(type)) listeners.window.set(type, []);
      listeners.window.get(type).push(fn);
    },
    removeEventListener() {},
    dispatch(type, event) {
      (listeners.window.get(type) || []).forEach((fn) => fn(event || { type }));
    },
    open: () => null,
    alert() {},
    confirm: () => true,
  };
  window.window = window;
  window.self = window;
  window.globalThis = window;

  async function fakeFetch(url) {
    fetchLog.push(String(url));
    if (fetchShouldFail) {
      throw new Error("network down");
    }
    const target = String(url);
    if (target.includes("clients/index.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(JSON.stringify(catalog)),
      };
    }
    if (target.includes("clients.json")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (target.includes("manifest.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: "Eaglercraft Launcher", icons: [] }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }

  const sandbox = {
    window,
    document,
    navigator,
    localStorage,
    sessionStorage: localStorage,
    location,
    console,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    requestAnimationFrame: window.requestAnimationFrame,
    matchMedia: window.matchMedia,
    addEventListener: window.addEventListener,
    removeEventListener: window.removeEventListener,
    dispatchEvent: window.dispatch,
    fetch: fakeFetch,
    URL,
    TextEncoder,
    TextDecoder,
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);

  const api = {
    context,
    window,
    document,
    navigator,
    localStorage,
    location,
    fetchLog,
    listeners,
    swListeners,
    /** Send a message from the service worker to the launcher. */
    async fromWorker(message) {
      swListeners.forEach((fn) => fn({ data: message }));
      await api.settle();
    },
    /** Let the pending promises resolve. */
    async settle(rounds = 8) {
      for (let i = 0; i < rounds; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    /** Break the network from now on. */
    goOffline() {
      fetchShouldFail = true;
      navigator.onLine = false;
    },
    /** Bring the network back. */
    goOnline() {
      fetchShouldFail = false;
      navigator.onLine = true;
    },
    /** The launch button, as the user sees it. */
    launchButton() {
      const btn = document.getElementById("launch-btn");
      return {
        disabled: !!btn.disabled,
        label: btn.textContent,
      };
    },
    /** The client cards currently on screen. */
    cards() {
      return document
        .getElementById("client-list")
        .querySelectorAll(".client-card")
        .map((card) => ({
          id: card.dataset.id,
          name: card.querySelectorAll(".client-name").map((n) => n.textContent)[0] || "",
        }));
    },
    /** The text of the empty state, if there is one. */
    emptyState() {
      const list = document.getElementById("client-list");
      const found = list.querySelectorAll(".empty-state");
      return found.length ? found[0].textContent : "";
    },
    /** Read a variable out of the launcher's script scope. */
    get(expression) {
      return vm.runInContext(expression, context);
    },
    /** Run a statement inside the launcher's script scope. */
    run(statement) {
      return vm.runInContext(statement, context);
    },
  };

  if (opts.script) {
    vm.runInContext(opts.script, context, { filename: "index.html:script" });
  }

  return api;
}

/**
 * Pull the launcher's inline <script> out of index.html.
 */
function extractInlineScript(html) {
  const blocks = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    if (/\bsrc\s*=/.test(match[1])) continue;
    blocks.push(match[2]);
  }
  if (!blocks.length) {
    throw new Error("no inline <script> found in index.html");
  }
  return blocks[blocks.length - 1];
}

/**
 * The starting text of the elements that have an id, so the stub starts
 * out looking like the real page (a button labelled "Launch Client" and
 * not an empty box).
 */
function extractSeed(html) {
  const seed = new Map();
  const re = /<([a-zA-Z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>([\s\S]{0,400}?)<\/\1>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    seed.set(match[3], match[4].replace(/<[^>]*>/g, "").trim());
  }
  return seed;
}

module.exports = { createEnv, extractInlineScript, extractSeed };
