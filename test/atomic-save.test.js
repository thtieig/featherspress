"use strict";

// Saving a post must never leave its file empty or cut short: on a full disk
// the old version has to survive. The disk is "filled" by making the write of
// a post file put half its bytes down and then fail with ENOSPC.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-atomic-"));
const POSTS = path.join(TMP, "content", "posts");
fs.mkdirSync(POSTS, { recursive: true });
fs.mkdirSync(path.join(TMP, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(TMP, "media"), { recursive: true });
process.env.CONTENT_DIR = path.join(TMP, "content");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.AUTH_CONFIG = path.join(TMP, "auth-config.json");
process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";

const RECOVERY = "abcd-1234";
fs.writeFileSync(process.env.AUTH_CONFIG, JSON.stringify({
  passwordHash: bcrypt.hashSync("testpassword123", 8),
  totpSecret: "JBSWY3DPEHPK3PXP",
  recoveryCodeHashes: [crypto.createHash("sha256").update(RECOVERY).digest("hex")],
}));
const ORIGINAL = "---\ntitle: Keep Me\ndate: 2026-01-01T00:00:00.000Z\nslug: keep-me\n---\n\nthe words that must survive\n";
fs.writeFileSync(path.join(POSTS, "keep-me.md"), ORIGINAL);

const app = require("../server");

let base, server, cookie;
test.before(async () => {
  await app.init();
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + "/admin/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "testpassword123", code: RECOVERY }),
  });
  assert.strictEqual(res.status, 200);
  cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
});
test.after(() => {
  if (server) server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// While active, any write into the posts folder lands half its bytes, then
// fails the way a full disk does.
function fillDisk() {
  const real = fs.writeFileSync;
  fs.writeFileSync = function (file, data, ...rest) {
    if (typeof file === "string" && file.startsWith(POSTS)) {
      real.call(fs, file, String(data).slice(0, 10), ...rest);
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    }
    return real.call(fs, file, data, ...rest);
  };
  return () => { fs.writeFileSync = real; };
}

const put = (p, body) => fetch(base + p, {
  method: "PUT",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify(body),
});

test("a save that fails on a full disk leaves the old post intact", async () => {
  const restore = fillDisk();
  let res;
  try {
    res = await put("/admin/api/post/post/keep-me", { title: "Keep Me", tags: "", body: "a much longer new body ".repeat(50) });
  } finally {
    restore();
  }
  assert.strictEqual(res.status, 500);
  assert.strictEqual(fs.readFileSync(path.join(POSTS, "keep-me.md"), "utf8"), ORIGINAL);
  assert.deepStrictEqual(fs.readdirSync(POSTS), ["keep-me.md"], "no temp file may be left behind");
});

test("a publish/draft toggle that fails on a full disk leaves the old post intact", async () => {
  const restore = fillDisk();
  let res;
  try {
    res = await fetch(base + "/admin/api/post/post/keep-me/status", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ status: "draft" }),
    });
  } finally {
    restore();
  }
  assert.strictEqual(res.status, 500);
  assert.strictEqual(fs.readFileSync(path.join(POSTS, "keep-me.md"), "utf8"), ORIGINAL);
  assert.deepStrictEqual(fs.readdirSync(POSTS), ["keep-me.md"]);
});

test("a post without tags can be saved without a tags field", async () => {
  const res = await put("/admin/api/post/post/keep-me", { title: "Keep Me", body: "no tags here" });
  assert.strictEqual(res.status, 200, await res.text());
  assert.match(fs.readFileSync(path.join(POSTS, "keep-me.md"), "utf8"), /no tags here/);
});

test("a normal save still works", async () => {
  const res = await put("/admin/api/post/post/keep-me", { title: "Keep Me", tags: "a, b", body: "new words" });
  assert.strictEqual(res.status, 200, await res.text());
  assert.match(fs.readFileSync(path.join(POSTS, "keep-me.md"), "utf8"), /new words/);
  assert.deepStrictEqual(fs.readdirSync(POSTS), ["keep-me.md"]);
});
