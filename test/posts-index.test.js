"use strict";

// The generic post-listing ("posts index") is served at the manifest's
// configurable `postsPath`. It behaves as an OVERRIDABLE placeholder: if a real
// page occupies that slug, the page wins; otherwise the engine auto-lists posts.
// Runs in its own process (node --test isolates files), so it sets its own env.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-postsidx-"));
fs.mkdirSync(path.join(TMP, "content", "posts"), { recursive: true });
fs.mkdirSync(path.join(TMP, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(TMP, "media"), { recursive: true });
fs.writeFileSync(
  path.join(TMP, "content", "posts", "one.md"),
  "---\ntitle: Post One\ndate: 2021-05-01\nslug: one\n---\n\nfirst body\n"
);
fs.writeFileSync(
  path.join(TMP, "content", "posts", "two.md"),
  "---\ntitle: Post Two\ndate: 2022-05-01\nslug: two\n---\n\nsecond body\n"
);
// A hand-written page whose slug matches the configured postsPath ("/writings/").
fs.writeFileSync(
  path.join(TMP, "content", "pages", "writings.md"),
  "---\ntitle: Hand-written Archive\nslug: writings\n---\n\nMANUAL ARCHIVE BODY\n"
);
fs.writeFileSync(
  path.join(TMP, "site.json"),
  JSON.stringify({
    title: "Idx Blog",
    skin: "notepad",
    homeMode: "feed",
    postsPath: "/writings/",
    postsHeading: "My Writings",
    nav: [{ label: "Home", href: "/" }],
  })
);
process.env.CONTENT_DIR = path.join(TMP, "content");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.SITE_MANIFEST = path.join(TMP, "site.json");

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const app = require("../server");

let server;
let base;
function get(p) {
  return new Promise((resolve, reject) => {
    http
      .get(base + p, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

test.before(async () => {
  await app.init();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("a real page at postsPath overrides the auto-index (placeholder replaced)", async () => {
  const r = await get("/writings/");
  assert.strictEqual(r.status, 200);
  // The hand-written page is rendered, not the auto-listing.
  assert.match(r.body, /MANUAL ARCHIVE BODY/);
  assert.match(r.body, /<h1>Hand-written Archive<\/h1>/);
  // The auto-index heading must NOT appear (proves the page won).
  assert.ok(!r.body.includes("My Writings"), "auto-index heading leaked; page did not override");
});

test("the default /posts/ path is inactive once postsPath is customised", async () => {
  const r = await get("/posts/");
  assert.strictEqual(r.status, 404);
});
