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
process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";
process.env.UPDATE_STATUS_FILE = path.join(TMP, "update-status.json");
process.env.UPDATE_APPLY_STATUS_FILE = path.join(TMP, "update-apply-status.json");

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

test("update-status omits apply fields when no GUI apply has ever happened", async () => {
  // Fresh install: update.sh has run (UPDATE_STATUS_FILE exists) but
  // update-control.js never has (UPDATE_APPLY_STATUS_FILE does not).
  fs.writeFileSync(
    process.env.UPDATE_STATUS_FILE,
    JSON.stringify({ available: false, behind: 0, currentCommit: "aaaa", checkedAt: "2026-07-20T00:00:00Z" })
  );
  fs.rmSync(process.env.UPDATE_APPLY_STATUS_FILE, { force: true });
  const res = await api("GET", "/admin/api/update-status");
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.available, false);
  assert.strictEqual(body.lastOk, undefined);
  assert.strictEqual(body.lastErr, undefined);
  assert.strictEqual(body.appliedAt, undefined);
});

test("update-status merges lastOk/lastErr/appliedAt once an apply status file exists", async () => {
  fs.writeFileSync(
    process.env.UPDATE_STATUS_FILE,
    JSON.stringify({ available: true, behind: 1, currentCommit: "aaaa", availableCommit: "cccc", checkedAt: "2026-07-21T00:00:00Z" })
  );
  fs.writeFileSync(
    process.env.UPDATE_APPLY_STATUS_FILE,
    JSON.stringify({ appliedRequestId: 5, lastOk: false, lastErr: "npm ci failed", appliedAt: "2026-07-21T00:05:00Z" })
  );
  const res = await api("GET", "/admin/api/update-status");
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  // Fields owned by update.sh (UPDATE_STATUS_FILE) survive the merge...
  assert.strictEqual(body.available, true);
  assert.strictEqual(body.behind, 1);
  // ...alongside the fields owned by update-control.js (UPDATE_APPLY_STATUS_FILE).
  assert.strictEqual(body.appliedRequestId, 5);
  assert.strictEqual(body.lastOk, false);
  assert.strictEqual(body.lastErr, "npm ci failed");
  assert.strictEqual(body.appliedAt, "2026-07-21T00:05:00Z");
});

// ---- agentSeenAt (review fix) ------------------------------------------
// The update-control agent (tools/update-control.js) is an optional,
// separately-installed piece (docs/DEPLOY.md) layered on top of the
// always-installed daily checker that writes UPDATE_STATUS_FILE. Before
// this fix, the GUI's Apply now button keyed its visibility purely off
// `available`, so it appeared and silently did nothing on any box lacking
// the optional agent. agentSeenAt — heartbeated by update-control.js on
// every trigger, including ones with nothing queued — is how the API tells
// "agent installed and alive" apart from "agent never installed".

const uc = require("../tools/update-control");

test("update-status: agentSeenAt is absent before the update-control agent has ever run", async () => {
  fs.rmSync(process.env.UPDATE_APPLY_STATUS_FILE, { force: true });
  fs.writeFileSync(
    process.env.UPDATE_STATUS_FILE,
    JSON.stringify({ available: true, behind: 1, currentCommit: "aaaa", availableCommit: "bbbb", checkedAt: "2026-08-01T00:00:00Z" })
  );
  const res = await api("GET", "/admin/api/update-status");
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.available, true);
  assert.strictEqual(body.agentSeenAt, undefined);
});

test("update-status: agentSeenAt appears once update-control.js processes even a no-request trigger", async () => {
  fs.rmSync(process.env.UPDATE_APPLY_STATUS_FILE, { force: true });
  // Simulate the .path unit or safety timer firing with nothing queued --
  // exactly applyRequest's no-request-file path.
  uc.applyRequest({
    UPDATE_REQUEST: path.join(TMP, "update-request-does-not-exist.json"),
    UPDATE_APPLY_STATUS: process.env.UPDATE_APPLY_STATUS_FILE,
    FP_ENV: "/dev/null",
    ENGINE_DIR: TMP,
    NODE_BIN: "/usr/bin/node",
    NPM_BIN: "/usr/bin/npm",
    SERVICE: "featherspress",
  });
  const res = await api("GET", "/admin/api/update-status");
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(body.agentSeenAt, "agentSeenAt must be present once the agent has checked in");
});

test("update-status apply fields survive even when the base status file is absent", async () => {
  fs.rmSync(process.env.UPDATE_STATUS_FILE, { force: true });
  fs.writeFileSync(
    process.env.UPDATE_APPLY_STATUS_FILE,
    JSON.stringify({ appliedRequestId: 6, lastOk: false, lastErr: "npm ci failed", appliedAt: "2026-07-22T00:00:00Z" })
  );
  const res = await api("GET", "/admin/api/update-status");
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.available, false);
  assert.strictEqual(body.lastOk, false);
  assert.strictEqual(body.lastErr, "npm ci failed");
});
