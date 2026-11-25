"use strict";

// Unit-level coverage for the #f-date "dirty flag" fix in
// admin/public/index.html: editing an existing post and saving it WITHOUT
// touching the date field must send no `date` key at all, even though the
// field is prefilled with a parseable value by editPost(). Only a genuine
// user edit of the field (an 'input' event) should cause save() to include
// `date` in the request payload.
//
// This repo has no browser/DOM test runner (no jsdom, no puppeteer/playwright
// -- see package.json), and the admin editor is a single self-contained IIFE
// with nothing exported. Rather than hand-copy the logic into a
// reimplementation (which would test a second copy of the logic, not the
// real one, and could silently drift from it), this test extracts the exact
// function/statement text it needs straight out of admin/public/index.html
// at run time via brace-matched slicing, and runs that real source in a
// `vm` sandbox against a small hand-built fake DOM. If the guarded lines in
// the real file are renamed or restructured, extraction fails loudly (the
// test errors out) rather than silently testing stale code.
//
// The server-side half of this contract ("update without date preserves the
// original") is already covered end-to-end via real HTTP routes in
// test/post-date.test.js; this file covers the client-side half the
// reviewer flagged as the actual gap.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC_PATH = path.join(__dirname, "..", "admin", "public", "index.html");
const SRC = fs.readFileSync(SRC_PATH, "utf8");

// Slices `src` from the start of `marker` (which must end in "{") through
// the matching closing brace, tracking quoted strings so braces inside
// string literals don't confuse the count.
function extractBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("editor-date-dirty test: could not find marker in index.html: " + JSON.stringify(marker));
  if (marker[marker.length - 1] !== "{") throw new Error("marker must end with '{': " + marker);
  let i = start + marker.length - 1; // index of marker's own opening brace
  let depth = 1;
  i++;
  let inSingle = false;
  let inDouble = false;
  let escape = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (inSingle) { if (c === "'") inSingle = false; continue; }
    if (inDouble) { if (c === '"') inDouble = false; continue; }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  if (depth !== 0) throw new Error("editor-date-dirty test: unbalanced braces extracting: " + marker);
  return src.slice(start, i);
}

function extractLine(src, needle) {
  if (!src.includes(needle)) {
    throw new Error("editor-date-dirty test: could not find exact line in index.html: " + JSON.stringify(needle));
  }
  return needle;
}

const dateFieldDirtyDecl = extractLine(SRC, "var dateFieldDirty = false;");
const elFn = extractBlock(SRC, "function el(id) {");
const toDatetimeLocalValueFn = extractBlock(SRC, "function toDatetimeLocalValue(iso) {");
const syncDateFieldVisibilityFn = extractBlock(SRC, "function syncDateFieldVisibility() {");
const dirtyListenerLine = extractLine(SRC, "el('f-date').addEventListener('input', function () { dateFieldDirty = true; });");
const resetFormFn = extractBlock(SRC, "function resetForm() {");
const editPostFn = extractBlock(SRC, "function editPost(type, slug) {");
const saveFn = extractBlock(SRC, "function save(status) {");

const harnessScript = [
  "var currentEditSlug = null;",
  "var currentEditType = null;",
  "var currentEditStatus = 'published';",
  dateFieldDirtyDecl,
  elFn,
  toDatetimeLocalValueFn,
  syncDateFieldVisibilityFn,
  dirtyListenerLine,
  resetFormFn,
  editPostFn,
  saveFn,
  "var __exports = { resetForm: resetForm, editPost: editPost, save: save, syncDateFieldVisibility: syncDateFieldVisibility, toDatetimeLocalValue: toDatetimeLocalValue, el: el, __getDirty: function () { return dateFieldDirty; } };",
].join("\n\n");

// ---- minimal fake DOM -------------------------------------------------

