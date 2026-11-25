"use strict";

// One .md file with front matter that won't parse must not take the site or
// /admin down: it is skipped with a warning naming the file, and the rest of
// the content is served. Media it references still counts as used, so the
// Media library never offers it for deletion.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-badfm-"));
const POSTS = path.join(TMP, "content", "posts");
fs.mkdirSync(POSTS, { recursive: true });
fs.mkdirSync(path.join(TMP, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(TMP, "media", "2024"), { recursive: true });
fs.writeFileSync(path.join(TMP, "media", "2024", "only-bad.png"), "x");

fs.writeFileSync(
  path.join(POSTS, "good-post.md"),
  `---\ntitle: "Good Post"\ndate: 2024-01-01 10:00:00\n---\n\nStill here.\n`
);
// Unclosed flow sequence: js-yaml throws on this.
fs.writeFileSync(
  path.join(POSTS, "broken-post.md"),
  `---\ntitle: [unclosed\ndate: 2024-01-02 10:00:00\n---\n\n![pic](/media/2024/only-bad.png)\n`
);

process.env.CONTENT_DIR = path.join(TMP, "content");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.AUTH_CONFIG = path.join(TMP, "auth-config.json");
process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";
delete process.env.SITE_PACKAGE;
delete process.env.SITE_MANIFEST;

const PASSWORD = "testpassword123";
const RECOVERY = "abcd-1234";
fs.writeFileSync(
  process.env.AUTH_CONFIG,
  JSON.stringify({
    passwordHash: bcrypt.hashSync(PASSWORD, 8),
    totpSecret: "JBSWY3DPEHPK3PXP",
    recoveryCodeHashes: [crypto.createHash("sha256").update(RECOVERY).digest("hex")],
  })
);

const posts = require("../src/posts");
const app = require("../server");

let base;
let server;
let cookie = "";
const warnings = [];

async function api(method, p) {
  const res = await fetch(base + p, { method, headers: cookie ? { cookie } : {} });
  const text = await res.text();
  return { status: res.status, text };
}

test.before(async () => {
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    await app.init();
  } finally {
    console.warn = warn;
  }
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + "/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD, code: RECOVERY }),
  });
  assert.strictEqual(res.status, 200, await res.text());
  cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test("loading skips the bad file and warns with its name", () => {
  assert.deepStrictEqual(posts.allPosts().map((p) => p.slug), ["good-post"]);
  assert.ok(warnings.some((w) => w.includes("broken-post.md")), warnings.join("\n"));
});

// gray-matter caches a file before parsing it, so a second read of a broken
// file "succeeds" with half-parsed data unless the cache is bypassed.
test("a reload (as after an admin save) still skips it", () => {
  posts.reload();
  assert.deepStrictEqual(posts.allPosts().map((p) => p.slug), ["good-post"]);
});

test("the public site serves the rest", async () => {
  const res = await api("GET", "/good-post");
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /Still here/);
});

test("the admin listing shows the rest", async () => {
  const res = await api("GET", "/admin/api/posts");
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(JSON.parse(res.text).map((p) => p.slug), ["good-post"]);
});

test("media used only by the bad file still counts as used", async () => {
  const res = await api("GET", "/admin/api/media");
  assert.strictEqual(res.status, 200, res.text);
  const hit = JSON.parse(res.text).find((f) => f.path === "/media/2024/only-bad.png");
  assert.ok(hit && hit.usage.length > 0, res.text);
});
