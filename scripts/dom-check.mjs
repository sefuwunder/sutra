// DOM-stubbed render check for the sutra desk.
// Direct Chromium is blocked in this environment, so this is the gate for
// frontend edits: parse the REAL index.html into a minimal fake DOM, eval
// the REAL app.js with a stubbed fetch, and assert live DOM state.
// Run: node scripts/dom-check.mjs
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ROOT = new URL("..", import.meta.url).pathname;
const appSrc = readFileSync(`${ROOT}public/app.js`, "utf8");
const htmlSrc = readFileSync(`${ROOT}public/index.html`, "utf8");

// ---------- minimal fake DOM ----------
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this._class = "";
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.hidden = false;
    this.attrs = {};
    this.listeners = {};
    this.onclick = null;
    this.src = "";
    this.href = "";
    this.type = "";
  }
  get id() { return this.attrs.id || ""; }
  set id(v) { this.attrs.id = v; }
  get className() { return this._class; }
  set className(v) { this._class = v; }
  get dataset() {
    const self = this;
    return new Proxy({}, {
      get(_, k) {
        const kebab = String(k).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
        return self.attrs["data-" + kebab];
      },
    });
  }
  get classList() {
    const self = this;
    const list = () => self._class.split(/\s+/).filter(Boolean);
    return {
      toggle(name, force) {
        const set = new Set(list());
        const on = force === undefined ? !set.has(name) : !!force;
        if (on) set.add(name); else set.delete(name);
        self._class = [...set].join(" ");
        return on;
      },
      contains(name) { return list().includes(name); },
      add(name) { const set = new Set(list()); set.add(name); self._class = [...set].join(" "); },
      remove(name) { const set = new Set(list()); set.delete(name); self._class = [...set].join(" "); },
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === "string") { this.textContent += n; continue; }
      n.parent = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    if (nodes.length) this.append(...nodes);
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  click() {
    const ev = { preventDefault() {} };
    for (const fn of this.listeners.click ?? []) fn(ev);
    if (this.onclick) return this.onclick(ev);
  }
  matchesSimple(sel) {
    // tag, .class, #id, tag.class
    let tag = null, cls = null, id = null;
    const m = sel.match(/^([a-zA-Z][a-zA-Z0-9-]*)?((?:[.#][a-zA-Z0-9_-]+)*)$/);
    if (!m) return false;
    tag = m[1] || null;
    for (const part of (m[2] || "").match(/[.#][a-zA-Z0-9_-]+/g) || []) {
      if (part[0] === ".") cls = part.slice(1);
      else id = part.slice(1);
    }
    if (tag && this.tagName.toLowerCase() !== tag) return false;
    if (cls && !this._class.split(/\s+/).includes(cls)) return false;
    if (id && this.attrs.id !== id) return false;
    return true;
  }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/);
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (matchesParts(c, parts)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
}

function matchesParts(el, parts) {
  if (!el.matchesSimple(parts[parts.length - 1])) return false;
  let cur = el.parent;
  for (let i = parts.length - 2; i >= 0; i--) {
    let found = false;
    while (cur) {
      if (cur.matchesSimple(parts[i])) { found = true; cur = cur.parent; break; }
      cur = cur.parent;
    }
    if (!found) return false;
  }
  return true;
}

const VOID = new Set(["input", "img", "br", "hr", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"]);

function parseHTML(src) {
  const root = new El("div");
  root.attrs.id = "root";
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^>]*)?)\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[4] !== undefined) {
      const text = m[4].replace(/\s+/g, " ").trim();
      if (text) {
        const cur = stack[stack.length - 1];
        cur.textContent = cur.textContent ? cur.textContent + " " + text : text;
      }
      continue;
    }
    const [, close, tag, attrStr] = m;
    const tagLower = tag.toLowerCase();
    if (close) {
      if (stack.length > 1 && stack[stack.length - 1].tagName.toLowerCase() === tagLower) stack.pop();
      continue;
    }
    const el = new El(tagLower);
    for (const am of attrStr.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
      el.attrs[am[1]] = am[2] ?? "";
      if (am[1] === "class") el._class = am[2] ?? "";
      if (am[1] === "hidden") el.hidden = true;
    }
    stack[stack.length - 1].append(el);
    if (!/\/\s*$/.test(attrStr) && !VOID.has(tagLower)) stack.push(el);
  }
  return root;
}

const docRoot = parseHTML(htmlSrc);
const document = {
  _root: docRoot,
  getElementById(id) { return docRoot.querySelectorAll("#" + id)[0] ?? null; },
  createElement(tag) { return new El(tag); },
  querySelectorAll(sel) { return docRoot.querySelectorAll(sel); },
  querySelector(sel) { return docRoot.querySelector(sel); },
};

// ---------- stubbed storage + network ----------
const store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const canned = {
  "/api/tools": { tesseract: true, pdftotext: true, pdftoppm: true, ollama_ok: false, tesseract_langs: ["bod", "san"], translate_provider: "ollama", gemini_key_set: false },
  "/api/settings": { ollama_url: "http://127.0.0.1:11434", ollama_model: "", translate_provider: "ollama", gemini_model: "gemini-2.5-flash", gemini_key_set: false },
  "/api/models": { models: ["llama3"] },
  "/api/docs": { docs: [{ id: 1, title: "Test Sutra", page_count: 2, source_type: "image", filename: "t.png", ocr_lang: "bod", created_at: 1 }] },
  "/api/docs/1": {
    doc: { id: 1, title: "Test Sutra", page_count: 2, source_type: "image", filename: "t.png", ocr_lang: "bod", created_at: 1, source_url: null, source_name: null },
    pages: [
      { page_no: 1, image_path: "p1.png", source_text: "om mani padme hum", source_kind: "ocr", translation: "", notes: "", source_ref: null },
      { page_no: 2, image_path: "p2.png", source_text: "gate gate paragate", source_kind: "ocr", translation: "gone, gone", notes: "", source_ref: null },
    ],
  },
  "/api/docs/1/pages/1/translate": { __status: 400, __body: { error: "No Gemini API key saved — add one in Settings." } },
};

const fetch = async (path, opts = {}) => {
  if (path === "/api/settings" && opts.method === "PATCH") {
    const patch = JSON.parse(opts.body || "{}");
    Object.assign(canned["/api/settings"], patch);
    return { ok: true, status: 200, json: async () => canned["/api/settings"] };
  }
  const data = canned[String(path)];
  if (!data) return { ok: false, status: 404, json: async () => ({ error: "not stubbed" }) };
  if (data.__status) return { ok: false, status: data.__status, json: async () => data.__body };
  return { ok: true, status: 200, json: async () => data };
};

// ---------- run the real app ----------
const sandbox = {
  document, fetch, localStorage,
  console, setTimeout, clearTimeout,
  confirm: () => true,
  FormData: class { constructor() { this._f = {}; } append(k, v) { this._f[k] = v; } },
};
vm.createContext(sandbox);
vm.runInContext(appSrc, sandbox);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byId = (id) => document.getElementById(id);
let passed = 0, failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++;
  else { failed++; console.log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  if (ok) console.log(`PASS ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}
const studyBtns = () => byId("study").querySelectorAll("button");
const findBtn = (re) => studyBtns().find((b) => re.test(b.textContent));
const studyAreas = () => byId("study").querySelectorAll("textarea");
const area = (cls) => studyAreas().find((t) => t.className === cls);

await sleep(150); // let startup loads (tools/docs/settings) settle

// Startup: library + settings.
check("doc list has one entry", byId("doc-list").querySelectorAll("button").map((b) => b.textContent), ["Test Sutra (2p)"]);
check("tools chips rendered", byId("tools").querySelectorAll("span").length >= 4, true);
check("ollama url loaded", byId("set-url").value, "http://127.0.0.1:11434");
check("ollama segment pressed", byId("provider-seg").querySelectorAll("button").find((b) => b.dataset.provider === "ollama").getAttribute("aria-pressed"), "true");
check("gemini section hidden", byId("set-gemini").hidden, true);

// Open the doc.
byId("doc-list").querySelector("button").click();
await sleep(100);
check("viewer shows page image", byId("viewer").querySelectorAll("img").map((i) => i.src), ["/files/p1.png"]);
check("source value", area("source").value, "om mani padme hum");
check("translation value", area("translation").value, "");

// Pretty font toggle.
let prettyBtn = findBtn(/^Aa$/);
prettyBtn.click();
check("pretty class on study", byId("study").className.includes("pretty"), true);
check("pretty button pressed", findBtn(/^Aa$/).className.includes("on"), true);
check("source value survives pretty toggle", area("source").value, "om mani padme hum");
findBtn(/^Aa$/).click();
check("pretty class off after second toggle", byId("study").className.includes("pretty"), false);

// Provider switch to Gemini.
byId("provider-seg").querySelectorAll("button").find((b) => b.dataset.provider === "gemini").click();
check("gemini section shown", byId("set-gemini").hidden, false);
check("ollama section hidden", byId("set-ollama").hidden, true);
check("gemini segment pressed", byId("provider-seg").querySelectorAll("button").find((b) => b.dataset.provider === "gemini").getAttribute("aria-pressed"), "true");
check("translate button names Gemini after switch", studyBtns().map((b) => b.textContent).find((t) => t.startsWith("Translate this page")), "Translate this page (Gemini)");

// Failed translate (stubbed 400): in-flight label, then a persistent error.
const trBtn = studyBtns().find((b) => b.textContent.startsWith("Translate this page"));
trBtn.click();
check("button shows Translating… while pending", trBtn.textContent, "Translating…");
check("button disabled while pending", trBtn.disabled, true);
await sleep(100);
check("failed translate shows the error", byId("msg").textContent, "No Gemini API key saved — add one in Settings.");
check("error has err class", byId("msg").className, "err");
check("button recovers its label", trBtn.textContent, "Translate this page (Gemini)");
check("button re-enabled after failure", trBtn.disabled, false);
await sleep(6500);
check("error persists past the old 6s clear", byId("msg").textContent, "No Gemini API key saved — add one in Settings.");

// Collapsible Source section.
findBtn(/^▾ Source/).click();
check("source section collapsed", findBtn(/^▸ Source/).parent.className.includes("collapsed"), true);
check("source head chevron flips", findBtn(/^▸ Source/) !== undefined, true);
check("source text still in DOM while collapsed", area("source").value, "om mani padme hum");
findBtn(/^▸ Source/).click();
check("source section re-opens", findBtn(/^▾ Source/) !== undefined, true);

// Collapsible Translation section.
findBtn(/^▾ Translation/).click();
check("translation section collapsed", findBtn(/^▸ Translation/).parent.className.includes("collapsed"), true);
findBtn(/^▸ Translation/).click();
check("translation section re-opens", findBtn(/^▾ Translation/) !== undefined, true);

// Pretty + collapse are independent.
findBtn(/^▾ Translation/).click();
findBtn(/^Aa$/).click();
check("pretty on while translation collapsed", byId("study").className.includes("pretty"), true);
check("translation stays collapsed under pretty", findBtn(/^▸ Translation/) !== undefined, true);
findBtn(/^Aa$/).click();
check("translation still collapsed after pretty off", findBtn(/^▸ Translation/) !== undefined, true);
findBtn(/^▸ Translation/).click();

// Page navigation still works (nav lives in the viewer pane).
const viewerBtns = () => byId("viewer").querySelectorAll("button");
viewerBtns().find((b) => b.textContent === "Next ›").click();
await sleep(50);
check("page 2 source", area("source").value, "gate gate paragate");
check("page 2 translation", area("translation").value, "gone, gone");
viewerBtns().find((b) => b.textContent === "‹ Prev").click();
await sleep(50);
check("back to page 1 source", area("source").value, "om mani padme hum");

console.log(failed === 0 ? `ALL ${passed} DOM CHECKS PASSED` : `${failed} FAILURES / ${passed} passed`);
process.exitCode = failed === 0 ? 0 : 1;
