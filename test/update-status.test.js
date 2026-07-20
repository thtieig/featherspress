"use strict";

// The admin update-status endpoint. A root-run update timer writes
// update-status.json into the data root; the admin UI reads it (behind auth) to
// show an "update available" banner. The app only READS — it never runs git or
// restarts — so the hardened service model is preserved.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "fp-upd-"));
fs.mkdirSync(path.join(TMP, "content", "posts"), { recursive: true });
fs.mkdirSync(path.join(TMP, "content", "pages"), { recursive: true });
fs.mkdirSync(path.join(TMP, "media"), { recursive: true });
process.env.CONTENT_DIR = path.join(TMP, "content");
process.env.MEDIA_DIR = path.join(TMP, "media");
process.env.AUTH_CONFIG = path.join(TMP, "auth-config.json");
process.env.UPDATE_STATUS_FILE = path.join(TMP, "update-status.json");

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

const app = require("../server");

let base;
let server;
let cookie = "";
async function api(method, p, body) {
  const headers = cookie ? { cookie } : {};
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(base + p, { method, headers, body: payload, redirect: "manual" });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  return res;
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

test("update-status requires auth", async () => {
  const res = await api("GET", "/admin/api/update-status");
  assert.strictEqual(res.status, 401);
});

test("update-status returns the status file when present", async () => {
  await api("POST", "/admin/api/login", { password: PASSWORD, code: RECOVERY });
  fs.writeFileSync(
    process.env.UPDATE_STATUS_FILE,
    JSON.stringify({ available: true, behind: 2, currentCommit: "aaaa", availableCommit: "bbbb", checkedAt: "2026-07-20T00:00:00Z" })
  );
  const res = await api("GET", "/admin/api/update-status");
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.available, true);
  assert.strictEqual(body.behind, 2);
  assert.strictEqual(body.availableCommit, "bbbb");
});

test("update-status is graceful when the file is absent", async () => {
  fs.rmSync(process.env.UPDATE_STATUS_FILE, { force: true });
  const res = await api("GET", "/admin/api/update-status");
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.available, false);
});