function makeElement(id) {
  const listeners = {};
  return {
    id: id,
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    textContent: "",
    className: "",
    innerHTML: "",
    addEventListener: function (type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatch: function (type, evt) {
      (listeners[type] || []).forEach(function (fn) { fn(evt || {}); });
    },
  };
}

// A minimal <input type=radio name=type> stand-in: checking one unchecks
// its groupmates, matching real radio-button semantics (the production code
// relies on this -- it only ever sets one radio's `.checked = true` and
// expects the other to become false as a side effect).
function makeRadio(name, value, group) {
  let _checked = false;
  const listeners = {};
  const radio = {
    name: name,
    value: value,
    get checked() { return _checked; },
    set checked(v) {
      _checked = !!v;
      if (_checked) group.forEach(function (r) { if (r !== radio) r._forceUnchecked(); });
    },
    _forceUnchecked: function () { _checked = false; },
    addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  group.push(radio);
  return radio;
}

function makeFakeDom() {
  const elements = new Map();
  const radios = [];
  makeRadio("type", "post", radios);
  makeRadio("type", "page", radios);
  radios[0].checked = true; // matches the real form's `checked` attribute on the Post radio

  const document = {
    getElementById: function (id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector: function (sel) {
      if (sel === "input[name=type]:checked") return radios.find(function (r) { return r.checked; }) || null;
      const m = sel.match(/^input\[name=type\]\[value=(post|page)\]$/);
      if (m) return radios.find(function (r) { return r.value === m[1]; }) || null;
      return null;
    },
    querySelectorAll: function (sel) {
      if (sel === "input[name=type]") return radios.slice();
      return [];
    },
  };
  return { document: document, elements: elements, radios: radios };
}

function makeFetchStub(routes) {
  const calls = [];
  function fetchStub(url, init) {
    calls.push({ url: url, init: init || {} });
    const handler = routes.find(function (r) { return r.match(url, init); });
    if (!handler) return Promise.reject(new Error("Unhandled fetch in test stub: " + url + " " + ((init && init.method) || "GET")));
    return Promise.resolve({
      ok: handler.ok !== false,
      json: function () { return Promise.resolve(handler.response); },
    });
  }
  fetchStub.calls = calls;
  return fetchStub;
}

function flush() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

function buildSandbox(fetchStub) {
  const dom = makeFakeDom();
  const sandbox = {
    document: dom.document,
    fetch: fetchStub,
    tagInput: { clear: function () {}, set: function () {}, get: function () { return []; } },
    editor: { setMarkdown: function () {}, getMarkdown: function () { return "body"; } },
    setEditorMode: function () {},
    showPreviewButton: function () {},
    activateTab: function () {},
    setStatus: function () {},
    setSavedBanner: function () {},
    loadMeta: function () {},
    console: console,
    setImmediate: setImmediate,
    Date: Date,
    JSON: JSON,
    Promise: Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(harnessScript, sandbox, { filename: "extracted-editor-date-dirty.js" });
  return { sandbox: sandbox, dom: dom };
}

// ---- tests --------------------------------------------------------------

test("editing an existing post without touching #f-date sends no date in the PUT payload", async () => {
  const existingPost = {
    slug: "existing-post",
    type: "post",
    title: "Existing Post",
    date: "2016-10-14T11:53:07.000Z",
    postTags: [],
    status: "published",
    body: "Body text.",
  };
  const fetchStub = makeFetchStub([
    { match: (url) => url === "/admin/api/post/post/existing-post", response: existingPost },
    {
      match: (url, init) => url === "/admin/api/post/post/existing-post" && init.method === "PUT",
      response: { ok: true, type: "post", slug: "existing-post", status: "published", url: "/existing-post/" },
    },
  ]);
  const { sandbox } = buildSandbox(fetchStub);
  const ex = sandbox.__exports;

  ex.editPost("post", "existing-post");
  await flush();

  // Sanity: the field really was prefilled with a parseable, non-blank value
  // (this is what makes the bug real -- "non-empty" is not "user touched it").
  assert.notStrictEqual(ex.el("f-date").value, "");
  assert.strictEqual(ex.__getDirty(), false, "prefill must not mark the field dirty");

  ex.save("published");
  await flush();

  const putCall = fetchStub.calls.find((c) => c.init.method === "PUT");
  assert.ok(putCall, "expected a PUT request");
  const payload = JSON.parse(putCall.init.body);
  assert.ok(!("date" in payload), "date key must be entirely absent from an untouched edit, got: " + JSON.stringify(payload));
});

test("typing into #f-date marks it dirty, and save() then sends the new ISO date", async () => {
  const existingPost = {
    slug: "existing-post-2",
    type: "post",
    title: "Existing Post 2",
    date: "2016-10-14T11:53:07.000Z",
    postTags: [],
    status: "published",
    body: "Body text.",
  };
  const fetchStub = makeFetchStub([
    { match: (url) => url === "/admin/api/post/post/existing-post-2", response: existingPost },
    {
      match: (url, init) => url === "/admin/api/post/post/existing-post-2" && init.method === "PUT",
      response: { ok: true, type: "post", slug: "existing-post-2", status: "published", url: "/existing-post-2/" },
    },
  ]);
  const { sandbox } = buildSandbox(fetchStub);
  const ex = sandbox.__exports;

  ex.editPost("post", "existing-post-2");
  await flush();

  const dateEl = ex.el("f-date");
  dateEl.value = "2021-05-05T09:15";
  dateEl.dispatch("input"); // the real production listener sets dateFieldDirty = true

  assert.strictEqual(ex.__getDirty(), true);

  ex.save("published");
  await flush();

  const putCall = fetchStub.calls.find((c) => c.init.method === "PUT");
  const payload = JSON.parse(putCall.init.body);
  assert.strictEqual(payload.date, new Date("2021-05-05T09:15").toISOString());
});

test("resetForm() clears both the field and the dirty flag, so a new post saved without touching date sends none", async () => {
  const fetchStub = makeFetchStub([
    {
      match: (url, init) => url === "/admin/api/post" && init.method === "POST",
      response: { ok: true, type: "post", slug: "brand-new-post", status: "published", url: "/brand-new-post/" },
    },
  ]);
  const { sandbox } = buildSandbox(fetchStub);
  const ex = sandbox.__exports;

  // Dirty the field first, to prove resetForm() actually clears the flag
  // rather than it merely starting false.
  const dateEl = ex.el("f-date");
  dateEl.value = "2021-05-05T09:15";
  dateEl.dispatch("input");
  assert.strictEqual(ex.__getDirty(), true);

  ex.resetForm();
  assert.strictEqual(ex.el("f-date").value, "");
  assert.strictEqual(ex.__getDirty(), false);

  ex.el("f-title").value = "Brand New Post";
  ex.save("published");
  await flush();

  const postCall = fetchStub.calls.find((c) => c.init.method === "POST");
  assert.ok(postCall, "expected a POST request");
  const payload = JSON.parse(postCall.init.body);
  assert.ok(!("date" in payload), "date key must be absent when creating with the field left untouched, got: " + JSON.stringify(payload));
});

// Found in the 2026-11-25 restore drill: editPost() loaded the body while the
// editor was still in WYSIWYG (the mode a fresh /admin opens in), so Toast UI
// ran it through the WYSIWYG model first and silently dropped raw HTML such
// as <details> before the Markdown view ever showed it. The switch to
// Markdown must come BEFORE setMarkdown.
test("editPost switches to Markdown mode before loading the body", async () => {
  const fetchStub = makeFetchStub([
    { match: (url) => url === "/admin/api/post/post/raw-html", response: { slug: "raw-html", type: "post", title: "Raw", date: "2016-10-14T11:53:07.000Z", postTags: [], status: "published", body: "<details><summary>More</summary>Hidden</details>" } },
  ]);
  const { sandbox } = buildSandbox(fetchStub);
  const order = [];
  sandbox.setEditorMode = function (mode) { order.push("mode:" + mode); };
  sandbox.editor = { setMarkdown: function () { order.push("setMarkdown"); }, getMarkdown: function () { return ""; } };
  sandbox.__exports.editPost("post", "raw-html");
  await flush();
  assert.deepStrictEqual(order, ["mode:markdown", "setMarkdown"]);
});
